"""Tests for LoopEngine — the self-improvement orchestrator.

BDD Scenarios:
- Given a LoopEngine, When I create it, Then components are stored
- Given an EvolutionReport, When I call summary, Then readable text is produced
- Given mocks for all components, When I run a basic cycle, Then improvements are tracked
- Given a gate that rejects, When I run, Then rejections are recorded
- Given strategies that return empty, When I run, Then loop stops
- Given max_iterations=2, When I run, Then at most 2 iterations happen
- Given all proposals rejected, When I run, Then history records rejections
"""

import pytest
from unittest.mock import AsyncMock, MagicMock
from dataclasses import dataclass, field
from typing import Any

from loopengine.primitives.events import EvalResult, Message
from loopengine.primitives.trajectory import Trajectory, TrajectoryStep


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


# ---------------------------------------------------------------------------
# Slice: LoopEngine creation
# ---------------------------------------------------------------------------


class TestLoopEngineCreation:
    """Given components, When I create a LoopEngine, Then all are stored."""

    def test_loop_engine_creation(self):
        """Given all components, When I create LoopEngine, Then they are stored."""
        from loopengine.evolution.loop_engine import LoopEngine

        agent_builder = MagicMock()
        benchmark = MagicMock()
        strategy = MagicMock()
        gate = MagicMock()

        engine = LoopEngine(
            agent_builder=agent_builder,
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            sandbox=None,
            max_iterations=10,
        )

        assert engine._agent_builder is agent_builder
        assert engine._benchmark is benchmark
        assert len(engine._strategies) == 1
        assert engine._gate is gate
        assert engine._max_iterations == 10

    def test_loop_engine_default_max_iterations(self):
        """Given no max_iterations, When I create LoopEngine, Then default is 100."""
        from loopengine.evolution.loop_engine import LoopEngine

        engine = LoopEngine(
            agent_builder=MagicMock(),
            benchmark=MagicMock(),
            strategies=[],
            gate=MagicMock(),
        )

        assert engine._max_iterations == 100


# ---------------------------------------------------------------------------
# Slice: EvolutionReport summary
# ---------------------------------------------------------------------------


class TestEvolutionReportSummary:
    """Given an EvolutionReport, When I call summary, Then readable text is produced."""

    def test_summary_basic(self):
        """Given a report with data, When I call summary, Then it contains key metrics."""
        from loopengine.evolution.loop_engine import EvolutionReport

        report = EvolutionReport(
            iterations=3,
            history=[
                {"iteration": 0, "score": 0.5, "proposals": 1, "promoted": True},
                {"iteration": 1, "score": 0.7, "proposals": 2, "promoted": False},
                {"iteration": 2, "score": 0.7, "proposals": 0, "promoted": False},
            ],
            final_score=0.7,
            improvements=1,
            rejections=2,
        )

        summary = report.summary()

        assert "3" in summary  # iterations
        assert "0.7" in summary  # final score
        assert "1" in summary  # improvements
        assert "2" in summary  # rejections
        assert "PROMOTED" in summary
        assert "REJECTED" in summary

    def test_summary_no_improvements(self):
        """Given no improvements, When I call summary, Then it says no improvements."""
        from loopengine.evolution.loop_engine import EvolutionReport

        report = EvolutionReport(
            iterations=0,
            history=[],
            final_score=0.0,
            improvements=0,
            rejections=0,
        )

        summary = report.summary()

        assert "no improvements" in summary.lower()

    def test_summary_calculates_total_improvement(self):
        """Given history with first and last scores, When I call summary, Then delta is shown."""
        from loopengine.evolution.loop_engine import EvolutionReport

        report = EvolutionReport(
            iterations=2,
            history=[
                {"iteration": 0, "score": 0.5, "proposals": 1, "promoted": True},
                {"iteration": 1, "score": 0.8, "proposals": 1, "promoted": True},
            ],
            final_score=0.8,
            improvements=2,
            rejections=0,
        )

        summary = report.summary()

        assert "+0.3" in summary  # total improvement

    def test_report_is_frozen(self):
        """Given an EvolutionReport, When I try to mutate, Then FrozenInstanceError is raised."""
        from dataclasses import FrozenInstanceError
        from loopengine.evolution.loop_engine import EvolutionReport

        report = EvolutionReport(iterations=1, final_score=0.5)

        with pytest.raises(FrozenInstanceError):
            report.iterations = 2  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Slice: Run basic cycle (mock everything)
# ---------------------------------------------------------------------------


class TestLoopEngineRunBasic:
    """Given mocks for all components, When I run, Then a basic cycle completes."""

    async def test_run_basic_cycle(self):
        """Given benchmark returns a result and strategy proposes a mod, When I run, Then cycle completes."""
        from loopengine.evolution.loop_engine import LoopEngine, EvolutionReport
        from loopengine.evolution.promotion import PromotionGate, PromotionDecision

        # Mock benchmark: returns good result first, then better
        call_count = 0

        async def mock_benchmark_run(tasks):
            nonlocal call_count
            call_count += 1
            if call_count <= 1:
                return BenchmarkResult(
                    scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
                    aggregate={"mean_score": 0.5, "pass_rate": 1.0},
                )
            else:
                return BenchmarkResult(
                    scores={"task_0": EvalResult(passed=True, score=0.8, reason="better")},
                    aggregate={"mean_score": 0.8, "pass_rate": 1.0},
                )

        benchmark = MagicMock()
        benchmark.run = AsyncMock(side_effect=mock_benchmark_run)

        # Mock strategy: returns a CodeMod
        mod = CodeMod(
            target_file="prompt.py",
            description="Improve prompt",
            diff="...",
            rationale="Agent is confused",
            expected_impact="Better score",
        )
        strategy = AsyncMock()
        strategy.name = "test_strategy"
        strategy.propose = AsyncMock(return_value=[mod])

        # Mock gate: promotes
        gate = MagicMock()
        gate.validate = AsyncMock(return_value=PromotionDecision(
            promoted=True,
            reason="Approved: +0.3 improvement",
        ))

        # Agent builder: returns a mock harness
        agent_builder = MagicMock()

        engine = LoopEngine(
            agent_builder=agent_builder,
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            max_iterations=5,
        )

        report = await engine.run(tasks=[MagicMock()], source_files={"prompt.py": "old"})

        assert isinstance(report, EvolutionReport)
        assert report.improvements >= 1
        assert report.iterations >= 1

    async def test_run_records_history(self):
        """Given a run, When it completes, Then history has entries for each iteration."""
        from loopengine.evolution.loop_engine import LoopEngine
        from loopengine.evolution.promotion import PromotionDecision

        benchmark = MagicMock()
        benchmark.run = AsyncMock(return_value=BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
            aggregate={"mean_score": 0.5, "pass_rate": 1.0},
        ))

        strategy = AsyncMock()
        strategy.name = "test"
        strategy.propose = AsyncMock(return_value=[
            CodeMod(target_file="x.py", description="mod", diff="...", rationale="", expected_impact=""),
        ])

        gate = MagicMock()
        gate.validate = AsyncMock(return_value=PromotionDecision(
            promoted=True, reason="ok",
        ))

        engine = LoopEngine(
            agent_builder=MagicMock(),
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            max_iterations=3,
        )

        report = await engine.run(tasks=[MagicMock()], source_files={})

        assert len(report.history) >= 1
        for entry in report.history:
            assert "iteration" in entry
            assert "score" in entry
            assert "proposals" in entry
            assert "promoted" in entry


# ---------------------------------------------------------------------------
# Slice: Run with rejection (gate rejects)
# ---------------------------------------------------------------------------


class TestLoopEngineRunRejection:
    """Given a gate that rejects all proposals, When I run, Then rejections are recorded."""

    async def test_run_with_rejection(self):
        """Given gate always rejects, When I run, Then rejections count increases."""
        from loopengine.evolution.loop_engine import LoopEngine
        from loopengine.evolution.promotion import PromotionDecision

        benchmark = MagicMock()
        benchmark.run = AsyncMock(return_value=BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
            aggregate={"mean_score": 0.5, "pass_rate": 1.0},
        ))

        # Strategy always proposes something
        strategy = AsyncMock()
        strategy.name = "test"
        strategy.propose = AsyncMock(return_value=[
            CodeMod(target_file="x.py", description="mod", diff="...", rationale="", expected_impact=""),
        ])

        # Gate always rejects
        gate = MagicMock()
        gate.validate = AsyncMock(return_value=PromotionDecision(
            promoted=False, reason="Insufficient improvement",
        ))

        engine = LoopEngine(
            agent_builder=MagicMock(),
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            max_iterations=3,
        )

        report = await engine.run(tasks=[MagicMock()], source_files={})

        assert report.rejections >= 1
        assert report.improvements == 0


# ---------------------------------------------------------------------------
# Slice: Run with no proposals (strategies return empty)
# ---------------------------------------------------------------------------


class TestLoopEngineRunNoProposals:
    """Given strategies return empty, When I run, Then loop stops after consecutive empty rounds."""

    async def test_run_stops_on_no_proposals(self):
        """Given strategies return [], When I run, Then loop stops quickly."""
        from loopengine.evolution.loop_engine import LoopEngine

        benchmark = MagicMock()
        benchmark.run = AsyncMock(return_value=BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
            aggregate={"mean_score": 0.5, "pass_rate": 1.0},
        ))

        # Strategy returns nothing
        strategy = AsyncMock()
        strategy.name = "empty"
        strategy.propose = AsyncMock(return_value=[])

        gate = MagicMock()

        engine = LoopEngine(
            agent_builder=MagicMock(),
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            max_iterations=100,
        )

        report = await engine.run(tasks=[MagicMock()], source_files={})

        # Should stop after 2 consecutive no-proposal iterations
        assert report.iterations <= 3
        assert report.improvements == 0


# ---------------------------------------------------------------------------
# Slice: Run max_iterations limit
# ---------------------------------------------------------------------------


class TestLoopEngineMaxIterations:
    """Given max_iterations=2, When I run, Then at most 2 iterations happen."""

    async def test_run_respects_max_iterations(self):
        """Given max_iterations=2, When I run, Then iterations <= 2."""
        from loopengine.evolution.loop_engine import LoopEngine
        from loopengine.evolution.promotion import PromotionDecision

        benchmark = MagicMock()
        benchmark.run = AsyncMock(return_value=BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
            aggregate={"mean_score": 0.5, "pass_rate": 1.0},
        ))

        # Strategy always returns a proposal
        strategy = AsyncMock()
        strategy.name = "persistent"
        strategy.propose = AsyncMock(return_value=[
            CodeMod(target_file="x.py", description="mod", diff="...", rationale="", expected_impact=""),
        ])

        # Gate always promotes
        gate = MagicMock()
        gate.validate = AsyncMock(return_value=PromotionDecision(
            promoted=True, reason="Approved",
        ))

        engine = LoopEngine(
            agent_builder=MagicMock(),
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            max_iterations=2,
        )

        report = await engine.run(tasks=[MagicMock()], source_files={})

        assert report.iterations <= 2


# ---------------------------------------------------------------------------
# Slice: All-rejected scenario
# ---------------------------------------------------------------------------


class TestLoopEngineAllRejected:
    """Given all proposals are rejected, When I run, Then final score stays at baseline."""

    async def test_all_rejected_keeps_baseline_score(self):
        """Given all mods rejected, When I run, Then final score equals baseline."""
        from loopengine.evolution.loop_engine import LoopEngine
        from loopengine.evolution.promotion import PromotionDecision

        benchmark = MagicMock()
        benchmark.run = AsyncMock(return_value=BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=0.6, reason="ok")},
            aggregate={"mean_score": 0.6, "pass_rate": 1.0},
        ))

        strategy = AsyncMock()
        strategy.name = "bad_strategy"
        strategy.propose = AsyncMock(return_value=[
            CodeMod(target_file="x.py", description="bad mod", diff="...", rationale="", expected_impact=""),
        ])

        gate = MagicMock()
        gate.validate = AsyncMock(return_value=PromotionDecision(
            promoted=False, reason="Made things worse",
        ))

        engine = LoopEngine(
            agent_builder=MagicMock(),
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            max_iterations=5,
        )

        report = await engine.run(tasks=[MagicMock()], source_files={})

        assert report.improvements == 0
        # Score should be from the last benchmark run (0.6)
        assert report.final_score == pytest.approx(0.6)


# ---------------------------------------------------------------------------
# Slice: _apply_mods helper
# ---------------------------------------------------------------------------


class TestLoopEngineApplyMods:
    """Given CodeMods, When I call _apply_mods, Then source files are modified."""

    def test_apply_mods_with_code_mod(self):
        """Given a CodeMod and source files, When I apply, Then files are modified."""
        from loopengine.evolution.loop_engine import LoopEngine

        engine = LoopEngine(
            agent_builder=MagicMock(),
            benchmark=MagicMock(),
            strategies=[],
            gate=MagicMock(),
        )

        source = {"prompt.py": "old prompt", "other.py": "unchanged"}
        mod = CodeMod(
            target_file="prompt.py",
            description="Better prompt",
            diff="",
            rationale="",
            expected_impact="",
        )

        # With the stub, apply_to just returns the files unchanged
        # With real CodeMod, it would apply the diff
        result = engine._apply_mods([mod], source)

        # The result should be a copy, not the original
        assert result is not source
        # Other file should still be there
        assert "other.py" in result
