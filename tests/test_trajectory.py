"""Tests for the Trajectory module — the agent's 'life story' recorder.

BDD scenarios are written as docstrings in Given/When/Then format.
TDD approach: ONE test at a time → implement → verify → repeat.
"""

from __future__ import annotations

import json
import pytest
from pathlib import Path

from loopengine.primitives.events import (
    Event,
    Message,
    ToolCall,
    ToolResult,
    EvalResult,
)
from loopengine.primitives.state import (
    Budget,
    State,
    StateDelta,
    StateSlot,
    StateSnapshot,
)
from loopengine.primitives.trajectory import (
    Trajectory,
    TrajectoryStep,
    load_trajectory,
)


# =========================================================================
# TEST 1: TrajectoryStep creation
# =========================================================================

class TestTrajectoryStepCreation:
    """Given a state snapshot and an action,
    When I create a TrajectoryStep,
    Then it stores all fields correctly and is immutable."""

    def test_step_creation_with_defaults(self) -> None:
        """A TrajectoryStep with minimal fields should have sensible defaults."""
        step = TrajectoryStep()
        assert step.state_before is not None
        assert step.action is None
        assert step.observations == ()
        assert step.reward == 0.0
        assert step.delta is not None
        assert step.metadata == {}

    def test_step_creation_with_explicit_fields(self, run_id: str) -> None:
        """A TrajectoryStep with explicit fields stores them correctly."""
        state = State()
        msg = Message(role="user", content="hello", run_id=run_id, step_id=0)
        state.add_message(msg)
        snap = state.snapshot()

        action = Message(role="assistant", content="hi there", run_id=run_id, step_id=0)
        observation = ToolResult(run_id=run_id, step_id=0, call_id="c1", output="done")
        delta = StateDelta(messages_added=1)

        step = TrajectoryStep(
            state_before=snap,
            action=action,
            observations=(observation,),
            reward=0.8,
            delta=delta,
            metadata={"attempt": 1},
        )

        assert step.state_before is snap
        assert step.action is action
        assert observation in step.observations
        assert step.reward == 0.8
        assert step.delta is delta
        assert step.metadata == {"attempt": 1}

    def test_step_is_frozen(self, run_id: str) -> None:
        """A TrajectoryStep is immutable (frozen dataclass)."""
        step = TrajectoryStep()
        with pytest.raises(AttributeError):
            step.reward = 1.0  # type: ignore[misc]

    def test_step_equality(self, run_id: str) -> None:
        """Two TrajectorySteps with the same data are equal."""
        snap = State().snapshot()
        delta = StateDelta()
        s1 = TrajectoryStep(state_before=snap, reward=0.5, delta=delta)
        s2 = TrajectoryStep(state_before=snap, reward=0.5, delta=delta)
        assert s1 == s2


# =========================================================================
# TEST 2: Trajectory creation and basic operations
# =========================================================================

class TestTrajectoryBasic:
    """Given a new Trajectory,
    When I add steps,
    Then I can iterate, get last_step, and compute total_reward."""

    def test_trajectory_creation(self) -> None:
        """A fresh Trajectory has no steps and zero reward."""
        traj = Trajectory(task_id="test-task-1")
        assert len(traj) == 0
        assert traj.total_reward == 0.0
        assert traj.last_step is None
        assert traj.task_id == "test-task-1"

    def test_trajectory_add_step(self, run_id: str) -> None:
        """Adding a step increases length and updates last_step."""
        traj = Trajectory(task_id="t1")
        step = TrajectoryStep(reward=0.5)
        traj.add_step(step)

        assert len(traj) == 1
        assert traj.last_step is step
        assert traj.total_reward == pytest.approx(0.5)

    def test_trajectory_multiple_steps(self, run_id: str) -> None:
        """Adding multiple steps tracks them in order with correct total reward."""
        traj = Trajectory(task_id="t1")
        s1 = TrajectoryStep(reward=0.3)
        s2 = TrajectoryStep(reward=0.7)
        s3 = TrajectoryStep(reward=-0.2)

        traj.add_step(s1)
        traj.add_step(s2)
        traj.add_step(s3)

        assert len(traj) == 3
        assert traj.last_step is s3
        assert traj.total_reward == pytest.approx(0.8)
        assert list(traj) == [s1, s2, s3]

    def test_trajectory_is_mutable(self) -> None:
        """Trajectory (unlike TrajectoryStep) is mutable — you add steps over time."""
        traj = Trajectory(task_id="t1")
        traj.metadata["env"] = "test"
        assert traj.metadata["env"] == "test"


# =========================================================================
# TEST 3: JSONL serialization roundtrip
# =========================================================================

class TestTrajectoryJsonl:
    """Given a Trajectory with steps,
    When I save it to JSONL and load it back,
    Then the loaded trajectory matches the original."""

    def test_jsonl_roundtrip(self, run_id: str, work_dir: Path) -> None:
        """Save to JSONL, load back, verify equality."""
        # Build a trajectory
        state = State()
        state.add_message(Message(role="user", content="hello", run_id=run_id, step_id=0))
        snap = state.snapshot()
        action = Message(role="assistant", content="hi", run_id=run_id, step_id=0)
        delta = StateDelta(messages_added=1)

        traj = Trajectory(task_id="roundtrip-test")
        traj.add_step(TrajectoryStep(
            state_before=snap,
            action=action,
            observations=(),
            reward=0.5,
            delta=delta,
            metadata={"attempt": 1},
        ))
        traj.add_step(TrajectoryStep(
            state_before=snap,
            action=action,
            observations=(),
            reward=0.8,
            delta=delta,
            metadata={"attempt": 2},
        ))

        # Save
        path = work_dir / "trajectory.jsonl"
        traj.to_jsonl(path)
        assert path.exists()

        # Verify file is valid JSONL (one JSON object per line)
        lines = path.read_text().strip().split("\n")
        assert len(lines) == 3  # 1 metadata line + 2 step lines

        # Load back
        loaded = load_trajectory(path)
        assert loaded.task_id == traj.task_id
        assert len(loaded) == len(traj)
        assert loaded.total_reward == pytest.approx(traj.total_reward)

    def test_jsonl_empty_trajectory(self, work_dir: Path) -> None:
        """An empty trajectory can be saved and loaded."""
        traj = Trajectory(task_id="empty")
        path = work_dir / "empty.jsonl"
        traj.to_jsonl(path)

        loaded = load_trajectory(path)
        assert loaded.task_id == "empty"
        assert len(loaded) == 0

    def test_load_nonexistent_file_raises(self, work_dir: Path) -> None:
        """Loading from a nonexistent file raises FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            load_trajectory(work_dir / "does_not_exist.jsonl")


# =========================================================================
# TEST 4: SFT and RL record stubs
# =========================================================================

class TestTrajectoryRecords:
    """Given a Trajectory,
    When I call to_sft_records() or to_rl_records(),
    Then they return lists (stubs for now)."""

    def test_sft_records_stub(self) -> None:
        """to_sft_records returns an empty list (stub)."""
        traj = Trajectory(task_id="t1")
        records = traj.to_sft_records()
        assert isinstance(records, list)

    def test_rl_records_stub(self) -> None:
        """to_rl_records returns an empty list (stub)."""
        traj = Trajectory(task_id="t1")
        records = traj.to_rl_records()
        assert isinstance(records, list)


# =========================================================================
# TEST 5: Integration — TrajectoryStep with real State operations
# =========================================================================

class TestTrajectoryIntegration:
    """Integration test: full trajectory lifecycle with State and Events."""

    def test_full_lifecycle(self, run_id: str, work_dir: Path) -> None:
        """Build a multi-step trajectory with real state changes and save it."""
        state = State()
        traj = Trajectory(task_id="integration-test")

        # Step 0: User says hello
        user_msg = Message(role="user", content="What is 2+2?", run_id=run_id, step_id=0)
        snap_before = state.snapshot()

        state.add_message(user_msg)
        assistant_msg = Message(role="assistant", content="4", run_id=run_id, step_id=0)
        state.add_message(assistant_msg)
        delta = state.compute_delta(snap_before)

        traj.add_step(TrajectoryStep(
            state_before=snap_before,
            action=assistant_msg,
            observations=(),
            reward=1.0,
            delta=delta,
        ))

        # Step 1: Follow-up
        snap_before2 = state.snapshot()
        user_msg2 = Message(role="user", content="And 3+3?", run_id=run_id, step_id=1)
        state.add_message(user_msg2)
        assistant_msg2 = Message(role="assistant", content="6", run_id=run_id, step_id=1)
        state.add_message(assistant_msg2)
        delta2 = state.compute_delta(snap_before2)

        traj.add_step(TrajectoryStep(
            state_before=snap_before2,
            action=assistant_msg2,
            observations=(),
            reward=0.9,
            delta=delta2,
        ))

        # Verify
        assert len(traj) == 2
        assert traj.total_reward == pytest.approx(1.9)
        assert traj.last_step is not None
        assert traj.last_step.delta.messages_added == 2

        # Save and reload
        path = work_dir / "integration.jsonl"
        traj.to_jsonl(path)
        loaded = load_trajectory(path)
        assert loaded.task_id == "integration-test"
        assert len(loaded) == 2
