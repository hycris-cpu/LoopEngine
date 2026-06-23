"""HarnessBuilder is an IMMUTABLE factory for assembling agent configs.

Plain English: Think of HarnessBuilder like ordering a custom car.
Each method call adds a feature, but instead of modifying your current order,
you get a NEW order with the feature added. Your old order is unchanged.

This "immutable" design prevents a huge class of bugs:
- No accidental shared state between different configs
- Safe to compose builders: (coding_builder | reliability_builder)
- Thread-safe by design

The | operator lets you MERGE two builders:
  builder = make_coding() | make_reliability()
This creates a new builder with processors/tools from both.
If there are conflicts (same singleton group), it raises an error.
"""

from __future__ import annotations

from typing import Any

from loopengine.primitives.processors import Processor
from loopengine.primitives.tools import Tool

from .config import HarnessConfig, ProcessorEntry
from .flags import FeatureFlag, FlagRegistry


# ---------------------------------------------------------------------------
# HarnessBuilder — the immutable config factory
# ---------------------------------------------------------------------------


class HarnessBuilder:
    """An immutable builder for assembling HarnessConfig objects.

    Plain English: This is like a car configurator website. Each click
    (method call) creates a NEW configuration — your previous selections
    are never modified. When you're done, you hit "Build" (build())
    and get the final config.

    IMMUTABILITY GUARANTEE:
    Every method (add, tool, flag, slot) returns a NEW HarnessBuilder.
    The original builder is NEVER modified. This is enforced by copying
    all internal lists/dicts on each method call.

    MERGE OPERATOR (|):
    builder = coding | reliability
    Creates a new builder combining both. Raises ValueError if there are
    singleton group conflicts (two processors claiming the same exclusive role).

    Attributes:
        _processors: The accumulated ProcessorEntry list.
        _tools: The accumulated Tool list.
        _flags: The accumulated flag dict.
        _slots: The accumulated slot dict.
        _singleton_groups: Set of singleton group names for conflict detection.
    """

    def __init__(
        self,
        processors: list[ProcessorEntry] | None = None,
        tools: list[Tool] | None = None,
        flags: dict[str, bool] | None = None,
        slots: dict[str, Any] | None = None,
        singleton_groups: set[str] | None = None,
    ) -> None:
        """Initialize a HarnessBuilder (usually via the no-arg constructor).

        Args:
            processors: Initial processor entries (defaults to empty).
            tools: Initial tools (defaults to empty).
            flags: Initial flags (defaults to empty).
            slots: Initial slots (defaults to empty).
            singleton_groups: Singleton group names for merge conflict detection.
        """
        self._processors: list[ProcessorEntry] = list(processors) if processors else []
        self._tools: list[Tool] = list(tools) if tools else []
        self._flags: dict[str, bool] = dict(flags) if flags else {}
        self._slots: dict[str, Any] = dict(slots) if slots else {}
        self._singleton_groups: set[str] = set(singleton_groups) if singleton_groups else set()

    def add(
        self,
        processor: Processor,
        hook: str = "step_end",
        order: int = 0,
        singleton_group: str | None = None,
    ) -> HarnessBuilder:
        """Register a processor at a hook point. Returns a NEW builder.

        BDD: Given a builder, When I add a processor, Then build() produces
             a config containing that processor. The original builder is unchanged.

        Args:
            processor: The Processor to register.
            hook: Which hook point (e.g., "step_end", "after_model").
            order: Priority within the hook (lower = runs first).
            singleton_group: Optional group name for merge conflict detection.
                If two builders both add a processor in the same singleton_group,
                merging them with | raises ValueError.

        Returns:
            A NEW HarnessBuilder with the processor added.
        """
        entry = ProcessorEntry(processor=processor, hook=hook, order=order)
        new_groups = set(self._singleton_groups)
        if singleton_group:
            if singleton_group in self._singleton_groups:
                raise ValueError(
                    f"Singleton group '{singleton_group}' already has a processor "
                    f"in this builder. Cannot add '{processor.name}'."
                )
            new_groups.add(singleton_group)
        return HarnessBuilder(
            processors=self._processors + [entry],
            tools=list(self._tools),
            flags=dict(self._flags),
            slots=dict(self._slots),
            singleton_groups=new_groups,
        )

    def tool(self, tool_instance: Tool) -> HarnessBuilder:
        """Register a tool. Returns a NEW builder.

        BDD: Given a builder, When I add a tool, Then build() produces
             a config containing that tool. The original builder is unchanged.

        Args:
            tool_instance: The Tool to make available to the agent.

        Returns:
            A NEW HarnessBuilder with the tool added.
        """
        return HarnessBuilder(
            processors=list(self._processors),
            tools=self._tools + [tool_instance],
            flags=dict(self._flags),
            slots=dict(self._slots),
            singleton_groups=set(self._singleton_groups),
        )

    def flag(self, name: str, enabled: bool = True) -> HarnessBuilder:
        """Set a feature flag. Returns a NEW builder.

        BDD: Given a builder, When I set flag "x" to True,
             Then build() produces a config where flags["x"] is True.

        Args:
            name: The flag name.
            enabled: Whether the flag is on (True) or off (False).

        Returns:
            A NEW HarnessBuilder with the flag set.
        """
        new_flags = dict(self._flags)
        new_flags[name] = enabled
        return HarnessBuilder(
            processors=list(self._processors),
            tools=list(self._tools),
            flags=new_flags,
            slots=dict(self._slots),
            singleton_groups=set(self._singleton_groups),
        )

    def slot(self, **kwargs: Any) -> HarnessBuilder:
        """Set config slots. Returns a NEW builder.

        BDD: Given a builder, When I set slot working_dir="/tmp",
             Then build() produces a config where slots["working_dir"] is "/tmp".

        Args:
            **kwargs: Key-value pairs to set as config slots.

        Returns:
            A NEW HarnessBuilder with the slots set.
        """
        new_slots = dict(self._slots)
        new_slots.update(kwargs)
        return HarnessBuilder(
            processors=list(self._processors),
            tools=list(self._tools),
            flags=dict(self._flags),
            slots=new_slots,
            singleton_groups=set(self._singleton_groups),
        )

    def plugin(self, plugin_instance: Any) -> HarnessBuilder:
        """Integrate a Plugin into this builder. Returns a NEW builder.

        Plain English: This is like plugging a USB device into your computer.
        The plugin contributes its processors, tools, and flags, and they
        all snap into place in the builder.

        A Plugin must have these attributes:
        - name: str
        - processors: list of (processor, hook, order) tuples
        - tools: list of Tool instances
        - flags: dict of flag name → boolean

        Args:
            plugin_instance: An object implementing the Plugin interface.

        Returns:
            A NEW HarnessBuilder with the plugin's parts integrated.
        """
        builder = HarnessBuilder(
            processors=list(self._processors),
            tools=list(self._tools),
            flags=dict(self._flags),
            slots=dict(self._slots),
            singleton_groups=set(self._singleton_groups),
        )
        # Add plugin's processors
        for item in plugin_instance.processors:
            if isinstance(item, tuple) and len(item) == 3:
                proc, hook, order = item
            else:
                proc = item
                hook = "step_end"
                order = 0
            builder = builder.add(proc, hook=hook, order=order)

        # Add plugin's tools
        for t in plugin_instance.tools:
            builder = builder.tool(t)

        # Add plugin's flags
        for fname, fval in plugin_instance.flags.items():
            builder = builder.flag(fname, enabled=fval)

        return builder

    def build(self) -> HarnessConfig:
        """Produce the final immutable HarnessConfig.

        BDD: Given a builder with processors, tools, flags, and slots,
             When I call build(), Then I get a HarnessConfig with all those parts.

        Returns:
            A HarnessConfig containing all accumulated parts.
        """
        return HarnessConfig(
            processors=list(self._processors),
            tools=list(self._tools),
            flags=dict(self._flags),
            slots=dict(self._slots),
        )

    def __or__(self, other: HarnessBuilder) -> HarnessBuilder:
        """Merge two builders using the | operator.

        Plain English: "I want a coding agent AND reliability safety nets."
        coding | reliability gives you a new builder with everything from both.

        Raises ValueError if both builders have processors in the same
        singleton group (conflict detection).

        Args:
            other: Another HarnessBuilder to merge with.

        Returns:
            A NEW HarnessBuilder combining both builders' parts.

        Raises:
            ValueError: If there are singleton group conflicts.
        """
        # Type check — only HarnessBuilder instances can be merged
        if not isinstance(other, HarnessBuilder):
            raise TypeError(
                f"Cannot merge HarnessBuilder with {type(other).__name__}. "
                "Use | only between two HarnessBuilder instances."
            )

        # Check for singleton group conflicts
        conflicts = self._singleton_groups & other._singleton_groups
        if conflicts:
            raise ValueError(
                f"Cannot merge builders: singleton group conflict(s) in {conflicts}. "
                "Both builders have processors claiming the same exclusive role."
            )

        # Merge all flags (other's flags override self's for same key)
        merged_flags = dict(self._flags)
        merged_flags.update(other._flags)

        # Merge all slots (other's slots override self's for same key)
        merged_slots = dict(self._slots)
        merged_slots.update(other._slots)

        return HarnessBuilder(
            processors=self._processors + other._processors,
            tools=self._tools + other._tools,
            flags=merged_flags,
            slots=merged_slots,
            singleton_groups=self._singleton_groups | other._singleton_groups,
        )

    def __repr__(self) -> str:
        """Return a human-readable representation for debugging."""
        return (
            f"HarnessBuilder("
            f"processors={len(self._processors)}, "
            f"tools={len(self._tools)}, "
            f"flags={len(self._flags)}, "
            f"slots={len(self._slots)})"
        )
