"""Metrics define MEASURABLE aspects of agent performance.

Plain English: A Metric is like a scoreboard in sports. Each metric
tracks one specific thing:
- PassRate: What percentage of tests passed?
- CodeQuality: How clean/readable is the code?
- Efficiency: How many steps/tokens did it take?
- Correctness: Does the output match expected results?

Metrics are the building blocks that Judges use. A MetricJudge collects
scores from multiple Metrics and averages them. Each Metric is focused
on ONE thing — like a thermometer only measures temperature.
"""

from __future__ import annotations

import re
from typing import Any, Protocol, runtime_checkable

from loopengine.primitives.trajectory import Trajectory


# ---------------------------------------------------------------------------
# Minimal stubs (execution layer may not exist yet)
# ---------------------------------------------------------------------------


@runtime_checkable
class _TaskProtocol(Protocol):
    """Minimal Task protocol for metrics."""
    prompt: str
    max_steps: int
    def is_done(self, state: Any) -> bool: ...


@runtime_checkable
class _SandboxProtocol(Protocol):
    """Minimal Sandbox protocol for metrics."""
    async def exec(self, command: str, cwd: str = ".", timeout: float = 30) -> tuple[str, str, int]: ...


# ---------------------------------------------------------------------------
# Metric — the core evaluation protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class Metric(Protocol):
    """Protocol defining what a metric must provide.

    A Metric is any object that can evaluate a trajectory and return
    a float score between 0.0 and 1.0.

    Think of a Metric as a specific instrument in a medical checkup:
    - Thermometer measures temperature
    - Scale measures weight
    - Blood pressure cuff measures blood pressure

    Each instrument (Metric) measures ONE thing precisely.
    The doctor (Judge) combines all measurements into an overall assessment.

    Real-world analogy: In basketball, each stat is a metric:
    - Points per game
    - Free throw percentage
    - Assists per game
    The coach (Judge) looks at all stats to evaluate a player.
    """

    @property
    def name(self) -> str:
        """The metric's name (what it measures)."""
        ...

    async def evaluate(self, trajectory: Trajectory, task: Any) -> float:
        """Evaluate the trajectory and return a score between 0.0 and 1.0.

        Args:
            trajectory: The agent's execution record.
            task: The task being evaluated.

        Returns:
            A float score where 0.0 is worst and 1.0 is best.
        """
        ...


# ---------------------------------------------------------------------------
# PassRateMetric — runs tests and returns pass rate
# ---------------------------------------------------------------------------


class PassRateMetric:
    """Runs a test command in the sandbox and returns the pass rate.

    Plain English: This metric runs your test suite (like pytest) and
    checks what percentage passed. It's the same as TestSuiteJudge,
    but packaged as a Metric so it can be used inside MetricJudge.

    The score is: passed / (passed + failed)
    - 10 passed → 1.0
    - 7 passed, 3 failed → 0.7
    - 0 passed, 5 failed → 0.0

    Attributes:
        test_command: The shell command to run tests.
        sandbox: The sandbox to execute in.
    """

    def __init__(self, test_command: str, sandbox: Any) -> None:
        """Initialize the PassRateMetric.

        Args:
            test_command: Shell command to run the test suite.
            sandbox: A Sandbox instance to execute the command in.
        """
        self._test_command = test_command
        self._sandbox = sandbox

    @property
    def name(self) -> str:
        """This metric's name: 'pass_rate'."""
        return "pass_rate"

    @property
    def test_command(self) -> str:
        """The test command that will be executed."""
        return self._test_command

    @property
    def sandbox(self) -> Any:
        """The sandbox used for test execution."""
        return self._sandbox

    @staticmethod
    def _parse_output(stdout: str, stderr: str) -> tuple[int, int]:
        """Parse pytest-style output for passed/failed counts.

        Args:
            stdout: Standard output from the test command.
            stderr: Standard error from the test command.

        Returns:
            A tuple of (passed_count, failed_count).
        """
        combined = stdout + "\n" + stderr
        passed = 0
        failed = 0

        passed_match = re.search(r"(\d+)\s+passed", combined)
        if passed_match:
            passed = int(passed_match.group(1))

        failed_match = re.search(r"(\d+)\s+failed", combined)
        if failed_match:
            failed = int(failed_match.group(1))

        return passed, failed

    async def evaluate(self, trajectory: Trajectory, task: Any) -> float:
        """Run the test command and return the pass rate.

        Args:
            trajectory: The agent's execution record (not used).
            task: The task being evaluated (not used).

        Returns:
            A float score between 0.0 and 1.0.
        """
        stdout, stderr, exit_code = await self._sandbox.exec(self._test_command)
        passed, failed = self._parse_output(stdout, stderr)
        total = passed + failed

        if total == 0:
            return 0.0

        return passed / total


# ---------------------------------------------------------------------------
# EfficiencyMetric — fewer steps = better score
# ---------------------------------------------------------------------------


class EfficiencyMetric:
    """Measures how efficiently the agent completed the task.

    Plain English: This metric rewards finishing quickly. If the task
    allows 10 steps and you finish in 3, you get a high score (0.7).
    If you use all 10, you get 0.0. If you use 0, you get 1.0.

    Formula: score = 1.0 - (steps_used / max_steps)

    Think of it like a timed exam — finishing early with correct answers
    is better than using all the time.

    Attributes:
        (none — it's stateless)
    """

    @property
    def name(self) -> str:
        """This metric's name: 'efficiency'."""
        return "efficiency"

    async def evaluate(self, trajectory: Trajectory, task: Any) -> float:
        """Compute efficiency score from the trajectory length vs max_steps.

        The score is: 1.0 - (len(trajectory) / task.max_steps)
        Clamped to [0.0, 1.0].

        Args:
            trajectory: The agent's execution record.
            task: The task being evaluated (uses task.max_steps).

        Returns:
            A float score between 0.0 and 1.0.
        """
        steps_used = len(trajectory.steps)
        max_steps = task.max_steps if hasattr(task, "max_steps") and task.max_steps > 0 else 1

        score = 1.0 - (steps_used / max_steps)
        return max(0.0, min(1.0, score))


# ---------------------------------------------------------------------------
# CustomMetric — wraps a user-provided evaluation function
# ---------------------------------------------------------------------------


class CustomMetric:
    """Wraps a user-provided function as a Metric.

    Plain English: Sometimes you have a specific thing you want to measure
    that doesn't fit the standard metrics. CustomMetric lets you plug in
    your own function. It's like bringing your own measuring tape.

    The function can be sync or async — CustomMetric handles both.

    Attributes:
        name: The metric's name.
    """

    def __init__(self, name: str, eval_fn: Any) -> None:
        """Initialize the CustomMetric.

        Args:
            name: The metric's name (what it measures).
            eval_fn: A function (sync or async) that takes (trajectory, task)
                     and returns a float score.
        """
        self._name = name
        self._eval_fn = eval_fn

    @property
    def name(self) -> str:
        """This metric's name."""
        return self._name

    async def evaluate(self, trajectory: Trajectory, task: Any) -> float:
        """Run the custom evaluation function.

        If the function is async, it's awaited directly.
        If the function is sync, it's called and the result is returned.

        Args:
            trajectory: The agent's execution record.
            task: The task being evaluated.

        Returns:
            A float score between 0.0 and 1.0.
        """
        import asyncio

        result = self._eval_fn(trajectory, task)
        if asyncio.iscoroutine(result):
            return await result
        return result
