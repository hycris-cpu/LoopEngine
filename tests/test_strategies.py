"""Tests for Evolution Strategies — the "brains" of self-improvement.

BDD Scenarios:
- Given a PromptEvolver with a mock model, When I call propose, Then it returns CodeMods
- Given a ConfigEvolver with a low-score trajectory, When I call propose, Then it suggests budget changes
- Given a CompositeEvolutionStrategy, When I call propose, Then all sub-strategies contribute
- Given an EvolutionStrategy, When I check the protocol, Then it has name and propose
"""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from typing import Any

from loopengine.primitives.events import EvalResult, Message
from loopengine.primitives.trajectory import Trajectory, TrajectoryStep


# ---------------------------------------------------------------------------
# Stubs for dependencies that may not exist yet
# ---------------------------------------------------------------------------

try:
    from loopengine.evolution.code_mod import CodeMod, CodeModSet
except ImportError:
    from dataclasses import dataclass

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


# ---------------------------------------------------------------------------
# Slice: EvolutionStrategy protocol check
# ---------------------------------------------------------------------------


class TestEvolutionStrategyProtocol:
    """Given the EvolutionStrategy protocol, When I check it, Then it has name and propose."""

    def test_protocol_has_name(self):
        """Given EvolutionStrategy, When I inspect it, Then it requires a 'name' property."""
        from loopengine.evolution.strategies import EvolutionStrategy
        from typing import Protocol

        # EvolutionStrategy should be a Protocol
        assert isinstance(EvolutionStrategy, type)

        # Check that 'name' is in the protocol's annotations
        # The Protocol defines name as a property
        assert hasattr(EvolutionStrategy, "name") or "name" in getattr(
            EvolutionStrategy, "__annotations__", {}
        )

    def test_prompt_evolver_satisfies_protocol(self):
        """Given a PromptEvolver, When I check protocol, Then it satisfies EvolutionStrategy."""
        from loopengine.evolution.strategies import EvolutionStrategy, PromptEvolver

        model = AsyncMock()
        evolver = PromptEvolver(model)

        # Runtime checkable protocol
        assert isinstance(evolver, EvolutionStrategy)
        assert evolver.name == "prompt_evolver"

    def test_config_evolver_satisfies_protocol(self):
        """Given a ConfigEvolver, When I check protocol, Then it satisfies EvolutionStrategy."""
        from loopengine.evolution.strategies import EvolutionStrategy, ConfigEvolver

        evolver = ConfigEvolver()

        assert isinstance(evolver, EvolutionStrategy)
        assert evolver.name == "config_evolver"

    def test_composite_satisfies_protocol(self):
        """Given a CompositeEvolutionStrategy, When I check protocol, Then it satisfies EvolutionStrategy."""
        from loopengine.evolution.strategies import EvolutionStrategy, CompositeEvolutionStrategy

        composite = CompositeEvolutionStrategy([])

        assert isinstance(composite, EvolutionStrategy)
        assert composite.name == "composite"


# ---------------------------------------------------------------------------
# Slice: PromptEvolver with mock model
# ---------------------------------------------------------------------------


class TestPromptEvolverCreation:
    """Given a model provider, When I create a PromptEvolver, Then it stores the model."""

    def test_prompt_evolver_creation(self):
        """Given a mock model, When I create PromptEvolver, Then model is stored."""
        from loopengine.evolution.strategies import PromptEvolver

        model = AsyncMock()
        evolver = PromptEvolver(model)

        assert evolver._model is model
        assert evolver.name == "prompt_evolver"


class TestPromptEvolverPropose:
    """Given a mock model that returns a CodeMod JSON, When I call propose, Then CodeMods are returned."""

    async def test_propose_returns_code_mods(self):
        """Given a mock model returning CodeMod JSON, When I propose, Then CodeMod list is returned."""
        from loopengine.evolution.strategies import PromptEvolver

        # Mock model returns a valid CodeMod JSON
        mod_json = json.dumps({
            "target_file": "system_prompt.py",
            "description": "Add step counting",
            "diff": "--- a/system_prompt.py\n+++ b/system_prompt.py\n...",
            "rationale": "Agent repeats itself",
            "expected_impact": "10% fewer steps",
        })

        mock_response = Message(
            role="assistant",
            content=mod_json,
        )
        model = AsyncMock()
        model.complete = AsyncMock(return_value=mock_response)

        evolver = PromptEvolver(model)

        # Create a trajectory with some low-reward steps
        trajectory = Trajectory()
        trajectory.add_step(TrajectoryStep(reward=-0.5))
        trajectory.add_step(TrajectoryStep(reward=-0.3))

        eval_result = EvalResult(passed=False, score=0.3, reason="poor performance")

        mods = await evolver.propose(
            trajectory=trajectory,
            eval_result=eval_result,
            config={},
            source_code={"system_prompt.py": "You are a helpful assistant."},
        )

        assert len(mods) >= 1
        assert mods[0].target_file == "system_prompt.py"
        assert mods[0].description == "Add step counting"

    async def test_propose_returns_empty_for_good_score(self):
        """Given a high score and no insights, When I propose, Then empty list is returned."""
        from loopengine.evolution.strategies import PromptEvolver

        model = AsyncMock()
        evolver = PromptEvolver(model)

        trajectory = Trajectory()
        eval_result = EvalResult(passed=True, score=0.95, reason="excellent")

        mods = await evolver.propose(
            trajectory=trajectory,
            eval_result=eval_result,
            config={},
            source_code={},
        )

        # With score >= 0.8 and no insights, should return empty
        assert mods == []

    async def test_propose_handles_list_response(self):
        """Given a model returning a JSON array, When I propose, Then all mods are parsed."""
        from loopengine.evolution.strategies import PromptEvolver

        mods_json = json.dumps([
            {
                "target_file": "prompt_a.py",
                "description": "First improvement",
                "diff": "diff1",
                "rationale": "reason1",
                "expected_impact": "impact1",
            },
            {
                "target_file": "prompt_b.py",
                "description": "Second improvement",
                "diff": "diff2",
                "rationale": "reason2",
                "expected_impact": "impact2",
            },
        ])

        mock_response = Message(role="assistant", content=mods_json)
        model = AsyncMock()
        model.complete = AsyncMock(return_value=mock_response)

        evolver = PromptEvolver(model)

        trajectory = Trajectory()
        trajectory.add_step(TrajectoryStep(reward=-0.5))
        eval_result = EvalResult(passed=False, score=0.3, reason="poor")

        mods = await evolver.propose(
            trajectory=trajectory,
            eval_result=eval_result,
            config={},
            source_code={"prompt_a.py": "old prompt", "prompt_b.py": "old prompt"},
        )

        assert len(mods) == 2
        assert mods[0].target_file == "prompt_a.py"
        assert mods[1].target_file == "prompt_b.py"


# ---------------------------------------------------------------------------
# Slice: ConfigEvolver with low-score trajectory
# ---------------------------------------------------------------------------


class TestConfigEvolverCreation:
    """Given thresholds, When I create a ConfigEvolver, Then thresholds are stored."""

    def test_config_evolver_defaults(self):
        """Given default params, When I create ConfigEvolver, Then defaults are used."""
        from loopengine.evolution.strategies import ConfigEvolver

        evolver = ConfigEvolver()

        assert evolver._score_threshold == 0.7
        assert evolver._step_threshold == 50

    def test_config_evolver_custom_thresholds(self):
        """Given custom thresholds, When I create ConfigEvolver, Then they are stored."""
        from loopengine.evolution.strategies import ConfigEvolver

        evolver = ConfigEvolver(score_threshold=0.5, step_threshold=30)

        assert evolver._score_threshold == 0.5
        assert evolver._step_threshold == 30


class TestConfigEvolverPropose:
    """Given a low-score eval result, When I call propose, Then budget increase is suggested."""

    async def test_low_score_proposes_budget_increase(self):
        """Given score 0.3, When I propose, Then budget increase mod is returned."""
        from loopengine.evolution.strategies import ConfigEvolver

        evolver = ConfigEvolver(score_threshold=0.7)

        trajectory = Trajectory()
        eval_result = EvalResult(passed=False, score=0.3, reason="low score")

        mods = await evolver.propose(
            trajectory=trajectory,
            eval_result=eval_result,
            config={},
            source_code={},
        )

        assert len(mods) >= 1
        # First mod should be about budget
        assert any("budget" in m.description.lower() for m in mods)

    async def test_high_score_returns_empty(self):
        """Given high score and few steps, When I propose, Then no mods returned."""
        from loopengine.evolution.strategies import ConfigEvolver

        evolver = ConfigEvolver(score_threshold=0.7, step_threshold=50)

        trajectory = Trajectory()
        trajectory.add_step(TrajectoryStep(reward=1.0))
        eval_result = EvalResult(passed=True, score=0.9, reason="great")

        mods = await evolver.propose(
            trajectory=trajectory,
            eval_result=eval_result,
            config={},
            source_code={},
        )

        assert mods == []

    async def test_many_steps_proposes_efficiency(self):
        """Given 60 steps, When I propose, Then efficiency mod is suggested."""
        from loopengine.evolution.strategies import ConfigEvolver

        evolver = ConfigEvolver(score_threshold=0.7, step_threshold=50)

        trajectory = Trajectory()
        for _ in range(60):
            trajectory.add_step(TrajectoryStep(reward=0.01))
        eval_result = EvalResult(passed=True, score=0.8, reason="ok but slow")

        mods = await evolver.propose(
            trajectory=trajectory,
            eval_result=eval_result,
            config={},
            source_code={},
        )

        assert len(mods) >= 1
        assert any("efficiency" in m.description.lower() for m in mods)

    async def test_tool_errors_propose_recovery(self):
        """Given 3+ tool errors, When I propose, Then error recovery mod is suggested."""
        from loopengine.evolution.strategies import ConfigEvolver
        from loopengine.primitives.events import ToolResult

        evolver = ConfigEvolver(score_threshold=0.7, step_threshold=50)

        trajectory = Trajectory()
        # Add steps with tool errors
        for _ in range(3):
            trajectory.add_step(TrajectoryStep(
                reward=-0.1,
                observations=(
                    ToolResult(
                        run_id="test",
                        call_id="call_1",
                        output="",
                        error="Tool failed",
                    ),
                ),
            ))
        eval_result = EvalResult(passed=False, score=0.4, reason="tool failures")

        mods = await evolver.propose(
            trajectory=trajectory,
            eval_result=eval_result,
            config={},
            source_code={},
        )

        assert len(mods) >= 1
        assert any("error" in m.description.lower() for m in mods)


# ---------------------------------------------------------------------------
# Slice: CompositeEvolutionStrategy aggregates results
# ---------------------------------------------------------------------------


class TestCompositeEvolutionStrategy:
    """Given multiple strategies, When I call propose, Then all contribute proposals."""

    def test_composite_creation(self):
        """Given a list of strategies, When I create composite, Then strategies are stored."""
        from loopengine.evolution.strategies import CompositeEvolutionStrategy, ConfigEvolver

        strategies = [ConfigEvolver(), ConfigEvolver()]
        composite = CompositeEvolutionStrategy(strategies)

        assert len(composite.strategies) == 2
        assert composite.name == "composite"

    async def test_composite_aggregates(self):
        """Given 2 strategies each returning 1 mod, When I propose, Then 2 mods are returned."""
        from loopengine.evolution.strategies import CompositeEvolutionStrategy

        # Create two mock strategies
        strategy_a = AsyncMock()
        strategy_a.name = "a"
        strategy_a.propose = AsyncMock(return_value=[
            CodeMod(target_file="a.py", description="mod from a"),
        ])

        strategy_b = AsyncMock()
        strategy_b.name = "b"
        strategy_b.propose = AsyncMock(return_value=[
            CodeMod(target_file="b.py", description="mod from b"),
        ])

        composite = CompositeEvolutionStrategy([strategy_a, strategy_b])

        mods = await composite.propose(
            trajectory=Trajectory(),
            eval_result=EvalResult(passed=False, score=0.3, reason="low"),
            config={},
            source_code={},
        )

        assert len(mods) == 2
        assert mods[0].target_file == "a.py"
        assert mods[1].target_file == "b.py"

    async def test_composite_handles_strategy_failure(self):
        """Given one strategy fails, When I propose, Then other strategies still run."""
        from loopengine.evolution.strategies import CompositeEvolutionStrategy

        # Strategy A will fail
        strategy_a = AsyncMock()
        strategy_a.name = "failing"
        strategy_a.propose = AsyncMock(side_effect=RuntimeError("boom"))

        # Strategy B will succeed
        strategy_b = AsyncMock()
        strategy_b.name = "working"
        strategy_b.propose = AsyncMock(return_value=[
            CodeMod(target_file="b.py", description="mod from b"),
        ])

        composite = CompositeEvolutionStrategy([strategy_a, strategy_b])

        mods = await composite.propose(
            trajectory=Trajectory(),
            eval_result=EvalResult(passed=False, score=0.3, reason="low"),
            config={},
            source_code={},
        )

        # Should still get mod from strategy B
        assert len(mods) == 1
        assert mods[0].target_file == "b.py"

    async def test_composite_empty_strategies(self):
        """Given no strategies, When I propose, Then empty list is returned."""
        from loopengine.evolution.strategies import CompositeEvolutionStrategy

        composite = CompositeEvolutionStrategy([])

        mods = await composite.propose(
            trajectory=Trajectory(),
            eval_result=EvalResult(passed=False, score=0.3, reason="low"),
            config={},
            source_code={},
        )

        assert mods == []


# ---------------------------------------------------------------------------
# Slice: ConfigEvolver targets an existing source file (bug M4)
# ---------------------------------------------------------------------------


class TestConfigEvolverTargeting:
    async def test_targets_existing_source_file(self):
        """A hard-coded 'config.py' target never applies; target a real file."""
        from loopengine.evolution.strategies import ConfigEvolver

        evolver = ConfigEvolver(score_threshold=0.7)
        trajectory = Trajectory()
        eval_result = EvalResult(passed=False, score=0.5, reason="low")
        source = {"loopengine/config.py": "budget = 1\n"}

        mods = await evolver.propose(trajectory, eval_result, {}, source)

        assert mods
        assert all(m.target_file == "loopengine/config.py" for m in mods)
