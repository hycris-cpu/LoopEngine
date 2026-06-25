"""Tests for evolution checkpoint/resume (Feature C).

Durable run state so a self-improvement run survives a crash and continues from
where it left off instead of restarting from scratch.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from loopengine.evaluation.benchmark import BenchmarkResult
from loopengine.evolution.checkpoint import CheckpointStore, EvolutionCheckpoint
from loopengine.evolution.loop_engine import LoopEngine
from loopengine.primitives.events import EvalResult


def _benchmark_returning(mean: float):
    benchmark = MagicMock()
    benchmark.run = AsyncMock(
        return_value=BenchmarkResult(
            scores={"task_0": EvalResult(passed=True, score=mean, reason="")},
            aggregate={"mean_score": mean, "pass_rate": 1.0},
        )
    )
    return benchmark


def _mock_agent_builder():
    harness = MagicMock()
    harness.run_batch = AsyncMock(return_value=[MagicMock()])
    return MagicMock(return_value=harness)


class TestCheckpointStore:
    def test_save_then_load_roundtrips(self, tmp_path):
        path = tmp_path / "ckpt.json"
        store = CheckpointStore(str(path))
        cp = EvolutionCheckpoint(
            iteration=2,
            history=[{"iteration": 0, "score": 0.5, "promoted": True}],
            current_source={"x.py": "v\n"},
            current_config={"flag": True},
            improvements=1,
            rejections=4,
            final_score=0.8,
        )
        store.save(cp)
        loaded = store.load()
        assert loaded is not None
        assert loaded.iteration == 2
        assert loaded.history == cp.history
        assert loaded.current_source == {"x.py": "v\n"}
        assert loaded.current_config == {"flag": True}
        assert loaded.improvements == 1
        assert loaded.rejections == 4
        assert loaded.final_score == 0.8

    def test_load_missing_returns_none(self, tmp_path):
        store = CheckpointStore(str(tmp_path / "absent.json"))
        assert store.exists() is False
        assert store.load() is None


class TestLoopEngineCheckpointing:
    async def test_run_writes_a_checkpoint(self, tmp_path):
        path = tmp_path / "run.json"
        strategy = AsyncMock()
        strategy.name = "s"
        strategy.propose = AsyncMock(return_value=[])  # no proposals → stops fast
        engine = LoopEngine(
            agent_builder=_mock_agent_builder(),
            benchmark=_benchmark_returning(0.5),
            strategies=[strategy],
            gate=MagicMock(),
            max_iterations=5,
            checkpoint_path=str(path),
        )
        await engine.run(tasks=[MagicMock()], source_files={})
        store = CheckpointStore(str(path))
        assert store.exists() is True
        assert store.load() is not None

    async def test_resume_restores_prior_state(self, tmp_path):
        path = tmp_path / "run.json"

        # Seed a checkpoint as if a prior run had already promoted 3 times.
        CheckpointStore(str(path)).save(
            EvolutionCheckpoint(
                iteration=0,
                history=[{"iteration": 0, "score": 0.9, "promoted": True}],
                current_source={"x.py": "v\n"},
                current_config={},
                improvements=3,
                rejections=2,
                final_score=0.9,
            )
        )

        # A fresh engine whose strategy proposes NOTHING. If state is restored,
        # improvements stays at 3; a non-resumed run would report 0.
        strategy = AsyncMock()
        strategy.name = "s"
        strategy.propose = AsyncMock(return_value=[])
        engine = LoopEngine(
            agent_builder=_mock_agent_builder(),
            benchmark=_benchmark_returning(0.5),
            strategies=[strategy],
            gate=MagicMock(),
            max_iterations=5,
            checkpoint_path=str(path),
        )
        report = await engine.run(tasks=[MagicMock()], source_files={}, resume=True)
        assert report.improvements == 3
