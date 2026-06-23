"""Tests for the harness module — the top-level agent API.

TDD approach: Write ONE test → implement → verify pass → repeat.
BDD style: Each test has a Given/When/Then docstring.

The Harness is the user-facing class that ties together:
- A model (the language model provider)
- A config (the blueprint with processors and tools)
- A sandbox (optional execution environment)

Users create a Harness, then call run(task) or run_batch(tasks).
"""

from __future__ import annotations

import pytest
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock

from loopengine.primitives.events import Event, Message, EvalResult
from loopengine.primitives.processors import MultiHookProcessor
from loopengine.primitives.state import Budget, State
from loopengine.primitives.trajectory import Trajectory
from loopengine.composition.config import HarnessConfig
from loopengine.composition.builder import HarnessBuilder
from loopengine.execution.runloop import RunResult, ModelProvider, run_loop
from loopengine.execution.harness import Harness


# ---------------------------------------------------------------------------
# Helpers: Shared mock classes for harness tests
# ---------------------------------------------------------------------------


class _MockTask:
    """A simple mock task for testing the Harness."""

    def __init__(
        self,
        prompt: str = "test",
        max_steps: int = 10,
        budget: Budget | None = None,
        eval_fn: Any = None,
    ) -> None:
        self.prompt = prompt
        self.max_steps = max_steps
        self.budget = budget or Budget(max_steps=max_steps)
        self._eval_fn = eval_fn

    def is_done(self, state: State) -> bool:
        return False

    async def evaluate(self, trajectory: Trajectory) -> EvalResult:
        if self._eval_fn is not None:
            return self._eval_fn(trajectory)
        return EvalResult(passed=True, score=1.0, reason="default pass")


class _SimpleModel:
    """A mock model that returns a fixed response."""

    def __init__(self, content: str = "done", tokens: int = 50) -> None:
        self._content = content
        self._tokens = tokens
        self.call_count = 0

    async def complete(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
    ) -> Message:
        self.call_count += 1
        return Message(role="assistant", content=self._content)

    def count_tokens(self, messages: list[Message]) -> int:
        return self._tokens


# ---------------------------------------------------------------------------
# Test 1: Harness creation — basic constructor
# ---------------------------------------------------------------------------


def test_harness_creation():
    """Given a model and a config,
    When I create a Harness,
    Then it should store the model, config, and have no sandbox."""
    model = _SimpleModel()
    config = HarnessConfig()

    harness = Harness(model=model, config=config)

    assert harness.model is model
    assert harness.config is config
    assert harness.sandbox is None


# ---------------------------------------------------------------------------
# Test 2: Harness creation — with sandbox
# ---------------------------------------------------------------------------


def test_harness_creation_with_sandbox():
    """Given a model, config, and sandbox,
    When I create a Harness,
    Then it should store all three."""
    model = _SimpleModel()
    config = HarnessConfig()
    sandbox = MagicMock()

    harness = Harness(model=model, config=config, sandbox=sandbox)

    assert harness.sandbox is sandbox


# ---------------------------------------------------------------------------
# Test 3: Harness.from_builder — convenience classmethod
# ---------------------------------------------------------------------------


def test_harness_from_builder():
    """Given a HarnessBuilder with a processor and flag,
    When I call Harness.from_builder(),
    Then it should create a Harness with a built config."""
    model = _SimpleModel()

    class DummyProcessor(MultiHookProcessor):
        def __init__(self):
            super().__init__("dummy")

    builder = (
        HarnessBuilder()
        .add(DummyProcessor(), hook="step_end")
        .flag("test_flag", enabled=True)
        .slot(working_dir="/tmp")
    )

    harness = Harness.from_builder(builder, model=model)

    assert isinstance(harness, Harness)
    assert harness.model is model
    assert harness.config is not None
    assert len(harness.config.processors) == 1
    assert harness.config.flags.get("test_flag") is True
    assert harness.config.slots.get("working_dir") == "/tmp"


# ---------------------------------------------------------------------------
# Test 4: Harness.from_builder — with sandbox
# ---------------------------------------------------------------------------


def test_harness_from_builder_with_sandbox():
    """Given a builder, model, and sandbox,
    When I call Harness.from_builder(),
    Then the harness should have the sandbox set."""
    model = _SimpleModel()
    builder = HarnessBuilder()
    sandbox = MagicMock()

    harness = Harness.from_builder(builder, model=model, sandbox=sandbox)

    assert harness.sandbox is sandbox


# ---------------------------------------------------------------------------
# Test 5: Harness.run — delegates to run_loop
# ---------------------------------------------------------------------------


async def test_harness_run_delegates_to_run_loop():
    """Given a Harness with a model and config,
    When I call harness.run(task),
    Then it should execute the task and return a RunResult."""
    model = _SimpleModel(content="The answer is 42.")
    config = HarnessConfig()
    harness = Harness(model=model, config=config)
    task = _MockTask(prompt="What is 2+2?")

    result = await harness.run(task)

    assert isinstance(result, RunResult)
    assert result.total_steps == 1
    assert result.exit_reason == "end_turn"
    assert result.trajectory[0].action.content == "The answer is 42."


# ---------------------------------------------------------------------------
# Test 6: Harness.run — passes run_id through
# ---------------------------------------------------------------------------


async def test_harness_run_with_run_id():
    """Given a Harness,
    When I call harness.run(task, run_id='my_run'),
    Then the result trajectory should reflect that run_id."""
    model = _SimpleModel()
    config = HarnessConfig()
    harness = Harness(model=model, config=config)
    task = _MockTask(prompt="test")

    result = await harness.run(task, run_id="my_run")

    assert isinstance(result, RunResult)
    # The trajectory step's metadata should contain the run_id
    assert result.trajectory[0].metadata.get("run_id") == "my_run"


# ---------------------------------------------------------------------------
# Test 7: Harness.run_batch — sequential (parallelism=1)
# ---------------------------------------------------------------------------


async def test_harness_run_batch_sequential():
    """Given a Harness and 3 tasks,
    When I call harness.run_batch(tasks, parallelism=1),
    Then it should return 3 RunResults in order."""
    model = _SimpleModel(content="done")
    config = HarnessConfig()
    harness = Harness(model=model, config=config)

    tasks = [
        _MockTask(prompt=f"task {i}") for i in range(3)
    ]

    results = await harness.run_batch(tasks, parallelism=1)

    assert len(results) == 3
    for i, result in enumerate(results):
        assert isinstance(result, RunResult)
        assert result.total_steps == 1


# ---------------------------------------------------------------------------
# Test 8: Harness.run_batch — parallel (parallelism > 1)
# ---------------------------------------------------------------------------


async def test_harness_run_batch_parallel():
    """Given a Harness and 4 tasks,
    When I call harness.run_batch(tasks, parallelism=2),
    Then it should return 4 RunResults (order preserved)."""
    model = _SimpleModel(content="parallel result")
    config = HarnessConfig()
    harness = Harness(model=model, config=config)

    tasks = [
        _MockTask(prompt=f"task {i}") for i in range(4)
    ]

    results = await harness.run_batch(tasks, parallelism=2)

    assert len(results) == 4
    for result in results:
        assert isinstance(result, RunResult)
        assert result.exit_reason == "end_turn"


# ---------------------------------------------------------------------------
# Test 9: Harness.run_batch — empty tasks list
# ---------------------------------------------------------------------------


async def test_harness_run_batch_empty():
    """Given a Harness,
    When I call harness.run_batch([]),
    Then it should return an empty list."""
    model = _SimpleModel()
    harness = Harness(model=model)

    results = await harness.run_batch([])

    assert results == []


# ---------------------------------------------------------------------------
# Test 10: Harness repr
# ---------------------------------------------------------------------------


def test_harness_repr():
    """Given a Harness,
    When I call repr(),
    Then it should show model name, config presence, and sandbox presence."""
    model = _SimpleModel()
    config = HarnessConfig()
    harness = Harness(model=model, config=config)

    r = repr(harness)
    assert "_SimpleModel" in r
    assert "config=yes" in r
    assert "sandbox=no" in r

    # With sandbox
    harness2 = Harness(model=model, config=config, sandbox=MagicMock())
    r2 = repr(harness2)
    assert "sandbox=yes" in r2
