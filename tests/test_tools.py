"""Tests for loopengine.primitives.tools — the Tools module.

Uses TDD (vertical slices), BDD (Given/When/Then docstrings), and DDD
(domain vocabulary in assertions).

Each test is a single behavior. We write ONE test, implement, verify, repeat.
"""
from __future__ import annotations

import pytest
from typing import Any

from loopengine.primitives.events import ToolResult
from loopengine.primitives.tools import Tool, ToolSchema, ToolContext, ToolRegistry, ToolNotFoundError


# ---------------------------------------------------------------------------
# Helper: a concrete tool implementation for testing
# ---------------------------------------------------------------------------

class EchoTool:
    """A simple tool that echoes its input back as output.

    Used in tests as a stand-in for a real tool. It satisfies the Tool Protocol
    without needing async infrastructure.
    """

    def __init__(self, name: str = "echo", description: str = "Echo input back") -> None:
        self._name = name
        self._description = description

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def input_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
        }

    async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
        return ToolResult(
            run_id=ctx.run_id,
            step_id=ctx.step_id,
            call_id="echo_call",
            output=input.get("message", ""),
        )


class FailingTool:
    """A tool that always raises an exception during execution.

    Used to test error handling in the registry's execute method.
    """

    @property
    def name(self) -> str:
        return "failing"

    @property
    def description(self) -> str:
        return "Always fails"

    @property
    def input_schema(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
        raise RuntimeError("Tool execution exploded!")


# ===================================================================
# SLICE 1: ToolSchema creation
# ===================================================================

class TestToolSchemaCreation:
    """Given a tool definition, When I create a ToolSchema, Then it stores all fields."""

    def test_schema_stores_name_and_description(self) -> None:
        """Given a name and description, When I create a ToolSchema,
        Then name and description are accessible."""
        schema = ToolSchema(
            name="search",
            description="Search the web",
            input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
        )
        assert schema.name == "search"
        assert schema.description == "Search the web"

    def test_schema_stores_input_schema(self) -> None:
        """Given an input_schema dict, When I create a ToolSchema,
        Then input_schema is stored correctly."""
        input_schema = {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        }
        schema = ToolSchema(name="t", description="d", input_schema=input_schema)
        assert schema.input_schema == input_schema

    def test_schema_default_metadata_is_empty(self) -> None:
        """Given no metadata, When I create a ToolSchema,
        Then metadata defaults to an empty dict."""
        schema = ToolSchema(name="t", description="d", input_schema={})
        assert schema.metadata == {}


# ===================================================================
# SLICE 2: ToolSchema immutability and serialization
# ===================================================================

class TestToolSchemaImmutability:
    """Given a ToolSchema, When I try to mutate it, Then it raises an error."""

    def test_frozen_schema_rejects_field_assignment(self) -> None:
        """Given a ToolSchema, When I try to change its name,
        Then a FrozenInstanceError is raised (immutability guarantee)."""
        schema = ToolSchema(name="search", description="d", input_schema={})
        with pytest.raises(AttributeError):
            schema.name = "other"  # type: ignore[misc]

    def test_schema_equality(self) -> None:
        """Given two ToolSchemas with the same fields,
        When I compare them, Then they are equal."""
        a = ToolSchema(name="t", description="d", input_schema={"x": 1})
        b = ToolSchema(name="t", description="d", input_schema={"x": 1})
        assert a == b

    def test_schema_inequality_by_name(self) -> None:
        """Given two ToolSchemas with different names,
        When I compare them, Then they are not equal."""
        a = ToolSchema(name="a", description="d", input_schema={})
        b = ToolSchema(name="b", description="d", input_schema={})
        assert a != b

    def test_to_openai_dict(self) -> None:
        """Given a ToolSchema, When I call to_openai_dict(),
        Then it matches OpenAI's function-calling format."""
        schema = ToolSchema(
            name="search",
            description="Search the web",
            input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
        )
        result = schema.to_openai_dict()
        assert result == {
            "type": "function",
            "function": {
                "name": "search",
                "description": "Search the web",
                "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
            },
        }


# ===================================================================
# SLICE 3: ToolContext creation
# ===================================================================

class TestToolContext:
    """Given run context, When I create a ToolContext, Then it holds all fields."""

    def test_context_stores_run_and_step(self, run_id: str) -> None:
        """Given a run_id and step_id, When I create a ToolContext,
        Then they are stored correctly."""
        ctx = ToolContext(run_id=run_id, step_id=3)
        assert ctx.run_id == run_id
        assert ctx.step_id == 3

    def test_context_defaults_state_and_sandbox_to_none(self, run_id: str) -> None:
        """Given no state or sandbox, When I create a ToolContext,
        Then both default to None."""
        ctx = ToolContext(run_id=run_id, step_id=0)
        assert ctx.state is None
        assert ctx.sandbox is None

    def test_context_accepts_state_and_sandbox(self, run_id: str) -> None:
        """Given a state and sandbox, When I create a ToolContext,
        Then they are stored for use by the tool."""
        fake_state = object()
        fake_sandbox = object()
        ctx = ToolContext(run_id=run_id, step_id=1, state=fake_state, sandbox=fake_sandbox)
        assert ctx.state is fake_state
        assert ctx.sandbox is fake_sandbox


# ===================================================================
# SLICE 4: Tool Protocol compliance
# ===================================================================

class TestToolProtocol:
    """Given an object with the right methods, When I check isinstance(Tool),
    Then it is recognized as a Tool (duck typing with type checking)."""

    def test_echo_tool_satisfies_protocol(self) -> None:
        """Given an EchoTool instance, When I check isinstance(Tool),
        Then it passes the Protocol check."""
        tool = EchoTool()
        assert isinstance(tool, Tool)

    def test_plain_object_does_not_satisfy_protocol(self) -> None:
        """Given a plain object, When I check isinstance(Tool),
        Then it does NOT pass the Protocol check."""
        assert not isinstance(object(), Tool)


# ===================================================================
# SLICE 5: ToolRegistry register and get
# ===================================================================

class TestToolRegistryRegisterGet:
    """Given a ToolRegistry, When I register a tool, Then I can get it back by name."""

    def test_register_then_get(self, run_id: str) -> None:
        """Given a registry and an EchoTool, When I register the tool,
        Then get() returns the same tool object."""
        registry = ToolRegistry()
        tool = EchoTool()
        registry.register(tool)
        assert registry.get("echo") is tool

    def test_get_unregistered_returns_none(self) -> None:
        """Given an empty registry, When I get a non-existent name,
        Then it returns None."""
        registry = ToolRegistry()
        assert registry.get("nonexistent") is None

    def test_register_returns_schema(self) -> None:
        """Given a registry and a tool, When I register the tool,
        Then register() returns a ToolSchema with the tool's interface."""
        registry = ToolRegistry()
        schema = registry.register(EchoTool())
        assert isinstance(schema, ToolSchema)
        assert schema.name == "echo"
        assert schema.description == "Echo input back"

    def test_register_duplicate_raises(self) -> None:
        """Given a registry with a registered tool, When I register the same name again,
        Then a ValueError is raised."""
        registry = ToolRegistry()
        registry.register(EchoTool())
        with pytest.raises(ValueError, match="already registered"):
            registry.register(EchoTool())


# ===================================================================
# SLICE 6: ToolRegistry list_schemas and has/names/len
# ===================================================================

class TestToolRegistryListing:
    """Given a ToolRegistry with tools, When I list schemas, Then all tools appear."""

    def test_list_schemas_returns_all(self) -> None:
        """Given a registry with two tools, When I call list_schemas(),
        Then I get two schemas, one per tool."""
        registry = ToolRegistry()
        registry.register(EchoTool(name="echo"))
        registry.register(EchoTool(name="echo2", description="Second echo"))
        schemas = registry.list_schemas()
        assert len(schemas) == 2
        names = {s.name for s in schemas}
        assert names == {"echo", "echo2"}

    def test_list_schemas_empty_registry(self) -> None:
        """Given an empty registry, When I call list_schemas(),
        Then I get an empty list."""
        registry = ToolRegistry()
        assert registry.list_schemas() == []

    def test_has_returns_true_for_registered(self) -> None:
        """Given a registry with a tool, When I check has() for its name,
        Then it returns True."""
        registry = ToolRegistry()
        registry.register(EchoTool())
        assert registry.has("echo") is True

    def test_has_returns_false_for_unregistered(self) -> None:
        """Given an empty registry, When I check has() for any name,
        Then it returns False."""
        registry = ToolRegistry()
        assert registry.has("echo") is False

    def test_names_returns_all_registered(self) -> None:
        """Given a registry with tools, When I call names(),
        Then I get all registered tool names."""
        registry = ToolRegistry()
        registry.register(EchoTool(name="a"))
        registry.register(EchoTool(name="b"))
        assert sorted(registry.names()) == ["a", "b"]

    def test_len_returns_count(self) -> None:
        """Given a registry with 2 tools, When I call len(),
        Then it returns 2."""
        registry = ToolRegistry()
        registry.register(EchoTool(name="a"))
        registry.register(EchoTool(name="b"))
        assert len(registry) == 2

    def test_contains_operator(self) -> None:
        """Given a registry with a tool, When I use 'in' operator,
        Then it returns True for registered names and False for others."""
        registry = ToolRegistry()
        registry.register(EchoTool())
        assert "echo" in registry
        assert "other" not in registry


# ===================================================================
# SLICE 7: ToolRegistry execute dispatch
# ===================================================================

class TestToolRegistryExecute:
    """Given a ToolRegistry with tools, When I execute by name,
    Then the correct tool runs and returns a ToolResult."""

    async def test_execute_dispatches_to_correct_tool(self, run_id: str) -> None:
        """Given a registry with an EchoTool, When I execute 'echo' with a message,
        Then the tool runs and returns a ToolResult with the message as output."""
        registry = ToolRegistry()
        registry.register(EchoTool())
        ctx = ToolContext(run_id=run_id, step_id=0)
        result = await registry.execute("echo", {"message": "hello"}, ctx)
        assert isinstance(result, ToolResult)
        assert result.output == "hello"

    async def test_execute_missing_tool_raises_not_found(self, run_id: str) -> None:
        """Given a registry without a tool, When I execute a non-existent name,
        Then ToolNotFoundError is raised."""
        registry = ToolRegistry()
        ctx = ToolContext(run_id=run_id, step_id=0)
        with pytest.raises(ToolNotFoundError):
            await registry.execute("ghost", {}, ctx)

    async def test_tool_not_found_error_contains_name(self) -> None:
        """Given a ToolNotFoundError, When I inspect it,
        Then it contains the missing tool's name and a helpful message."""
        err = ToolNotFoundError("my_tool")
        assert err.tool_name == "my_tool"
        assert "my_tool" in str(err)

    async def test_tool_not_found_is_key_error(self) -> None:
        """Given a ToolNotFoundError, When I check its type,
        Then it is a subclass of KeyError (for compatibility)."""
        err = ToolNotFoundError("x")
        assert isinstance(err, KeyError)


# ===================================================================
# SLICE 8: Registry → OpenAI-compatible tool list
# ===================================================================

class TestRegistryOpenAIFormat:
    """Given a ToolRegistry with tools, When I get schemas and convert each
    to OpenAI format, Then the result is a valid tools array for the API."""

    def test_registry_schemas_to_openai_list(self) -> None:
        """Given a registry with two tools, When I convert all schemas
        to OpenAI format, Then each entry has the right structure."""
        registry = ToolRegistry()
        registry.register(EchoTool(name="echo", description="Echo back"))
        registry.register(EchoTool(name="search", description="Search web"))

        openai_tools = [s.to_openai_dict() for s in registry.list_schemas()]
        assert len(openai_tools) == 2
        # Verify structure of each entry
        for tool in openai_tools:
            assert tool["type"] == "function"
            assert "name" in tool["function"]
            assert "description" in tool["function"]
            assert "parameters" in tool["function"]

    def test_empty_registry_produces_empty_list(self) -> None:
        """Given an empty registry, When I get schemas in OpenAI format,
        Then the result is an empty list."""
        registry = ToolRegistry()
        assert [s.to_openai_dict() for s in registry.list_schemas()] == []


# ===================================================================
# SLICE 9: FailingTool error propagation
# ===================================================================

class TestToolExecuteErrors:
    """Given a tool that raises during execution, When the registry executes it,
    Then the exception propagates to the caller."""

    async def test_tool_exception_propagates(self, run_id: str) -> None:
        """Given a FailingTool that raises RuntimeError, When I execute it
        through the registry, Then RuntimeError is raised."""
        registry = ToolRegistry()
        registry.register(FailingTool())
        ctx = ToolContext(run_id=run_id, step_id=0)
        with pytest.raises(RuntimeError, match="exploded"):
            await registry.execute("failing", {}, ctx)
