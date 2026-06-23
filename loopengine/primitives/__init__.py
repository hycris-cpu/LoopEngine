"""Primitives — the foundational building blocks of LoopEngine.

These are the atomic types and interfaces that everything else is built on:
- Events: Things that happen (messages, tool calls, evaluations)
- State: The agent's working memory
- Tools: What the agent can do
- Processors: Behavioral building blocks that intercept and transform events
- Trajectory: The agent's full life story during a task
"""

from loopengine.primitives.events import (
    Event,
    EvalResult,
    Message,
    MessageType,
    ToolCall,
    ToolCallMetadata,
    ToolResult,
)
from loopengine.primitives.processors import (
    HOOK_POINTS,
    MultiHookProcessor,
    Processor,
    ProcessorChain,
    event_to_hook,
    pipe,
    pipe_all,
)

__all__ = [
    # Events
    "Event", "Message", "MessageType", "ToolCall", "ToolCallMetadata",
    "ToolResult", "EvalResult",
    # Processors
    "HOOK_POINTS", "MultiHookProcessor", "Processor", "ProcessorChain",
    "event_to_hook", "pipe", "pipe_all",
]
