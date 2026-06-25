"""
Integration tests — verifying that all 5 layers work together end-to-end.

These tests exercise the FULL STACK:
  Primitives → Composition → Execution → Evaluation → Evolution

Think of these as "smoke tests" for the entire framework.
If unit tests check each part in isolation, integration tests check
that the parts fit together like puzzle pieces.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

import loopengine as le
from loopengine.composition.builder import HarnessBuilder
from loopengine.composition.config import HarnessConfig
from loopengine.evaluation.benchmark import BenchmarkResult, compare
from loopengine.evolution.analysis import Insight, analyze_trajectory
from loopengine.evolution.code_mod import CodeMod, CodeModSet
from loopengine.evolution.promotion import PromotionDecision, PromotionGate
from loopengine.execution.harness import Harness
from loopengine.execution.runloop import ModelProvider, RunResult, run_loop
from loopengine.execution.task import SimpleTask
from loopengine.primitives.events import Event, Message, MessageType
from loopengine.primitives.processors import MultiHookProcessor, ProcessorChain
from loopengine.primitives.state import Budget, State
from loopengine.primitives.tools import ToolContext, ToolRegistry, ToolSchema
from loopengine.primitives.trajectory import Trajectory, TrajectoryStep, load_trajectory

# ---------------------------------------------------------------------------
# BDD: Building an agent from scratch using the builder pattern
# ---------------------------------------------------------------------------


class TestBuilderToHarnessIntegration:
    """BDD: Given a user who wants to build a coding agent,
    When they compose bundles and build a harness,
    Then they get a working agent that can run tasks."""

    def test_compose_bundles_and_build(self):
        """Given two bundles (coding + reliability),
        When composed with | and built,
        Then we get a valid HarnessConfig with processors from both."""
        builder = le.make_coding(working_dir="/tmp") | le.make_reliability()
        config = builder.build()

        assert isinstance(config, HarnessConfig)
        # Both bundles contribute processors
        assert len(config.processors) > 0
        # Config has a deterministic fingerprint
        fp1 = config.fingerprint()
        fp2 = config.fingerprint()
        assert fp1 == fp2  # Same config → same hash

    def test_harness_from_builder(self):
        """Given a builder with tools and processors,
        When creating a Harness via from_builder,
        Then the Harness is ready to run tasks."""
        mock_model = AsyncMock(spec=ModelProvider)
        mock_model.complete = AsyncMock(
            return_value=Message(
                type="message",
                run_id="r",
                step_id=0,
                role="assistant",
                content="Done!",
            )
        )
        mock_model.count_tokens = MagicMock(return_value=10)

        builder = le.make_coding()
        harness = Harness.from_builder(builder, model=mock_model)

        assert isinstance(harness, Harness)
        assert harness.model is mock_model


# ---------------------------------------------------------------------------
# BDD: Running a task through the full execution pipeline
# ---------------------------------------------------------------------------


class TestRunLoopIntegration:
    """BDD: Given an agent with a mock model,
    When we run a task through the run loop,
    Then we get a RunResult with a trajectory."""

    @pytest.fixture
    def mock_model(self):
        """A mock model that responds with a simple message (no tool calls)."""
        model = AsyncMock(spec=ModelProvider)
        model.complete = AsyncMock(
            return_value=Message(
                type="message",
                run_id="test",
                step_id=0,
                role="assistant",
                content="I'll help with that.",
            )
        )
        model.count_tokens = MagicMock(return_value=10)
        return model

    async def test_run_loop_produces_trajectory(self, mock_model):
        """Given a task and mock model,
        When running the run_loop,
        Then we get a RunResult with trajectory steps."""
        task = SimpleTask(prompt="Say hello", max_steps=5)
        config = HarnessConfig()

        result = await run_loop(task=task, model=mock_model, config=config)

        assert isinstance(result, RunResult)
        assert isinstance(result.trajectory, Trajectory)
        assert result.exit_reason in ("end_turn", "max_steps", "is_done", "budget")
        assert result.total_steps >= 1

    async def test_harness_run_end_to_end(self, mock_model):
        """Given a Harness with a coding config,
        When running a SimpleTask,
        Then we get a RunResult with populated fields."""
        config = (le.make_coding()).build()
        harness = Harness(model=mock_model, config=config)
        task = SimpleTask(prompt="Write fibonacci", max_steps=3)

        result = await harness.run(task)

        assert isinstance(result, RunResult)
        assert result.trajectory is not None


# ---------------------------------------------------------------------------
# BDD: Evaluation pipeline — from trajectory to score
# ---------------------------------------------------------------------------


class TestEvaluationIntegration:
    """BDD: Given a completed trajectory,
    When we evaluate it with judges,
    Then we get scores and can compare benchmark results."""

    def test_benchmark_result_comparison(self):
        """Given two benchmark runs (baseline vs candidate),
        When we compare them,
        Then we see improvements and regressions."""
        baseline = BenchmarkResult(
            scores={
                "task1": le.EvalResult(
                    type="eval",
                    run_id="r",
                    step_id=0,
                    passed=True,
                    score=0.6,
                    reason="ok",
                    reward=0.6,
                ),
                "task2": le.EvalResult(
                    type="eval",
                    run_id="r",
                    step_id=0,
                    passed=True,
                    score=0.4,
                    reason="ok",
                    reward=0.4,
                ),
            },
            aggregate={"mean_score": 0.5},
        )
        candidate = BenchmarkResult(
            scores={
                "task1": le.EvalResult(
                    type="eval",
                    run_id="r",
                    step_id=0,
                    passed=True,
                    score=0.8,
                    reason="better",
                    reward=0.8,
                ),
                "task2": le.EvalResult(
                    type="eval",
                    run_id="r",
                    step_id=0,
                    passed=True,
                    score=0.3,
                    reason="worse",
                    reward=0.3,
                ),
            },
            aggregate={"mean_score": 0.55},
        )

        comparison = compare(baseline, candidate)

        assert isinstance(comparison, le.Comparison)
        # task1 improved (0.6 → 0.8), task2 regressed (0.4 → 0.3)
        assert len(comparison.improvements) > 0 or len(comparison.regressions) > 0


# ---------------------------------------------------------------------------
# BDD: Evolution pipeline — trajectory analysis → CodeMod → promotion
# ---------------------------------------------------------------------------


class TestEvolutionIntegration:
    """BDD: Given a trajectory with poor performance,
    When we analyze it and propose modifications,
    Then the promotion gate correctly evaluates the proposals."""

    def test_trajectory_analysis_finds_issues(self):
        """Given a trajectory with repeated identical actions,
        When we analyze it,
        Then we get Insights about the loop pattern."""
        # Build a trajectory with repeated identical steps
        trajectory = Trajectory()
        state = State()
        snap = state.snapshot()

        for i in range(5):
            step = TrajectoryStep(
                state_before=snap,
                action=Message(
                    type="message",
                    run_id="r",
                    step_id=i,
                    role="assistant",
                    content="search(query)",
                ),
                observations=(
                    le.ToolResult(
                        type="tool_result",
                        run_id="r",
                        step_id=i,
                        call_id=f"tc_{i}",
                        output="same result",
                    ),
                ),
                reward=0.1,
                delta=state.compute_delta(snap),
            )
            trajectory.add_step(step)

        insights = analyze_trajectory(trajectory)

        assert len(insights) > 0
        # Should detect the loop pattern
        categories = {i.category for i in insights}
        assert "loop" in categories or "inefficiency" in categories

    def test_code_mod_safety_check(self):
        """Given a CodeMod with a dangerous operation,
        When we check safety,
        Then it's flagged as unsafe."""
        safe_mod = CodeMod(
            target_file="prompts/system.py",
            description="Add a newline",
            diff="-old\n+new",
            rationale="Cleaner",
            expected_impact="Marginal",
        )
        unsafe_mod = CodeMod(
            target_file="prompts/system.py",
            description="Delete everything",
            diff="-old\n+import os; os.system('rm -rf /')",
            rationale="Evil",
            expected_impact="Destruction",
        )

        assert safe_mod.is_safe() is True
        assert unsafe_mod.is_safe() is False

    async def test_promotion_gate_decides_correctly(self):
        """Given a baseline and an improved candidate,
        When the promotion gate validates,
        Then it promotes if improvement exceeds threshold."""
        gate = PromotionGate(min_improvement=0.05, no_regression=0.1)

        baseline = BenchmarkResult(
            scores={
                "t1": le.EvalResult(
                    type="eval",
                    run_id="r",
                    step_id=0,
                    passed=True,
                    score=0.5,
                    reason="ok",
                    reward=0.5,
                )
            },
            aggregate={"mean_score": 0.5},
        )
        improved = BenchmarkResult(
            scores={
                "t1": le.EvalResult(
                    type="eval",
                    run_id="r",
                    step_id=0,
                    passed=True,
                    score=0.7,
                    reason="better",
                    reward=0.7,
                )
            },
            aggregate={"mean_score": 0.7},
        )

        mod = CodeMod(
            target_file="test.py",
            description="Better prompt",
            diff="-old\n+new",
            rationale="Improve accuracy",
            expected_impact="Higher score",
        )

        decision = await gate.validate(baseline, improved, mod)

        assert isinstance(decision, PromotionDecision)
        assert decision.promoted is True
        assert "improvement" in decision.reason.lower()


# ---------------------------------------------------------------------------
# BDD: Full loop engine cycle with mocks
# ---------------------------------------------------------------------------


class TestLoopEngineIntegration:
    """BDD: Given all components assembled,
    When the LoopEngine runs one cycle,
    Then it measures, proposes, tests, and decides."""

    async def test_loop_engine_single_cycle(self):
        """Given a LoopEngine with mock benchmark and strategy,
        When running one iteration,
        Then it produces an EvolutionReport with history."""
        # Mock benchmark: returns a result
        mock_benchmark = AsyncMock()
        result_a = BenchmarkResult(
            scores={
                "t1": le.EvalResult(
                    type="eval",
                    run_id="r",
                    step_id=0,
                    passed=True,
                    score=0.5,
                    reason="baseline",
                    reward=0.5,
                )
            },
            aggregate={"mean_score": 0.5},
        )
        result_b = BenchmarkResult(
            scores={
                "t1": le.EvalResult(
                    type="eval",
                    run_id="r",
                    step_id=0,
                    passed=True,
                    score=0.7,
                    reason="improved",
                    reward=0.7,
                )
            },
            aggregate={"mean_score": 0.7},
        )
        mock_benchmark.run = AsyncMock(side_effect=[result_a, result_b])

        # Mock strategy: proposes one mod
        mock_strategy = AsyncMock()
        mock_strategy.name = "test_strategy"
        mock_strategy.propose = AsyncMock(
            return_value=[
                CodeMod(
                    target_file="test.py",
                    description="Improve",
                    diff="-old\n+new",
                    rationale="Better",
                    expected_impact="Higher score",
                )
            ]
        )

        # Mock model for building agents
        mock_model = AsyncMock(spec=ModelProvider)
        mock_model.complete = AsyncMock(
            return_value=Message(
                type="message",
                run_id="r",
                step_id=0,
                role="assistant",
                content="Done",
            )
        )
        mock_model.count_tokens = MagicMock(return_value=10)

        # Agent builder: wraps make_coding() builder with a mock model to
        # produce a Harness from a config dict.
        base_builder = le.make_coding()

        def agent_builder(cfg):
            if isinstance(cfg, HarnessConfig):
                return Harness(model=mock_model, config=cfg)
            # cfg is a dict with source_files/sandbox merged in by _run_benchmark
            return Harness.from_builder(base_builder, model=mock_model)

        engine = le.LoopEngine(
            agent_builder=agent_builder,
            benchmark=mock_benchmark,
            strategies=[mock_strategy],
            gate=le.PromotionGate(min_improvement=0.01),
            sandbox=None,
            max_iterations=1,
        )

        report = await engine.run()

        assert isinstance(report, le.EvolutionReport)
        assert report.iterations >= 1


# ---------------------------------------------------------------------------
# BDD: Serialization roundtrip — config survives save/load
# ---------------------------------------------------------------------------


class TestSerializationIntegration:
    """BDD: Given a fully configured harness,
    When we serialize and deserialize it,
    Then the fingerprint matches (content-addressed)."""

    def test_config_fingerprint_roundtrip(self):
        """Given a config built from bundles,
        When serialized to dict and fingerprinted,
        Then identical configs produce identical fingerprints."""
        config1 = (le.make_coding() | le.make_reliability()).build()
        config2 = (le.make_coding() | le.make_reliability()).build()

        # Same build → same fingerprint
        assert config1.fingerprint() == config2.fingerprint()

        # Different build → different fingerprint
        config3 = (le.make_coding() | le.make_evaluation()).build()
        assert config1.fingerprint() != config3.fingerprint()

    def test_trajectory_jsonl_roundtrip(self, tmp_path):
        """Given a trajectory with steps,
        When saved to JSONL and loaded back,
        Then the data is preserved."""
        trajectory = Trajectory()
        state = State()
        snap = state.snapshot()

        trajectory.add_step(
            TrajectoryStep(
                state_before=snap,
                action=Message(
                    type="message",
                    run_id="r",
                    step_id=0,
                    role="assistant",
                    content="Hello",
                ),
                observations=(),
                reward=0.5,
                delta=state.compute_delta(snap),
            )
        )

        path = str(tmp_path / "traj.jsonl")
        trajectory.to_jsonl(path)
        loaded = load_trajectory(path)

        assert len(loaded) == 1
        assert loaded[0].reward == 0.5
