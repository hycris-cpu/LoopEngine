"""Plugins package up reusable capabilities that can be dropped into any agent.

Plain English: A Plugin is like a LEGO kit. Each kit comes with:
- Processors (behavioral pieces)
- Tools (capability pieces)
- Flags (configuration switches)
- Setup/teardown logic (lifecycle hooks)

You "plug in" a kit to your agent, and all the pieces snap into place.
Plugins have a TWO-PHASE LIFECYCLE:
1. Build time: The builder reads the plugin's parts (processors, tools, flags)
2. Runtime: setup() is called when the agent starts, teardown() when it stops

This separation means the config can be serialized (build-time parts)
while runtime resources (database connections, file handles) are managed
by setup/teardown.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from loopengine.primitives.processors import Processor
from loopengine.primitives.tools import Tool


# ---------------------------------------------------------------------------
# Plugin Protocol — the interface all plugins must satisfy
# ---------------------------------------------------------------------------


@runtime_checkable
class Plugin(Protocol):
    """Protocol defining what a Plugin must provide.

    Plain English: This is the "USB standard" for plugins — any object
    that has these attributes and methods can be plugged into a builder.

    A Plugin is a self-contained capability bundle. It declares:
    - name: its identity
    - processors: behavioral checkpoints to install
    - tools: capabilities to make available
    - flags: configuration switches to set
    - setup/teardown: lifecycle hooks for runtime resource management

    The two-phase design separates BUILD-TIME (serializable config)
    from RUNTIME (resource management):
    - processors, tools, flags → used at build time (can be serialized)
    - setup/teardown → called at runtime (manage live resources)
    """

    @property
    def name(self) -> str:
        """A unique name for this plugin."""
        ...

    @property
    def processors(self) -> list[tuple[Processor, str, int]]:
        """Processors to install, as (processor, hook_point, order) triples."""
        ...

    @property
    def tools(self) -> list[Tool]:
        """Tools to make available to the agent."""
        ...

    @property
    def flags(self) -> dict[str, bool]:
        """Feature flags to set (name → enabled)."""
        ...

    async def setup(self, config: dict[str, Any]) -> None:
        """Initialize runtime resources. Called when the agent starts.

        Args:
            config: The HarnessConfig (as dict) for context.
        """
        ...

    async def teardown(self) -> None:
        """Release runtime resources. Called when the agent stops."""
        ...


# ---------------------------------------------------------------------------
# SimplePlugin — concrete base class implementing Plugin
# ---------------------------------------------------------------------------


class SimplePlugin:
    """A concrete Plugin implementation with list-based configuration.

    Plain English: This is a "fill-in-the-blanks" plugin template.
    You give it a name and lists of processors/tools/flags, and it
    satisfies the Plugin protocol. The setup/teardown methods are
    no-ops by default — override them for custom lifecycle behavior.

    Use this as a base class for your own plugins, or create instances
    directly for simple cases.

    Example::

        plugin = SimplePlugin(
            name="my_plugin",
            processors=[(my_processor, "step_end", 0)],
            tools=[my_tool],
            flags={"verbose": True},
        )

        # Or subclass for custom lifecycle:
        class DbPlugin(SimplePlugin):
            async def setup(self, config):
                self.db = await connect(config["db_url"])
            async def teardown(self):
                await self.db.close()
    """

    def __init__(
        self,
        name: str,
        processors: list[tuple[Processor, str, int]] | None = None,
        tools: list[Tool] | None = None,
        flags: dict[str, bool] | None = None,
    ) -> None:
        """Initialize a SimplePlugin.

        Args:
            name: Unique plugin name.
            processors: List of (processor, hook_point, order) triples.
            tools: List of Tool instances.
            flags: Dict mapping flag names to boolean values.
        """
        self._name = name
        self._processors: list[tuple[Processor, str, int]] = list(processors) if processors else []
        self._tools: list[Tool] = list(tools) if tools else []
        self._flags: dict[str, bool] = dict(flags) if flags else {}

    @property
    def name(self) -> str:
        """This plugin's unique name."""
        return self._name

    @property
    def processors(self) -> list[tuple[Processor, str, int]]:
        """Processors to install, as (processor, hook_point, order) triples."""
        return list(self._processors)

    @property
    def tools(self) -> list[Tool]:
        """Tools to make available."""
        return list(self._tools)

    @property
    def flags(self) -> dict[str, bool]:
        """Feature flags to set."""
        return dict(self._flags)

    async def setup(self, config: dict[str, Any]) -> None:
        """Initialize runtime resources. Default: no-op.

        Override in subclasses for custom initialization (e.g., database
        connections, file handles, cached data).

        Args:
            config: The HarnessConfig as a dict, for context during setup.
        """
        pass

    async def teardown(self) -> None:
        """Release runtime resources. Default: no-op.

        Override in subclasses for custom cleanup (e.g., close connections,
        flush buffers, release locks).
        """
        pass


# ---------------------------------------------------------------------------
# PluginLoader — registry for discovering and loading plugins
# ---------------------------------------------------------------------------


class PluginLoader:
    """A registry that manages plugin instances by name.

    Think of PluginLoader as the "app store" for plugins. You can:
    - register(): Install a plugin (like downloading an app)
    - get(): Look up a plugin by name
    - list(): See all installed plugin names

    The loader holds Plugin instances, not classes — the plugins are
    already constructed and ready to be integrated into a builder.
    """

    def __init__(self) -> None:
        """Initialize an empty loader with no plugins."""
        self._plugins: dict[str, Plugin] = {}

    def register(self, plugin: Plugin) -> None:
        """Register a plugin, making it available for lookup.

        Args:
            plugin: The Plugin instance to register.

        Raises:
            ValueError: If a plugin with the same name is already registered.
        """
        if plugin.name in self._plugins:
            raise ValueError(
                f"Plugin '{plugin.name}' is already registered. "
                "Use a different name or unregister first."
            )
        self._plugins[plugin.name] = plugin

    def get(self, name: str) -> Plugin | None:
        """Look up a plugin by name.

        Args:
            name: The plugin name to search for.

        Returns:
            The Plugin if found, None otherwise.
        """
        return self._plugins.get(name)

    def list(self) -> list[str]:
        """Get a list of all registered plugin names.

        Returns:
            List of plugin name strings.
        """
        return list(self._plugins.keys())

    def __len__(self) -> int:
        """Return the number of registered plugins."""
        return len(self._plugins)
