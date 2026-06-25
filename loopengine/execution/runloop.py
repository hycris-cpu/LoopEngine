"""The RunLoop is the HEART of the framework — the main execution loop.

Plain English: The RunLoop is like a game loop in a video game.
Each "frame" (step):
1. We look at the current situation (step_start processors assemble context)
2. We think about what to do (before_model processors make final adjustments)
3. We ask the AI for a decision (call the model)
4. We process the AI's response (after_model processors review it)
5. We execute any tools the AI requested (before_tool → execute → after_tool)
6. We observe what happened (step_end processors record observations)
7. We check if we're done (budget exhausted? max steps? task complete?)
8. If done, evaluate the whole run (task_end processors)

The loop is PURE — all behavior is driven by processors.
If you want different behavior, you add/change processors, not the loop itself.
This is the "single source of truth" principle from Harness-1.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from loopengine.primitives.events import (
    Event, EvalResult, Message, MessageType, ToolCall, ToolResult,
)
from loopengine.primitives.processors import (
    HOOK_POINTS, Processor, ProcessorChain, pipe, pipe_all,
)
from loopengine.primitives.state import Budget, State
from loopengine.primitives.trajectory import Trajectory, TrajectoryStep
from loopengine.primitives.tools import ToolSchema

# ---------------------------------------------------------------------------
# Try to import Task and Sandbox from the execution layer.
# If they don't exist yet (another agent is building them), define stubs.
# ---------------------------------------------------------------------------

try:
    from loopengine.execution.task import Task, SimpleTask
except ImportError:
    from typing import Protocol as _Protocol

    class Task(_Protocol):  # type: ignore[no-redef]
        """Stub Task protocol — replaced when task.py is built."""

        @property
        def prompt(self) -> str: ...

        @property
        def max_steps(self) -> int: ...

        @property
        def budget(self) -> Budget: ...

        def is_done(self, state: State) -> bool: ...

        async def evaluate(self, trajectory: Trajectory) -> EvalResult: ...


try:
    from loopengine.execution.sandbox import Sandbox, LocalSandbox
except ImportError:
    pass  # Sandbox is optional for run_loop


# ---------------------------------------------------------------------------
# ModelProvider — the Protocol for language model backends
# ---------------------------------------------------------------------------


@runtime_checkable
class ModelProvider(Protocol):
    """Protocol defining the interface to a language model.

    Plain English: A ModelProvider is like a phone call to a smart friend.
    You give them the conversation so far (messages) and a list of things
    they can do (tools), and they tell you what they'd say or do next.

    Implementations could wrap OpenAI, Anthropic, local models, or even
    a human in the loop. The RunLoop doesn't care — it just calls
    complete() and gets a Message back.

    Methods:
        complete: Generate the next assistant message given conversation history.
        count_tokens: Estimate how many tokens a list of messages would use.
    """

    async def complete(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
    ) -> Message:
        """Generate the next assistant response.

        Args:
            messages: The conversation history (what the model sees).
            tools: Optional list of tool schemas in OpenAI format.

        Returns:
            A Message (role=assistant) with the model's response.
            If the model wants to call tools, they appear in tool_calls.
        """
        ...

    def count_tokens(self, messages: list[Message]) -> int:
        """Estimate the token count for a list of messages.

        This is used for budget tracking — we need to know how many
        tokens each step consumed to enforce the budget limit.

        Args:
            messages: The messages to count tokens for.

        Returns:
            Estimated number of tokens.
        """
        ...


# ---------------------------------------------------------------------------
# RunResult — the immutable outcome of a single run
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RunResult:
    """The outcome of a single agent run — immutable and complete.

    Plain English: After the agent finishes a task (or runs out of budget),
    a RunResult captures everything that happened:
    - trajectory: The full step-by-step record of what the agent did
    - eval_result: How well the agent scored (if evaluated)
    - total_steps: How many steps the agent took
    - total_tokens: How many tokens were consumed
    - exit_reason: WHY the run ended (end_turn, max_steps, budget, done)

    Frozen means it can never be changed after creation — the run's outcome
    is carved in stone, like a final exam score.

    Attributes:
        trajectory: The full execution trajectory (every step recorded).
        eval_result: The evaluation outcome (score, pass/fail, reason).
        total_steps: Number of steps the agent took.
        total_tokens: Total tokens consumed across all model calls.
        exit_reason: Why the run ended. One of:
            - "end_turn": Model responded without tool calls (natural end).
            - "max_steps": Hit the step limit.
            - "budget": Token or cost budget exhausted.
            - "done": Task's is_done() returned True.
    """

    trajectory: Trajectory = field(default_factory=Trajectory)
    eval_result: EvalResult | None = None
    total_steps: int = 0
    total_tokens: int = 0
    exit_reason: str = "end_turn"


# ---------------------------------------------------------------------------
# run_loop — the main execution loop
# ---------------------------------------------------------------------------


async def run_loop(
    task: Task,
    model: ModelProvider,
    config: Any = None,
    sandbox: Any = None,
    run_id: str | None = None,
) -> RunResult:
    """Execute the main agent loop — the heart of LoopEngine.

    Plain English: This is the "game loop" that drives the agent. It goes
    step by step, asking the AI what to do, executing tools, and checking
    if we're done. Think of it like a very methodical assistant:
    1. Read the task (set up initial state)
    2. For each step:
       a. Prepare context (step_start processors)
       b. Final adjustments (before_model processors)
       c. Ask the AI (call model.complete)
       d. Process the answer (after_model processors)
       e. Run any tools the AI requested
       f. Record what happened (step_end processors)
       g. Check if done
    3. Evaluate the full run (task_end processors)

    The loop is driven by processors — the same loop with different
    processors produces completely different agent behavior.

    Args:
        task: The task to execute (defines prompt, limits, evaluation).
        model: The language model provider to call.
        config: Optional HarnessConfig with processors and tools.
        sandbox: Optional sandboxed execution environment.
        run_id: Optional unique identifier for this run (auto-generated if None).

    Returns:
        A RunResult with the trajectory, evaluation, and run statistics.
    """
    if run_id is None:
        run_id = f"run_{uuid.uuid4().hex[:12]}"

    # Extract processors and tools from config
    processor_entries: list[Any] = []
    tools: list[Any] = []
    if config is not None:
        processor_entries = getattr(config, "processors", [])
        tools = getattr(config, "tools", [])

    # Build processor chains for each hook point
    # Sort by order so lower-order processors run first
    hook_chains: dict[str, ProcessorChain] = {}
    for hook in HOOK_POINTS:
        hook_procs = sorted(
            [pe for pe in processor_entries if pe.hook == hook],
            key=lambda pe: pe.order,
        )
        hook_chains[hook] = ProcessorChain([pe.processor for pe in hook_procs])

    # Initialize state from the task
    state = State(
        budget=task.budget,
    )

    # Build tool schemas for the model (OpenAI format)
    tool_schemas = [
        ToolSchema(name=t.name, description=t.description, input_schema=t.input_schema).to_openai_dict()
        for t in tools
    ] if tools else None

    # Build a tool name → tool mapping for dispatch
    tool_map: dict[str, Any] = {t.name: t for t in tools}

    # Initialize trajectory
    trajectory = Trajectory(task_id=run_id)

    # Add the initial user message with the task prompt
    initial_msg = Message(
        type="message",
        run_id=run_id,
        step_id=0,
        role="user",
        content=task.prompt,
    )
    state.add_message(initial_msg)

    # Emit task_start event
    task_start_event = Event(type="task_start", run_id=run_id, step_id=0)
    await _emit_event(task_start_event, hook_chains, state)

    exit_reason = "end_turn"
    total_tokens = 0

    # ---- Main loop ----
    for step in range(task.max_steps):
        state.step = step

        # Remember how many messages existed before this step so we can count
        # only the NEW messages it produces. Counting the whole conversation
        # every step would accumulate tokens quadratically (bug C1).
        messages_before_step = len(state.messages)

        # 1. step_start — assemble context
        step_start_event = Event(type="step_start", run_id=run_id, step_id=step)
        await _emit_event(step_start_event, hook_chains, state)

        # Take a snapshot for the trajectory step
        snapshot_before = state.snapshot()

        # 2. before_model — final adjustments before calling AI
        before_model_event = Event(type="before_model", run_id=run_id, step_id=step)
        await _emit_event(before_model_event, hook_chains, state)

        # 3. Call the model
        assistant_msg = await model.complete(
            messages=list(state.messages),
            tools=tool_schemas,
        )

        # Record the assistant message
        state.add_message(assistant_msg)

        # 4. after_model — processors review the response
        after_model_event = Event(type="after_model", run_id=run_id, step_id=step)
        await _emit_event(after_model_event, hook_chains, state)

        # Collect observations (tool results) for the trajectory step
        observations: list[Event] = []

        # 5. Execute tool calls (if any)
        if assistant_msg.tool_calls:
            for tool_call in assistant_msg.tool_calls:
                # before_tool
                before_tool_event = Event(
                    type="before_tool", run_id=run_id, step_id=step,
                )
                await _emit_event(before_tool_event, hook_chains, state)

                # Execute the tool
                tool_result = await _execute_tool(
                    tool_call, tool_map, state, sandbox, run_id, step,
                )
                observations.append(tool_result)

                # Record tool result as a message the model can see
                tool_result_msg = Message(
                    type="message",
                    run_id=run_id,
                    step_id=step,
                    role="tool",
                    content=tool_result.output if not tool_result.is_error else tool_result.error,
                )
                state.add_message(tool_result_msg)

                # after_tool
                after_tool_event = Event(
                    type="after_tool", run_id=run_id, step_id=step,
                )
                await _emit_event(after_tool_event, hook_chains, state)
        else:
            # No tool calls → natural end of turn
            exit_reason = "end_turn"

        # Track token usage for THIS step only — count the messages added
        # since the step began (assistant message + any tool results), not the
        # entire growing conversation. This keeps accounting linear (bug C1).
        new_messages = state.messages[messages_before_step:]
        step_tokens = model.count_tokens(new_messages)
        total_tokens += step_tokens
        state.record_usage(tokens=step_tokens)

        # 6. step_end — record observations
        step_end_event = Event(type="step_end", run_id=run_id, step_id=step)
        await _emit_event(step_end_event, hook_chains, state)

        # Record the trajectory step
        delta = state.compute_delta(snapshot_before)
        traj_step = TrajectoryStep(
            state_before=snapshot_before,
            action=assistant_msg,
            observations=tuple(observations),
            reward=0.0,
            delta=delta,
            metadata={"step": step, "run_id": run_id},
        )
        trajectory.add_step(traj_step)

        # 7. Check termination conditions
        if not assistant_msg.tool_calls:
            exit_reason = "end_turn"
            break

        if task.is_done(state):
            exit_reason = "done"
            break

        if state.is_budget_exhausted:
            exit_reason = "budget"
            break

    else:
        # Loop completed without break → hit max_steps
        exit_reason = "max_steps"

    # 8. task_end — evaluate and wrap up
    task_end_event = Event(type="task_end", run_id=run_id, step_id=state.step)
    await _emit_event(task_end_event, hook_chains, state)

    # Evaluate the task (if the task has an evaluate method)
    eval_result: EvalResult | None = None
    if hasattr(task, "evaluate"):
        eval_result = await task.evaluate(trajectory)

    return RunResult(
        trajectory=trajectory,
        eval_result=eval_result,
        total_steps=len(trajectory),
        total_tokens=total_tokens,
        exit_reason=exit_reason,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _emit_event(
    event: Event,
    hook_chains: dict[str, ProcessorChain],
    state: State,
) -> list[Event]:
    """Emit an event through the appropriate hook chain.

    This is the "routing" logic — each event type maps to a specific
    hook point, and the event is processed through that hook's chain.

    Args:
        event: The event to emit.
        hook_chains: Mapping from hook point name to ProcessorChain.
        state: The current agent state (processors may modify it).

    Returns:
        The list of output events after processing.
    """
    chain = hook_chains.get(event.type)
    if chain is None:
        return [event]
    return [out async for out in chain.process(event)]


async def _execute_tool(
    tool_call: ToolCall,
    tool_map: dict[str, Any],
    state: State,
    sandbox: Any,
    run_id: str,
    step: int,
) -> ToolResult:
    """Execute a single tool call and return the result.

    Plain English: This is the "work order fulfillment" step.
    The assistant submitted a work order (ToolCall), and this function
    finds the right worker (tool), gives them the order, and collects
    the result.

    Args:
        tool_call: The tool call to execute.
        tool_map: Mapping from tool name to tool instance.
        state: The current agent state.
        sandbox: Optional sandbox for execution.
        run_id: The current run identifier.
        step: The current step number.

    Returns:
        A ToolResult with the tool's output or an error message.
    """
    from loopengine.primitives.tools import ToolContext

    tool = tool_map.get(tool_call.name)
    if tool is None:
        return ToolResult(
            run_id=run_id,
            step_id=step,
            call_id=tool_call.id,
            output="",
            error=f"Tool not found: {tool_call.name}",
        )

    ctx = ToolContext(
        run_id=run_id,
        step_id=step,
        state=state,
        sandbox=sandbox,
    )

    try:
        result = await tool.execute(tool_call.input, ctx)
        return result
    except Exception as exc:
        return ToolResult(
            run_id=run_id,
            step_id=step,
            call_id=tool_call.id,
            output="",
            error=f"Tool execution error: {exc}",
        )
