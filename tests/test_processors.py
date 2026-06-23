"""Tests for the processors module.

TDD approach: Write ONE test → implement → verify pass → repeat.
BDD style: Each test has a Given/When/Then docstring.
"""

from __future__ import annotations

import pytest
from typing import AsyncIterator, List

from loopengine.primitives.events import Event, Message, ToolCall, ToolResult, EvalResult
from loopengine.primitives.processors import (
    HOOK_POINTS,
    Processor,
    MultiHookProcessor,
    ProcessorChain,
    pipe,
    pipe_all,
)


# ---------------------------------------------------------------------------
# Test 1: HOOK_POINTS constant exists and has all 8 hook points
# ---------------------------------------------------------------------------


def test_hook_points_defined():
    """Given the processors module,
    When I access HOOK_POINTS,
    Then it should be a list of exactly 8 hook point names."""
    assert isinstance(HOOK_POINTS, list)
    assert len(HOOK_POINTS) == 8

    expected_hooks = {
        "task_start",
        "step_start",
        "before_model",
        "after_model",
        "before_tool",
        "after_tool",
        "step_end",
        "task_end",
    }
    assert set(HOOK_POINTS) == expected_hooks


# ---------------------------------------------------------------------------
# Test 2: Processor protocol — any class with name + process satisfies it
# ---------------------------------------------------------------------------


def test_processor_protocol_compliance():
    """Given a class with a name property and async process() method,
    When I check isinstance against Processor,
    Then it should satisfy the Protocol."""

    class SimpleProcessor:
        """A minimal processor that just passes events through."""

        @property
        def name(self) -> str:
            return "simple"

        async def process(self, event: Event) -> AsyncIterator[Event]:
            yield event

    assert isinstance(SimpleProcessor(), Processor)


# ---------------------------------------------------------------------------
# Test 3: MultiHookProcessor — creation and name property
# ---------------------------------------------------------------------------


def test_multi_hook_processor_name():
    """Given a MultiHookProcessor with a name,
    When I access the name property,
    Then it should return the name I provided."""
    proc = MultiHookProcessor("my_processor")
    assert proc.name == "my_processor"


# ---------------------------------------------------------------------------
# Test 4: MultiHookProcessor dispatch — default pass-through behavior
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_multi_hook_dispatch_pass_through(run_id: str):
    """Given a MultiHookProcessor with default hooks (all pass-through),
    When I dispatch an event to any hook,
    Then the same event should come out unchanged."""
    proc = MultiHookProcessor("pass_through")
    event = Message(
        type="message", run_id=run_id, step_id=0,
        role="user", content="hello"
    )

    # Default hooks should pass the event through unchanged
    results = [e async for e in proc.dispatch(event, "task_start")]
    assert len(results) == 1
    assert results[0] is event


# ---------------------------------------------------------------------------
# Test 5: MultiHookProcessor with custom hook — modification
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_multi_hook_custom_modification(run_id: str):
    """Given a MultiHookProcessor that overrides on_after_model to add metadata,
    When I dispatch an event through that hook,
    Then the output event should have the added metadata."""

    class MetadataAdder(MultiHookProcessor):
        """Adds a 'processed' flag to events after model responds."""

        async def on_after_model(self, event: Event) -> AsyncIterator[Event]:
            # We can't mutate frozen dataclasses, so we create a new one
            if isinstance(event, Message):
                new_meta = {**event.metadata, "processed": True}
                yield Message(
                    type=event.type,
                    run_id=event.run_id,
                    step_id=event.step_id,
                    ts=event.ts,
                    role=event.role,
                    content=event.content,
                    tool_calls=event.tool_calls,
                    metadata=new_meta,
                )
            else:
                yield event

    proc = MetadataAdder("metadata_adder")
    event = Message(
        type="message", run_id=run_id, step_id=0,
        role="assistant", content="I think the answer is 42."
    )

    results = [e async for e in proc.dispatch(event, "after_model")]
    assert len(results) == 1
    assert results[0].metadata.get("processed") is True
    assert results[0].content == "I think the answer is 42."


# ---------------------------------------------------------------------------
# Test 6: MultiHookProcessor with custom hook — suppression (yield nothing)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_multi_hook_suppression(run_id: str):
    """Given a MultiHookProcessor that suppresses tool events,
    When I dispatch a tool event through that hook,
    Then no events should come out."""

    class ToolSuppressor(MultiHookProcessor):
        """Suppresses all events in the before_tool hook."""

        async def on_before_tool(self, event: Event) -> AsyncIterator[Event]:
            # Yield nothing — suppress the event
            return
            yield  # Make this an async generator (unreachable)

    proc = ToolSuppressor("tool_suppressor")
    event = Event(type="tool_call", run_id=run_id, step_id=0)

    results = [e async for e in proc.dispatch(event, "before_tool")]
    assert len(results) == 0


# ---------------------------------------------------------------------------
# Test 7: ProcessorChain — empty chain passes event through unchanged
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chain_empty_pass_through(run_id: str):
    """Given an empty ProcessorChain,
    When I process an event through it,
    Then the event should come out unchanged."""
    chain = ProcessorChain([])
    event = Event(type="test", run_id=run_id, step_id=0)

    results = [e async for e in chain.process(event)]
    assert len(results) == 1
    assert results[0] is event


# ---------------------------------------------------------------------------
# Test 8: ProcessorChain — single pass-through processor
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chain_single_pass_through(run_id: str):
    """Given a ProcessorChain with one pass-through processor,
    When I process an event through it,
    Then the event should come out unchanged."""

    class Passthrough:
        """A simple processor that passes events through unchanged."""

        @property
        def name(self) -> str:
            return "passthrough"

        async def process(self, event: Event) -> AsyncIterator[Event]:
            yield event

    chain = ProcessorChain([Passthrough()])
    event = Event(type="test", run_id=run_id, step_id=0)

    results = [e async for e in chain.process(event)]
    assert len(results) == 1
    assert results[0] is event


# ---------------------------------------------------------------------------
# Test 9: ProcessorChain — multiple processors in sequence (modification)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chain_multiple_modifiers(run_id: str):
    """Given a ProcessorChain with two processors that each add a step_id,
    When I process an event through the chain,
    Then both processors should have modified the event in order."""

    class StepAdder:
        """Adds 1 to the step_id of each event."""

        def __init__(self, name: str) -> None:
            self._name = name

        @property
        def name(self) -> str:
            return self._name

        async def process(self, event: Event) -> AsyncIterator[Event]:
            # Create new event with incremented step_id
            yield Event(
                type=event.type,
                run_id=event.run_id,
                step_id=event.step_id + 1,
                ts=event.ts,
            )

    chain = ProcessorChain([StepAdder("first"), StepAdder("second")])
    event = Event(type="test", run_id=run_id, step_id=0)

    results = [e async for e in chain.process(event)]
    assert len(results) == 1
    assert results[0].step_id == 2  # 0 + 1 + 1 = 2


# ---------------------------------------------------------------------------
# Test 10: ProcessorChain — suppression in the middle stops propagation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chain_suppression_stops_propagation(run_id: str):
    """Given a ProcessorChain with a suppressor between two pass-through processors,
    When I process an event through the chain,
    Then the event should be suppressed and never reach the last processor."""

    class Passthrough:
        """Passes events through unchanged."""

        def __init__(self, name: str) -> None:
            self._name = name

        @property
        def name(self) -> str:
            return self._name

        async def process(self, event: Event) -> AsyncIterator[Event]:
            yield event

    class Suppressor:
        """Suppresses all events."""

        @property
        def name(self) -> str:
            return "suppressor"

        async def process(self, event: Event) -> AsyncIterator[Event]:
            return
            yield  # Make this an async generator (unreachable)

    chain = ProcessorChain([
        Passthrough("first"),
        Suppressor(),
        Passthrough("third"),
    ])
    event = Event(type="test", run_id=run_id, step_id=0)

    results = [e async for e in chain.process(event)]
    assert len(results) == 0


# ---------------------------------------------------------------------------
# Test 11: ProcessorChain — injection (one event becomes multiple)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chain_injection(run_id: str):
    """Given a ProcessorChain with an injector that duplicates events,
    When I process one event through the chain,
    Then two events should come out."""

    class Duplicator:
        """Yields each event twice."""

        @property
        def name(self) -> str:
            return "duplicator"

        async def process(self, event: Event) -> AsyncIterator[Event]:
            yield event
            yield event

    chain = ProcessorChain([Duplicator()])
    event = Event(type="test", run_id=run_id, step_id=0)

    results = [e async for e in chain.process(event)]
    assert len(results) == 2
    assert results[0] is event
    assert results[1] is event


# ---------------------------------------------------------------------------
# Test 12: pipe() helper — runs one event through a list of processors
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pipe_helper(run_id: str):
    """Given a list of processors and an event,
    When I call pipe() with them,
    Then it should return a list of output events."""

    class Passthrough:
        """Passes events through unchanged."""

        @property
        def name(self) -> str:
            return "passthrough"

        async def process(self, event: Event) -> AsyncIterator[Event]:
            yield event

    event = Event(type="test", run_id=run_id, step_id=0)
    processors = [Passthrough(), Passthrough()]

    results = await pipe(event, processors)
    assert len(results) == 1
    assert results[0] is event


# ---------------------------------------------------------------------------
# Test 13: pipe_all() helper — runs multiple events through processors
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pipe_all_helper(run_id: str):
    """Given a list of processors and multiple events,
    When I call pipe_all() with them,
    Then it should return all output events in order."""

    class Passthrough:
        """Passes events through unchanged."""

        @property
        def name(self) -> str:
            return "passthrough"

        async def process(self, event: Event) -> AsyncIterator[Event]:
            yield event

    events = [
        Event(type="test", run_id=run_id, step_id=0),
        Event(type="test", run_id=run_id, step_id=1),
        Event(type="test", run_id=run_id, step_id=2),
    ]
    processors = [Passthrough()]

    results = await pipe_all(events, processors)
    assert len(results) == 3
    assert results[0].step_id == 0
    assert results[1].step_id == 1
    assert results[2].step_id == 2


# ---------------------------------------------------------------------------
# Test 14: ProcessorChain — name property
# ---------------------------------------------------------------------------


def test_chain_name():
    """Given a ProcessorChain with named processors,
    When I access the name property,
    Then it should include all processor names joined by arrows."""

    class Alpha:
        @property
        def name(self) -> str:
            return "alpha"

        async def process(self, event: Event) -> AsyncIterator[Event]:
            yield event

    class Beta:
        @property
        def name(self) -> str:
            return "beta"

        async def process(self, event: Event) -> AsyncIterator[Event]:
            yield event

    chain = ProcessorChain([Alpha(), Beta()])
    assert "alpha" in chain.name
    assert "beta" in chain.name


# ---------------------------------------------------------------------------
# Test 15: MultiHookProcessor — invalid hook_point raises ValueError
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_invalid_hook_point(run_id: str):
    """Given a MultiHookProcessor,
    When I dispatch an event to an invalid hook_point name,
    Then it should raise a ValueError."""
    proc = MultiHookProcessor("test")
    event = Event(type="test", run_id=run_id, step_id=0)

    with pytest.raises(ValueError, match="Unknown hook_point"):
        async for _ in proc.dispatch(event, "nonexistent_hook"):
            pass


# ---------------------------------------------------------------------------
# Test 16: ProcessorChain — injection then pass-through
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chain_injection_then_passthrough(run_id: str):
    """Given a chain with an injector (duplicates) followed by a pass-through,
    When I process one event,
    Then two events should survive the chain."""

    class Duplicator:
        """Yields each event twice."""

        @property
        def name(self) -> str:
            return "duplicator"

        async def process(self, event: Event) -> AsyncIterator[Event]:
            yield event
            yield event

    class Passthrough:
        """Passes events through unchanged."""

        @property
        def name(self) -> str:
            return "passthrough"

        async def process(self, event: Event) -> AsyncIterator[Event]:
            yield event

    chain = ProcessorChain([Duplicator(), Passthrough()])
    event = Event(type="test", run_id=run_id, step_id=0)

    results = [e async for e in chain.process(event)]
    assert len(results) == 2


# ---------------------------------------------------------------------------
# Test 17: pipe_all() with suppression — some events filtered out
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pipe_all_with_suppression(run_id: str):
    """Given a processor that suppresses events with step_id > 0,
    When I call pipe_all() with events [0, 1, 2],
    Then only event with step_id=0 should survive."""

    class StepFilter:
        """Suppresses events with step_id > 0."""

        @property
        def name(self) -> str:
            return "step_filter"

        async def process(self, event: Event) -> AsyncIterator[Event]:
            if event.step_id == 0:
                yield event
            # else: yield nothing (suppress)

    events = [
        Event(type="test", run_id=run_id, step_id=0),
        Event(type="test", run_id=run_id, step_id=1),
        Event(type="test", run_id=run_id, step_id=2),
    ]

    results = await pipe_all(events, [StepFilter()])
    assert len(results) == 1
    assert results[0].step_id == 0
