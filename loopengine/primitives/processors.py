"""The Processors module defines the "behavioral building blocks" of the framework.

Plain English: A Processor is like a security checkpoint at an airport.
Events (passengers) flow through processors (checkpoints), and each processor
can:
- Let the event pass through unchanged (pass-through)
- Modify the event (like adding a stamp to a passport)
- Suppress the event (deny entry)
- Inject new events (create additional passengers)

There are 8 "checkpoint locations" (hook points):
1. task_start — when a new task begins
2. step_start — at the beginning of each step
3. before_model — right before we ask the AI for a response
4. after_model — right after the AI responds
5. before_tool — right before we run a tool
6. after_tool — right after a tool finishes
7. step_end — at the end of each step (read-only observation)
8. task_end — when the task is done

MultiHookProcessor is a convenience base class — you override only the hooks you care about.
ProcessorChain is a pipeline that runs multiple processors in order.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Protocol, runtime_checkable

from loopengine.primitives.events import (
    Event,
    EvalResult,
    Message,
    ToolCall,
    ToolResult,
)

# ---------------------------------------------------------------------------
# HOOK_POINTS — the 8 places where processors can intervene
# ---------------------------------------------------------------------------

HOOK_POINTS: list[str] = [
    "task_start",
    "step_start",
    "before_model",
    "after_model",
    "before_tool",
    "after_tool",
    "step_end",
    "task_end",
]
"""The 8 hook points where processors can intercept events.

Think of these as the 8 security checkpoints in an airport:
1. task_start:    The entrance door (new passenger arriving)
2. step_start:    Entering the terminal (start of a new step)
3. before_model:  Before the flight (about to ask the AI)
4. after_model:   After the flight (AI just responded)
5. before_tool:   Before baggage claim (about to run a tool)
6. after_tool:    After baggage claim (tool just finished)
7. step_end:      Leaving the terminal (step complete, observation only)
8. task_end:      Exiting the airport (task complete)
"""


# ---------------------------------------------------------------------------
# Event-to-hook mapping
# ---------------------------------------------------------------------------

def event_to_hook(event: Event) -> str | None:
    """Map an event type to the corresponding hook point name.

    This is the "routing" logic that determines which hook an event triggers.
    Returns None if the event type doesn't map to any hook.
    """
    mapping: dict[str, str] = {
        "task_start": "task_start",
        "step_start": "step_start",
        "before_model": "before_model",
        "after_model": "after_model",
        "before_tool": "before_tool",
        "after_tool": "after_tool",
        "step_end": "step_end",
        "task_end": "task_end",
    }
    return mapping.get(event.type)


# ---------------------------------------------------------------------------
# Processor — the core Protocol
# ---------------------------------------------------------------------------

@runtime_checkable
class Processor(Protocol):
    """Protocol defining what a processor must provide.

    A processor is any object with a name and an async process() method.
    The process method receives an event and yields zero or more events.
    - Yielding the same event = pass-through
    - Yielding a modified event = modification
    - Yielding nothing = suppression
    - Yielding additional events = injection
    """

    @property
    def name(self) -> str:
        """A human-readable name for this processor."""
        ...

    async def process(self, event: Event) -> AsyncIterator[Event]:
        """Process an event, yielding zero or more output events.

        Args:
            event: The event to process.

        Yields:
            Events to pass to the next processor (or the final consumer).
            Yield nothing to suppress the event.
            Yield multiple events to inject additional ones.
        """
        ...


# ---------------------------------------------------------------------------
# MultiHookProcessor — convenience base class
# ---------------------------------------------------------------------------

class MultiHookProcessor:
    """A base class that routes events to specific hook methods.

    Instead of implementing a single process() method that handles all event
    types, you override only the hook methods you care about. The default
    implementation of each hook is pass-through (yield the event unchanged).

    Think of this as a receptionist who reads each visitor's purpose and
    directs them to the right department. If no department handles that
    purpose, the visitor passes through unchanged.

    Subclasses override specific hooks:
        class MyProcessor(MultiHookProcessor):
            async def on_after_model(self, event: Event) -> AsyncIterator[Event]:
                # Do something special after the AI responds
                yield event  # pass through
    """

    def __init__(self, name: str = "multi_hook_processor") -> None:
        """Initialize with a name for this processor."""
        self._name = name

    @property
    def name(self) -> str:
        """This processor's name."""
        return self._name

    # ---- Hook methods (override these in subclasses) ----

    async def on_task_start(self, event: Event) -> AsyncIterator[Event]:
        """Called when a new task begins. Default: pass-through."""
        yield event

    async def on_step_start(self, event: Event) -> AsyncIterator[Event]:
        """Called at the start of each step. Default: pass-through."""
        yield event

    async def on_before_model(self, event: Event) -> AsyncIterator[Event]:
        """Called right before asking the AI. Default: pass-through."""
        yield event

    async def on_after_model(self, event: Event) -> AsyncIterator[Event]:
        """Called right after the AI responds. Default: pass-through."""
        yield event

    async def on_before_tool(self, event: Event) -> AsyncIterator[Event]:
        """Called right before running a tool. Default: pass-through."""
        yield event

    async def on_after_tool(self, event: Event) -> AsyncIterator[Event]:
        """Called right after a tool finishes. Default: pass-through."""
        yield event

    async def on_step_end(self, event: Event) -> AsyncIterator[Event]:
        """Called at the end of each step (read-only). Default: pass-through."""
        yield event

    async def on_task_end(self, event: Event) -> AsyncIterator[Event]:
        """Called when the task ends. Default: pass-through."""
        yield event

    # ---- Hook map (shared by dispatch and process) ----

    def _get_hook_map(self) -> dict[str, Any]:
        """Return the mapping from hook point names to hook methods.

        Returns:
            A dict mapping hook point name strings to async generator methods.
        """
        return {
            "task_start": self.on_task_start,
            "step_start": self.on_step_start,
            "before_model": self.on_before_model,
            "after_model": self.on_after_model,
            "before_tool": self.on_before_tool,
            "after_tool": self.on_after_tool,
            "step_end": self.on_step_end,
            "task_end": self.on_task_end,
        }

    # ---- Dispatch logic ----

    async def dispatch(self, event: Event, hook_point: str) -> AsyncIterator[Event]:
        """Route an event to a specific hook by name.

        Args:
            event: The event to process.
            hook_point: Which hook to call (must be one of HOOK_POINTS).

        Yields:
            Events from the hook method.

        Raises:
            ValueError: If hook_point is not a valid hook name.
        """
        hook_map = self._get_hook_map()
        if hook_point not in hook_map:
            raise ValueError(
                f"Unknown hook_point '{hook_point}'. Must be one of: {list(hook_map.keys())}"
            )
        async for out_event in hook_map[hook_point](event):
            yield out_event

    async def process(self, event: Event) -> AsyncIterator[Event]:
        """Route an event to the appropriate hook method based on event type.

        This is the main entry point for the Processor protocol. It determines
        which hook to call based on the event's type field, then delegates to
        that hook.

        If the event type doesn't map to any hook, it passes through unchanged.
        """
        hook_map = self._get_hook_map()
        hook_fn = hook_map.get(event.type)
        if hook_fn is not None:
            async for out_event in hook_fn(event):
                yield out_event
        else:
            # Unknown event type — pass through unchanged
            yield event


# ---------------------------------------------------------------------------
# ProcessorChain — a pipeline of processors
# ---------------------------------------------------------------------------

class ProcessorChain:
    """A pipeline that runs events through a sequence of processors.

    Think of this as an assembly line. Each processor is a station.
    Events enter at one end, pass through each station in order,
    and come out the other end (possibly modified, suppressed, or
    with additional events injected).

    The chain is ordered: the first processor gets the original event,
    and each subsequent processor gets the output of the previous one.

    Attributes:
        processors: The ordered list of processors in the chain.
    """

    def __init__(self, processors: list[Processor]) -> None:
        """Initialize the chain with an ordered list of processors.

        Args:
            processors: Processors to run, in order.
        """
        self.processors = list(processors)

    @property
    def name(self) -> str:
        """A descriptive name for this chain."""
        names = [p.name for p in self.processors]
        return f"ProcessorChain({' -> '.join(names)})"

    async def process(self, event: Event) -> AsyncIterator[Event]:
        """Run an event through the entire processor chain.

        Each processor's output becomes the input for the next processor.
        If a processor suppresses an event (yields nothing), the chain
        stops for that event — subsequent processors won't see it.

        Args:
            event: The event to process.

        Yields:
            The final output events after passing through all processors.
        """
        if not self.processors:
            yield event
            return

        # Start with the initial event
        current_events = [event]

        for processor in self.processors:
            next_events: list[Event] = []
            for evt in current_events:
                async for out_evt in processor.process(evt):
                    next_events.append(out_evt)
            current_events = next_events

        for evt in current_events:
            yield evt


# ---------------------------------------------------------------------------
# pipe / pipe_all — async helpers
# ---------------------------------------------------------------------------

async def pipe(event: Event, processors: list[Processor]) -> list[Event]:
    """Run a single event through a list of processors and collect the results.

    This is a convenience function that creates a temporary ProcessorChain
    and collects all output events into a list.

    Args:
        event: The event to process.
        processors: The processors to run it through, in order.

    Returns:
        A list of output events (may be empty if the event was suppressed).
    """
    chain = ProcessorChain(processors)
    return [out async for out in chain.process(event)]


async def pipe_all(events: list[Event], processors: list[Processor]) -> list[Event]:
    """Run multiple events through a list of processors.

    Each event is processed independently (not chained together).
    The results are concatenated in order.

    Args:
        events: The events to process.
        processors: The processors to run each event through.

    Returns:
        A flat list of all output events.
    """
    chain = ProcessorChain(processors)
    results: list[Event] = []
    for event in events:
        async for out in chain.process(event):
            results.append(out)
    return results
