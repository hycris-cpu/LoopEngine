"""Tests for the builder module — HarnessBuilder as the immutable factory.

BDD scenarios:
  Given a HarnessBuilder, When I add a processor, Then a NEW builder is returned
  and the original is unchanged (immutability).
  Given two builders, When I merge them with |, Then a new builder with both's
  contents is returned.
"""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock

from loopengine.composition.builder import HarnessBuilder
from loopengine.composition.config import HarnessConfig, ProcessorEntry
from loopengine.composition.flags import FlagRegistry
from loopengine.primitives.processors import MultiHookProcessor


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_processor(name: str = "mock_proc") -> MultiHookProcessor:
    """Create a MultiHookProcessor with the given name."""
    return MultiHookProcessor(name=name)


def _make_tool(name: str = "mock_tool", description: str = "A mock tool"):
    """Create a minimal mock tool."""
    tool = MagicMock()
    tool.name = name
    tool.description = description
    tool.input_schema = {"type": "object", "properties": {}}
    return tool


# ---------------------------------------------------------------------------
# HarnessBuilder — basic construction
# ---------------------------------------------------------------------------


class TestHarnessBuilderBasic:
    """Tests for basic HarnessBuilder operations."""

    def test_create_empty_builder(self):
        """Given an empty HarnessBuilder, When I inspect it,
        Then it has no processors, tools, flags, or slots."""
        builder = HarnessBuilder()
        assert builder._processors == []
        assert builder._tools == []
        assert builder._flags == {}
        assert builder._slots == {}

    def test_add_processor(self):
        """Given a builder, When I add a processor,
        Then a NEW builder is returned with the processor."""
        proc = _make_processor("p1")
        builder = HarnessBuilder()
        builder2 = builder.add(proc, hook="step_end", order=5)
        # Original is unchanged
        assert builder._processors == []
        # New builder has the processor
        assert len(builder2._processors) == 1
        entry = builder2._processors[0]
        assert entry.processor.name == "p1"
        assert entry.hook == "step_end"
        assert entry.order == 5

    def test_add_processor_defaults(self):
        """Given a builder, When I add a processor with default args,
        Then hook is 'step_end' and order is 0."""
        proc = _make_processor("p1")
        builder = HarnessBuilder()
        builder2 = builder.add(proc)
        entry = builder2._processors[0]
        assert entry.hook == "step_end"
        assert entry.order == 0

    def test_add_tool(self):
        """Given a builder, When I add a tool,
        Then a NEW builder is returned with the tool."""
        tool = _make_tool("search")
        builder = HarnessBuilder()
        builder2 = builder.tool(tool)
        assert builder._tools == []
        assert len(builder2._tools) == 1
        assert builder2._tools[0].name == "search"

    def test_set_flag(self):
        """Given a builder, When I set a flag,
        Then a NEW builder is returned with the flag set."""
        builder = HarnessBuilder()
        builder2 = builder.flag("verbose", enabled=True)
        assert builder._flags == {}
        assert builder2._flags == {"verbose": True}

    def test_set_flag_default_enabled(self):
        """Given a builder, When I set a flag without specifying enabled,
        Then the flag defaults to True."""
        builder = HarnessBuilder()
        builder2 = builder.flag("debug")
        assert builder2._flags == {"debug": True}

    def test_set_flag_disabled(self):
        """Given a builder, When I set a flag with enabled=False,
        Then the flag is False."""
        builder = HarnessBuilder()
        builder2 = builder.flag("verbose", enabled=False)
        assert builder2._flags == {"verbose": False}

    def test_set_slot(self):
        """Given a builder, When I set a slot,
        Then a NEW builder is returned with the slot set."""
        builder = HarnessBuilder()
        builder2 = builder.slot(model="gpt-4", temperature=0.7)
        assert builder._slots == {}
        assert builder2._slots == {"model": "gpt-4", "temperature": 0.7}

    def test_set_multiple_slots(self):
        """Given a builder, When I set slots in multiple calls,
        Then all slots are accumulated."""
        builder = HarnessBuilder()
        builder2 = builder.slot(model="gpt-4")
        builder3 = builder2.slot(temperature=0.7)
        assert builder3._slots == {"model": "gpt-4", "temperature": 0.7}


# ---------------------------------------------------------------------------
# HarnessBuilder — immutability
# ---------------------------------------------------------------------------


class TestHarnessBuilderImmutability:
    """Tests proving that builder operations return NEW instances."""

    def test_add_returns_new_instance(self):
        """Given a builder, When I call add(), Then a different object is returned."""
        builder = HarnessBuilder()
        builder2 = builder.add(_make_processor("p1"))
        assert builder is not builder2

    def test_tool_returns_new_instance(self):
        """Given a builder, When I call tool(), Then a different object is returned."""
        builder = HarnessBuilder()
        builder2 = builder.tool(_make_tool("t1"))
        assert builder is not builder2

    def test_flag_returns_new_instance(self):
        """Given a builder, When I call flag(), Then a different object is returned."""
        builder = HarnessBuilder()
        builder2 = builder.flag("x")
        assert builder is not builder2

    def test_slot_returns_new_instance(self):
        """Given a builder, When I call slot(), Then a different object is returned."""
        builder = HarnessBuilder()
        builder2 = builder.slot(x=1)
        assert builder is not builder2

    def test_original_unchanged_after_multiple_adds(self):
        """Given a builder, When I chain multiple operations,
        Then the original is still empty."""
        original = HarnessBuilder()
        _ = original.add(_make_processor("p1")).tool(_make_tool("t1")).flag("x")
        assert original._processors == []
        assert original._tools == []
        assert original._flags == {}

    def test_branching_from_same_builder(self):
        """Given one builder, When I create two branches,
        Then each branch is independent."""
        base = HarnessBuilder()
        branch_a = base.add(_make_processor("p1"))
        branch_b = base.add(_make_processor("p2"))
        assert branch_a._processors[0].processor.name == "p1"
        assert branch_b._processors[0].processor.name == "p2"
        assert len(base._processors) == 0


# ---------------------------------------------------------------------------
# HarnessBuilder — build()
# ---------------------------------------------------------------------------


class TestHarnessBuilderBuild:
    """Tests for building a HarnessConfig from a builder."""

    def test_build_produces_config(self):
        """Given a builder, When I call build(),
        Then I get a HarnessConfig."""
        builder = HarnessBuilder()
        config = builder.build()
        assert isinstance(config, HarnessConfig)

    def test_build_with_all_parts(self):
        """Given a builder with processors, tools, flags, and slots,
        When I call build(), Then the config contains everything."""
        proc = _make_processor("p1")
        tool = _make_tool("search")
        config = (
            HarnessBuilder()
            .add(proc, hook="after_model", order=1)
            .tool(tool)
            .flag("verbose")
            .slot(model="gpt-4")
            .build()
        )
        assert len(config.processors) == 1
        assert config.processors[0].processor.name == "p1"
        assert config.processors[0].hook == "after_model"
        assert config.processors[0].order == 1
        assert len(config.tools) == 1
        assert config.tools[0].name == "search"
        assert config.flags == {"verbose": True}
        assert config.slots == {"model": "gpt-4"}

    def test_build_preserves_order(self):
        """Given a builder with multiple processors, When I build(),
        Then processors are in the order they were added."""
        config = (
            HarnessBuilder()
            .add(_make_processor("first"), order=0)
            .add(_make_processor("second"), order=1)
            .add(_make_processor("third"), order=2)
            .build()
        )
        names = [pe.processor.name for pe in config.processors]
        assert names == ["first", "second", "third"]


# ---------------------------------------------------------------------------
# HarnessBuilder — merge with |
# ---------------------------------------------------------------------------


class TestHarnessBuilderMerge:
    """Tests for the | operator (merge)."""

    def test_merge_two_builders(self):
        """Given two builders, When I merge them with |,
        Then the result contains processors and tools from both."""
        a = HarnessBuilder().add(_make_processor("p1"))
        b = HarnessBuilder().add(_make_processor("p2"))
        merged = a | b
        assert len(merged._processors) == 2
        names = [pe.processor.name for pe in merged._processors]
        assert "p1" in names
        assert "p2" in names

    def test_merge_tools(self):
        """Given two builders with different tools, When I merge,
        Then both tools are present."""
        a = HarnessBuilder().tool(_make_tool("search"))
        b = HarnessBuilder().tool(_make_tool("calc"))
        merged = a | b
        assert len(merged._tools) == 2

    def test_merge_flags(self):
        """Given two builders with different flags, When I merge,
        Then all flags are present."""
        a = HarnessBuilder().flag("verbose")
        b = HarnessBuilder().flag("debug")
        merged = a | b
        assert merged._flags == {"verbose": True, "debug": True}

    def test_merge_slots(self):
        """Given two builders with different slots, When I merge,
        Then all slots are present."""
        a = HarnessBuilder().slot(model="gpt-4")
        b = HarnessBuilder().slot(temperature=0.7)
        merged = a | b
        assert merged._slots == {"model": "gpt-4", "temperature": 0.7}

    def test_merge_right_overrides_flag(self):
        """Given two builders with the same flag set to different values,
        When I merge, Then the right builder's value wins."""
        a = HarnessBuilder().flag("verbose", enabled=True)
        b = HarnessBuilder().flag("verbose", enabled=False)
        merged = a | b
        assert merged._flags["verbose"] is False

    def test_merge_right_overrides_slot(self):
        """Given two builders with the same slot set to different values,
        When I merge, Then the right builder's value wins."""
        a = HarnessBuilder().slot(model="gpt-4")
        b = HarnessBuilder().slot(model="claude-3")
        merged = a | b
        assert merged._slots["model"] == "claude-3"

    def test_merge_originals_unchanged(self):
        """Given two builders merged with |,
        Then both originals are unchanged."""
        a = HarnessBuilder().add(_make_processor("p1"))
        b = HarnessBuilder().add(_make_processor("p2"))
        _ = a | b
        assert len(a._processors) == 1
        assert len(b._processors) == 1
        assert a._processors[0].processor.name == "p1"
        assert b._processors[0].processor.name == "p2"

    def test_merge_produces_valid_config(self):
        """Given two builders merged with |, When I build(),
        Then I get a valid config."""
        a = HarnessBuilder().add(_make_processor("p1")).flag("verbose")
        b = HarnessBuilder().tool(_make_tool("search")).slot(model="gpt-4")
        config = (a | b).build()
        assert len(config.processors) == 1
        assert len(config.tools) == 1
        assert config.flags == {"verbose": True}
        assert config.slots == {"model": "gpt-4"}

    def test_merge_with_non_builder_raises(self):
        """Given a builder and a non-builder, When I merge,
        Then TypeError is raised."""
        builder = HarnessBuilder()
        with pytest.raises(TypeError):
            _ = builder | "not a builder"

    def test_chained_merge(self):
        """Given three builders, When I chain merges,
        Then all contents are combined."""
        a = HarnessBuilder().add(_make_processor("p1"))
        b = HarnessBuilder().add(_make_processor("p2"))
        c = HarnessBuilder().add(_make_processor("p3"))
        merged = a | b | c
        assert len(merged._processors) == 3

    def test_merge_conflict_same_singleton_group_raises(self):
        """Given two builders that register processors in the same singleton group,
        When I merge, Then ValueError is raised for conflict."""
        proc1 = _make_processor("p1")
        proc2 = _make_processor("p2")
        # Use the processor name as the singleton group
        a = HarnessBuilder().add(proc1, singleton_group="my_singleton")
        b = HarnessBuilder().add(proc2, singleton_group="my_singleton")
        with pytest.raises(ValueError, match="singleton"):
            _ = a | b


# ---------------------------------------------------------------------------
# HarnessBuilder — repr
# ---------------------------------------------------------------------------


class TestHarnessBuilderRepr:
    """Tests for the __repr__ method."""

    def test_repr_empty(self):
        """Given an empty builder, When I repr it,
        Then it shows HarnessBuilder with zero counts."""
        builder = HarnessBuilder()
        r = repr(builder)
        assert "HarnessBuilder" in r
        assert "processors=0" in r
        assert "tools=0" in r

    def test_repr_with_contents(self):
        """Given a builder with contents, When I repr it,
        Then it shows the correct counts."""
        builder = (
            HarnessBuilder()
            .add(_make_processor("p1"))
            .tool(_make_tool("t1"))
            .flag("verbose")
            .slot(model="gpt-4")
        )
        r = repr(builder)
        assert "processors=1" in r
        assert "tools=1" in r
        assert "flags=1" in r
        assert "slots=1" in r
