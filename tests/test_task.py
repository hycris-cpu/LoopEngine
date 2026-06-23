"""Tests for the Task module — defining WHAT the agent should accomplish.

TDD approach: Write ONE test → implement → verify pass → repeat (vertical slices)
BDD style: Each test has a Given/When/Then docstring.
DDD style: Tests verify domain behavior through public interfaces only.

A Task is like a homework assignment:
- prompt: The question or problem to solve
- max_steps: How many attempts you get
- budget: How many resources (tokens, money) you can spend
- is_done(): A way to check if you're finished
- evaluate(): A way to grade your work
"""

from __future__ import annotations

import pytest
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from loopengine.primitives import EvalResult, Message
from loopengine.primitives.state import Budget, State
from loopengine.primitives.trajectory import Trajectory, TrajectoryStep
from loopengine.execution.task import Task, SimpleTask, BatchTask


# ============================================================================
# Test 1: Task Protocol — the interface contract
# ============================================================================

class TestTaskProtocol:
    """Tests for the Task Protocol definition."""

    def test_task_protocol_exists(self):
        """Given the task module, When imported, Then Task protocol is available."""
        assert Task is not None

    def test_simple_task_satisfies_protocol(self):
        """Given a SimpleTask instance, When checked against Task protocol,
        Then it satisfies the protocol."""
        task = SimpleTask(prompt="Hello")
        assert isinstance(task, Task)


# ============================================================================
# Test 2: SimpleTask — creation and defaults
# ============================================================================

class TestSimpleTaskCreation:
    """Tests for creating SimpleTask instances."""

    def test_simple_task_creation_with_defaults(self):
        """Given just a prompt, When I create a SimpleTask,
        Then it has sensible defaults for max_steps and budget."""
        task = SimpleTask(prompt="Solve this problem")
        assert task.prompt == "Solve this problem"
        assert task.max_steps == 50
        assert isinstance(task.budget, Budget)

    def test_simple_task_creation_with_custom_values(self):
        """Given custom values, When I create a SimpleTask,
        Then it stores them correctly."""
        budget = Budget(max_tokens=4096, max_cost_usd=1.0, max_steps=10)
        task = SimpleTask(
            prompt="Custom task",
            max_steps=10,
            budget=budget,
        )
        assert task.prompt == "Custom task"
        assert task.max_steps == 10
        assert task.budget.max_tokens == 4096
        assert task.budget.max_cost_usd == 1.0

    def test_simple_task_prompt_is_required(self):
        """Given no prompt, When I try to create a SimpleTask,
        Then it should work with an empty string default."""
        # Prompt has a default to keep construction simple
        task = SimpleTask()
        assert task.prompt == ""

    def test_simple_task_has_default_budget(self):
        """Given a SimpleTask, When I access budget,
        Then it's a Budget with sensible defaults."""
        task = SimpleTask(prompt="test")
        assert task.budget.max_tokens == 128_000
        assert task.budget.max_cost_usd == 10.0


# ============================================================================
# Test 3: SimpleTask.is_done — checking completion
# ============================================================================

class TestSimpleTaskIsDone:
    """Tests for SimpleTask.is_done — determining when a task is complete."""

    def test_is_done_default_returns_false(self):
        """Given a SimpleTask with no done_condition, When I check is_done,
        Then it always returns False (never done)."""
        task = SimpleTask(prompt="infinite task")
        state = State()
        assert task.is_done(state) is False

    def test_is_done_default_never_done_even_with_messages(self):
        """Given a SimpleTask with no done_condition, When I add messages and check,
        Then it still returns False."""
        task = SimpleTask(prompt="task")
        state = State()
        state.add_message(Message(role="assistant", content="working on it..."))
        assert task.is_done(state) is False

    def test_is_done_with_custom_condition(self):
        """Given a SimpleTask with a custom done_condition, When I check is_done,
        Then it delegates to the condition function."""
        # Done when the state has a "done" slot set to True
        def check_done(state: State) -> bool:
            done_slot = state.get_slot("done")
            return done_slot is not None and done_slot.value is True

        task = SimpleTask(prompt="task", done_condition=check_done)
        state = State()

        # Not done initially
        assert task.is_done(state) is False

        # Set the done slot
        state.set_slot("done", True)
        assert task.is_done(state) is True

    def test_is_done_with_content_condition(self):
        """Given a SimpleTask with content-based condition, When the assistant
        writes 'DONE', Then is_done returns True."""
        def check_done(state: State) -> bool:
            for msg in state.messages:
                if msg.role == "assistant" and "DONE" in msg.content:
                    return True
            return False

        task = SimpleTask(prompt="task", done_condition=check_done)
        state = State()

        state.add_message(Message(role="assistant", content="Still working..."))
        assert task.is_done(state) is False

        state.add_message(Message(role="assistant", content="DONE"))
        assert task.is_done(state) is True


# ============================================================================
# Test 4: SimpleTask.evaluate — grading the work
# ============================================================================

class TestSimpleTaskEvaluate:
    """Tests for SimpleTask.evaluate — grading the agent's work."""

    @pytest.mark.asyncio
    async def test_evaluate_default_returns_zero(self):
        """Given a SimpleTask with no eval_fn, When I evaluate,
        Then it returns an EvalResult with score 0.0."""
        task = SimpleTask(prompt="task")
        trajectory = Trajectory()
        result = await task.evaluate(trajectory)
        assert isinstance(result, EvalResult)
        assert result.score == 0.0
        assert result.passed is False

    @pytest.mark.asyncio
    async def test_evaluate_with_custom_function(self):
        """Given a SimpleTask with a custom eval_fn, When I evaluate,
        Then it delegates to the eval function."""
        async def my_eval(trajectory: Trajectory, task: Task) -> EvalResult:
            return EvalResult(passed=True, score=0.95, reason="Great work!")

        task = SimpleTask(prompt="task", eval_fn=my_eval)
        trajectory = Trajectory()
        result = await task.evaluate(trajectory)

        assert result.passed is True
        assert result.score == 0.95
        assert result.reason == "Great work!"

    @pytest.mark.asyncio
    async def test_evaluate_with_trajectory_steps(self):
        """Given a SimpleTask with step-counting eval, When I evaluate
        a trajectory with steps, Then eval_fn receives the trajectory."""
        async def count_steps_eval(trajectory: Trajectory, task: Task) -> EvalResult:
            steps = len(trajectory)
            score = 1.0 if steps > 0 else 0.0
            return EvalResult(passed=score > 0, score=score, reason=f"{steps} steps")

        task = SimpleTask(prompt="task", eval_fn=count_steps_eval)

        # Empty trajectory
        empty_traj = Trajectory()
        result = await task.evaluate(empty_traj)
        assert result.score == 0.0

        # Trajectory with a step
        traj_with_step = Trajectory()
        traj_with_step.add_step(TrajectoryStep(
            action=Message(role="assistant", content="I did it"),
        ))
        result = await task.evaluate(traj_with_step)
        assert result.score == 1.0
        assert result.reason == "1 steps"


# ============================================================================
# Test 5: BatchTask — running multiple tasks
# ============================================================================

class TestBatchTask:
    """Tests for BatchTask — wrapping multiple tasks for benchmark runs."""

    def test_batch_task_creation(self):
        """Given a list of tasks, When I create a BatchTask,
        Then it stores them all."""
        tasks = [
            SimpleTask(prompt="task 1"),
            SimpleTask(prompt="task 2"),
            SimpleTask(prompt="task 3"),
        ]
        batch = BatchTask(tasks=tasks)
        assert len(batch.tasks) == 3

    def test_batch_task_is_iterable(self):
        """Given a BatchTask, When I iterate over it,
        Then I get each task in order."""
        tasks = [
            SimpleTask(prompt="first"),
            SimpleTask(prompt="second"),
        ]
        batch = BatchTask(tasks=tasks)
        items = list(batch)
        assert items[0].prompt == "first"
        assert items[1].prompt == "second"

    def test_batch_task_has_length(self):
        """Given a BatchTask with N tasks, When I check len(),
        Then it returns N."""
        tasks = [SimpleTask(prompt=f"task {i}") for i in range(5)]
        batch = BatchTask(tasks=tasks)
        assert len(batch) == 5

    def test_batch_task_getitem(self):
        """Given a BatchTask, When I access by index,
        Then I get the correct task."""
        tasks = [
            SimpleTask(prompt="a"),
            SimpleTask(prompt="b"),
            SimpleTask(prompt="c"),
        ]
        batch = BatchTask(tasks=tasks)
        assert batch[0].prompt == "a"
        assert batch[2].prompt == "c"

    def test_batch_task_empty(self):
        """Given an empty list, When I create a BatchTask,
        Then it has length 0 and is iterable."""
        batch = BatchTask(tasks=[])
        assert len(batch) == 0
        assert list(batch) == []

    def test_batch_task_is_task(self):
        """Given a BatchTask, When checked against Task protocol,
        Then it satisfies it (delegates to first task)."""
        tasks = [SimpleTask(prompt="test")]
        batch = BatchTask(tasks=tasks)
        # BatchTask itself is not a Task — it's a container
        # But it provides prompt, max_steps, budget by delegating
        assert batch.prompt == "test"
        assert batch.max_steps == 50


# ============================================================================
# Test 6: SimpleTask — edge cases and integration
# ============================================================================

class TestSimpleTaskEdgeCases:
    """Edge case tests for SimpleTask."""

    def test_simple_task_with_max_steps_zero(self):
        """Given a SimpleTask with max_steps=0, When I check max_steps,
        Then it's 0 (immediate termination)."""
        task = SimpleTask(prompt="instant", max_steps=0)
        assert task.max_steps == 0

    def test_simple_task_custom_budget(self):
        """Given a SimpleTask with a custom budget, When I access budget,
        Then the budget values match."""
        budget = Budget(max_tokens=1000, max_cost_usd=0.01, max_steps=3)
        task = SimpleTask(prompt="cheap task", budget=budget)
        assert task.budget.max_tokens == 1000
        assert task.budget.max_cost_usd == 0.01
        assert task.budget.max_steps == 3

    @pytest.mark.asyncio
    async def test_simple_task_evaluate_passes_task_to_eval_fn(self):
        """Given a SimpleTask with eval_fn, When I evaluate,
        Then eval_fn receives the task itself as second arg."""
        captured_task = None

        async def my_eval(trajectory: Trajectory, task: Task) -> EvalResult:
            nonlocal captured_task
            captured_task = task
            return EvalResult(passed=True, score=1.0)

        task = SimpleTask(prompt="test prompt", eval_fn=my_eval)
        await task.evaluate(Trajectory())
        assert captured_task is task
        assert captured_task.prompt == "test prompt"
