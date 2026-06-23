"""Tests for the flags module — feature flags as light switches.

BDD scenarios:
  Given a fresh FlagRegistry, When I create a flag with default=False,
  Then is_enabled() returns False and get() returns False.
"""

from __future__ import annotations

import pytest

from loopengine.composition.flags import FeatureFlag, FlagRegistry, flag


# ---------------------------------------------------------------------------
# FeatureFlag — individual flag
# ---------------------------------------------------------------------------


class TestFeatureFlag:
    """Tests for the FeatureFlag dataclass."""

    def test_create_flag_with_defaults(self):
        """Given a FeatureFlag with only a name, When I inspect it,
        Then default is False, current value is False, and description is empty."""
        f = FeatureFlag(name="test_flag")
        assert f.name == "test_flag"
        assert f.default is False
        assert f.value is False
        assert f.description == ""

    def test_create_flag_with_custom_default(self):
        """Given a FeatureFlag with default=True, When I inspect it,
        Then current value matches the default."""
        f = FeatureFlag(name="verbose", default=True, description="Enable verbose mode")
        assert f.default is True
        assert f.value is True
        assert f.description == "Enable verbose mode"

    def test_is_enabled_reflects_value(self):
        """Given a FeatureFlag, When I check is_enabled,
        Then it returns the current value."""
        f = FeatureFlag(name="x")
        assert f.is_enabled is False
        f = FeatureFlag(name="x", default=True)
        assert f.is_enabled is True

    def test_flag_equality_by_name(self):
        """Given two FeatureFlags with the same name, When I compare them,
        Then they are equal (flags are identified by name)."""
        f1 = FeatureFlag(name="x", default=True)
        f2 = FeatureFlag(name="x", default=False)
        # Same name, different defaults — name is the identity
        assert f1.name == f2.name

    def test_flag_to_dict(self):
        """Given a FeatureFlag, When I serialize it, Then I get a dict with all fields."""
        f = FeatureFlag(name="debug", default=True, description="debug mode")
        d = f.to_dict()
        assert d == {
            "name": "debug",
            "default": True,
            "value": True,
            "description": "debug mode",
        }


# ---------------------------------------------------------------------------
# FlagRegistry — manages a collection of flags
# ---------------------------------------------------------------------------


class TestFlagRegistry:
    """Tests for the FlagRegistry class."""

    def test_create_registry(self):
        """Given a new FlagRegistry, When I inspect it, Then it has no flags."""
        reg = FlagRegistry()
        assert reg.all() == {}

    def test_register_and_get(self):
        """Given a registry, When I register a flag and get it by name,
        Then the flag is returned."""
        reg = FlagRegistry()
        reg.register(FeatureFlag(name="verbose", default=True))
        result = reg.get("verbose")
        assert result is not None
        assert result.name == "verbose"
        assert result.value is True

    def test_get_nonexistent_returns_none(self):
        """Given an empty registry, When I get a non-existent flag,
        Then None is returned."""
        reg = FlagRegistry()
        assert reg.get("missing") is None

    def test_set_updates_value(self):
        """Given a registry with a flag, When I set() it to True,
        Then the flag's value is True."""
        reg = FlagRegistry()
        reg.register(FeatureFlag(name="x", default=False))
        reg.set("x", True)
        assert reg.get("x").value is True

    def test_set_nonexistent_raises(self):
        """Given an empty registry, When I set() a non-existent flag,
        Then KeyError is raised."""
        reg = FlagRegistry()
        with pytest.raises(KeyError):
            reg.set("missing", True)

    def test_is_enabled(self):
        """Given a registry with a flag set to True, When I call is_enabled(),
        Then it returns True."""
        reg = FlagRegistry()
        reg.register(FeatureFlag(name="x", default=False))
        reg.set("x", True)
        assert reg.is_enabled("x") is True
        assert reg.is_enabled("y") is False  # non-existent returns False

    def test_is_enabled_default_false(self):
        """Given a registry with a flag defaulting to False, When I call is_enabled(),
        Then it returns False without having set the value."""
        reg = FlagRegistry()
        reg.register(FeatureFlag(name="x"))
        assert reg.is_enabled("x") is False

    def test_reset_to_default(self):
        """Given a registry with a modified flag, When I reset(),
        Then the value returns to the default."""
        reg = FlagRegistry()
        reg.register(FeatureFlag(name="x", default=False))
        reg.set("x", True)
        assert reg.get("x").value is True
        reg.reset("x")
        assert reg.get("x").value is False

    def test_reset_all(self):
        """Given a registry with multiple modified flags, When I reset all,
        Then all values return to defaults."""
        reg = FlagRegistry()
        reg.register(FeatureFlag(name="a", default=False))
        reg.register(FeatureFlag(name="b", default=True))
        reg.set("a", True)
        reg.set("b", False)
        reg.reset()  # no args = reset all
        assert reg.get("a").value is False
        assert reg.get("b").value is True

    def test_all_returns_dict(self):
        """Given a registry with multiple flags, When I call all(),
        Then I get a dict mapping name -> FeatureFlag."""
        reg = FlagRegistry()
        reg.register(FeatureFlag(name="a", default=False))
        reg.register(FeatureFlag(name="b", default=True))
        result = reg.all()
        assert set(result.keys()) == {"a", "b"}
        assert isinstance(result["a"], FeatureFlag)

    def test_register_duplicate_raises(self):
        """Given a registry with a flag, When I register another with the same name,
        Then ValueError is raised."""
        reg = FlagRegistry()
        reg.register(FeatureFlag(name="x"))
        with pytest.raises(ValueError):
            reg.register(FeatureFlag(name="x"))


# ---------------------------------------------------------------------------
# flag() convenience function
# ---------------------------------------------------------------------------


class TestFlagConvenience:
    """Tests for the flag() convenience function."""

    def test_flag_creates_and_registers(self):
        """Given a registry, When I call flag(reg, 'x'),
        Then the flag is registered and returned."""
        reg = FlagRegistry()
        f = flag(reg, "x", default=True, description="test")
        assert f.name == "x"
        assert f.value is True
        assert reg.get("x") is f

    def test_flag_defaults(self):
        """Given a registry, When I call flag(reg, 'x') with no args,
        Then the flag has default=False and empty description."""
        reg = FlagRegistry()
        f = flag(reg, "x")
        assert f.default is False
        assert f.description == ""
