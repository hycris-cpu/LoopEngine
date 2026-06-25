"""Tests for the runloop module — the HEART of LoopEngine.

TDD approach: Write ONE test → implement → verify pass → repeat.
BDD style: Each test has a Given/When/Then docstring.

The RunLoop is the main execution loop that drives the agent:
1. Assemble context (step_start processors)
2. Adjust before model (before_model processors)
3. Call the AI model
4. Process response (after_model processors)
5. Execute tool calls (before_tool → execute → after_tool)
6. Record observations (step_end processors)
7. Check termination conditions
8. Evaluate the full run (task_end processors)
"""

from __future__ import annotations

import pytest
from dataclasses import FrozenInstanceError
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

from loopengine.primitives.events import Event, Message, ToolCall, ToolResult, EvalResult
from loopengine.primitives.processors import (
    HOOK_POINTS, MultiHookProcessor, Processor, ProcessorChain, pipe,
)
from loopengine.primitives.state import Budget, State
from loopengine.primitives.trajectory import Trajectory

# Import the module under test
from loopengine.execution.runloop import RunResult, ModelProvider, run_loop
from loopengine.composition.config import HarnessConfig


# ---------------------------------------------------------------------------
# Test 1: RunResult — creation with default values
# ---------------------------------------------------------------------------


def test_run_result_defaults():
    """Given a RunResult with no arguments,
    When I inspect its fields,
    Then they should have sensible defaults:
    - empty trajectory
    - None eval_result
    - 0 total_steps
    - 0 total_tokens
    - 'end_turn' exit_reason."""
    result = RunResult()

    assert isinstance(result.trajectory, Trajectory)
    assert len(result.trajectory) == 0
    assert result.eval_result is None
    assert result.total_steps == 0
    assert result.total_tokens == 0
    assert result.exit_reason == "end_turn"


# ---------------------------------------------------------------------------
# Test 2: RunResult — frozen (immutable) dataclass
# ---------------------------------------------------------------------------


def test_run_result_is_frozen():
    """Given a RunResult instance,
    When I try to modify any field,
    Then it should raise a FrozenInstanceError (immutability guarantee)."""
    result = RunResult(total_steps=5, exit_reason="done")

    with pytest.raises(FrozenInstanceError):
        result.total_steps = 10  # type: ignore[misc]

    with pytest.raises(FrozenInstanceError):
        result.exit_reason = "budget"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Test 3: RunResult — creation with all custom values
# ---------------------------------------------------------------------------


def test_run_result_custom_values():
    """Given a RunResult with all fields specified,
    When I inspect each field,
    Then every field should match the value I provided."""
    traj = Trajectory(task_id="t1")
    eval_r = EvalResult(passed=True, score=0.9, reason="great job")

    result = RunResult(
        trajectory=traj,
        eval_result=eval_r,
        total_steps=7,
        total_tokens=1500,
        exit_reason="done",
    )

    assert result.trajectory is traj
    assert result.trajectory.task_id == "t1"
    assert result.eval_result is eval_r
    assert result.eval_result.passed is True
    assert result.eval_result.score == 0.9
    assert result.total_steps == 7
    assert result.total_tokens == 1500
    assert result.exit_reason == "done"


# ---------------------------------------------------------------------------
# Test 4: ModelProvider protocol — any class with complete + count_tokens
# ---------------------------------------------------------------------------


def test_model_provider_protocol_compliance():
    """Given a class with complete() and count_tokens() methods,
    When I check isinstance against ModelProvider,
    Then it should satisfy the Protocol."""

    class FakeModel:
        """A minimal model provider for testing."""

        async def complete(
            self,
            messages: list[Message],
            tools: list[dict[str, Any]] | None = None,
        ) -> Message:
            return Message(role="assistant", content="hello")

        def count_tokens(self, messages: list[Message]) -> int:
            return 42

    model = FakeModel()
    assert isinstance(model, ModelProvider)


# ---------------------------------------------------------------------------
# Helpers: Mock Task for run_loop tests
# ---------------------------------------------------------------------------


class MockTask:
    """A mock task that provides a prompt, limits, and optional evaluation.

    Plain English: This is a fake "homework assignment" for testing.
    You give it a question (prompt), set how many attempts you allow,
    and optionally provide a grading function.
    """

    def __init__(
        self,
        prompt: str = "What is 2+2?",
        max_steps: int = 10,
        budget: Budget | None = None,
        done_condition: Any = None,
        eval_fn: Any = None,
    ) -> None:
        self.prompt = prompt
        self.max_steps = max_steps
        self.budget = budget or Budget(max_steps=max_steps)
        self._done_condition = done_condition
        self._eval_fn = eval_fn

    def is_done(self, state: State) -> bool:
        """Check if the task is done. Default: never done (relies on end_turn/max_steps)."""
        if self._done_condition is not None:
            return self._done_condition(state)
        return False

    async def evaluate(self, trajectory: Trajectory) -> EvalResult:
        """Evaluate the trajectory. Default: always passes with score 1.0."""
        if self._eval_fn is not None:
            return self._eval_fn(trajectory)
        return EvalResult(passed=True, score=1.0, reason="default pass")


class SimpleMockModel:
    """A mock model that returns pre-programmed responses in sequence.

    Plain English: This is like a teleprompter — you script exactly what
    the AI should say, and it says those things in order.
    Useful for testing deterministic run-loop behavior.
    """

    def __init__(self, responses: list[Message], tokens_per_call: int = 50) -> None:
        self._responses = list(responses)
        self._call_count = 0
        self._tokens_per_call = tokens_per_call

    async def complete(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
    ) -> Message:
        """Return the next pre-programmed response."""
        idx = min(self._call_count, len(self._responses) - 1)
        self._call_count += 1
        return self._responses[idx]

    def count_tokens(self, messages: list[Message]) -> int:
        """Return a fixed token count per call."""
        return self._tokens_per_call


# ---------------------------------------------------------------------------
# Test 5: run_loop basic flow — model responds with text, no tools → 1 step
# ---------------------------------------------------------------------------


async def test_run_loop_basic_no_tools():
    """Given a task and a model that returns a plain text message (no tool calls),
    When I run the loop,
    Then it should complete in 1 step with exit_reason='end_turn'."""
    response = Message(role="assistant", content="The answer is 42.")
    model = SimpleMockModel(responses=[response])
    task = MockTask(prompt="What is the meaning of life?")

    result = await run_loop(task=task, model=model)

    assert isinstance(result, RunResult)
    assert result.total_steps == 1
    assert result.exit_reason == "end_turn"
    assert len(result.trajectory) == 1
    # The trajectory step should have the assistant message as the action
    assert result.trajectory[0].action is not None
    assert result.trajectory[0].action.content == "The answer is 42."


# ---------------------------------------------------------------------------
# Test 6: run_loop with tool calls — model calls tool, gets result, finishes
# ---------------------------------------------------------------------------


async def test_run_loop_with_tool_calls():
    """Given a task with a mock tool, and a model that:
    - Step 1: calls the tool
    - Step 2: responds with text (no tool calls → end_turn)
    When I run the loop,
    Then the tool should be executed, result returned to model,
    and the run should complete in 2 steps."""
    from loopengine.primitives.tools import ToolContext

    # Mock tool that echoes input
    class EchoTool:
        @property
        def name(self) -> str:
            return "echo"

        @property
        def description(self) -> str:
            return "Echo the input back"

        @property
        def input_schema(self) -> dict[str, Any]:
            return {
                "type": "function",
                "function": {
                    "name": "echo",
                    "description": "Echo the input back",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "text": {"type": "string"},
                        },
                    },
                },
            }

        async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(
                call_id="call_1",
                output=input.get("text", ""),
            )

    # Model: step 1 calls "echo" tool, step 2 gives final text
    tool_call = ToolCall(name="echo", input={"text": "hello world"})
    step1_response = Message(
        role="assistant",
        content="",
        tool_calls=(tool_call,),
    )
    step2_response = Message(
        role="assistant",
        content="The echo said: hello world",
    )

    model = SimpleMockModel(responses=[step1_response, step2_response])
    task = MockTask(prompt="Echo 'hello world' and tell me the result.")

    # Build a config with the echo tool
    from loopengine.composition.config import HarnessConfig
    config = HarnessConfig(tools=[EchoTool()])

    result = await run_loop(task=task, model=model, config=config)

    assert result.total_steps == 2
    assert result.exit_reason == "end_turn"
    assert len(result.trajectory) == 2

    # Step 1 should have the tool call as action and tool result as observation
    step1 = result.trajectory[0]
    assert step1.action is not None
    assert len(step1.action.tool_calls) == 1
    assert step1.action.tool_calls[0].name == "echo"
    assert len(step1.observations) == 1
    assert isinstance(step1.observations[0], ToolResult)
    assert step1.observations[0].output == "hello world"

    # Step 2 should be a text response with no tool calls
    step2 = result.trajectory[1]
    assert step2.action is not None
    assert step2.action.content == "The echo said: hello world"


# ---------------------------------------------------------------------------
# Test 7: run_loop respects max_steps — stops when limit hit
# ---------------------------------------------------------------------------


async def test_run_loop_respects_max_steps():
    """Given a task with max_steps=3, and a model that always calls a tool,
    When I run the loop,
    Then it should stop after exactly 3 steps with exit_reason='max_steps'."""
    from loopengine.primitives.tools import ToolContext

    # A tool that returns a fixed result
    class NoopTool:
        @property
        def name(self) -> str:
            return "noop"

        @property
        def description(self) -> str:
            return "Does nothing"

        @property
        def input_schema(self) -> dict[str, Any]:
            return {
                "type": "function",
                "function": {
                    "name": "noop",
                    "description": "Does nothing",
                    "parameters": {"type": "object", "properties": {}},
                },
            }

        async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(call_id="noop_1", output="ok")

    # Model always calls the noop tool (never finishes naturally)
    tool_call = ToolCall(name="noop", input={})

    def make_tool_response():
        return Message(role="assistant", content="", tool_calls=(tool_call,))

    class AlwaysCallModel:
        """A model that ALWAYS calls tools — never produces a text-only response."""

        def __init__(self):
            self._call_count = 0

        async def complete(self, messages, tools=None):
            self._call_count += 1
            return make_tool_response()

        def count_tokens(self, messages):
            return 10

    model = AlwaysCallModel()
    task = MockTask(
        prompt="Do something forever.",
        max_steps=3,
        budget=Budget(max_steps=3),
    )
    config = HarnessConfig(tools=[NoopTool()])

    result = await run_loop(task=task, model=model, config=config)

    assert result.total_steps == 3
    assert result.exit_reason == "max_steps"
    assert len(result.trajectory) == 3


# ---------------------------------------------------------------------------
# Test 8: run_loop respects budget — stops when tokens exhausted
# ---------------------------------------------------------------------------


async def test_run_loop_respects_budget():
    """Given a task with a tight token budget (100 tokens),
    and a model that uses 60 tokens per call and always calls a tool,
    When I run the loop,
    Then it should stop after the budget is exhausted."""
    from loopengine.primitives.tools import ToolContext

    class NoopTool:
        @property
        def name(self) -> str:
            return "noop"

        @property
        def description(self) -> str:
            return "Does nothing"

        @property
        def input_schema(self) -> dict[str, Any]:
            return {
                "type": "function",
                "function": {
                    "name": "noop",
                    "description": "Does nothing",
                    "parameters": {"type": "object", "properties": {}},
                },
            }

        async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(call_id="noop_1", output="ok")

    tool_call = ToolCall(name="noop", input={})

    class HighTokenModel:
        """Model that uses 60 tokens per call and always calls a tool."""

        async def complete(self, messages, tools=None):
            return Message(role="assistant", content="", tool_calls=(tool_call,))

        def count_tokens(self, messages):
            return 60

    model = HighTokenModel()
    task = MockTask(
        prompt="Do stuff.",
        max_steps=100,
        budget=Budget(max_tokens=100, max_steps=100),
    )
    config = HarnessConfig(tools=[NoopTool()])

    result = await run_loop(task=task, model=model, config=config)

    # After step 1: 60 tokens used. After step 2: 120 tokens → budget exhausted.
    assert result.exit_reason == "budget"
    assert result.total_steps >= 1
    assert result.total_tokens >= 100


# ---------------------------------------------------------------------------
# Test 9: run_loop runs processors at each hook point
# ---------------------------------------------------------------------------


async def test_run_loop_processors_at_hook_points():
    """Given a config with processors attached to every hook point,
    When I run the loop for 1 step (no tool calls),
    Then each processor should have been called exactly once with the correct event type."""
    from loopengine.composition.config import HarnessConfig, ProcessorEntry

    # Track which hook points were called
    called_hooks: list[str] = []

    class TrackingProcessor:
        """Records every event it sees, along with the hook point."""

        def __init__(self, name: str, hook: str):
            self._name = name
            self._hook = hook

        @property
        def name(self) -> str:
            return self._name

        async def process(self, event: Event) -> AsyncIterator[Event]:
            called_hooks.append(event.type)
            yield event

    # Create a processor for each hook point
    entries = []
    for hook in HOOK_POINTS:
        proc = TrackingProcessor(f"tracker_{hook}", hook)
        entries.append(ProcessorEntry(processor=proc, hook=hook, order=0))

    config = HarnessConfig(processors=entries)

    response = Message(role="assistant", content="done")
    model = SimpleMockModel(responses=[response])
    task = MockTask(prompt="test")

    called_hooks.clear()
    result = await run_loop(task=task, model=model, config=config)

    # For a 1-step run with no tools:
    # task_start, step_start, before_model, after_model, step_end, task_end
    assert "task_start" in called_hooks
    assert "step_start" in called_hooks
    assert "before_model" in called_hooks
    assert "after_model" in called_hooks
    assert "step_end" in called_hooks
    assert "task_end" in called_hooks
    # before_tool/after_tool should NOT be called (no tool calls)
    assert "before_tool" not in called_hooks
    assert "after_tool" not in called_hooks


# ---------------------------------------------------------------------------
# Test 10: RunResult fields populated correctly after a real run
# ---------------------------------------------------------------------------


async def test_run_result_fields_populated():
    """Given a 2-step run that evaluates the trajectory,
    When I inspect the RunResult,
    Then all fields should be correctly populated:
    - trajectory has 2 steps
    - total_steps is 2
    - total_tokens is the sum of both steps
    - exit_reason is 'end_turn'
    - eval_result is populated from task.evaluate()"""
    from loopengine.primitives.tools import ToolContext

    class EchoTool:
        @property
        def name(self) -> str:
            return "echo"

        @property
        def description(self) -> str:
            return "Echo input"

        @property
        def input_schema(self) -> dict[str, Any]:
            return {
                "type": "function",
                "function": {
                    "name": "echo",
                    "description": "Echo input",
                    "parameters": {
                        "type": "object",
                        "properties": {"text": {"type": "string"}},
                    },
                },
            }

        async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(call_id="c1", output=input.get("text", ""))

    tool_call = ToolCall(name="echo", input={"text": "hi"})
    step1 = Message(role="assistant", content="", tool_calls=(tool_call,))
    step2 = Message(role="assistant", content="Done!")
    model = SimpleMockModel(responses=[step1, step2], tokens_per_call=100)

    def custom_eval(trajectory):
        return EvalResult(passed=True, score=0.85, reason="well done")

    task = MockTask(prompt="Say hi", eval_fn=custom_eval)
    config = HarnessConfig(tools=[EchoTool()])

    result = await run_loop(task=task, model=model, config=config)

    assert result.total_steps == 2
    assert result.total_tokens == 200  # 100 per step
    assert result.exit_reason == "end_turn"
    assert len(result.trajectory) == 2
    assert result.eval_result is not None
    assert result.eval_result.passed is True
    assert result.eval_result.score == 0.85
    assert result.eval_result.reason == "well done"


# ---------------------------------------------------------------------------
# Test 11: run_loop respects task.is_done() — stops when task signals done
# ---------------------------------------------------------------------------


async def test_run_loop_respects_is_done():
    """Given a task that becomes 'done' after step 2,
    and a model that always calls a tool,
    When I run the loop,
    Then it should stop at step 2 with exit_reason='done'."""
    from loopengine.primitives.tools import ToolContext

    class NoopTool:
        @property
        def name(self) -> str:
            return "noop"

        @property
        def description(self) -> str:
            return "Does nothing"

        @property
        def input_schema(self) -> dict[str, Any]:
            return {
                "type": "function",
                "function": {
                    "name": "noop",
                    "description": "Does nothing",
                    "parameters": {"type": "object", "properties": {}},
                },
            }

        async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(call_id="noop_1", output="ok")

    tool_call = ToolCall(name="noop", input={})

    step_counter = {"count": 0}

    def done_after_two(state: State) -> bool:
        step_counter["count"] += 1
        return step_counter["count"] >= 2

    class AlwaysCallModel:
        async def complete(self, messages, tools=None):
            return Message(role="assistant", content="", tool_calls=(tool_call,))

        def count_tokens(self, messages):
            return 10

    model = AlwaysCallModel()
    task = MockTask(
        prompt="Keep going until I say stop.",
        max_steps=100,
        done_condition=done_after_two,
    )
    config = HarnessConfig(tools=[NoopTool()])

    result = await run_loop(task=task, model=model, config=config)

    assert result.exit_reason == "done"
    assert result.total_steps == 2


# ---------------------------------------------------------------------------
# Test 12: run_loop handles tool not found gracefully
# ---------------------------------------------------------------------------


async def test_run_loop_tool_not_found():
    """Given a model that calls a tool not in the config,
    When I run the loop,
    Then the tool result should be an error, but the loop should continue."""
    tool_call = ToolCall(name="nonexistent_tool", input={"x": 1})
    step1 = Message(role="assistant", content="", tool_calls=(tool_call,))
    step2 = Message(role="assistant", content="I couldn't find that tool.")
    model = SimpleMockModel(responses=[step1, step2])
    task = MockTask(prompt="Use the nonexistent tool.")
    config = HarnessConfig(tools=[])  # No tools registered

    result = await run_loop(task=task, model=model, config=config)

    # The run should complete successfully despite the tool error
    assert result.total_steps == 2
    assert result.exit_reason == "end_turn"

    # The first step's observations should contain an error ToolResult
    step1_obs = result.trajectory[0].observations
    assert len(step1_obs) == 1
    assert isinstance(step1_obs[0], ToolResult)
    assert step1_obs[0].is_error
    assert "nonexistent_tool" in step1_obs[0].error


# ---------------------------------------------------------------------------
# Test 13: run_loop handles tool execution error gracefully
# ---------------------------------------------------------------------------


async def test_run_loop_tool_execution_error():
    """Given a tool that raises an exception during execution,
    When I run the loop,
    Then the tool result should be an error, but the loop should continue."""
    from loopengine.primitives.tools import ToolContext

    class BrokenTool:
        @property
        def name(self) -> str:
            return "broken"

        @property
        def description(self) -> str:
            return "A tool that always fails"

        @property
        def input_schema(self) -> dict[str, Any]:
            return {
                "type": "function",
                "function": {
                    "name": "broken",
                    "description": "A tool that always fails",
                    "parameters": {"type": "object", "properties": {}},
                },
            }

        async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
            raise RuntimeError("Something went terribly wrong!")

    tool_call = ToolCall(name="broken", input={})
    step1 = Message(role="assistant", content="", tool_calls=(tool_call,))
    step2 = Message(role="assistant", content="The tool broke.")
    model = SimpleMockModel(responses=[step1, step2])
    task = MockTask(prompt="Try the broken tool.")
    config = HarnessConfig(tools=[BrokenTool()])

    result = await run_loop(task=task, model=model, config=config)

    assert result.total_steps == 2
    assert result.exit_reason == "end_turn"

    # The tool result should be an error
    step1_obs = result.trajectory[0].observations
    assert len(step1_obs) == 1
    assert step1_obs[0].is_error
    assert "terribly wrong" in step1_obs[0].error


# ---------------------------------------------------------------------------
# Test 14: run_loop with no config — should still work
# ---------------------------------------------------------------------------


async def test_run_loop_no_config():
    """Given a task and model with no config (None),
    When I run the loop,
    Then it should still complete normally with no processors or tools."""
    response = Message(role="assistant", content="Hello!")
    model = SimpleMockModel(responses=[response])
    task = MockTask(prompt="Say hello.")

    result = await run_loop(task=task, model=model, config=None)

    assert result.total_steps == 1
    assert result.exit_reason == "end_turn"
    assert result.eval_result is not None


# ---------------------------------------------------------------------------
# Test 15: token accounting is linear, not quadratic (bug C1)
# ---------------------------------------------------------------------------


async def test_token_accounting_is_linear_not_quadratic():
    """Given a model whose count_tokens reflects the conversation length,
    When a multi-step run accumulates messages,
    Then total_tokens must count each NEW message once (linear) — not re-count
    the whole growing conversation every step (quadratic).

    Conversation produced here (after the initial user prompt):
        step0: assistant(tool_call) + tool result  -> 2 new
        step1: assistant(tool_call) + tool result  -> 2 new
        step2: assistant(text)                      -> 1 new
    => 5 new messages total. The old quadratic bug reported 12."""
    from loopengine.primitives.tools import ToolContext

    class EchoTool:
        @property
        def name(self) -> str:
            return "echo"

        @property
        def description(self) -> str:
            return "Echo input"

        @property
        def input_schema(self) -> dict[str, Any]:
            return {
                "type": "function",
                "function": {"name": "echo", "parameters": {"type": "object"}},
            }

        async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(call_id="c1", output="ok")

    class LenCountingModel:
        """count_tokens returns the number of messages it is given."""

        def __init__(self, responses: list[Message]) -> None:
            self._responses = list(responses)
            self._i = 0

        async def complete(self, messages, tools=None):
            idx = min(self._i, len(self._responses) - 1)
            self._i += 1
            return self._responses[idx]

        def count_tokens(self, messages: list[Message]) -> int:
            return len(messages)

        # noqa

    tc = ToolCall(name="echo", input={})
    responses = [
        Message(role="assistant", content="", tool_calls=(tc,)),
        Message(role="assistant", content="", tool_calls=(tc,)),
        Message(role="assistant", content="done"),
    ]
    model = LenCountingModel(responses)
    task = MockTask(prompt="go", max_steps=10)
    config = HarnessConfig(tools=[EchoTool()])

    result = await run_loop(task=task, model=model, config=config)

    assert result.total_steps == 3
    assert result.total_tokens == 5


# ---------------------------------------------------------------------------
# Test 16: tool_schemas passed to model are in OpenAI format (bug: raw schema)
# ---------------------------------------------------------------------------


async def test_tool_schemas_passed_in_openai_format():
    """Given a config with tools whose input_schema is raw JSON Schema,
    When I run the loop,
    Then the tools parameter passed to model.complete() should be wrapped
    in OpenAI format ({type: 'function', function: {name, description, parameters}})
    — NOT the raw input_schema dict."""
    from loopengine.primitives.tools import ToolContext

    captured_tools: list[Any] = []

    class CapturingModel:
        """A model that captures the tools argument for inspection."""
        async def complete(self, messages, tools=None):
            captured_tools.append(tools)
            return Message(role="assistant", content="done")

        def count_tokens(self, messages):
            return 0

    class SimpleTool:
        @property
        def name(self) -> str:
            return "read_file"

        @property
        def description(self) -> str:
            return "Read a file"

        @property
        def input_schema(self) -> dict[str, Any]:
            return {"type": "object", "properties": {"path": {"type": "string"}}}

        async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(call_id="c1", output="ok")

    model = CapturingModel()
    task = MockTask(prompt="Read a file", max_steps=5)
    config = HarnessConfig(tools=[SimpleTool()])

    await run_loop(task=task, model=model, config=config)

    # Verify tools were passed and in correct OpenAI format
    assert len(captured_tools) == 1
    assert captured_tools[0] is not None
    tool_def = captured_tools[0][0]
    assert tool_def["type"] == "function"
    assert "function" in tool_def
    assert tool_def["function"]["name"] == "read_file"
    assert tool_def["function"]["description"] == "Read a file"
    assert tool_def["function"]["parameters"] == {"type": "object", "properties": {"path": {"type": "string"}}}
