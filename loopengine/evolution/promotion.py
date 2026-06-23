"""The Promotion Gate — the quality control checkpoint for self-modifications.

Plain English: Think of the Promotion Gate as a code review process.
Before any self-modification is applied to the real codebase, it must pass
through this gate. The gate checks:

1. Does the modification actually improve performance?
2. Does it avoid breaking anything that currently works?
3. Is it safe? (no destructive operations)
4. Is the improvement statistically significant? (not just noise)

If a modification passes all checks, it's "promoted" — applied to the
real codebase. If it fails, it's "rolled back" — discarded, and we try
something else.

Real-world analogy: This is like a product review before launch.
- "Does the new feature make users happier?" (improvement check)
- "Did we break anything that was working?" (regression check)
- "Is the product safe to use?" (safety check)
- "Is the improvement real or just a fluke?" (significance check)

Only when ALL checks pass does the product ship.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# Import CodeMod and CodeModSet from sibling module.
# Use stubs if the other agent hasn't built code_mod.py yet.
# ---------------------------------------------------------------------------

try:
    from loopengine.evolution.code_mod import CodeMod, CodeModSet
except ImportError:
    @dataclass(frozen=True)
    class CodeMod:
        """Stub CodeMod — replaced when code_mod.py is built."""
        target_file: str = ""
        description: str = ""
        diff: str = ""
        rationale: str = ""
        expected_impact: str = ""

        def to_dict(self) -> dict[str, Any]:
            return {
                "target_file": self.target_file,
                "description": self.description,
                "diff": self.diff,
                "rationale": self.rationale,
                "expected_impact": self.expected_impact,
            }

        def is_safe(self) -> bool:
            return True

    @dataclass(frozen=True)
    class CodeModSet:
        """Stub CodeModSet — replaced when code_mod.py is built."""
        mods: tuple[CodeMod, ...] = ()

        def is_safe(self) -> bool:
            return all(m.is_safe() for m in self.mods)

        def apply_to(self, files: dict[str, str]) -> dict[str, str]:
            return files


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
    4. SIGNIFICANCE: "Is this improvement real or just noise?" — the
       improvement must exceed the threshold.

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
    ) -> None:
        """Initialize the PromotionGate.

        Args:
            min_improvement: Minimum aggregate score delta to approve (default 0.01).
            no_regression: Maximum allowed per-task regression (default 0.02).
            require_safety: Whether mods must pass is_safe() (default True).
        """
        self._min_improvement = min_improvement
        self._no_regression = no_regression
        self._require_safety = require_safety

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
