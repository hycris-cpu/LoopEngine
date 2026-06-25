"""The Promotion Gate — the quality control checkpoint for self-modifications.

Plain English: Think of the Promotion Gate as a code review process.
Before any self-modification is applied to the real codebase, it must pass
through this gate. The gate checks:

1. Is it safe? (no destructive operations)
2. Is the candidate valid? (no missing/NaN score)
3. Does the modification actually improve performance by at least
   ``min_improvement`` (or satisfy a custom ``is_better`` comparator)?
4. Does it avoid breaking anything that currently works (per-task regression)?

If a modification passes all checks, it's "promoted" — applied to the
real codebase. If it fails, it's "rolled back" — discarded, and we try
something else.

NOTE: this gate compares single benchmark runs against fixed thresholds. It
does NOT perform a statistical-significance test (no repeated trials or
variance estimate), so a small delta from a noisy/stochastic benchmark can pass.
Run the benchmark over enough tasks/seeds that the threshold is meaningful, or
supply a stricter ``min_improvement``.

Real-world analogy: This is like a product review before launch.
- "Is the product safe to use?" (safety check)
- "Is the submission even valid?" (validity check)
- "Does the new feature make users happier?" (improvement check)
- "Did we break anything that was working?" (regression check)

Only when ALL checks pass does the product ship.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Import CodeMod and CodeModSet from sibling module.
# Direct import — no dangerous is_safe()=True stub fallback (bug C3).
# ---------------------------------------------------------------------------

from loopengine.evolution.code_mod import CodeMod, CodeModSet


# ---------------------------------------------------------------------------
# Import BenchmarkResult from the evaluation layer
# ---------------------------------------------------------------------------

try:
    from loopengine.evaluation.benchmark import BenchmarkResult
except ImportError:
    @dataclass(frozen=True)
    class BenchmarkResult:
        """Stub BenchmarkResult — replaced when benchmark.py is built."""
        scores: dict[str, Any] = field(default_factory=dict)
        aggregate: dict[str, float] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# PromotionDecision — the gate's verdict
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PromotionDecision:  # type: ignore[no-redef]
    """The promotion gate's verdict — promote or reject a self-modification.

    Plain English: This is like a judge's ruling. It tells you:
    - promoted: True = "Ship it!" / False = "Back to the drawing board."
    - reason: A human-readable explanation of the decision.
    - details: Extra data about each check that was performed.

    Frozen (immutable) because once a decision is made, it shouldn't change.
    You can't un-ring a bell.

    Attributes:
        promoted: Whether the modification is approved for application.
        reason: Human-readable explanation of the decision.
        details: Dict with details of each check performed.
    """

    promoted: bool = False
    reason: str = ""
    details: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# PromotionGate — the gatekeeper
# ---------------------------------------------------------------------------


class PromotionGate:
    """The quality control checkpoint for self-modifications.

    Plain English: This is the "bouncer at the club door." Every proposed
    change (CodeMod) must convince the bouncer that it's worth letting in.
    The bouncer checks:

    1. IMPROVEMENT: "Is this change actually better?" — the candidate's
       aggregate score must improve by at least min_improvement.
    2. NO REGRESSION: "Does this change break anything?" — no individual
       task score may regress by more than no_regression.
    3. SAFETY: "Is this change dangerous?" — all mods must pass is_safe().
    4. VALIDITY: "Is the candidate even valid?" — a missing or NaN aggregate
       score is rejected outright (it can never rank as best).

    This is a threshold gate, not a statistical-significance test: it compares
    single runs against fixed thresholds and does not estimate variance.

    If ANY check fails, the modification is rejected with a detailed
    explanation. The evolution loop uses this feedback to try again.

    Attributes:
        _min_improvement: Minimum aggregate score improvement required.
        _no_regression: Maximum allowed regression per individual task.
        _require_safety: Whether to enforce the is_safe() check.
    """

    def __init__(
        self,
        min_improvement: float = 0.01,
        no_regression: float = 0.02,
        require_safety: bool = True,
        is_better: Callable[[float, float], bool] | None = None,
    ) -> None:
        """Initialize the PromotionGate.

        Args:
            min_improvement: Minimum aggregate score delta to approve (default 0.01).
            no_regression: Maximum allowed per-task regression (default 0.02).
            require_safety: Whether mods must pass is_safe() (default True).
            is_better: Optional ``(candidate_score, baseline_score) -> bool``
                comparator making the optimization direction explicit (bug H2).
                When given, it decides whether the candidate is an improvement,
                replacing the default higher-is-better threshold + regression
                checks. Default ``None`` keeps the higher-is-better behavior.
        """
        self._min_improvement = min_improvement
        self._no_regression = no_regression
        self._require_safety = require_safety
        self._is_better = is_better

    async def validate(
        self,
        baseline: BenchmarkResult,
        candidate: BenchmarkResult,
        mods: Any,
    ) -> PromotionDecision:
        """Validate a proposed modification against the baseline.

        Plain English: "Before we ship this change, let's run the tests
        on both the old version and the new version, then compare."

        Steps:
        1. Check safety (if required)
        2. Check aggregate improvement
        3. Check per-task regression
        4. Return a PromotionDecision with full reasoning

        Args:
            baseline: The BenchmarkResult from the current (unmodified) agent.
            candidate: The BenchmarkResult from the modified agent.
            mods: The CodeMod or CodeModSet that was applied.

        Returns:
            A PromotionDecision indicating whether to promote or reject.
        """
        details: dict[str, Any] = {}

        # --- Check 1: Safety ---
        if self._require_safety:
            is_safe = self._check_safety(mods)
            details["safety"] = {
                "passed": is_safe,
                "require_safety": self._require_safety,
            }
            if not is_safe:
                return PromotionDecision(
                    promoted=False,
                    reason="Safety check failed: one or more mods contain dangerous operations.",
                    details=details,
                )

        # --- Check 2: Aggregate improvement ---
        baseline_score = baseline.aggregate.get("mean_score", 0.0)
        candidate_score = candidate.aggregate.get("mean_score", 0.0)

        # Invalid candidates can never be promoted — a missing or NaN score must
        # not slip through (an invalid run must never rank as "best"; bug H2).
        if candidate_score is None or (
            isinstance(candidate_score, float) and math.isnan(candidate_score)
        ):
            details["validity"] = {"passed": False, "candidate_score": candidate_score}
            return PromotionDecision(
                promoted=False,
                reason="Invalid candidate: missing or NaN aggregate score.",
                details=details,
            )

        # When an explicit optimization-direction comparator is supplied, it is
        # the single source of truth for "did this improve?" — the default
        # higher-is-better threshold and regression checks (which assume
        # higher==better) are bypassed so they can't fight the comparator.
        if self._is_better is not None:
            improved = bool(self._is_better(candidate_score, baseline_score))
            details["improvement"] = {
                "baseline_score": baseline_score,
                "candidate_score": candidate_score,
                "comparator": "custom is_better",
                "passed": improved,
            }
            if not improved:
                return PromotionDecision(
                    promoted=False,
                    reason=(
                        f"Not an improvement under is_better: candidate "
                        f"{candidate_score:.4f} vs baseline {baseline_score:.4f}."
                    ),
                    details=details,
                )
            details["verdict"] = "promoted"
            return PromotionDecision(
                promoted=True,
                reason=(
                    f"Approved by is_better: candidate {candidate_score:.4f} "
                    f"beats baseline {baseline_score:.4f}, safety "
                    f"{'passed' if self._require_safety else 'skipped'}."
                ),
                details=details,
            )

        improvement = candidate_score - baseline_score

        details["improvement"] = {
            "baseline_score": baseline_score,
            "candidate_score": candidate_score,
            "delta": improvement,
            "threshold": self._min_improvement,
            "passed": improvement >= self._min_improvement,
        }

        if improvement < self._min_improvement:
            return PromotionDecision(
                promoted=False,
                reason=(
                    f"Insufficient improvement: {improvement:+.4f} "
                    f"(need >= {self._min_improvement:+.4f}). "
                    f"Baseline: {baseline_score:.4f}, Candidate: {candidate_score:.4f}."
                ),
                details=details,
            )

        # --- Check 3: Per-task regression ---
        regression_details = self._check_regressions(baseline, candidate)
        details["regression"] = regression_details

        if regression_details["has_regression"]:
            worst = regression_details["worst_regression"]
            task = regression_details["worst_task"]
            return PromotionDecision(
                promoted=False,
                reason=(
                    f"Regression detected on task '{task}': "
                    f"{worst:+.4f} exceeds tolerance {self._no_regression:+.4f}. "
                    "The improvement must not come at the cost of breaking existing functionality."
                ),
                details=details,
            )

        # --- All checks passed: promote! ---
        details["verdict"] = "promoted"
        return PromotionDecision(
            promoted=True,
            reason=(
                f"Approved: {improvement:+.4f} improvement, "
                f"no regressions exceeding {self._no_regression:+.4f}, "
                f"safety check {'passed' if self._require_safety else 'skipped'}."
            ),
            details=details,
        )

    def _check_safety(self, mods: Any) -> bool:
        """Check if all mods pass the safety check.

        Args:
            mods: A CodeMod or CodeModSet to check.

        Returns:
            True if safe, False if any mod is dangerous.
        """
        if hasattr(mods, "is_safe"):
            return mods.is_safe()
        # If it's a list, check each one
        if isinstance(mods, (list, tuple)):
            return all(
                (m.is_safe() if hasattr(m, "is_safe") else True)
                for m in mods
            )
        return True

    def _check_regressions(
        self,
        baseline: BenchmarkResult,
        candidate: BenchmarkResult,
    ) -> dict[str, Any]:
        """Check for per-task regressions between baseline and candidate.

        A regression means a specific task scored WORSE with the modification
        than without it. Small regressions might be acceptable (noise), but
        large regressions are a red flag.

        Args:
            baseline: The baseline BenchmarkResult.
            candidate: The candidate BenchmarkResult.

        Returns:
            A dict with regression details.
        """
        worst_regression = 0.0
        worst_task = ""
        regressed_tasks: list[str] = []

        # Compare each task's score
        all_tasks = set(baseline.scores.keys()) | set(candidate.scores.keys())
        for task_id in sorted(all_tasks):
            baseline_score = (
                baseline.scores[task_id].score
                if task_id in baseline.scores
                else 0.0
            )
            candidate_score = (
                candidate.scores[task_id].score
                if task_id in candidate.scores
                else 0.0
            )

            delta = candidate_score - baseline_score
            if delta < 0:
                regression_magnitude = abs(delta)
                if regression_magnitude > worst_regression:
                    worst_regression = regression_magnitude
                    worst_task = task_id
                if regression_magnitude > self._no_regression:
                    regressed_tasks.append(task_id)

        return {
            "has_regression": len(regressed_tasks) > 0,
            "regressed_tasks": regressed_tasks,
            "worst_regression": worst_regression,
            "worst_task": worst_task,
            "tolerance": self._no_regression,
        }
