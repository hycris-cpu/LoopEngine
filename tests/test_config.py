"""Tests for the config module — HarnessConfig as the agent blueprint.

BDD scenarios:
  Given a valid HarnessConfig with processors, tools, flags, and slots,
  When I call to_dict(), Then the result is a serializable dict.
  When I call fingerprint(), Then it returns a deterministic SHA-256 hash.
  When I call validate(), Then it returns no errors for a valid config.
"""

from __future__ import annotations

import hashlib
import json

import pytest
from unittest.mock import MagicMock

from loopengine.composition.config import HarnessConfig, ProcessorEntry
from loopengine.composition.flags import FeatureFlag, FlagRegistry, flag
from loopengine.primitives.processors import MultiHookProcessor


# ---------------------------------------------------------------------------
# Helpers — lightweight mock processor and tool for testing
# ---------------------------------------------------------------------------


def _make_processor(name: str = "mock_proc") -> MultiHookProcessor:
    """Create a MultiHookProcessor with the given name."""
    return MultiHookProcessor(name=name)


def _make_tool(name: str = "mock_tool", description: str = "A mock tool"):
    """Create a minimal mock tool satisfying the Tool protocol."""
    tool = MagicMock()
    tool.name = name
    tool.description = description
    tool.input_schema = {"type": "object", "properties": {}}
    return tool


# ---------------------------------------------------------------------------
# ProcessorEntry
# ---------------------------------------------------------------------------


class TestProcessorEntry:
    """Tests for the ProcessorEntry dataclass."""

    def test_create_entry(self):
        """Given a processor, hook, and order, When I create a ProcessorEntry,
        Then all fields are stored correctly."""
        proc = _make_processor("my_proc")
        entry = ProcessorEntry(processor=proc, hook="step_end", order=5)
        assert entry.processor is proc
        assert entry.hook == "step_end"
        assert entry.order == 5

    def test_entry_defaults(self):
        """Given only a processor, When I create an entry with defaults,
        Then hook is 'step_end' and order is 0."""
        proc = _make_processor()
        entry = ProcessorEntry(processor=proc)
        assert entry.hook == "step_end"
        assert entry.order == 0

    def test_entry_to_dict(self):
        """Given a ProcessorEntry, When I serialize it,
        Then I get a dict with processor name, hook, and order."""
        proc = _make_processor("checker")
        entry = ProcessorEntry(processor=proc, hook="after_model", order=3)
        d = entry.to_dict()
        assert d == {
            "processor": "checker",
            "hook": "after_model",
            "order": 3,
        }


# ---------------------------------------------------------------------------
# HarnessConfig — the blueprint
# ---------------------------------------------------------------------------


class TestHarnessConfig:
    """Tests for the HarnessConfig dataclass."""

    def test_create_empty_config(self):
        """Given an empty HarnessConfig, When I inspect it,
        Then processors, tools, flags, and slots are all empty."""
        config = HarnessConfig()
        assert config.processors == []
        assert config.tools == []
        assert config.flags == {}
        assert config.slots == {}

    def test_create_with_processors(self):
        """Given a config with processors, When I inspect processors,
        Then they are stored as ProcessorEntry objects."""
        proc = _make_processor("p1")
        entry = ProcessorEntry(processor=proc, hook="step_end", order=0)
        config = HarnessConfig(processors=[entry])
        assert len(config.processors) == 1
        assert config.processors[0].processor.name == "p1"

    def test_create_with_tools(self):
        """Given a config with tools, When I inspect tools,
        Then they are stored correctly."""
        tool = _make_tool("search")
        config = HarnessConfig(tools=[tool])
        assert len(config.tools) == 1
        assert config.tools[0].name == "search"

    def test_create_with_flags(self):
        """Given a config with flags, When I inspect flags,
        Then they are stored as a dict of name -> bool."""
        config = HarnessConfig(flags={"verbose": True, "debug": False})
        assert config.flags == {"verbose": True, "debug": False}

    def test_create_with_slots(self):
        """Given a config with slots, When I inspect slots,
        Then they are stored as a dict of name -> value."""
        config = HarnessConfig(slots={"model": "gpt-4", "temperature": 0.7})
        assert config.slots["model"] == "gpt-4"
        assert config.slots["temperature"] == 0.7

    def test_to_dict(self):
        """Given a config with processors, tools, flags, and slots,
        When I call to_dict(), Then everything is serializable."""
        proc = _make_processor("p1")
        entry = ProcessorEntry(processor=proc, hook="step_end", order=0)
        tool = _make_tool("search", description="search tool")
        config = HarnessConfig(
            processors=[entry],
            tools=[tool],
            flags={"verbose": True},
            slots={"model": "gpt-4"},
        )
        d = config.to_dict()
        assert d["processors"] == [{"processor": "p1", "hook": "step_end", "order": 0}]
        assert d["tools"] == [{"name": "search", "description": "search tool"}]
        assert d["flags"] == {"verbose": True}
        assert d["slots"] == {"model": "gpt-4"}

    def test_fingerprint_deterministic(self):
        """Given a config, When I call fingerprint() twice,
        Then I get the same hash both times."""
        proc = _make_processor("p1")
        entry = ProcessorEntry(processor=proc, hook="step_end", order=0)
        config = HarnessConfig(
            processors=[entry],
            flags={"verbose": True},
            slots={"model": "gpt-4"},
        )
        fp1 = config.fingerprint()
        fp2 = config.fingerprint()
        assert fp1 == fp2

    def test_fingerprint_is_sha256(self):
        """Given a config, When I call fingerprint(),
        Then it is a valid SHA-256 hex string (64 hex chars)."""
        config = HarnessConfig()
        fp = config.fingerprint()
        assert len(fp) == 64
        # Should be all hex characters
        assert all(c in "0123456789abcdef" for c in fp)

    def test_fingerprint_changes_with_different_configs(self):
        """Given two configs with different processors,
        When I compare fingerprints, Then they differ."""
        proc1 = _make_processor("p1")
        proc2 = _make_processor("p2")
        config1 = HarnessConfig(processors=[ProcessorEntry(processor=proc1)])
        config2 = HarnessConfig(processors=[ProcessorEntry(processor=proc2)])
        assert config1.fingerprint() != config2.fingerprint()

    def test_fingerprint_matches_manual_hash(self):
        """Given a config, When I compute the hash manually from to_dict(),
        Then it matches the fingerprint."""
        config = HarnessConfig(flags={"x": True}, slots={"y": 42})
        expected = hashlib.sha256(
            json.dumps(config.to_dict(), sort_keys=True).encode()
        ).hexdigest()
        assert config.fingerprint() == expected

    def test_validate_empty_config_is_valid(self):
        """Given an empty config, When I validate(), Then no errors are returned."""
        config = HarnessConfig()
        errors = config.validate()
        assert errors == []

    def test_validate_with_valid_data(self):
        """Given a config with processors, tools, flags, and slots,
        When I validate(), Then no errors are returned."""
        proc = _make_processor("p1")
        entry = ProcessorEntry(processor=proc, hook="step_end", order=0)
        tool = _make_tool("search")
        config = HarnessConfig(
            processors=[entry],
            tools=[tool],
            flags={"verbose": True},
            slots={"model": "gpt-4"},
        )
        errors = config.validate()
        assert errors == []

    def test_validate_invalid_hook(self):
        """Given a config with a processor using an invalid hook name,
        When I validate(), Then an error is returned."""
        proc = _make_processor("p1")
        entry = ProcessorEntry(processor=proc, hook="invalid_hook", order=0)
        config = HarnessConfig(processors=[entry])
        errors = config.validate()
        assert len(errors) > 0
        assert any("invalid_hook" in e for e in errors)

    def test_validate_tool_without_name(self):
        """Given a config with a tool missing a name,
        When I validate(), Then an error is returned."""
        tool = MagicMock()
        tool.name = ""
        tool.description = "something"
        config = HarnessConfig(tools=[tool])
        errors = config.validate()
        assert len(errors) > 0
        assert any("name" in e.lower() for e in errors)
