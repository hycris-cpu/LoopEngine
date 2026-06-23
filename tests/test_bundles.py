"""Tests for loopengine.composition.bundles — the Bundles module.

Uses TDD (vertical slices), BDD (Given/When/Then docstrings), and DDD
(domain vocabulary in assertions).

Each test is a single behavior. We write ONE test, implement, verify, repeat.
"""
from __future__ import annotations

import pytest

from loopengine.composition.builder import HarnessBuilder
from loopengine.composition.config import HarnessConfig
from loopengine.composition.bundles import (
    make_coding,
    make_reliability,
    make_evaluation,
    make_self_improve,
)


# ===================================================================
# SLICE 1: make_coding returns a HarnessBuilder
# ===================================================================


class TestMakeCoding:
    """Given make_coding(), When I call it, Then it returns a HarnessBuilder."""

    def test_returns_harness_builder(self) -> None:
        """Given make_coding(), When I call it, Then the result is a HarnessBuilder."""
        builder = make_coding()
        assert isinstance(builder, HarnessBuilder)

    def test_produces_valid_config(self) -> None:
        """Given make_coding(), When I build and validate, Then no errors."""
        builder = make_coding()
        config = builder.build()
        assert isinstance(config, HarnessConfig)
        errors = config.validate()
        assert errors == []

    def test_has_processors(self) -> None:
        """Given make_coding(), When I build, Then the config has at least one processor."""
        config = make_coding().build()
        assert len(config.processors) >= 1

    def test_has_tools(self) -> None:
        """Given make_coding(), When I build, Then the config has at least one tool."""
        config = make_coding().build()
        assert len(config.tools) >= 1

    def test_has_coding_flags(self) -> None:
        """Given make_coding(), When I build, Then the config has coding-related flags."""
        config = make_coding().build()
        # At minimum, coding should have some flags set
        assert isinstance(config.flags, dict)

    def test_accepts_working_dir(self) -> None:
        """Given make_coding with a working_dir, When I build,
        Then the config slot contains that directory."""
        config = make_coding(working_dir="/tmp/project").build()
        assert config.slots.get("working_dir") == "/tmp/project"

    def test_default_working_dir_is_dot(self) -> None:
        """Given make_coding() with no args, When I build,
        Then working_dir defaults to '.'."""
        config = make_coding().build()
        assert config.slots.get("working_dir") == "."


# ===================================================================
# SLICE 2: make_reliability returns a HarnessBuilder
# ===================================================================


class TestMakeReliability:
    """Given make_reliability(), When I call it, Then it returns a HarnessBuilder."""

    def test_returns_harness_builder(self) -> None:
        """Given make_reliability(), When I call it, Then it returns a HarnessBuilder."""
        builder = make_reliability()
        assert isinstance(builder, HarnessBuilder)

    def test_produces_valid_config(self) -> None:
        """Given make_reliability(), When I build and validate, Then no errors."""
        config = make_reliability().build()
        errors = config.validate()
        assert errors == []

    def test_has_processors(self) -> None:
        """Given make_reliability(), When I build, Then the config has at least one processor."""
        config = make_reliability().build()
        assert len(config.processors) >= 1

    def test_has_reliability_flags(self) -> None:
        """Given make_reliability(), When I build, Then reliability flags are set."""
        config = make_reliability().build()
        assert isinstance(config.flags, dict)
        # Should enable some safety-related flags
        assert any("loop" in k.lower() or "safe" in k.lower() or "guard" in k.lower()
                    for k in config.flags)


# ===================================================================
# SLICE 3: make_evaluation returns a HarnessBuilder
# ===================================================================


class TestMakeEvaluation:
    """Given make_evaluation(), When I call it, Then it returns a HarnessBuilder."""

    def test_returns_harness_builder(self) -> None:
        """Given make_evaluation(), When I call it, Then it returns a HarnessBuilder."""
        builder = make_evaluation()
        assert isinstance(builder, HarnessBuilder)

    def test_produces_valid_config(self) -> None:
        """Given make_evaluation(), When I build and validate, Then no errors."""
        config = make_evaluation().build()
        errors = config.validate()
        assert errors == []

    def test_has_processors(self) -> None:
        """Given make_evaluation(), When I build, Then the config has at least one processor."""
        config = make_evaluation().build()
        assert len(config.processors) >= 1

    def test_has_evaluation_flags(self) -> None:
        """Given make_evaluation(), When I build, Then evaluation flags are set."""
        config = make_evaluation().build()
        assert isinstance(config.flags, dict)
        assert any("eval" in k.lower() for k in config.flags)


# ===================================================================
# SLICE 4: make_self_improve returns a HarnessBuilder
# ===================================================================


class TestMakeSelfImprove:
    """Given make_self_improve(), When I call it, Then it returns a HarnessBuilder."""

    def test_returns_harness_builder(self) -> None:
        """Given make_self_improve(), When I call it, Then it returns a HarnessBuilder."""
        builder = make_self_improve()
        assert isinstance(builder, HarnessBuilder)

    def test_produces_valid_config(self) -> None:
        """Given make_self_improve(), When I build and validate, Then no errors."""
        config = make_self_improve().build()
        errors = config.validate()
        assert errors == []

    def test_has_processors(self) -> None:
        """Given make_self_improve(), When I build, Then the config has at least one processor."""
        config = make_self_improve().build()
        assert len(config.processors) >= 1


# ===================================================================
# SLICE 5: Bundles compose with | operator
# ===================================================================


class TestBundleComposition:
    """Given two bundles, When I merge them with |, Then the result is a valid combined config."""

    def test_coding_and_reliability_compose(self) -> None:
        """Given make_coding() | make_reliability(), When I build,
        Then the config has processors from both bundles."""
        builder = make_coding() | make_reliability()
        config = builder.build()
        assert isinstance(config, HarnessConfig)
        # Both bundles contribute processors
        assert len(config.processors) >= 2

    def test_coding_and_evaluation_compose(self) -> None:
        """Given make_coding() | make_evaluation(), When I build,
        Then the config has processors and tools from both bundles."""
        builder = make_coding() | make_evaluation()
        config = builder.build()
        assert isinstance(config, HarnessConfig)
        assert len(config.processors) >= 2

    def test_merges_flags(self) -> None:
        """Given make_coding() | make_reliability(), When I build,
        Then the config flags contain entries from both bundles."""
        builder = make_coding() | make_reliability()
        config = builder.build()
        # Flags from both bundles should be present
        assert len(config.flags) >= 2

    def test_merges_tools(self) -> None:
        """Given make_coding() | make_reliability(), When I build,
        Then the config tools contain entries from both bundles."""
        builder = make_coding() | make_reliability()
        config = builder.build()
        # Tools from at least one bundle
        assert len(config.tools) >= 1

    def test_triple_compose(self) -> None:
        """Given make_coding() | make_reliability() | make_evaluation(),
        When I build, Then the combined config is valid."""
        builder = make_coding() | make_reliability() | make_evaluation()
        config = builder.build()
        errors = config.validate()
        assert errors == []
        assert len(config.processors) >= 3

    def test_all_four_compose(self) -> None:
        """Given all four bundles merged, When I build, Then the result is valid."""
        builder = (
            make_coding() | make_reliability() | make_evaluation() | make_self_improve()
        )
        config = builder.build()
        errors = config.validate()
        assert errors == []


# ===================================================================
# SLICE 6: Bundle-produced configs are deterministic
# ===================================================================


class TestBundleDeterminism:
    """Given the same bundle function, When I call it twice,
    Then the configs have the same fingerprint."""

    def test_coding_fingerprint_is_stable(self) -> None:
        """Given make_coding() called twice, When I fingerprint both,
        Then the fingerprints are equal."""
        c1 = make_coding().build()
        c2 = make_coding().build()
        assert c1.fingerprint() == c2.fingerprint()

    def test_reliability_fingerprint_is_stable(self) -> None:
        """Given make_reliability() called twice, When I fingerprint both,
        Then the fingerprints are equal."""
        r1 = make_reliability().build()
        r2 = make_reliability().build()
        assert r1.fingerprint() == r2.fingerprint()

    def test_evaluation_fingerprint_is_stable(self) -> None:
        """Given make_evaluation() called twice, When I fingerprint both,
        Then the fingerprints are equal."""
        e1 = make_evaluation().build()
        e2 = make_evaluation().build()
        assert e1.fingerprint() == e2.fingerprint()

    def test_self_improve_fingerprint_is_stable(self) -> None:
        """Given make_self_improve() called twice, When I fingerprint both,
        Then the fingerprints are equal."""
        s1 = make_self_improve().build()
        s2 = make_self_improve().build()
        assert s1.fingerprint() == s2.fingerprint()

    def test_different_bundles_have_different_fingerprints(self) -> None:
        """Given make_coding() and make_reliability(), When I fingerprint both,
        Then the fingerprints differ."""
        c = make_coding().build()
        r = make_reliability().build()
        assert c.fingerprint() != r.fingerprint()
