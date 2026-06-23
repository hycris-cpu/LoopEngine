"""The Trajectory module records the agent's full "life story" during a task.

Plain English: A Trajectory is like a diary. Each entry (TrajectoryStep) records:
- What the situation was before acting (state_before)
- What the agent decided to do (action)
- What happened as a result (observations)
- How well it did (reward)
- What changed (delta)

The Trajectory is a FIRST-CLASS OUTPUT — not just a log side-product.
It can be:
- Saved to JSONL for analysis
- Converted to SFT training records (supervised fine-tuning)
- Converted to RL training records (reinforcement learning)
- Compared across runs to measure improvement

Think of it as the "black box flight recorder" — after a crash (or success),
you can replay exactly what happened, step by step.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loopengine.primitives.events import Event, Message, ToolCall, ToolResult
from loopengine.primitives.state import StateDelta, StateSnapshot


# ---------------------------------------------------------------------------
# TrajectoryStep — a single entry in the diary
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TrajectoryStep:
    """One step in the agent's trajectory — a single "diary entry".

    Each step captures a complete snapshot of what happened during one
    think-act cycle:
    - state_before: What the world looked like before acting (frozen snapshot)
    - action: What the agent decided to do (a Message, typically assistant response)
    - observations: What came back from tool calls (tuple of ToolResults)
    - reward: How good this step was (0.0 = neutral, positive = good, negative = bad)
    - delta: What changed in the state as a result of this step
    - metadata: Any extra info (attempt number, model used, latency, etc.)

    Frozen (immutable) because once a step is recorded, it should never change.
    This is a historical record — you can't rewrite history.

    Attributes:
        state_before: Snapshot of State before this step's action.
        action: The agent's action (typically an assistant Message).
        observations: Results from tool calls made during this step.
        reward: Scalar reward signal (for RL training).
        delta: What changed in the state during this step.
        metadata: Arbitrary extra data about this step.
    """

    state_before: StateSnapshot = field(default_factory=StateSnapshot)
    action: Message | None = None
    observations: tuple[Event, ...] = ()
    reward: float = 0.0
    delta: StateDelta = field(default_factory=StateDelta)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Serialize this step to a dictionary.

        Converts the step into a JSON-serializable dict. Events are converted
        using their own to_dict() methods. The state_before is serialized
        using its own to_dict() method for JSONL roundtrip support.
        """
        return {
            "state_before": self.state_before.to_dict(),
            "action": self.action.to_dict() if self.action else None,
            "observations": [obs.to_dict() for obs in self.observations],
            "reward": self.reward,
            "delta": {
                "created_slots": list(self.delta.created_slots),
                "updated_slots": list(self.delta.updated_slots),
                "deleted_slots": list(self.delta.deleted_slots),
                "messages_added": self.delta.messages_added,
                "step_delta": self.delta.step_delta,
                "budget_delta": dict(self.delta.budget_delta),
            },
            "metadata": dict(self.metadata),
        }


# ---------------------------------------------------------------------------
# Trajectory — the full diary
# ---------------------------------------------------------------------------

@dataclass
class Trajectory:
    """The complete record of an agent's execution during a task.

    A Trajectory is an ordered collection of TrajectorySteps — one per
    think-act cycle. It's the agent's "flight recorder" or "diary".

    Trajectories are FIRST-CLASS OUTPUTS, not just logging artifacts.
    They can be saved, analyzed, compared, and used for training.

    Unlike TrajectoryStep, Trajectory is MUTABLE — you add steps as
    the execution progresses.

    Attributes:
        steps: The ordered list of trajectory steps.
        task_id: Which task this trajectory belongs to.
        metadata: Extra info about the trajectory (task description, config, etc.).
    """

    steps: list[TrajectoryStep] = field(default_factory=list)
    task_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    # ---- Collection operations ----

    def add_step(self, step: TrajectoryStep) -> None:
        """Append a step to the trajectory.

        This is the primary way to build a trajectory during execution.
        Steps should be added in chronological order.

        Args:
            step: The TrajectoryStep to append.
        """
        self.steps.append(step)

    @property
    def last_step(self) -> TrajectoryStep | None:
        """The most recent step, or None if the trajectory is empty."""
        return self.steps[-1] if self.steps else None

    @property
    def total_reward(self) -> float:
        """Sum of all step rewards — the trajectory's overall score.

        This is the primary metric for comparing trajectories. A higher
        total_reward means the agent performed better overall.
        """
        return sum(step.reward for step in self.steps)

    def __len__(self) -> int:
        """Number of steps in the trajectory."""
        return len(self.steps)

    def __iter__(self):
        """Iterate over steps in chronological order."""
        return iter(self.steps)

    def __getitem__(self, index: int) -> TrajectoryStep:
        """Get a step by index (supports negative indexing)."""
        return self.steps[index]

    # ---- Serialization ----

    def to_dict(self) -> dict[str, Any]:
        """Serialize the entire trajectory to a dictionary.

        The first line is metadata (task_id, step count, total reward).
        Each subsequent line is a serialized step.
        """
        return {
            "task_id": self.task_id,
            "step_count": len(self.steps),
            "total_reward": self.total_reward,
            "metadata": dict(self.metadata),
            "steps": [step.to_dict() for step in self.steps],
        }

    def to_jsonl(self, path: Path | str) -> None:
        """Save the trajectory to a JSONL file.

        JSONL format: one JSON object per line. The first line is the
        trajectory metadata, and each subsequent line is one step.

        This format is chosen because:
        - Streaming: you can read one step at a time without loading everything
        - Appendable: new steps can be added without rewriting the file
        - Tooling: standard format for ML training pipelines

        Args:
            path: File path to write to. Parent directory must exist.
        """
        path = Path(path)
        with open(path, "w") as f:
            # First line: trajectory metadata
            meta_line = {
                "type": "trajectory_meta",
                "task_id": self.task_id,
                "step_count": len(self.steps),
                "total_reward": self.total_reward,
                "metadata": dict(self.metadata),
            }
            f.write(json.dumps(meta_line) + "\n")

            # Subsequent lines: one per step
            for step in self.steps:
                step_data = step.to_dict()
                step_data["type"] = "trajectory_step"
                f.write(json.dumps(step_data) + "\n")

    # ---- Training record stubs ----

    def to_sft_records(self) -> list[dict[str, Any]]:
        """Convert trajectory to SFT (supervised fine-tuning) training records.

        SFT records are input-output pairs where the model learns to reproduce
        the "correct" assistant response given the conversation history.

        Each record would look like:
            {"messages": [...history...], "completion": "the assistant's response"}

        Currently a stub — returns empty list. Will be implemented when the
        training pipeline is ready.
        """
        return []

    def to_rl_records(self) -> list[dict[str, Any]]:
        """Convert trajectory to RL (reinforcement learning) training records.

        RL records include the action taken and the reward received, so the
        model can learn which actions lead to good outcomes.

        Each record would look like:
            {"state": {...}, "action": {...}, "reward": 0.8, "next_state": {...}}

        Currently a stub — returns empty list. Will be implemented when the
        training pipeline is ready.
        """
        return []


# ---------------------------------------------------------------------------
# load_trajectory — deserialize from JSONL
# ---------------------------------------------------------------------------

def load_trajectory(path: Path | str) -> Trajectory:
    """Load a Trajectory from a JSONL file.

    This is the inverse of Trajectory.to_jsonl(). It reads the metadata
    line and all step lines, reconstructing the Trajectory object.

    Note: The loaded trajectory's steps will have simplified state_before
    and delta objects (just dicts, not fully reconstructed StateSnapshots).
    For full fidelity, use the in-memory objects directly.

    Args:
        path: Path to the JSONL file.

    Returns:
        A Trajectory object with the loaded data.

    Raises:
        FileNotFoundError: If the file doesn't exist.
        json.JSONDecodeError: If the file contains invalid JSON.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Trajectory file not found: {path}")

    lines = path.read_text().strip().split("\n")
    if not lines or not lines[0].strip():
        # Empty file — return empty trajectory
        return Trajectory(task_id="unknown")

    # Parse metadata from first line
    meta = json.loads(lines[0])
    traj = Trajectory(
        task_id=meta.get("task_id", ""),
        metadata=meta.get("metadata", {}),
    )

    # Parse steps from subsequent lines
    for line in lines[1:]:
        if not line.strip():
            continue
        step_data = json.loads(line)

        # Reconstruct the action (Message) if present
        action = None
        action_data = step_data.get("action")
        if action_data is not None:
            action = Message(
                role=action_data.get("role", "assistant"),
                content=action_data.get("content", ""),
                run_id=action_data.get("run_id", ""),
                step_id=action_data.get("step_id", 0),
                ts=action_data.get("ts", 0.0),
            )

        # Reconstruct observations
        observations: list[Event] = []
        for obs_data in step_data.get("observations", []):
            if obs_data.get("type") == "tool_result":
                observations.append(ToolResult(
                    run_id=obs_data.get("run_id", ""),
                    step_id=obs_data.get("step_id", 0),
                    ts=obs_data.get("ts", 0.0),
                    call_id=obs_data.get("call_id", ""),
                    output=obs_data.get("output", ""),
                    error=obs_data.get("error"),
                ))

        # Reconstruct delta
        delta_data = step_data.get("delta", {})
        delta = StateDelta(
            created_slots=delta_data.get("created_slots", []),
            updated_slots=delta_data.get("updated_slots", []),
            deleted_slots=delta_data.get("deleted_slots", []),
            messages_added=delta_data.get("messages_added", 0),
            step_delta=delta_data.get("step_delta", 0),
            budget_delta=delta_data.get("budget_delta", {}),
        )

        # Reconstruct state_before summary as a StateSnapshot
        state_data = step_data.get("state_before", {})
        state_before = StateSnapshot(
            step=state_data.get("step", 0),
        )

        step = TrajectoryStep(
            state_before=state_before,
            action=action,
            observations=tuple(observations),
            reward=step_data.get("reward", 0.0),
            delta=delta,
            metadata=step_data.get("metadata", {}),
        )
        traj.add_step(step)

    return traj
