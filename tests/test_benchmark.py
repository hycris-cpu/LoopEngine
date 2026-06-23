"""Tests for the Benchmark module — runs agent on multiple tasks and aggregates results.

BDD Scenarios:
- Given scores from multiple tasks, When I create a BenchmarkResult, Then aggregate is computed
- Given a judge and tasks, When Benchmark runs, Then it collects results from each task
- Given two BenchmarkResults, When I compare them, Then improvements/regressions are identified
- Given identical results, When I compare them, Then everything is unchanged
"""

import pytest
from unittest.mock import AsyncMock

from loopengine.primitives import EvalResult, Message
from loopengine.primitives.trajectory import Trajectory, TrajectoryStep
from typing import Any


# ---------------------------------------------------------------------------
# Minimal stubs (execution layer may not exist yet)
# ---------------------------------------------------------------------------


class _StubTask:
    """A simple task stub for testing benchmarks."""
    def __init__(self, prompt: str = "test", max_steps: int = 10) -> None:
        self.prompt = prompt
        self.max_steps = max_steps

    def is_done(self, state: Any) -> bool:
        return False


class _StubHarness:
    """A stub harness that returns pre-configured results."""

    def __init__(self, results: list[Any]) -> None:
        self._results = list(results)
        self._call_count = 0

    async def run(self, task: Any) -> Any:
        result = self._results[self._call_count]
        self._call_count += 1
        return result


class _StubRunResult:
    """A stub for RunResult."""
    def __init__(self, eval_result: EvalResult, trajectory: Trajectory | None = None) -> None:
        self.eval_result = eval_result
        self.trajectory = trajectory or Trajectory()


# ---------------------------------------------------------------------------
# Slice 7: BenchmarkResult
# ---------------------------------------------------------------------------


class TestBenchmarkResultCreation:
    """Given scores and aggregates, When I create a BenchmarkResult, Then fields are set."""

    def test_benchmark_result_creation(self):
        """Given scores and aggregates, When I create BenchmarkResult, Then fields are set."""
        from loopengine.evaluation.benchmark import BenchmarkResult

        scores = {
            "task1": EvalResult(passed=True, score=0.9, reason="good"),
            "task2": EvalResult(passed=False, score=0.5, reason="ok"),
        }
        aggregate = {"mean_score": 0.7, "pass_rate": 0.5}

        result = BenchmarkResult(scores=scores, aggregate=aggregate)
        assert result.scores == scores
        assert result.aggregate == aggregate


class TestBenchmarkResultFrozen:
    """Given a BenchmarkResult, When I try to mutate it, Then FrozenInstanceError is raised."""

    def test_benchmark_result_is_frozen(self):
        """Given a BenchmarkResult, When I try to mutate scores, Then FrozenInstanceError is raised."""
        from dataclasses import FrozenInstanceError
        from loopengine.evaluation.benchmark import BenchmarkResult

        scores = {"task1": EvalResult(passed=True, score=0.9, reason="good")}
        result = BenchmarkResult(scores=scores, aggregate={"mean_score": 0.9})

        with pytest.raises(FrozenInstanceError):
            result.scores = {}  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Slice 8: Benchmark.run()
# ---------------------------------------------------------------------------


class TestBenchmarkCreation:
    """Given a judge and parallelism, When I create a Benchmark, Then fields are set."""

    def test_benchmark_creation(self):
        """Given a judge, When I create Benchmark, Then fields are set."""
        from loopengine.evaluation.benchmark import Benchmark

        judge = AsyncMock()
        benchmark = Benchmark(judge=judge, parallelism=2)
        assert benchmark.judge is judge
        assert benchmark.parallelism == 2


class TestBenchmarkRun:
    """Given a judge and tasks, When Benchmark runs, Then it collects results from each task."""

    async def test_benchmark_runs_tasks(self):
        """Given 3 tasks and a mock judge, When I run, Then 3 results are collected."""
        from loopengine.evaluation.benchmark import Benchmark

        # Judge returns different scores for each task
        judge = AsyncMock()
        judge.evaluate = AsyncMock(side_effect=[
            EvalResult(passed=True, score=0.9, reason="good"),
            EvalResult(passed=False, score=0.5, reason="ok"),
            EvalResult(passed=True, score=0.8, reason="nice"),
        ])
        judge.name = "test_judge"

        tasks = [_StubTask(f"task {i}") for i in range(3)]
        benchmark = Benchmark(judge=judge)

        result = await benchmark.run(tasks)

        assert len(result.scores) == 3
        assert judge.evaluate.call_count == 3

    async def test_benchmark_aggregates_mean(self):
        """Given scores 0.9, 0.5, 0.8, When I run, Then mean is 0.733..."""
        from loopengine.evaluation.benchmark import Benchmark

        judge = AsyncMock()
        judge.evaluate = AsyncMock(side_effect=[
            EvalResult(passed=True, score=0.9, reason="good"),
            EvalResult(passed=False, score=0.5, reason="ok"),
            EvalResult(passed=True, score=0.8, reason="nice"),
        ])
        judge.name = "test_judge"

        tasks = [_StubTask(f"task {i}") for i in range(3)]
        benchmark = Benchmark(judge=judge)

        result = await benchmark.run(tasks)

        expected_mean = (0.9 + 0.5 + 0.8) / 3
        assert result.aggregate["mean_score"] == pytest.approx(expected_mean)

    async def test_benchmark_aggregates_pass_rate(self):
        """Given 2 passed out of 3, When I run, Then pass_rate is 2/3."""
        from loopengine.evaluation.benchmark import Benchmark

        judge = AsyncMock()
        judge.evaluate = AsyncMock(side_effect=[
            EvalResult(passed=True, score=0.9, reason="good"),
            EvalResult(passed=False, score=0.5, reason="ok"),
            EvalResult(passed=True, score=0.8, reason="nice"),
        ])
        judge.name = "test_judge"

        tasks = [_StubTask(f"task {i}") for i in range(3)]
        benchmark = Benchmark(judge=judge)

        result = await benchmark.run(tasks)

        assert result.aggregate["pass_rate"] == pytest.approx(2 / 3)


# ---------------------------------------------------------------------------
# Slice 9: compare()
# ---------------------------------------------------------------------------


class TestCompareIdentical:
    """Given identical results, When I compare them, Then everything is unchanged."""

    def test_compare_identical_results(self):
        """Given two identical BenchmarkResults, When I compare, Then no improvements or regressions."""
        from loopengine.evaluation.benchmark import compare, BenchmarkResult

        scores = {
            "task1": EvalResult(passed=True, score=0.8, reason="ok"),
            "task2": EvalResult(passed=True, score=0.9, reason="good"),
        }
        aggregate = {"mean_score": 0.85, "pass_rate": 1.0}

        a = BenchmarkResult(scores=scores, aggregate=aggregate)
        b = BenchmarkResult(scores=scores, aggregate=aggregate)

        comparison = compare(a, b)

        assert len(comparison.improvements) == 0
        assert len(comparison.regressions) == 0
        assert len(comparison.unchanged) == 2


class TestCompareImprovements:
    """Given improved scores, When I compare, Then improvements are detected."""

    def test_compare_improvements(self):
        """Given B has higher scores than A, When I compare, Then improvements are listed."""
        from loopengine.evaluation.benchmark import compare, BenchmarkResult

        a_scores = {
            "task1": EvalResult(passed=False, score=0.5, reason="ok"),
            "task2": EvalResult(passed=True, score=0.8, reason="good"),
        }
        b_scores = {
            "task1": EvalResult(passed=True, score=0.9, reason="great"),
            "task2": EvalResult(passed=True, score=0.8, reason="good"),
        }

        a = BenchmarkResult(scores=a_scores, aggregate={"mean_score": 0.65})
        b = BenchmarkResult(scores=b_scores, aggregate={"mean_score": 0.85})

        comparison = compare(a, b)

        assert "task1" in comparison.improvements
        assert len(comparison.regressions) == 0
        assert comparison.improvements["task1"] == pytest.approx(0.4)  # 0.9 - 0.5


class TestCompareRegressions:
    """Given regressed scores, When I compare, Then regressions are detected."""

    def test_compare_regressions(self):
        """Given B has lower scores than A, When I compare, Then regressions are listed."""
        from loopengine.evaluation.benchmark import compare, BenchmarkResult

        a_scores = {
            "task1": EvalResult(passed=True, score=0.9, reason="great"),
        }
        b_scores = {
            "task1": EvalResult(passed=False, score=0.5, reason="ok"),
        }

        a = BenchmarkResult(scores=a_scores, aggregate={"mean_score": 0.9})
        b = BenchmarkResult(scores=b_scores, aggregate={"mean_score": 0.5})

        comparison = compare(a, b)

        assert "task1" in comparison.regressions
        assert len(comparison.improvements) == 0
        assert comparison.regressions["task1"] == pytest.approx(0.4)  # 0.9 - 0.5


class TestCompareSummary:
    """Given a comparison, When I check the summary, Then it's a readable string."""

    def test_compare_has_summary(self):
        """Given a comparison result, When I access summary, Then it's a non-empty string."""
        from loopengine.evaluation.benchmark import compare, BenchmarkResult

        a_scores = {"task1": EvalResult(passed=True, score=0.8, reason="ok")}
        b_scores = {"task1": EvalResult(passed=True, score=0.9, reason="better")}

        a = BenchmarkResult(scores=a_scores, aggregate={"mean_score": 0.8})
        b = BenchmarkResult(scores=b_scores, aggregate={"mean_score": 0.9})

        comparison = compare(a, b)

        assert isinstance(comparison.summary, str)
        assert len(comparison.summary) > 0
        assert "0.80" in comparison.summary
        assert "0.90" in comparison.summary
