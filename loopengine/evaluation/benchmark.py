"""Benchmarks run the agent on multiple tasks and aggregate results.

Plain English: If a single test is one exam question, a benchmark is the
full exam. It runs the agent on many tasks, collects all the results,
and produces a summary report.

The Benchmark class also supports COMPARISON — given two benchmark runs,
it shows which one was better and by how much. This is essential for the
evolution layer to decide if a self-modification was an improvement.

Real-world analogy: A benchmark is like a school report card that shows
your grade in every subject, plus the overall GPA. Comparing two report
cards tells you which subjects improved and which got worse.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from loopengine.primitives.events import EvalResult

# ---------------------------------------------------------------------------
# BenchmarkResult — the outcome of a benchmark run
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BenchmarkResult:
    """The result of running a benchmark — scores for every task plus aggregates.

    Plain English: This is the "report card" after a full benchmark run.
    It contains:
    - scores: Individual scores for each task (like subject grades)
    - aggregate: Summary statistics (like GPA, pass rate, etc.)

    Frozen (immutable) because once a benchmark is run, its results should
    never change. You can compare two BenchmarkResults to see progress.

    Attributes:
        scores: Dict mapping task identifier to EvalResult.
        aggregate: Dict of summary statistics (mean_score, pass_rate, etc.).
    """

    scores: dict[str, EvalResult] = field(default_factory=dict)
    aggregate: dict[str, float] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Comparison — the diff between two benchmark runs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Comparison:
    """The difference between two BenchmarkResults — what improved, regressed, or stayed the same.

    Plain English: This is like comparing two report cards side by side.
    It tells you:
    - improvements: Tasks where the new run scored higher
    - regressions: Tasks where the new run scored lower
    - unchanged: Tasks where scores are the same

    The summary is a human-readable string you can print or log.

    Attributes:
        improvements: Dict of task_id → score improvement (positive delta).
        regressions: Dict of task_id → score regression (negative delta, stored as positive).
        unchanged: List of task_ids where scores didn't change.
        summary: A human-readable summary of the comparison.
    """

    improvements: dict[str, float] = field(default_factory=dict)
    regressions: dict[str, float] = field(default_factory=dict)
    unchanged: list[str] = field(default_factory=list)
    summary: str = ""


# ---------------------------------------------------------------------------
# Benchmark — runs agent on multiple tasks and collects results
# ---------------------------------------------------------------------------


class Benchmark:
    """Runs the agent on multiple tasks and produces a BenchmarkResult.

    Plain English: A Benchmark is like a test administrator. You give it:
    - A judge (how to grade)
    - A list of tasks (what to test)

    It runs each task through the judge and collects all the scores.
    Then it computes aggregate statistics (mean, pass rate, etc.).

    The parallelism parameter controls how many tasks run concurrently.
    parallelism=1 means sequential (one at a time).
    parallelism=4 means up to 4 tasks run in parallel.

    Attributes:
        judge: The Judge to evaluate each task's trajectory.
        parallelism: Maximum number of concurrent task evaluations.
    """

    def __init__(self, judge: Any, parallelism: int = 1) -> None:
        """Initialize the Benchmark.

        Args:
            judge: A Judge instance to evaluate trajectories.
            parallelism: Maximum concurrent evaluations (default 1 = sequential).
        """
        self._judge = judge
        self._parallelism = parallelism

    @property
    def judge(self) -> Any:
        """The judge used for evaluation."""
        return self._judge

    @property
    def parallelism(self) -> int:
        """Maximum concurrent task evaluations."""
        return self._parallelism

    async def run(
        self,
        run_results: list[Any],
        tasks: list[Any] | None = None,
    ) -> BenchmarkResult:
        """Run all run results through the judge and produce a BenchmarkResult.

        Steps:
        1. For each run result, extract its trajectory and evaluate with the judge
        2. Collect all EvalResults
        3. Compute aggregate statistics (mean score, pass rate)
        4. Return a frozen BenchmarkResult

        When ``tasks`` is provided, the original Task objects are passed to the
        judge (which needs ``task.prompt``, ``task.max_steps``, etc.). When
        ``tasks`` is None, the run result itself is passed — this preserves
        backward compatibility for callers that pass Task objects directly.

        Args:
            run_results: A list of RunResult objects (or Task objects with a
                        ``trajectory`` attribute) to evaluate.
            tasks: Optional list of original Task objects, one per run result.
                   When provided, these are passed to the judge instead of the
                   run results.

        Returns:
            A BenchmarkResult with individual scores and aggregates.
        """
        import asyncio

        scores: dict[str, EvalResult] = {}

        # Pair each run result with its original task (if provided)
        paired: list[tuple[Any, Any]] = []
        for i, run_result in enumerate(run_results):
            original_task = tasks[i] if tasks and i < len(tasks) else run_result
            paired.append((run_result, original_task))

        # Evaluate each pair
        if self._parallelism <= 1:
            # Sequential mode
            for i, (run_result, original_task) in enumerate(paired):
                task_id = f"task_{i}"
                trajectory = _get_trajectory(run_result)
                result = await self._judge.evaluate(trajectory, original_task)
                scores[task_id] = result
        else:
            # Parallel mode
            async def _eval_one(
                index: int, run_result: Any, original_task: Any
            ) -> tuple[str, EvalResult]:
                task_id = f"task_{index}"
                trajectory = _get_trajectory(run_result)
                result = await self._judge.evaluate(trajectory, original_task)
                return task_id, result

            # Run in batches of parallelism
            for batch_start in range(0, len(paired), self._parallelism):
                batch = paired[batch_start : batch_start + self._parallelism]
                batch_results = await asyncio.gather(
                    *[
                        _eval_one(batch_start + i, rr, ot)
                        for i, (rr, ot) in enumerate(batch)
                    ]
                )
                for task_id, result in batch_results:
                    scores[task_id] = result

        # Compute aggregates
        aggregate = _compute_aggregate(scores)

        return BenchmarkResult(scores=scores, aggregate=aggregate)


# ---------------------------------------------------------------------------
# compare() — diff two benchmark results
# ---------------------------------------------------------------------------


def compare(a: BenchmarkResult, b: BenchmarkResult) -> Comparison:
    """Compare two BenchmarkResults and produce a diff report.

    Plain English: This is like holding two report cards side by side.
    For each task (subject), it checks:
    - Did the score go up? (improvement)
    - Did it go down? (regression)
    - Did it stay the same? (unchanged)

    The Comparison also includes an overall summary comparing the
    aggregate scores.

    Args:
        a: The baseline BenchmarkResult (the "before").
        b: The new BenchmarkResult (the "after").

    Returns:
        A Comparison showing improvements, regressions, and unchanged tasks.
    """
    improvements: dict[str, float] = {}
    regressions: dict[str, float] = {}
    unchanged: list[str] = []

    # Compare individual task scores
    all_tasks = set(a.scores.keys()) | set(b.scores.keys())
    for task_id in sorted(all_tasks):
        score_a = a.scores[task_id].score if task_id in a.scores else 0.0
        score_b = b.scores[task_id].score if task_id in b.scores else 0.0

        delta = score_b - score_a
        if delta > 0.001:  # threshold to avoid floating-point noise
            improvements[task_id] = delta
        elif delta < -0.001:
            regressions[task_id] = abs(delta)
        else:
            unchanged.append(task_id)

    # Build summary
    mean_a = a.aggregate.get("mean_score", 0.0)
    mean_b = b.aggregate.get("mean_score", 0.0)
    pass_rate_a = a.aggregate.get("pass_rate", 0.0)
    pass_rate_b = b.aggregate.get("pass_rate", 0.0)

    summary_parts = [
        f"Benchmark comparison:",
        f"  Mean score: {mean_a:.2f} → {mean_b:.2f} (delta: {mean_b - mean_a:+.2f})",
        f"  Pass rate:  {pass_rate_a:.2f} → {pass_rate_b:.2f} (delta: {pass_rate_b - pass_rate_a:+.2f})",
        f"  Tasks improved:   {len(improvements)}",
        f"  Tasks regressed:  {len(regressions)}",
        f"  Tasks unchanged:  {len(unchanged)}",
    ]

    if improvements:
        for task_id, delta in improvements.items():
            summary_parts.append(f"    ✓ {task_id}: +{delta:.2f}")
    if regressions:
        for task_id, delta in regressions.items():
            summary_parts.append(f"    ✗ {task_id}: -{delta:.2f}")

    return Comparison(
        improvements=improvements,
        regressions=regressions,
        unchanged=unchanged,
        summary="\n".join(summary_parts),
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _get_trajectory(task: Any) -> Any:
    """Extract a trajectory from a task or RunResult.

    If the task has a 'trajectory' attribute, return it.
    Otherwise, return an empty Trajectory.

    Args:
        task: A task or RunResult object.

    Returns:
        A Trajectory object.
    """
    from loopengine.primitives.trajectory import Trajectory

    if hasattr(task, "trajectory"):
        return task.trajectory
    return Trajectory()


def _compute_aggregate(scores: dict[str, EvalResult]) -> dict[str, float]:
    """Compute aggregate statistics from a dict of EvalResults.

    Args:
        scores: Dict mapping task_id to EvalResult.

    Returns:
        A dict with 'mean_score' and 'pass_rate'.
    """
    if not scores:
        return {"mean_score": 0.0, "pass_rate": 0.0}

    total_score = sum(r.score for r in scores.values())
    total_passed = sum(1 for r in scores.values() if r.passed)
    count = len(scores)

    return {
        "mean_score": total_score / count,
        "pass_rate": total_passed / count,
    }
