"""Tests for the Analysis module — finding patterns in trajectories.

BDD Scenarios:
- Given a category and description, When I create an Insight, Then all fields are stored
- Given a trajectory with repeated identical actions, When I analyze, Then a "loop" insight is found
- Given a trajectory with low rewards, When I analyze, Then a "quality" insight is found
- Given a trajectory with high efficiency (few steps, high reward), When I analyze, Then no critical insights
- Given a trajectory with tool errors, When I analyze, Then an "error" insight is found
- Given a trajectory, When I summarize, Then a human-readable summary dict is returned
"""

from __future__ import annotations

import pytest
from dataclasses import FrozenInstanceError

from loopengine.primitives.events import Message, ToolCall, ToolResult, EvalResult
from loopengine.primitives.state import State, StateDelta, StateSnapshot
from loopengine.primitives.trajectory import Trajectory, TrajectoryStep

from loopengine.evolution.analysis import (
    Insight,
    analyze_trajectory,
    summarize_trajectory,
)


# ---------------------------------------------------------------------------
# Helpers: build trajectories with specific patterns
# ---------------------------------------------------------------------------


def _make_step(
    action_content: str = "doing something",
    reward: float = 0.5,
    tool_results: tuple[ToolResult, ...] = (),
    run_id: str = "test-run",
    step_id: int = 0,
) -> TrajectoryStep:
    """Helper to build a TrajectoryStep with minimal boilerplate."""
    action = Message(
        role="assistant",
        content=action_content,
        run_id=run_id,
        step_id=step_id,
    )
    return TrajectoryStep(
        state_before=StateSnapshot(step=step_id),
        action=action,
        observations=tool_results,
        reward=reward,
        delta=StateDelta(messages_added=1, step_delta=1),
    )


def _make_trajectory(steps: list[TrajectoryStep], task_id: str = "test-task") -> Trajectory:
    """Helper to build a Trajectory from a list of steps."""
    traj = Trajectory(task_id=task_id)
    for step in steps:
        traj.add_step(step)
    return traj


# =========================================================================
# SLICE 1: Insight creation
# =========================================================================

class TestInsightCreation:
    """Given a category, description, severity, evidence, and suggested fix,
    When I create an Insight,
    Then all fields are stored correctly and it is immutable."""

    def test_creation_with_defaults(self) -> None:
        """An Insight with minimal fields has sensible defaults."""
        insight = Insight()
        assert insight.category == ""
        assert insight.description == ""
        assert insight.severity == "low"
        assert insight.evidence == ""
        assert insight.suggested_fix == ""

    def test_creation_with_explicit_fields(self) -> None:
        """An Insight with explicit fields stores them correctly."""
        insight = Insight(
            category="loop",
            description="Agent repeated the same search 5 times",
            severity="high",
            evidence="Step 3-7 all called search_files with identical args",
            suggested_fix="Add deduplication check to search processor",
        )
        assert insight.category == "loop"
        assert insight.description == "Agent repeated the same search 5 times"
        assert insight.severity == "high"
        assert "Step 3-7" in insight.evidence
        assert "deduplication" in insight.suggested_fix

    def test_is_frozen(self) -> None:
        """An Insight is immutable (frozen dataclass)."""
        insight = Insight(category="loop")
        with pytest.raises(FrozenInstanceError):
            insight.category = "error"  # type: ignore[misc]

    def test_equality(self) -> None:
        """Two Insights with the same data are equal."""
        i1 = Insight(category="loop", severity="high", description="same")
        i2 = Insight(category="loop", severity="high", description="same")
        assert i1 == i2


# =========================================================================
# SLICE 2: Insight serialization
# =========================================================================

class TestInsightSerialization:
    """Given an Insight,
    When I call to_dict()/from_dict(),
    Then roundtrip preserves all data."""

    def test_to_dict(self) -> None:
        """to_dict produces a plain dictionary."""
        insight = Insight(
            category="loop",
            description="repeated action",
            severity="medium",
            evidence="steps 2-5 identical",
            suggested_fix="add check",
        )
        d = insight.to_dict()
        assert d["category"] == "loop"
        assert d["description"] == "repeated action"
        assert d["severity"] == "medium"

    def test_from_dict(self) -> None:
        """from_dict creates an Insight from a plain dictionary."""
        d = {
            "category": "error",
            "description": "tool failures",
            "severity": "critical",
            "evidence": "8 out of 10 calls failed",
            "suggested_fix": "add retry logic",
        }
        insight = Insight.from_dict(d)
        assert insight.category == "error"
        assert insight.severity == "critical"

    def test_roundtrip(self) -> None:
        """to_dict → from_dict roundtrip produces an equal Insight."""
        original = Insight(
            category="budget_waste",
            description="wasted tokens on irrelevant searches",
            severity="medium",
            evidence="steps 10-20 all searching unrelated files",
            suggested_fix="narrow search scope",
        )
        restored = Insight.from_dict(original.to_dict())
        assert restored == original


# =========================================================================
# SLICE 3: analyze_trajectory — loop detection
# =========================================================================

class TestAnalyzeTrajectoryLoopDetection:
    """Given a trajectory with repeated identical actions,
    When I analyze it,
    Then a 'loop' insight is detected."""

    def test_repeated_actions_detected(self) -> None:
        """Given 5 identical assistant messages, When I analyze,
        Then a loop insight with high severity is found."""
        # Build 5 steps with identical action content
        steps = [_make_step(action_content="search for foo", reward=0.0, step_id=i)
                 for i in range(5)]
        traj = _make_trajectory(steps)

        insights = analyze_trajectory(traj)

        loop_insights = [i for i in insights if i.category == "loop"]
        assert len(loop_insights) >= 1
        assert loop_insights[0].severity in ("medium", "high")

    def test_no_loop_with_varied_actions(self) -> None:
        """Given varied actions, When I analyze, Then no loop insight."""
        steps = [
            _make_step(action_content="search for foo", reward=0.5, step_id=0),
            _make_step(action_content="read file bar.py", reward=0.5, step_id=1),
            _make_step(action_content="edit the function", reward=0.5, step_id=2),
            _make_step(action_content="run tests", reward=0.5, step_id=3),
        ]
        traj = _make_trajectory(steps)

        insights = analyze_trajectory(traj)

        loop_insights = [i for i in insights if i.category == "loop"]
        assert len(loop_insights) == 0

    def test_loop_with_three_repeats(self) -> None:
        """Given 3 identical actions (minimum loop threshold), When I analyze,
        Then a loop insight is found."""
        steps = [_make_step(action_content="same thing", reward=0.0, step_id=i)
                 for i in range(3)]
        traj = _make_trajectory(steps)

        insights = analyze_trajectory(traj)

        loop_insights = [i for i in insights if i.category == "loop"]
        assert len(loop_insights) >= 1


# =========================================================================
# SLICE 4: analyze_trajectory — low reward / quality detection
# =========================================================================

class TestAnalyzeTrajectoryQuality:
    """Given a trajectory with consistently low rewards,
    When I analyze it,
    Then a 'quality' insight is found."""

    def test_low_total_reward(self) -> None:
        """Given steps with all-zero rewards, When I analyze,
        Then a quality insight is found."""
        steps = [_make_step(reward=0.0, step_id=i) for i in range(5)]
        traj = _make_trajectory(steps)

        insights = analyze_trajectory(traj)

        quality_insights = [i for i in insights if i.category == "quality"]
        assert len(quality_insights) >= 1

    def test_high_quality_no_insight(self) -> None:
        """Given steps with high rewards, When I analyze,
        Then no quality insight."""
        steps = [_make_step(reward=0.9, step_id=i) for i in range(5)]
        traj = _make_trajectory(steps)

        insights = analyze_trajectory(traj)

        quality_insights = [i for i in insights if i.category == "quality"]
        assert len(quality_insights) == 0


# =========================================================================
# SLICE 5: analyze_trajectory — tool error detection
# =========================================================================

class TestAnalyzeTrajectoryErrors:
    """Given a trajectory with tool errors in observations,
    When I analyze it,
    Then an 'error' insight is found."""

    def test_tool_errors_detected(self) -> None:
        """Given steps with ToolResult errors, When I analyze,
        Then an error insight is found."""
        error_result = ToolResult(
            run_id="test", step_id=0, call_id="c1",
            output="", error="FileNotFoundError: not found",
        )
        steps = [
            _make_step(
                reward=-0.1,
                step_id=0,
                tool_results=(error_result,),
            ),
            _make_step(
                reward=-0.1,
                step_id=1,
                tool_results=(ToolResult(
                    run_id="test", step_id=1, call_id="c2",
                    output="", error="Permission denied",
                ),),
            ),
        ]
        traj = _make_trajectory(steps)

        insights = analyze_trajectory(traj)

        error_insights = [i for i in insights if i.category == "error"]
        assert len(error_insights) >= 1

    def test_no_errors_no_insight(self) -> None:
        """Given steps with successful tool results, When I analyze,
        Then no error insight."""
        success_result = ToolResult(
            run_id="test", step_id=0, call_id="c1",
            output="success", error=None,
        )
        steps = [
            _make_step(reward=0.5, step_id=0, tool_results=(success_result,)),
            _make_step(reward=0.5, step_id=1),
        ]
        traj = _make_trajectory(steps)

        insights = analyze_trajectory(traj)

        error_insights = [i for i in insights if i.category == "error"]
        assert len(error_insights) == 0


# =========================================================================
# SLICE 6: analyze_trajectory — inefficiency detection
# =========================================================================

class TestAnalyzeTrajectoryInefficiency:
    """Given a trajectory with excessive steps relative to reward,
    When I analyze it,
    Then an 'inefficiency' insight is found."""

    def test_many_steps_low_reward(self) -> None:
        """Given 20 steps with total reward < 0.5, When I analyze,
        Then an inefficiency insight is found."""
        steps = [_make_step(reward=0.01, step_id=i) for i in range(20)]
        traj = _make_trajectory(steps)

        insights = analyze_trajectory(traj)

        ineff_insights = [i for i in insights if i.category == "inefficiency"]
        assert len(ineff_insights) >= 1

    def test_few_steps_high_reward_no_inefficiency(self) -> None:
        """Given 3 steps with high reward, When I analyze,
        Then no inefficiency insight."""
        steps = [_make_step(reward=0.9, step_id=i) for i in range(3)]
        traj = _make_trajectory(steps)

        insights = analyze_trajectory(traj)

        ineff_insights = [i for i in insights if i.category == "inefficiency"]
        assert len(ineff_insights) == 0


# =========================================================================
# SLICE 7: analyze_trajectory — empty trajectory
# =========================================================================

class TestAnalyzeTrajectoryEmpty:
    """Given an empty trajectory,
    When I analyze it,
    Then no insights are returned."""

    def test_empty_trajectory(self) -> None:
        """An empty trajectory has nothing to analyze."""
        traj = Trajectory(task_id="empty")
        insights = analyze_trajectory(traj)
        assert insights == []


# =========================================================================
# SLICE 8: summarize_trajectory
# =========================================================================

class TestSummarizeTrajectory:
    """Given a trajectory,
    When I call summarize_trajectory(),
    Then a human-readable summary dict is returned."""

    def test_summary_structure(self) -> None:
        """The summary dict contains expected keys."""
        steps = [_make_step(reward=0.5, step_id=i) for i in range(3)]
        traj = _make_trajectory(steps, task_id="summary-test")

        summary = summarize_trajectory(traj)

        assert isinstance(summary, dict)
        assert "task_id" in summary
        assert "total_steps" in summary
        assert "total_reward" in summary
        assert "avg_reward" in summary

    def test_summary_values(self) -> None:
        """The summary values match the trajectory data."""
        steps = [
            _make_step(reward=0.3, step_id=0),
            _make_step(reward=0.7, step_id=1),
        ]
        traj = _make_trajectory(steps, task_id="val-test")

        summary = summarize_trajectory(traj)

        assert summary["task_id"] == "val-test"
        assert summary["total_steps"] == 2
        assert summary["total_reward"] == pytest.approx(1.0)
        assert summary["avg_reward"] == pytest.approx(0.5)

    def test_summary_empty_trajectory(self) -> None:
        """An empty trajectory produces a summary with zero steps and reward."""
        traj = Trajectory(task_id="empty")
        summary = summarize_trajectory(traj)

        assert summary["task_id"] == "empty"
        assert summary["total_steps"] == 0
        assert summary["total_reward"] == pytest.approx(0.0)

    def test_summary_includes_error_count(self) -> None:
        """The summary counts tool errors from observations."""
        error_result = ToolResult(
            run_id="test", step_id=0, call_id="c1",
            output="", error="fail",
        )
        steps = [
            _make_step(reward=-0.1, step_id=0, tool_results=(error_result,)),
            _make_step(reward=0.5, step_id=1),
        ]
        traj = _make_trajectory(steps)

        summary = summarize_trajectory(traj)

        assert summary["error_count"] >= 1

    def test_summary_includes_action_variety(self) -> None:
        """The summary includes a count of unique actions."""
        steps = [
            _make_step(action_content="search", reward=0.5, step_id=0),
            _make_step(action_content="search", reward=0.5, step_id=1),
            _make_step(action_content="read", reward=0.5, step_id=2),
        ]
        traj = _make_trajectory(steps)

        summary = summarize_trajectory(traj)

        assert summary["unique_actions"] == 2
