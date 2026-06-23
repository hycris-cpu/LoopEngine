"""Trajectory Analysis — finding patterns in what went wrong.

Plain English: After the agent finishes a task, we look at its "diary" (trajectory)
to find patterns. Did it get stuck in a loop? Did it waste time on irrelevant
searches? Did it make the same mistake multiple times?

The analysis produces INSIGHTS — structured observations about failure modes
that the evolution strategies can use to propose fixes.

Think of this module as the "sports analyst" watching game tape. It doesn't
PLAY the game (that's the agent's job) or COACH the team (that's the
strategies' job). It just watches the tape and writes up observations like:
- "The quarterback threw to the same receiver 5 times in a row" (loop)
- "The team spent 80% of the game in their own territory" (inefficiency)
- "Three fumbles in the red zone" (error pattern)
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from loopengine.primitives.trajectory import Trajectory, TrajectoryStep


# ---------------------------------------------------------------------------
# Severity levels
# ---------------------------------------------------------------------------

# Plain English: Severity is how worried we should be about this pattern.
# - low: Worth noting, but probably fine
# - medium: This is costing us performance
# - high: This is seriously hurting us
# - critical: Stop everything, this needs immediate attention
_VALID_SEVERITIES = ("low", "medium", "high", "critical")


# ---------------------------------------------------------------------------
# Insight categories
# ---------------------------------------------------------------------------

# Plain English: Categories help the evolution strategies know WHAT to fix.
# - loop: The agent is doing the same thing over and over (like a broken record)
# - inefficiency: The agent is working hard but not smart (wasting resources)
# - error: Tools are failing and the agent isn't handling it well
# - budget_waste: Too many tokens/cost for too little result
# - quality: The overall output quality is poor
_VALID_CATEGORIES = ("loop", "inefficiency", "error", "budget_waste", "quality")


# ---------------------------------------------------------------------------
# Insight — a structured observation about a trajectory
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Insight:
    """A structured observation about a trajectory — a "finding" from the tape review.

    Plain English: An Insight is like a coach's note after watching game tape.
    It says:
    - category: What TYPE of problem is this? (loop, inefficiency, error, etc.)
    - description: What happened? (plain English summary)
    - severity: How bad is it? (low → critical)
    - evidence: What specifically did we see? (step numbers, counts, etc.)
    - suggested_fix: What should we try? (the evolution strategies use this)

    Insights are FROZEN (immutable) — they're historical observations that
    should never be altered after creation.

    Attributes:
        category: The type of pattern detected (loop, inefficiency, error, etc.).
        description: Human-readable summary of the finding.
        severity: How concerning this is (low, medium, high, critical).
        evidence: Specific data supporting this finding.
        suggested_fix: A hint for the evolution strategies on how to fix this.
    """

    category: str = ""
    description: str = ""
    severity: str = "low"
    evidence: str = ""
    suggested_fix: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Serialize this Insight to a plain dictionary.

        Returns:
            A dictionary with all Insight fields.
        """
        return {
            "category": self.category,
            "description": self.description,
            "severity": self.severity,
            "evidence": self.evidence,
            "suggested_fix": self.suggested_fix,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Insight:
        """Create an Insight from a plain dictionary.

        Args:
            d: A dictionary with Insight fields.

        Returns:
            A new Insight instance.
        """
        return cls(
            category=d.get("category", ""),
            description=d.get("description", ""),
            severity=d.get("severity", "low"),
            evidence=d.get("evidence", ""),
            suggested_fix=d.get("suggested_fix", ""),
        )


# ---------------------------------------------------------------------------
# Thresholds for pattern detection
# ---------------------------------------------------------------------------

# Plain English: These are the "trip wires" — when a metric crosses one of
# these thresholds, we flag it as an insight.

_MIN_LOOP_LENGTH = 3       # At least 3 identical actions to count as a loop
_LOW_REWARD_THRESHOLD = 0.1   # Average reward below this → quality concern
_HIGH_STEP_COUNT = 15      # More than 15 steps → check for inefficiency
_LOW_EFFICIENCY_RATIO = 0.03  # reward-per-step below this → inefficient


# ---------------------------------------------------------------------------
# analyze_trajectory — static analysis of a trajectory
# ---------------------------------------------------------------------------


def analyze_trajectory(trajectory: Trajectory) -> list[Insight]:
    """Analyze a trajectory and produce a list of Insights.

    Plain English: This is the "game tape review." We watch the agent's
    execution step by step and look for patterns:

    1. LOOP DETECTION: Did the agent repeat the same action 3+ times?
       Like a broken record — if you hear the same verse 5 times,
       something's wrong.

    2. QUALITY CHECK: Are the rewards consistently low?
       If every step scores near zero, the agent isn't making progress.

    3. ERROR DETECTION: Did tools fail repeatedly?
       Like a mechanic whose wrench keeps slipping — eventually you need
       a different tool or technique.

    4. INEFFICIENCY CHECK: Are there too many steps for too little reward?
       Like writing a 10-page essay when a paragraph would do.

    Args:
        trajectory: The Trajectory to analyze.

    Returns:
        A list of Insights describing patterns found. Empty list means
        the trajectory looks healthy.
    """
    if not trajectory or len(trajectory) == 0:
        return []

    insights: list[Insight] = []

    # --- Loop detection: find repeated identical actions ---
    loop_insights = _detect_loops(trajectory)
    insights.extend(loop_insights)

    # --- Error detection: find tool failures ---
    error_insights = _detect_errors(trajectory)
    insights.extend(error_insights)

    # --- Quality check: are rewards consistently low? ---
    quality_insights = _detect_quality_issues(trajectory)
    insights.extend(quality_insights)

    # --- Inefficiency: too many steps for too little reward ---
    inefficiency_insights = _detect_inefficiency(trajectory)
    insights.extend(inefficiency_insights)

    return insights


# ---------------------------------------------------------------------------
# Internal detection helpers
# ---------------------------------------------------------------------------


def _detect_loops(trajectory: Trajectory) -> list[Insight]:
    """Detect repeated identical actions in the trajectory.

    Plain English: We look for the agent doing the exact same thing
    multiple times in a row. Like someone trying the same door handle
    over and over — if it didn't open the first 3 times, try something
    different!

    Returns:
        A list of loop-related Insights (may be empty).
    """
    insights: list[Insight] = []

    # Extract action content from each step
    actions: list[str] = []
    for step in trajectory:
        if step.action and step.action.content:
            actions.append(step.action.content)
        else:
            actions.append("")

    # Find the longest run of identical consecutive actions
    if len(actions) < _MIN_LOOP_LENGTH:
        return insights

    # Use a sliding window to find repeated runs
    # We look for the most egregious loop — the longest run
    max_run_length = 1
    max_run_action = ""
    current_run_length = 1
    current_run_action = actions[0]

    for i in range(1, len(actions)):
        if actions[i] == current_run_action and actions[i] != "":
            current_run_length += 1
        else:
            if current_run_length > max_run_length:
                max_run_length = current_run_length
                max_run_action = current_run_action
            current_run_action = actions[i]
            current_run_length = 1

    # Check the final run
    if current_run_length > max_run_length:
        max_run_length = current_run_length
        max_run_action = current_run_action

    if max_run_length >= _MIN_LOOP_LENGTH:
        # Determine severity based on loop length
        if max_run_length >= 7:
            severity = "high"
        elif max_run_length >= 5:
            severity = "medium"
        else:
            severity = "medium"

        insights.append(Insight(
            category="loop",
            description=(
                f"Agent repeated the same action {max_run_length} times consecutively. "
                f"This suggests the agent is stuck and unable to make progress."
            ),
            severity=severity,
            evidence=(
                f"Action '{max_run_action[:80]}' repeated {max_run_length} times in a row."
            ),
            suggested_fix=(
                "Add a deduplication check that detects repeated actions and forces "
                "the agent to try a different approach after 2 identical attempts."
            ),
        ))

    return insights


def _detect_errors(trajectory: Trajectory) -> list[Insight]:
    """Detect tool errors in the trajectory.

    Plain English: We count how many tool calls ended in failure.
    A few errors are normal (file not found, network hiccup), but
    a pattern of errors means the agent is using the wrong tools
    or approaching the problem incorrectly.

    Returns:
        A list of error-related Insights (may be empty).
    """
    total_observations = 0
    error_observations = 0

    for step in trajectory:
        for obs in step.observations:
            # Count all tool results
            if hasattr(obs, "type") and obs.type == "tool_result":
                total_observations += 1
                if hasattr(obs, "error") and obs.error is not None:
                    error_observations += 1

    if error_observations == 0:
        return []

    insights: list[Insight] = []

    # Calculate error rate
    error_rate = error_observations / total_observations if total_observations > 0 else 0

    if error_rate > 0.5:
        severity = "critical"
    elif error_rate > 0.3:
        severity = "high"
    else:
        severity = "medium"

    insights.append(Insight(
        category="error",
        description=(
            f"Agent encountered {error_observations} tool errors out of "
            f"{total_observations} tool calls ({error_rate:.0%} error rate)."
        ),
        severity=severity,
        evidence=(
            f"{error_observations}/{total_observations} tool calls returned errors."
        ),
        suggested_fix=(
            "Add retry logic for transient errors, and add validation before "
            "tool calls to catch predictable failures."
        ),
    ))

    return insights


def _detect_quality_issues(trajectory: Trajectory) -> list[Insight]:
    """Detect consistently low reward (poor quality).

    Plain English: We check if the agent is actually making progress.
    If every step scores near zero, the agent is just spinning its wheels —
    doing things without getting results. Like studying for a test but
    never actually learning anything.

    Returns:
        A list of quality-related Insights (may be empty).
    """
    if len(trajectory) == 0:
        return []

    total_reward = trajectory.total_reward
    avg_reward = total_reward / len(trajectory)

    if avg_reward >= _LOW_REWARD_THRESHOLD:
        return []

    # Determine severity based on how low the reward is
    if avg_reward <= 0.0:
        severity = "high"
    else:
        severity = "medium"

    return [Insight(
        category="quality",
        description=(
            f"Average reward per step is {avg_reward:.3f}, which is below the "
            f"threshold of {_LOW_REWARD_THRESHOLD}. The agent is not making "
            f"meaningful progress."
        ),
        severity=severity,
        evidence=(
            f"Total reward: {total_reward:.3f} over {len(trajectory)} steps "
            f"(avg: {avg_reward:.3f})."
        ),
        suggested_fix=(
            "Review the task decomposition — the task may be too complex "
            "for the current agent capabilities, or the reward signal may "
            "be too sparse."
        ),
    )]


def _detect_inefficiency(trajectory: Trajectory) -> list[Insight]:
    """Detect excessive steps relative to reward (inefficiency).

    Plain English: We check if the agent is working hard but not smart.
    A high step count with low reward means the agent is taking the long
    way around — like writing a 10-page report when a paragraph would do.

    Returns:
        A list of inefficiency-related Insights (may be empty).
    """
    step_count = len(trajectory)
    total_reward = trajectory.total_reward

    if step_count <= _HIGH_STEP_COUNT:
        return []

    # Efficiency ratio: reward per step
    efficiency = total_reward / step_count if step_count > 0 else 0

    if efficiency >= _LOW_EFFICIENCY_RATIO:
        return []

    return [Insight(
        category="inefficiency",
        description=(
            f"Agent used {step_count} steps but achieved low reward "
            f"(efficiency ratio: {efficiency:.4f}). This suggests the agent "
            f"is working hard but not smart."
        ),
        severity="medium",
        evidence=(
            f"{step_count} steps, total reward {total_reward:.3f}, "
            f"efficiency {efficiency:.4f}."
        ),
        suggested_fix=(
            "Add step pruning or early stopping — if the agent isn't making "
            "progress after N steps, try a completely different approach."
        ),
    )]


# ---------------------------------------------------------------------------
# summarize_trajectory — produce a human-readable summary dict
# ---------------------------------------------------------------------------


def summarize_trajectory(trajectory: Trajectory) -> dict[str, Any]:
    """Produce a human-readable summary of a trajectory.

    Plain English: This is the "box score" — a quick overview of how the
    agent did. It includes the basics (steps, reward) plus some derived
    metrics (error count, action variety) that help you quickly assess
    performance without reading the full trajectory.

    Args:
        trajectory: The Trajectory to summarize.

    Returns:
        A dict with summary statistics:
        - task_id: Which task this was
        - total_steps: How many steps the agent took
        - total_reward: Sum of all step rewards
        - avg_reward: Average reward per step
        - error_count: Number of tool calls that resulted in errors
        - unique_actions: Number of distinct action contents
    """
    # Count tool errors across all steps
    error_count = 0
    for step in trajectory:
        for obs in step.observations:
            if hasattr(obs, "type") and obs.type == "tool_result":
                if hasattr(obs, "error") and obs.error is not None:
                    error_count += 1

    # Count unique actions (non-empty action contents)
    action_contents = set()
    for step in trajectory:
        if step.action and step.action.content:
            action_contents.add(step.action.content)

    total_steps = len(trajectory)
    total_reward = trajectory.total_reward

    return {
        "task_id": trajectory.task_id,
        "total_steps": total_steps,
        "total_reward": total_reward,
        "avg_reward": total_reward / total_steps if total_steps > 0 else 0.0,
        "error_count": error_count,
        "unique_actions": len(action_contents),
    }
