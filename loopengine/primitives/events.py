"""The Events module defines every "thing that happens" in the system.

Plain English: Imagine the agent's life as a movie. Each frame of that movie
is an Event. There are different types of frames:
- Message: someone says something (user, assistant, system, tool)
- ToolCall: the assistant wants to use a tool
- ToolResult: the tool gives back a result
- EvalResult: someone judges how well we did

All Events are IMMUTABLE (frozen=True). Once created, they can never be changed.
This is like a historical record — you can't rewrite history, only add new entries.
"""

from __future__ import annotations

import enum
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal


# ---------------------------------------------------------------------------
# MessageType — the four "speaking roles" in a conversation
# ---------------------------------------------------------------------------

class MessageType(str, enum.Enum):
    """The type of message being sent.

    Think of a play with four actors:
    - SYSTEM: the stage director (sets the scene, gives instructions)
    - USER: the audience (asks questions, gives tasks)
    - ASSISTANT: the lead actor (responds, thinks, acts)
    - TOOL: the props department (returns results from tool calls)
    """

    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


# ---------------------------------------------------------------------------
# Event — the base "thing that happened"
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Event:
    """Base class for all events in the system.

    An Event is the atomic unit of history. Every action, message, and result
    is recorded as an Event. Events are immutable — once created, they're
    carved in stone. This ensures the integrity of the execution history.

    Attributes:
        type: What kind of event this is (e.g., "message", "tool_call").
        run_id: Which execution run this belongs to (like a case number).
        step_id: Which step in the run this happened at (0-indexed).
        ts: Unix timestamp of when this event occurred.
    """

    type: str = ""
    run_id: str = ""
    step_id: int = 0
    ts: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        """Serialize this event to a plain dictionary.

        Useful for JSON serialization and logging. Subclasses should override
        to add their specific fields.
        """
        return {
            "type": self.type,
            "run_id": self.run_id,
            "step_id": self.step_id,
            "ts": self.ts,
        }

    def to_json(self) -> str:
        """Serialize this event to a JSON string."""
        return json.dumps(self.to_dict())


# ---------------------------------------------------------------------------
# ToolCallMetadata — extra info attached to tool calls
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ToolCallMetadata:
    """Metadata attached to a tool call for tracking and debugging.

    Think of this as the "envelope" around a tool request — it carries
    routing information, timing data, and other context that helps
    diagnose issues and measure performance.

    Attributes:
        processor_name: Which processor generated or modified this call.
        retry_count: How many times this call has been retried.
        timeout_ms: Maximum allowed execution time in milliseconds.
        tags: Arbitrary key-value pairs for filtering and analysis.
    """

    processor_name: str = ""
    retry_count: int = 0
    timeout_ms: int = 30_000
    tags: dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Message — someone says something
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Message(Event):
    """A message in the conversation — someone says something.

    Messages are the primary communication unit. A conversation is just a
    sequence of Messages with different roles (system, user, assistant, tool).

    Attributes:
        role: Who is speaking (system, user, assistant, or tool).
        content: What they said (text content).
        tool_calls: Any tool calls the assistant wants to make (empty for non-assistant).
        metadata: Additional structured data (token counts, model info, etc.).
    """

    role: Literal["system", "user", "assistant", "tool"] = "user"
    content: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Ensure the type field is always 'message'."""
        object.__setattr__(self, "type", "message")

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict, including role, content, and tool calls."""
        d = super().to_dict()
        d.update({
            "role": self.role,
            "content": self.content,
            "tool_calls": [tc.to_dict() for tc in self.tool_calls],
            "metadata": dict(self.metadata),
        })
        return d

    def to_openai_dict(self) -> dict[str, Any]:
        """Convert to OpenAI-compatible message format.

        This is the format expected by the OpenAI Chat Completions API.
        Other providers (Anthropic, etc.) may need different conversions.
        """
        d: dict[str, Any] = {"role": self.role, "content": self.content}
        if self.tool_calls:
            d["tool_calls"] = [tc.to_openai_dict() for tc in self.tool_calls]
        return d


# ---------------------------------------------------------------------------
# ToolCall — the assistant wants to use a tool
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ToolCall(Event):
    """A request from the assistant to execute a tool.

    Think of this as a "work order" — the assistant fills out a form saying
    "I need tool X with these inputs" and hands it to the system.

    Attributes:
        id: Unique identifier for this specific tool call (like a ticket number).
        name: Which tool to call (must match a registered tool name).
        input: The arguments to pass to the tool (as a dict).
    """

    id: str = ""
    name: str = ""
    input: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Ensure the type field is always 'tool_call' and generate an id if needed."""
        object.__setattr__(self, "type", "tool_call")
        if not self.id:
            object.__setattr__(self, "id", f"call_{uuid.uuid4().hex[:12]}")

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict including id, name, and input."""
        d = super().to_dict()
        d.update({
            "id": self.id,
            "name": self.name,
            "input": dict(self.input),
        })
        return d

    def to_openai_dict(self) -> dict[str, Any]:
        """Convert to OpenAI-compatible tool_call format."""
        return {
            "id": self.id,
            "type": "function",
            "function": {
                "name": self.name,
                "arguments": json.dumps(self.input),
            },
        }


# ---------------------------------------------------------------------------
# ToolResult — a tool gives back a result
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ToolResult(Event):
    """The result returned after a tool executes.

    Think of this as the "completed work order" — the tool did its job
    and here's what came back (or what went wrong).

    Attributes:
        call_id: Which ToolCall this is a response to (links request to result).
        output: The tool's output (text, data, whatever it produced).
        error: If the tool failed, the error message. None means success.
    """

    call_id: str = ""
    output: str = ""
    error: str | None = None

    def __post_init__(self) -> None:
        """Ensure the type field is always 'tool_result'."""
        object.__setattr__(self, "type", "tool_result")

    @property
    def is_error(self) -> bool:
        """Check if this result represents an error.

        Returns True if the tool execution failed.
        """
        return self.error is not None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict including call_id, output, and error."""
        d = super().to_dict()
        d.update({
            "call_id": self.call_id,
            "output": self.output,
            "error": self.error,
        })
        return d


# ---------------------------------------------------------------------------
# EvalResult — someone judges how well we did
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class EvalResult(Event):
    """An evaluation outcome — someone judged how well the agent did.

    Think of this as a "report card" — after the agent completes a step
    or task, an evaluator assigns a score and explains why.

    Attributes:
        passed: Whether the evaluation passed (True) or failed (False).
        score: Numeric score (0.0 to 1.0, higher is better).
        reason: Human-readable explanation of the evaluation.
        reward: Numeric reward signal for RL training (can be negative).
    """

    passed: bool = False
    score: float = 0.0
    reason: str = ""
    reward: float = 0.0

    def __post_init__(self) -> None:
        """Ensure the type field is always 'eval_result'."""
        object.__setattr__(self, "type", "eval_result")

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict including evaluation details."""
        d = super().to_dict()
        d.update({
            "passed": self.passed,
            "score": self.score,
            "reason": self.reason,
            "reward": self.reward,
        })
        return d
