"""Tests for loopengine.composition.plugins — the Plugins module.

Uses TDD (vertical slices), BDD (Given/When/Then docstrings), and DDD
(domain vocabulary in assertions).

Each test is a single behavior. We write ONE test, implement, verify, repeat.
"""
from __future__ import annotations

import pytest
from typing import Any, AsyncIterator

from loopengine.primitives.events import Event
from loopengine.primitives.processors import MultiHookProcessor
from loopengine.primitives.tools import Tool, ToolContext, ToolResult

from loopengine.composition.plugins import Plugin, SimplePlugin, PluginLoader
from loopengine.composition.builder import HarnessBuilder


# ---------------------------------------------------------------------------
# Helpers: concrete test implementations
# ---------------------------------------------------------------------------


class PassThroughProcessor(MultiHookProcessor):
    """A processor that passes all events through unchanged.

    Used as a minimal processor for plugin testing.
    """

    def __init__(self) -> None:
        super().__init__(name="passthrough")


class StubTool:
    """A minimal tool that returns a fixed result.

    Used as a stand-in tool for plugin testing.
    """

    def __init__(self, name: str = "stub", description: str = "A stub tool") -> None:
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
        return {"type": "object", "properties": {}}

    async def execute(self, input: dict[str, Any], ctx: ToolContext) -> ToolResult:
        return ToolResult(run_id=ctx.run_id, step_id=ctx.step_id, output="stub_result")


# ===================================================================
# SLICE 1: SimplePlugin creation
# ===================================================================


class TestSimplePluginCreation:
    """Given plugin parameters, When I create a SimplePlugin, Then it stores all fields."""

    def test_plugin_stores_name(self) -> None:
        """Given a name, When I create a SimplePlugin, Then name is accessible."""
        plugin = SimplePlugin(name="test_plugin")
        assert plugin.name == "test_plugin"

    def test_plugin_default_processors_is_empty(self) -> None:
        """Given no processors, When I create a SimplePlugin, Then processors is empty."""
        plugin = SimplePlugin(name="test")
        assert plugin.processors == []

    def test_plugin_default_tools_is_empty(self) -> None:
        """Given no tools, When I create a SimplePlugin, Then tools is empty."""
        plugin = SimplePlugin(name="test")
        assert plugin.tools == []

    def test_plugin_default_flags_is_empty(self) -> None:
        """Given no flags, When I create a SimplePlugin, Then flags is empty."""
        plugin = SimplePlugin(name="test")
        assert plugin.flags == {}


# ===================================================================
# SLICE 2: SimplePlugin with populated fields
# ===================================================================


class TestSimplePluginWithFields:
    """Given a SimplePlugin with processors, tools, and flags,
    When I inspect its fields, Then they contain the expected items."""

    def test_plugin_stores_processors(self) -> None:
        """Given a processor triple, When I create a SimplePlugin, Then processors contains it."""
        proc = PassThroughProcessor()
        plugin = SimplePlugin(
            name="test",
            processors=[(proc, "step_end", 0)],
        )
        assert len(plugin.processors) == 1
        assert plugin.processors[0] == (proc, "step_end", 0)

    def test_plugin_stores_tools(self) -> None:
        """Given a tool, When I create a SimplePlugin, Then tools contains it."""
        tool = StubTool()
        plugin = SimplePlugin(name="test", tools=[tool])
        assert len(plugin.tools) == 1
        assert plugin.tools[0] is tool

    def test_plugin_stores_flags(self) -> None:
        """Given flags, When I create a SimplePlugin, Then flags dict contains them."""
        plugin = SimplePlugin(name="test", flags={"verbose": True, "debug": False})
        assert plugin.flags == {"verbose": True, "debug": False}


# ===================================================================
# SLICE 3: Plugin Protocol compliance
# ===================================================================


class TestPluginProtocol:
    """Given a SimplePlugin, When I check isinstance(Plugin),
    Then it satisfies the Plugin Protocol."""

    def test_simple_plugin_satisfies_protocol(self) -> None:
        """Given a SimplePlugin instance, When I check isinstance(Plugin),
        Then it passes the Protocol check."""
        plugin = SimplePlugin(name="test")
        assert isinstance(plugin, Plugin)

    def test_bare_object_does_not_satisfy_protocol(self) -> None:
        """Given a plain object, When I check isinstance(Plugin),
        Then it does NOT pass the Protocol check."""
        assert not isinstance(object(), Plugin)


# ===================================================================
# SLICE 4: Plugin setup/teardown lifecycle
# ===================================================================


class TestPluginLifecycle:
    """Given a SimplePlugin, When I call setup() and teardown(),
    Then the lifecycle methods execute correctly."""

    async def test_setup_returns_none_by_default(self) -> None:
        """Given a SimplePlugin, When I call setup(), Then it returns None."""
        plugin = SimplePlugin(name="test")
        result = await plugin.setup({})
        assert result is None

    async def test_teardown_returns_none_by_default(self) -> None:
        """Given a SimplePlugin, When I call teardown(), Then it returns None."""
        plugin = SimplePlugin(name="test")
        result = await plugin.teardown()
        assert result is None

    async def test_setup_with_config(self) -> None:
        """Given a SimplePlugin, When I call setup with a config dict,
        Then the config is passed through (no error)."""
        plugin = SimplePlugin(name="test")
        config = {"working_dir": "/tmp", "model": "gpt-4"}
        result = await plugin.setup(config)
        assert result is None

    async def test_custom_setup_teardown(self) -> None:
        """Given a plugin with custom setup/teardown, When lifecycle runs,
        Then the custom methods are called and track state."""

        class TrackingPlugin(SimplePlugin):
            def __init__(self) -> None:
                super().__init__(name="tracker")
                self.setup_called = False
                self.teardown_called = False

            async def setup(self, config: dict[str, Any]) -> None:
                self.setup_called = True

            async def teardown(self) -> None:
                self.teardown_called = True

        plugin = TrackingPlugin()
        assert not plugin.setup_called
        assert not plugin.teardown_called

        await plugin.setup({})
        assert plugin.setup_called
        assert not plugin.teardown_called

        await plugin.teardown()
        assert plugin.setup_called
        assert plugin.teardown_called


# ===================================================================
# SLICE 5: PluginLoader register/get/list
# ===================================================================


class TestPluginLoader:
    """Given a PluginLoader, When I register plugins, Then I can get and list them."""

    def test_register_then_get(self) -> None:
        """Given a loader and a plugin, When I register it, Then get() returns it."""
        loader = PluginLoader()
        plugin = SimplePlugin(name="my_plugin")
        loader.register(plugin)
        assert loader.get("my_plugin") is plugin

    def test_get_missing_returns_none(self) -> None:
        """Given an empty loader, When I get a non-existent name, Then it returns None."""
        loader = PluginLoader()
        assert loader.get("ghost") is None

    def test_list_returns_all_registered(self) -> None:
        """Given a loader with 2 plugins, When I call list(), Then both names appear."""
        loader = PluginLoader()
        loader.register(SimplePlugin(name="alpha"))
        loader.register(SimplePlugin(name="beta"))
        names = loader.list()
        assert sorted(names) == ["alpha", "beta"]

    def test_list_empty_loader(self) -> None:
        """Given an empty loader, When I call list(), Then it returns an empty list."""
        loader = PluginLoader()
        assert loader.list() == []

    def test_register_duplicate_raises(self) -> None:
        """Given a loader with a registered plugin, When I register the same name,
        Then a ValueError is raised."""
        loader = PluginLoader()
        loader.register(SimplePlugin(name="dup"))
        with pytest.raises(ValueError, match="already registered"):
            loader.register(SimplePlugin(name="dup"))

    def test_len_returns_count(self) -> None:
        """Given a loader with 3 plugins, When I call len(), Then it returns 3."""
        loader = PluginLoader()
        loader.register(SimplePlugin(name="a"))
        loader.register(SimplePlugin(name="b"))
        loader.register(SimplePlugin(name="c"))
        assert len(loader) == 3


# ===================================================================
# SLICE 6: Plugin integrates with HarnessBuilder
# ===================================================================


class TestPluginBuilderIntegration:
    """Given a plugin and a HarnessBuilder, When I call builder.plugin(plugin),
    Then the plugin's parts are added to the builder."""

    def test_plugin_adds_processor_to_builder(self) -> None:
        """Given a plugin with a processor, When I add it to a builder,
        Then the built config contains that processor."""
        proc = PassThroughProcessor()
        plugin = SimplePlugin(
            name="test",
            processors=[(proc, "step_end", 0)],
        )
        builder = HarnessBuilder().plugin(plugin)
        config = builder.build()
        assert len(config.processors) == 1
        assert config.processors[0].processor is proc

    def test_plugin_adds_tool_to_builder(self) -> None:
        """Given a plugin with a tool, When I add it to a builder,
        Then the built config contains that tool."""
        tool = StubTool(name="search")
        plugin = SimplePlugin(name="test", tools=[tool])
        builder = HarnessBuilder().plugin(plugin)
        config = builder.build()
        assert len(config.tools) == 1
        assert config.tools[0].name == "search"

    def test_plugin_adds_flags_to_builder(self) -> None:
        """Given a plugin with flags, When I add it to a builder,
        Then the built config contains those flags."""
        plugin = SimplePlugin(name="test", flags={"verbose": True, "debug": False})
        builder = HarnessBuilder().plugin(plugin)
        config = builder.build()
        assert config.flags["verbose"] is True
        assert config.flags["debug"] is False

    def test_plugin_does_not_mutate_builder(self) -> None:
        """Given a builder, When I add a plugin, Then the original builder is unchanged."""
        original = HarnessBuilder()
        plugin = SimplePlugin(
            name="test",
            tools=[StubTool()],
            flags={"x": True},
        )
        _ = original.plugin(plugin)
        config = original.build()
        assert len(config.tools) == 0
        assert len(config.flags) == 0

    def test_multiple_plugins_compose(self) -> None:
        """Given two plugins, When I add both to a builder, Then all parts are present."""
        p1 = SimplePlugin(name="p1", tools=[StubTool(name="t1")])
        p2 = SimplePlugin(name="p2", tools=[StubTool(name="t2")])
        builder = HarnessBuilder().plugin(p1).plugin(p2)
        config = builder.build()
        assert len(config.tools) == 2
        tool_names = {t.name for t in config.tools}
        assert tool_names == {"t1", "t2"}
