"""Tests for the Promotion Gate — quality control for self-modifications.

BDD Scenarios:
- Given a PromotionGate, When I create it, Then thresholds are stored
- Given improved benchmark results, When I validate, Then promoted=True
- Given regressed benchmark results, When I validate, Then promoted=False
- Given unsafe mods, When I validate, Then promoted=False
- Given marginal improvement, When I validate, Then promoted=False (below threshold)
- Given zero regression tolerance, When I validate, Then any regression is rejected
"""

import pytest
from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Stubs for dependencies
# ---------------------------------------------------------------------------

try:
    from loopengine.evolution.code_mod import CodeMod, CodeModSet
except ImportError:
    @dataclass(frozen=True)
    class CodeMod:
        target_file: str = ""
        description: str = ""
        diff: str = ""
        rationale: str = ""
        expected_impact: str = ""
        def to_dict(self): return {}
        def is_safe(self) -> bool: return True

    @dataclass(frozen=True)
    class CodeModSet:
        mods: tuple = ()
        def is_safe(self) -> bool: return True
        def apply_to(self, files): return files


try:
    from loopengine.evaluation.benchmark import BenchmarkResult
except ImportError:
    @dataclass(frozen=True)
    class BenchmarkResult:
        scores: dict = field(default_factory=dict)
        aggregate: dict = field(default_factory=dict)


try:
    from loopengine.primitives.events import EvalResult
except ImportError:
    @dataclass(frozen=True)
    class EvalResult:
        passed: bool = False
        score: float = 0.0
        reason: str = ""
        reward: float = 0.0


# ---------------------------------------------------------------------------
# Slice: PromotionGate creation
# ---------------------------------------------------------------------------


class TestPromotionGateCreation:
    """Given default params, When I create a PromotionGate, Then defaults are used."""

    def test_promotion_gate_defaults(self):
        """Given default params, When I create PromotionGate, Then default thresholds are set."""
        from loopengine.evolution.promotion import PromotionGate

        gate = PromotionGate()

        assert gate._min_improvement == 0.01
        assert gate._no_regression == 0.02
        assert gate._require_safety is True

    def test_promotion_gate_custom_params(self):
        """Given custom params, When I create PromotionGate, Then they are stored."""
        from loopengine.evolution.promotion import PromotionGate

        gate = PromotionGate(
            min_improvement=0.05,
            no_regression=0.10,
            require_safety=False,
        )

        assert gate._min_improvement == 0.05
        assert gate._no_regression == 0.10
        assert gate._require_safety is False


class TestPromotionDecisionCreation:
    """Given fields, When I create a PromotionDecision, Then fields are set."""

    def test_decision_creation(self):
        """Given promoted=True and reason, When I create PromotionDecision, Then fields are set."""
        from loopengine.evolution.promotion import PromotionDecision

        decision = PromotionDecision(
            promoted=True,
            reason="Improved by 5%",
            details={"improvement": 0.05},
        )

        assert decision.promoted is True
        assert decision.reason == "Improved by 5%"
        assert decision.details["improvement"] == 0.05

    def test_decision_is_frozen(self):
        """Given a PromotionDecision, When I try to mutate, Then FrozenInstanceError is raised."""
        from dataclasses import FrozenInstanceError
        from loopengine.evolution.promotion import PromotionDecision

        decision = PromotionDecision(promoted=True, reason="ok")

        with pytest.raises(FrozenInstanceError):
            decision.promoted = False  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Slice: Validate with improvement (promoted=True)
# ---------------------------------------------------------------------------


class TestValidateWithImprovement:
    """Given a candidate that improves on baseline, When I validate, Then promoted=True."""

    async def test_validate_promotes_on_improvement(self):
        """Given candidate score > baseline by min_improvement, When I validate, Then promoted."""
        from loopengine.evolution.promotion import PromotionGate, BenchmarkResult

        gate = PromotionGate(min_improvement=0.01, no_regression=0.02)

        # Baseline: mean_score 0.6
        baseline = BenchmarkResult(
            scores={
                "task_0": EvalResult(passed=True, score=0.6, reason="ok"),
            },
            aggregate={"mean_score": 0.6, "pass_rate": 1.0},
        )

        # Candidate: mean_score 0.7 (improvement = 0.1 > 0.01 threshold)
        candidate = BenchmarkResult(
            scores={
                "task_0": EvalResult(passed=True, score=0.7, reason="better"),
            },
            aggregate={"mean_score": 0.7, "pass_rate": 1.0},
        )

        mod = CodeMod(
            target_file="prompt.py",
            description="Better prompt",
            diff="...",
            rationale="Test",
            expected_impact="Better score",
        )

        decision = await gate.validate(baseline, candidate, mod)

        assert decision.promoted is True
        assert "approved" in decision.reason.lower()

    async def test_validate_tracks_improvement_details(self):
        """Given an improvement, When I validate, Then details include improvement metrics."""
        from loopengine.evolution.promotion import PromotionGate, BenchmarkResult

        gate = PromotionGate(min_improvement=0.01)

        baseline = BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
            aggregate={"mean_score": 0.5},
        )
        candidate = BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.8, reason="better")},
            aggregate={"mean_score": 0.8},
        )

        mod = CodeMod(target_file="x.py", description="mod", diff="...", rationale="", expected_impact="")

        decision = await gate.validate(baseline, candidate, mod)

        assert decision.details["improvement"]["baseline_score"] == 0.5
        assert decision.details["improvement"]["candidate_score"] == 0.8
        assert decision.details["improvement"]["delta"] == pytest.approx(0.3)
        assert decision.details["improvement"]["passed"] is True


# ---------------------------------------------------------------------------
# Slice: Validate with regression (promoted=False)
# ---------------------------------------------------------------------------


class TestValidateWithRegression:
    """Given a candidate that regresses on a task, When I validate, Then promoted=False."""

    async def test_validate_rejects_on_regression(self):
        """Given a task score drops by > no_regression, When I validate, Then rejected."""
        from loopengine.evolution.promotion import PromotionGate, BenchmarkResult

        gate = PromotionGate(min_improvement=0.01, no_regression=0.02)

        # Baseline: task_0=0.8, task_1=0.6 → mean=0.7
        baseline = BenchmarkResult(
            scores={
                "task_0": EvalResult(passed=True, score=0.8, reason="good"),
                "task_1": EvalResult(passed=True, score=0.6, reason="ok"),
            },
            aggregate={"mean_score": 0.7},
        )

        # Candidate: task_0=0.5 (regression!), task_1=0.95 (big improvement) → mean=0.725
        # Aggregate improves by 0.025 > 0.01 threshold, but task_0 regressed by 0.3 > 0.02
        candidate = BenchmarkResult(
            scores={
                "task_0": EvalResult(passed=False, score=0.5, reason="worse"),
                "task_1": EvalResult(passed=True, score=0.95, reason="better"),
            },
            aggregate={"mean_score": 0.725},
        )

        mod = CodeMod(target_file="x.py", description="mod", diff="...", rationale="", expected_impact="")

        decision = await gate.validate(baseline, candidate, mod)

        assert decision.promoted is False
        assert "regression" in decision.reason.lower()

    async def test_validate_regression_details(self):
        """Given regression, When I validate, Then details include regression info."""
        from loopengine.evolution.promotion import PromotionGate, BenchmarkResult

        gate = PromotionGate(min_improvement=0.0, no_regression=0.05)

        # task_0=0.9, task_1=0.5 → mean=0.7
        baseline = BenchmarkResult(
            scores={
                "task_0": EvalResult(passed=True, score=0.9, reason="good"),
                "task_1": EvalResult(passed=True, score=0.5, reason="ok"),
            },
            aggregate={"mean_score": 0.7},
        )
        # task_0=0.6 (regression by 0.3!), task_1=0.95 (improvement) → mean=0.775
        # Aggregate improves by 0.075 > 0.0, but task_0 regressed by 0.3 > 0.05
        candidate = BenchmarkResult(
            scores={
                "task_0": EvalResult(passed=True, score=0.6, reason="worse"),
                "task_1": EvalResult(passed=True, score=0.95, reason="better"),
            },
            aggregate={"mean_score": 0.775},
        )

        mod = CodeMod(target_file="x.py", description="mod", diff="...", rationale="", expected_impact="")

        decision = await gate.validate(baseline, candidate, mod)

        assert decision.details["regression"]["has_regression"] is True
        assert "task_0" in decision.details["regression"]["regressed_tasks"]
        assert decision.details["regression"]["worst_task"] == "task_0"


# ---------------------------------------------------------------------------
# Slice: Validate with unsafe mod (promoted=False)
# ---------------------------------------------------------------------------


class TestValidateWithUnsafeMod:
    """Given an unsafe mod, When I validate, Then promoted=False regardless of improvement."""

    async def test_validate_rejects_unsafe_mod(self):
        """Given a mod that fails is_safe(), When I validate, Then rejected for safety."""
        from loopengine.evolution.promotion import PromotionGate, BenchmarkResult

        gate = PromotionGate(min_improvement=0.01, require_safety=True)

        baseline = BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
            aggregate={"mean_score": 0.5},
        )
        candidate = BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.9, reason="great")},
            aggregate={"mean_score": 0.9},
        )

        # Unsafe mod
        class UnsafeMod:
            def is_safe(self) -> bool:
                return False

        decision = await gate.validate(baseline, candidate, UnsafeMod())

        assert decision.promoted is False
        assert "safety" in decision.reason.lower()
        assert decision.details["safety"]["passed"] is False

    async def test_validate_skips_safety_when_disabled(self):
        """Given require_safety=False, When I validate with unsafe mod, Then safety is skipped."""
        from loopengine.evolution.promotion import PromotionGate, BenchmarkResult

        gate = PromotionGate(min_improvement=0.01, require_safety=False)

        baseline = BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
            aggregate={"mean_score": 0.5},
        )
        candidate = BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.9, reason="great")},
            aggregate={"mean_score": 0.9},
        )

        class UnsafeMod:
            def is_safe(self) -> bool:
                return False

        decision = await gate.validate(baseline, candidate, UnsafeMod())

        # Should be promoted because safety check is disabled and improvement is good
        assert decision.promoted is True


# ---------------------------------------------------------------------------
# Slice: Validate with marginal improvement (promoted=False)
# ---------------------------------------------------------------------------


class TestValidateMarginalImprovement:
    """Given improvement below threshold, When I validate, Then promoted=False."""

    async def test_validate_rejects_marginal_improvement(self):
        """Given improvement 0.005 < threshold 0.01, When I validate, Then rejected."""
        from loopengine.evolution.promotion import PromotionGate, BenchmarkResult

        gate = PromotionGate(min_improvement=0.01, no_regression=0.02)

        baseline = BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.6, reason="ok")},
            aggregate={"mean_score": 0.6},
        )
        # Improvement is 0.005, which is < 0.01 threshold
        candidate = BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.605, reason="slightly better")},
            aggregate={"mean_score": 0.605},
        )

        mod = CodeMod(target_file="x.py", description="mod", diff="...", rationale="", expected_impact="")

        decision = await gate.validate(baseline, candidate, mod)

        assert decision.promoted is False
        assert "insufficient improvement" in decision.reason.lower()

    async def test_validate_exact_threshold_is_promoted(self):
        """Given improvement exactly at threshold, When I validate, Then promoted."""
        from loopengine.evolution.promotion import PromotionGate, BenchmarkResult

        gate = PromotionGate(min_improvement=0.01, no_regression=0.02)

        baseline = BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.6, reason="ok")},
            aggregate={"mean_score": 0.6},
        )
        # Exactly 0.01 improvement
        candidate = BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.61, reason="better")},
            aggregate={"mean_score": 0.61},
        )

        mod = CodeMod(target_file="x.py", description="mod", diff="...", rationale="", expected_impact="")

        decision = await gate.validate(baseline, candidate, mod)

        assert decision.promoted is True


# ---------------------------------------------------------------------------
# Slice: Zero regression tolerance
# ---------------------------------------------------------------------------


class TestZeroRegressionTolerance:
    """Given zero regression tolerance, When I validate, Then ANY regression is rejected."""

    async def test_zero_tolerance_rejects_any_regression(self):
        """Given no_regression=0.0, When task regresses by 0.001, Then rejected."""
        from loopengine.evolution.promotion import PromotionGate, BenchmarkResult

        gate = PromotionGate(min_improvement=0.0, no_regression=0.0)

        # Two tasks: task_0=0.7, task_1=0.5 → mean=0.6
        baseline = BenchmarkResult(
            scores={
                "task_0": EvalResult(passed=True, score=0.7, reason="ok"),
                "task_1": EvalResult(passed=True, score=0.5, reason="ok"),
            },
            aggregate={"mean_score": 0.6},
        )
        # task_0=0.699 (tiny regression!), task_1=0.9 (improvement) → mean=0.7995
        # Aggregate improves by 0.1995 > 0.0, but task_0 regressed > 0.0 tolerance
        candidate = BenchmarkResult(
            scores={
                "task_0": EvalResult(passed=True, score=0.699, reason="slightly worse"),
                "task_1": EvalResult(passed=True, score=0.9, reason="much better"),
            },
            aggregate={"mean_score": 0.7995},
        )

        mod = CodeMod(target_file="x.py", description="mod", diff="...", rationale="", expected_impact="")

        decision = await gate.validate(baseline, candidate, mod)

        assert decision.promoted is False
        assert "regression" in decision.reason.lower()

    async def test_zero_tolerance_allows_no_regression(self):
        """Given no_regression=0.0, When no task regresses, Then promoted (if improvement ok)."""
        from loopengine.evolution.promotion import PromotionGate, BenchmarkResult

        gate = PromotionGate(min_improvement=0.0, no_regression=0.0)

        baseline = BenchmarkResult(
            scores={
                "task_0": EvalResult(passed=True, score=0.7, reason="ok"),
            },
            aggregate={"mean_score": 0.7},
        )
        # Improvement, no regression
        candidate = BenchmarkResult(
            scores={
                "task_0": EvalResult(passed=True, score=0.8, reason="better"),
            },
            aggregate={"mean_score": 0.8},
        )

        mod = CodeMod(target_file="x.py", description="mod", diff="...", rationale="", expected_impact="")

        decision = await gate.validate(baseline, candidate, mod)

        assert decision.promoted is True
