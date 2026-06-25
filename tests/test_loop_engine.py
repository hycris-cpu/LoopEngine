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

from dataclasses import dataclass, field
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

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

        def to_dict(self):
            return {}

        def is_safe(self) -> bool:
            return True

    @dataclass(frozen=True)
    class CodeModSet:
        mods: tuple = ()

        def is_safe(self) -> bool:
            return True

        def apply_to(self, files):
            return files


def _make_mock_agent_builder():
    """Create a mock agent_builder that returns a harness with async run_batch.

    The evolution loop calls agent_builder(config) to get a Harness, then
    harness.run_batch(tasks) to run tasks. Both need to be mockable.
    """
    harness = MagicMock()
    harness.run_batch = AsyncMock(return_value=[MagicMock()])
    return MagicMock(return_value=harness)


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
        from loopengine.evolution.loop_engine import EvolutionReport, LoopEngine
        from loopengine.evolution.promotion import PromotionDecision, PromotionGate

        # Mock benchmark: returns good result first, then better
        call_count = 0

        async def mock_benchmark_run(run_results, tasks=None):
            nonlocal call_count
            call_count += 1
            if call_count <= 1:
                return BenchmarkResult(
                    scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
                    aggregate={"mean_score": 0.5, "pass_rate": 1.0},
                )
            else:
                return BenchmarkResult(
                    scores={
                        "task_0": EvalResult(passed=True, score=0.8, reason="better")
                    },
                    aggregate={"mean_score": 0.8, "pass_rate": 1.0},
                )

        benchmark = MagicMock()
        benchmark.run = AsyncMock(side_effect=mock_benchmark_run)

        # Mock strategy: returns a CodeMod
        mod = CodeMod(
            target_file="prompt.py",
            description="Improve prompt",
            diff="--- a/prompt.py\n+++ b/prompt.py\n@@ -1 +1 @@\n-old\n+new\n",
            rationale="Agent is confused",
            expected_impact="Better score",
        )
        strategy = AsyncMock()
        strategy.name = "test_strategy"
        strategy.propose = AsyncMock(return_value=[mod])

        # Mock gate: promotes
        gate = MagicMock()
        gate.validate = AsyncMock(
            return_value=PromotionDecision(
                promoted=True,
                reason="Approved: +0.3 improvement",
            )
        )

        # Agent builder: returns a mock harness with async run_batch
        agent_builder = _make_mock_agent_builder()

        engine = LoopEngine(
            agent_builder=agent_builder,
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            max_iterations=5,
        )

        report = await engine.run(
            tasks=[MagicMock()], source_files={"prompt.py": "old\n"}
        )

        assert isinstance(report, EvolutionReport)
        assert report.improvements >= 1
        assert report.iterations >= 1

    async def test_run_records_history(self):
        """Given a run, When it completes, Then history has entries for each iteration."""
        from loopengine.evolution.loop_engine import LoopEngine
        from loopengine.evolution.promotion import PromotionDecision

        benchmark = MagicMock()
        benchmark.run = AsyncMock(
            return_value=BenchmarkResult(
                scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
                aggregate={"mean_score": 0.5, "pass_rate": 1.0},
            )
        )

        strategy = AsyncMock()
        strategy.name = "test"
        strategy.propose = AsyncMock(
            return_value=[
                CodeMod(
                    target_file="x.py",
                    description="mod",
                    diff="...",
                    rationale="",
                    expected_impact="",
                ),
            ]
        )

        gate = MagicMock()
        gate.validate = AsyncMock(
            return_value=PromotionDecision(
                promoted=True,
                reason="ok",
            )
        )

        engine = LoopEngine(
            agent_builder=_make_mock_agent_builder(),
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
        benchmark.run = AsyncMock(
            return_value=BenchmarkResult(
                scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
                aggregate={"mean_score": 0.5, "pass_rate": 1.0},
            )
        )

        # Strategy always proposes something
        strategy = AsyncMock()
        strategy.name = "test"
        strategy.propose = AsyncMock(
            return_value=[
                CodeMod(
                    target_file="x.py",
                    description="mod",
                    diff="...",
                    rationale="",
                    expected_impact="",
                ),
            ]
        )

        # Gate always rejects
        gate = MagicMock()
        gate.validate = AsyncMock(
            return_value=PromotionDecision(
                promoted=False,
                reason="Insufficient improvement",
            )
        )

        engine = LoopEngine(
            agent_builder=_make_mock_agent_builder(),
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
        benchmark.run = AsyncMock(
            return_value=BenchmarkResult(
                scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
                aggregate={"mean_score": 0.5, "pass_rate": 1.0},
            )
        )

        # Strategy returns nothing
        strategy = AsyncMock()
        strategy.name = "empty"
        strategy.propose = AsyncMock(return_value=[])

        gate = MagicMock()

        engine = LoopEngine(
            agent_builder=_make_mock_agent_builder(),
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
        benchmark.run = AsyncMock(
            return_value=BenchmarkResult(
                scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
                aggregate={"mean_score": 0.5, "pass_rate": 1.0},
            )
        )

        # Strategy always returns a proposal
        strategy = AsyncMock()
        strategy.name = "persistent"
        strategy.propose = AsyncMock(
            return_value=[
                CodeMod(
                    target_file="x.py",
                    description="mod",
                    diff="...",
                    rationale="",
                    expected_impact="",
                ),
            ]
        )

        # Gate always promotes
        gate = MagicMock()
        gate.validate = AsyncMock(
            return_value=PromotionDecision(
                promoted=True,
                reason="Approved",
            )
        )

        engine = LoopEngine(
            agent_builder=_make_mock_agent_builder(),
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
        benchmark.run = AsyncMock(
            return_value=BenchmarkResult(
                scores={"task_0": EvalResult(passed=True, score=0.6, reason="ok")},
                aggregate={"mean_score": 0.6, "pass_rate": 1.0},
            )
        )

        strategy = AsyncMock()
        strategy.name = "bad_strategy"
        strategy.propose = AsyncMock(
            return_value=[
                CodeMod(
                    target_file="x.py",
                    description="bad mod",
                    diff="...",
                    rationale="",
                    expected_impact="",
                ),
            ]
        )

        gate = MagicMock()
        gate.validate = AsyncMock(
            return_value=PromotionDecision(
                promoted=False,
                reason="Made things worse",
            )
        )

        engine = LoopEngine(
            agent_builder=_make_mock_agent_builder(),
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


# ---------------------------------------------------------------------------
# Slice: agent_builder receives modified source files
# ---------------------------------------------------------------------------


class TestLoopEngineAgentBuilderReceivesSource:
    """Given a run with a proposal, When the candidate benchmark runs,
    Then agent_builder receives the modified source files."""

    async def test_agent_builder_gets_candidate_source(self):
        """Given a promoted mod, When _run_benchmark is called for the candidate,
        Then agent_builder receives a config with the modified source_files."""
        from loopengine.evolution.loop_engine import LoopEngine
        from loopengine.evolution.promotion import PromotionDecision

        # Track what configs agent_builder receives
        received_configs: list[dict] = []

        def agent_builder(cfg):
            received_configs.append(dict(cfg))
            harness = MagicMock()
            harness.run_batch = AsyncMock(return_value=[MagicMock()])
            return harness

        # Benchmark returns baseline first, then improved
        call_count = 0

        async def mock_benchmark_run(run_results, tasks=None):
            nonlocal call_count
            call_count += 1
            if call_count <= 1:
                return BenchmarkResult(
                    scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
                    aggregate={"mean_score": 0.5, "pass_rate": 1.0},
                )
            return BenchmarkResult(
                scores={"task_0": EvalResult(passed=True, score=0.8, reason="better")},
                aggregate={"mean_score": 0.8, "pass_rate": 1.0},
            )

        benchmark = MagicMock()
        benchmark.run = AsyncMock(side_effect=mock_benchmark_run)

        strategy = AsyncMock()
        strategy.name = "test"
        strategy.propose = AsyncMock(
            return_value=[
                CodeMod(
                    target_file="prompt.py",
                    description="Improve prompt",
                    diff="--- a/prompt.py\n+++ b/prompt.py\n@@ -1 +1 @@\n-old prompt\n+new prompt\n",
                    rationale="Better",
                    expected_impact="Higher score",
                )
            ]
        )

        gate = MagicMock()
        gate.validate = AsyncMock(
            return_value=PromotionDecision(promoted=True, reason="ok")
        )

        engine = LoopEngine(
            agent_builder=agent_builder,
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            max_iterations=1,
        )

        await engine.run(
            tasks=[MagicMock()],
            source_files={"prompt.py": "old prompt\n"},
        )

        # agent_builder should have been called at least twice:
        # once for baseline, once for candidate
        assert len(received_configs) >= 2

        # The baseline call should have the original source
        baseline_source = received_configs[0].get("source_files", {})
        assert baseline_source.get("prompt.py") == "old prompt\n"

        # The candidate call should have the modified source
        candidate_source = received_configs[1].get("source_files", {})
        assert candidate_source.get("prompt.py") == "new prompt\n"


# ---------------------------------------------------------------------------
# Slice: hardening fixes (C2 safety-before-exec, C3 fail-loud, M2 ranking,
# M3 patience, C4 materialization)
# ---------------------------------------------------------------------------


class TestLoopEngineHardening:
    def test_uses_real_codemod_no_shadow_stub(self):
        """C3: loop_engine must use the real CodeMod, not a fail-open stub."""
        from loopengine.evolution import loop_engine as le
        from loopengine.evolution.code_mod import CodeMod as RealCodeMod
        from loopengine.evolution.promotion import PromotionGate as RealGate
        from loopengine.evaluation.benchmark import BenchmarkResult as RealBR

        assert le.CodeMod is RealCodeMod
        assert le.PromotionGate is RealGate
        assert le.BenchmarkResult is RealBR

    async def test_unsafe_mod_is_never_built_or_run(self):
        """C2: an unsafe mod must be rejected BEFORE the candidate is built."""
        from loopengine.evolution.loop_engine import LoopEngine
        from loopengine.evolution.code_mod import CodeMod
        from loopengine.primitives.events import EvalResult

        unsafe_call = "os." + "system"  # avoid the literal token in source
        unsafe_mod = CodeMod(
            target_file="x.py",
            description="run a command",
            diff=f"--- a/x.py\n+++ b/x.py\n@@ -1 +1,2 @@\n a\n+{unsafe_call}('echo hi')\n",
            rationale="x",
        )

        benchmark = MagicMock()
        benchmark.run = AsyncMock(
            return_value=BenchmarkResult(
                scores={"task_0": EvalResult(passed=True, score=0.5, reason="ok")},
                aggregate={"mean_score": 0.5, "pass_rate": 1.0},
            )
        )
        strategy = AsyncMock()
        strategy.name = "s"
        strategy.propose = AsyncMock(return_value=[unsafe_mod])

        gate = MagicMock()  # would promote, but must never be consulted
        gate.validate = AsyncMock(side_effect=AssertionError("gate ran on unsafe mod"))

        builder = _make_mock_agent_builder()
        engine = LoopEngine(
            agent_builder=builder,
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            max_iterations=1,
        )
        report = await engine.run(tasks=[MagicMock()], source_files={"x.py": "a\n"})

        # Only the baseline harness is built; the unsafe candidate is skipped.
        assert builder.call_count == 1
        assert report.improvements == 0
        assert report.rejections >= 1

    async def test_promotes_highest_scoring_candidate_not_first(self):
        """M2: among passing candidates, promote the best, not the first."""
        from loopengine.evolution.loop_engine import LoopEngine
        from loopengine.evolution.code_mod import CodeMod
        from loopengine.evolution.promotion import PromotionDecision
        from loopengine.primitives.events import EvalResult

        seq = [0.5, 0.6, 0.9, 0.7]  # baseline, candA, candB, candC
        idx = 0

        async def bench_run(run_results, tasks=None):
            nonlocal idx
            s = seq[min(idx, len(seq) - 1)]
            idx += 1
            return BenchmarkResult(
                scores={"task_0": EvalResult(passed=True, score=s, reason="")},
                aggregate={"mean_score": s, "pass_rate": 1.0},
            )

        benchmark = MagicMock()
        benchmark.run = AsyncMock(side_effect=bench_run)

        mods = [
            CodeMod(target_file="x.py", diff="--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+A\n"),
            CodeMod(target_file="x.py", diff="--- a/x.py\n+++ b/x.py\n@@ -2 +2 @@\n-b\n+B\n"),
            CodeMod(target_file="x.py", diff="--- a/x.py\n+++ b/x.py\n@@ -3 +3 @@\n-c\n+C\n"),
        ]
        strategy = AsyncMock()
        strategy.name = "s"
        strategy.propose = AsyncMock(return_value=mods)

        gate = MagicMock()
        gate.validate = AsyncMock(
            return_value=PromotionDecision(promoted=True, reason="ok")
        )

        engine = LoopEngine(
            agent_builder=_make_mock_agent_builder(),
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            max_iterations=1,
        )
        report = await engine.run(
            tasks=[MagicMock()], source_files={"x.py": "a\nb\nc\n"}
        )

        assert report.improvements == 1
        assert report.final_score == 0.9  # candidate B, the best — not first

    async def test_patience_stops_after_consecutive_non_promotions(self):
        """M3: stop after `patience` consecutive iterations with no promotion."""
        from loopengine.evolution.loop_engine import LoopEngine
        from loopengine.evolution.code_mod import CodeMod
        from loopengine.evolution.promotion import PromotionDecision
        from loopengine.primitives.events import EvalResult

        benchmark = MagicMock()
        benchmark.run = AsyncMock(
            return_value=BenchmarkResult(
                scores={"task_0": EvalResult(passed=True, score=0.5, reason="")},
                aggregate={"mean_score": 0.5, "pass_rate": 1.0},
            )
        )
        mod = CodeMod(target_file="x.py", diff="--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+A\n")
        strategy = AsyncMock()
        strategy.name = "s"
        strategy.propose = AsyncMock(return_value=[mod])

        gate = MagicMock()
        gate.validate = AsyncMock(
            return_value=PromotionDecision(promoted=False, reason="no")
        )

        engine = LoopEngine(
            agent_builder=_make_mock_agent_builder(),
            benchmark=benchmark,
            strategies=[strategy],
            gate=gate,
            max_iterations=10,
            patience=2,
        )
        report = await engine.run(tasks=[MagicMock()], source_files={"x.py": "a\n"})

        assert report.iterations == 2

    def test_materialize_writes_source_to_workspace(self):
        """C4: source_files are materialized to an isolated on-disk workspace."""
        import tempfile
        from pathlib import Path
        from loopengine.evolution.loop_engine import LoopEngine

        engine = LoopEngine(
            agent_builder=MagicMock(),
            benchmark=MagicMock(),
            strategies=[],
            gate=MagicMock(),
        )
        src = {"pkg/mod.py": "print(1)\n", "top.py": "x = 2\n"}
        with tempfile.TemporaryDirectory() as root:
            workspace = engine._materialize(src, root)
            assert (Path(workspace) / "pkg" / "mod.py").read_text() == "print(1)\n"
            assert (Path(workspace) / "top.py").read_text() == "x = 2\n"
