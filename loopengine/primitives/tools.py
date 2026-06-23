"""The Tools module defines what the agent CAN DO.

Plain English: Tools are like apps on a phone. Each tool has:
- A name (what to call it)
- A description (what it does, for the AI to understand)
- An input schema (what arguments it needs, in JSON Schema format)
- An execute method (the actual code that runs when called)

The ToolRegistry is like the phone's app store — it holds all available tools
and lets you look them up by name.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from loopengine.primitives.events import ToolResult


# ---------------------------------------------------------------------------
# ToolSchema — defines a tool's public interface
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ToolSchema:
    """The immutable definition of a tool's interface.

    Think of a ToolSchema as a job posting — it describes what the tool is
    called, what it does, and what inputs it expects (in JSON Schema format).
    It does NOT contain the tool's implementation — just its contract.

    This is frozen (immutable) because a tool's interface should not change
    after it's registered. If you need a different interface, create a new tool.

    Attributes:
        name: The tool's unique identifier (like an app name on a phone).
        description: Human-readable explanation of what the tool does.
            This is sent to the AI model so it knows when to use the tool.
        input_schema: A JSON Schema dict defining the expected inputs.
            Example: {"type": "object", "properties": {"query": {"type": "string"}}}
        metadata: Arbitrary extra info (version, author, category, etc.).
    """

    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_openai_dict(self) -> dict[str, Any]:
        """Convert this schema to OpenAI's function-calling format.

        The OpenAI API expects tools in a specific nested structure:
        {"type": "function", "function": {"name": ..., "description": ..., "parameters": ...}}

        Returns:
            A dict matching the OpenAI tool definition format.
        """
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema,
            },
        }


# ---------------------------------------------------------------------------
# ToolContext — information available to a tool during execution
# ---------------------------------------------------------------------------

@dataclass
class ToolContext:
    """The context passed to a tool when it executes.

    Think of ToolContext as the "briefing packet" a contractor receives
    before starting a job. It tells them which job this is (run_id),
    what step they're on (step_id), the current state of the workspace,
    and where they can run code (sandbox).

    Attributes:
        run_id: Unique identifier for the current execution run.
        step_id: Which step in the run this tool call belongs to.
        state: The current State (working memory) — tools can read/write it.
        sandbox: The sandboxed execution environment (for code-running tools).
    """

    run_id: str
    step_id: int
    state: Any = None
    sandbox: Any = None


# ---------------------------------------------------------------------------
# Tool Protocol — the interface that all tools must satisfy
# ---------------------------------------------------------------------------

@runtime_checkable
class Tool(Protocol):
    """The interface that any tool implementation must satisfy.

    Think of Tool as a "contract" — if something claims to be a tool,
    it must have these attributes and methods. The Protocol approach
    means you don't need to inherit from anything; just implement
    the right methods (duck typing with type checking).

    A Tool is like a vending machine:
    - name: what's written on the front (e.g., "search", "calculator")
    - description: the instruction label
    - input_schema: the coin slot shape (what inputs it accepts)
    - execute(): put coins in, get a snack out (input → ToolResult)
    """

    @property
    def name(self) -> str:
        """The tool's unique name (used for dispatch)."""
        ...

    @property
    def description(self) -> str:
        """What the tool does (sent to the AI model)."""
        ...

    @property
    def input_schema(self) -> dict[str, Any]:
        """JSON Schema describing the tool's expected inputs."""
        ...

    async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
        """Run the tool with the given input and context.

        Args:
            input: The arguments to the tool (matching input_schema).
            ctx: Execution context (run_id, step_id, state, sandbox).

        Returns:
            A ToolResult with the output (or error if something went wrong).
        """
        ...


# ---------------------------------------------------------------------------
# ToolRegistry — the "app store" that holds all available tools
# ---------------------------------------------------------------------------

class ToolNotFoundError(KeyError):
    """Raised when trying to execute a tool that isn't registered.

    Like trying to open an app that's not installed on your phone.
    """

    def __init__(self, name: str) -> None:
        """Initialize with the missing tool's name.

        Args:
            name: The name of the tool that wasn't found.
        """
        self.tool_name = name
        super().__init__(f"Tool not found: {name!r}")


class ToolRegistry:
    """A dict-like container that holds all available tools.

    Think of ToolRegistry as the phone's app store. You can:
    - register(): Install a new tool (like downloading an app)
    - get(): Look up a tool by name (like searching for an app)
    - list_schemas(): See all installed tools' interfaces
    - execute(): Find a tool and run it in one step

    The registry is the single source of truth for what tools are available.
    """

    def __init__(self) -> None:
        """Initialize an empty registry with no tools."""
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> ToolSchema:
        """Register a tool, making it available for execution.

        Args:
            tool: The tool to register. Must have name, description,
                  input_schema, and execute().

        Returns:
            The ToolSchema extracted from the tool (useful for serialization).

        Raises:
            ValueError: If a tool with the same name is already registered.
        """
        if tool.name in self._tools:
            raise ValueError(
                f"Tool {tool.name!r} is already registered. "
                "Use a different name or unregister first."
            )
        self._tools[tool.name] = tool
        return ToolSchema(
            name=tool.name,
            description=tool.description,
            input_schema=tool.input_schema,
        )

    def get(self, name: str) -> Tool | None:
        """Look up a tool by name.

        Args:
            name: The tool name to search for.

        Returns:
            The tool if found, None otherwise.
        """
        return self._tools.get(name)

    def has(self, name: str) -> bool:
        """Check if a tool with the given name is registered.

        Args:
            name: The tool name to check.

        Returns:
            True if the tool is registered, False otherwise.
        """
        return name in self._tools

    def list_schemas(self) -> list[ToolSchema]:
        """Get schemas for all registered tools.

        This is what you'd send to the AI model so it knows what tools
        are available. Each schema tells the model the tool's name,
        description, and expected input format.

        Returns:
            A list of ToolSchema objects, one per registered tool.
        """
        return [
            ToolSchema(
                name=tool.name,
                description=tool.description,
                input_schema=tool.input_schema,
            )
            for tool in self._tools.values()
        ]

    async def execute(self, name: str, input: dict[str, Any],
                      ctx: ToolContext) -> ToolResult:
        """Find a tool by name and execute it.

        This is a convenience method that combines get() + execute().
        If the tool isn't found, returns an error ToolResult instead
        of raising an exception (so the agent can recover gracefully).

        Args:
            name: The name of the tool to execute.
            input: The arguments to pass to the tool.
            ctx: Execution context (run_id, step_id, state, sandbox).

        Returns:
            A ToolResult with the tool's output, or an error if the
            tool wasn't found or execution failed.

        Raises:
            ToolNotFoundError: If the tool is not registered.
        """
        tool = self.get(name)
        if tool is None:
            raise ToolNotFoundError(name)
        return await tool.execute(input, ctx)

    def __len__(self) -> int:
        """Return the number of registered tools."""
        return len(self._tools)

    def __contains__(self, name: str) -> bool:
        """Support `name in registry` syntax."""
        return name in self._tools

    def names(self) -> list[str]:
        """Get a list of all registered tool names.

        Returns:
            List of tool name strings.
        """
        return list(self._tools.keys())
