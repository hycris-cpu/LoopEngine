"""Judges evaluate how well the agent performed on a task.

Plain English: A Judge is like a teacher grading an exam. Different judges
specialize in different aspects:
- TestSuiteJudge: Runs the actual tests (like pytest) and counts passes
- LLMJudge: Asks another AI to evaluate the quality of the work
- MetricJudge: Checks specific measurable criteria (speed, accuracy, etc.)
- CompositeJudge: Combines multiple judges with weights (like a panel)

Each judge produces an EvalResult with a score (0.0 to 1.0) and explanation.
"""

from __future__ import annotations

import re
from typing import Any, Protocol, runtime_checkable

from loopengine.primitives.events import EvalResult, Message
from loopengine.primitives.trajectory import Trajectory


# ---------------------------------------------------------------------------
# Minimal stubs for Task and Sandbox (execution layer may not exist yet)
# ---------------------------------------------------------------------------


@runtime_checkable
class _TaskProtocol(Protocol):
    """Minimal Task protocol for evaluation."""
    prompt: str
    max_steps: int
    def is_done(self, state: Any) -> bool: ...


@runtime_checkable
class _SandboxProtocol(Protocol):
    """Minimal Sandbox protocol for evaluation."""
    async def exec(self, command: str, cwd: str = ".", timeout: float = 30) -> tuple[str, str, int]: ...


# ---------------------------------------------------------------------------
# Judge — the core evaluation protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class Judge(Protocol):
    """Protocol defining what a judge must provide.

    A Judge is any object that can evaluate a trajectory against a task
    and produce an EvalResult (score + explanation).

    Think of a Judge as a teacher grading homework:
    - trajectory: The student's complete work (every step they took)
    - task: The assignment (what they were supposed to do)
    - EvalResult: The grade (score, pass/fail, explanation)

    Real-world analogy: Different teachers specialize in different subjects.
    A math teacher checks calculations, an English teacher checks grammar.
    Similarly, different judges evaluate different aspects of agent performance.
    """

    @property
    def name(self) -> str:
        """A human-readable name for this judge."""
        ...

    async def evaluate(self, trajectory: Trajectory, task: Any) -> EvalResult:
        """Evaluate a trajectory against a task and produce a score.

        Args:
            trajectory: The agent's full execution record.
            task: The task that was being attempted.

        Returns:
            An EvalResult with score (0.0-1.0), pass/fail, and explanation.
        """
        ...


# ---------------------------------------------------------------------------
# TestSuiteJudge — runs test commands and checks pass rate
# ---------------------------------------------------------------------------


class TestSuiteJudge:
    """Runs a test command in the sandbox and computes pass rate as score.

    Plain English: This judge is like running `pytest` and counting how many
    tests passed vs failed. It's the most "objective" judge — either the
    tests pass or they don't. No opinions, just facts.

    The score is: passed / (passed + failed)
    - All pass → 1.0
    - All fail → 0.0
    - 8 pass, 2 fail → 0.8

    It parses pytest-style output like:
    - "10 passed in 0.5s"
    - "8 passed, 2 failed in 1.0s"
    - "5 failed in 0.2s"

    Attributes:
        test_command: The command to run (e.g., "pytest", "pytest tests/").
        sandbox: The sandbox to execute the command in.
    """

    def __init__(self, test_command: str, sandbox: Any) -> None:
        """Initialize the TestSuiteJudge.

        Args:
            test_command: Shell command to run the test suite.
            sandbox: A Sandbox instance to execute the command in.
        """
        self._test_command = test_command
        self._sandbox = sandbox

    @property
    def name(self) -> str:
        """This judge's name: 'test_suite'."""
        return "test_suite"

    @property
    def test_command(self) -> str:
        """The test command that will be executed."""
        return self._test_command

    @property
    def sandbox(self) -> Any:
        """The sandbox used for test execution."""
        return self._sandbox

    @staticmethod
    def _parse_pytest_output(stdout: str, stderr: str) -> tuple[int, int]:
        """Parse pytest-style output to extract passed and failed counts.

        Real-world analogy: Like reading a report card that says
        "8 out of 10 tests passed". We extract the numbers.

        Args:
            stdout: Standard output from the test command.
            stderr: Standard error from the test command.

        Returns:
            A tuple of (passed_count, failed_count).
        """
        combined = stdout + "\n" + stderr
        passed = 0
        failed = 0

        # Match "N passed" (with optional comma/space before)
        passed_match = re.search(r"(\d+)\s+passed", combined)
        if passed_match:
            passed = int(passed_match.group(1))

        # Match "N failed" (with optional comma/space before)
        failed_match = re.search(r"(\d+)\s+failed", combined)
        if failed_match:
            failed = int(failed_match.group(1))

        return passed, failed

    async def evaluate(self, trajectory: Trajectory, task: Any) -> EvalResult:
        """Run the test command and compute the pass rate.

        Steps:
        1. Execute the test command in the sandbox
        2. Parse the output for passed/failed counts
        3. Compute score = passed / (passed + failed)
        4. Return an EvalResult with the score and explanation

        Args:
            trajectory: The agent's execution record (not used by this judge,
                       but required by the Judge protocol).
            task: The task being evaluated (not used by this judge).

        Returns:
            An EvalResult with the test pass rate as score.
        """
        stdout, stderr, exit_code = await self._sandbox.exec(self._test_command)

        passed, failed = self._parse_pytest_output(stdout, stderr)
        total = passed + failed

        if total == 0:
            # No tests found — score is 0
            return EvalResult(
                passed=False,
                score=0.0,
                reason=f"No tests found. Output: {stdout.strip() or stderr.strip() or '(empty)'}",
            )

        score = passed / total
        all_passed = failed == 0

        reason = f"{passed} passed, {failed} failed out of {total} tests"
        return EvalResult(
            passed=all_passed,
            score=score,
            reason=reason,
        )


# ---------------------------------------------------------------------------
# LLMJudge — uses an LLM to evaluate quality
# ---------------------------------------------------------------------------


class LLMJudge:
    """Uses an LLM to evaluate the quality of agent work.

    Plain English: This judge is like asking a second expert to review
    the work. You give them a rubric (what to look for) and the agent's
    trajectory (what they did), and the LLM produces a score.

    The LLM is asked to return a score in the format "Score: X.XX"
    where X.XX is a float between 0.0 and 1.0.

    Attributes:
        model: The LLM provider with a complete() method.
        rubric: The evaluation criteria (what the LLM should look for).
        pass_threshold: Minimum score to consider the evaluation as "passed".
    """

    def __init__(self, model: Any, rubric: str, pass_threshold: float = 0.5) -> None:
        """Initialize the LLMJudge.

        Args:
            model: An LLM provider with a complete(messages, tools) method.
            rubric: Evaluation criteria describing what to assess.
            pass_threshold: Score at or above which the evaluation passes.
        """
        self._model = model
        self._rubric = rubric
        self._pass_threshold = pass_threshold

    @property
    def name(self) -> str:
        """This judge's name: 'llm_judge'."""
        return "llm_judge"

    @property
    def model(self) -> Any:
        """The LLM provider used for evaluation."""
        return self._model

    @property
    def rubric(self) -> str:
        """The evaluation rubric."""
        return self._rubric

    @staticmethod
    def _extract_score(text: str) -> float:
        """Extract a numeric score from LLM response text.

        Looks for patterns like:
        - "Score: 0.85"
        - "score: 0.85"
        - "SCORE: 0.85"
        - "Score: 1.0"
        - "Score: 0.0"

        If multiple matches exist, returns the last one (the final verdict).

        Args:
            text: The LLM's response text.

        Returns:
            The extracted score as a float, clamped to [0.0, 1.0].

        Raises:
            ValueError: If no score can be extracted.
        """
        matches = re.findall(r"[Ss]core:\s*(\d+\.?\d*)", text)
        if not matches:
            raise ValueError(
                f"Could not extract score from LLM response. "
                f"Expected format 'Score: X.XX'. Response: {text!r}"
            )
        raw_score = float(matches[-1])
        # Clamp to [0.0, 1.0]
        return max(0.0, min(1.0, raw_score))

    def _build_prompt(self, trajectory: Trajectory, task: Any) -> list[Message]:
        """Build the evaluation prompt to send to the LLM.

        Constructs a conversation with a system message (the rubric) and a
        user message (the task and trajectory summary).

        Args:
            trajectory: The agent's execution record.
            task: The task being evaluated.

        Returns:
            A list of Message objects to send to the model.
        """
        # Summarize the trajectory into a readable format
        step_summaries = []
        for i, step in enumerate(trajectory.steps):
            action_text = step.action.content if step.action else "(no action)"
            step_summaries.append(f"Step {i}: {action_text}")

        trajectory_text = "\n".join(step_summaries) if step_summaries else "(no steps taken)"

        system_msg = Message(
            role="system",
            content=(
                f"You are an evaluation judge. {self._rubric}\n\n"
                "Respond with your analysis and end with 'Score: X.XX' "
                "where X.XX is a number between 0.0 and 1.0."
            ),
        )
        user_msg = Message(
            role="user",
            content=(
                f"Task: {task.prompt}\n\n"
                f"Agent trajectory:\n{trajectory_text}"
            ),
        )
        return [system_msg, user_msg]

    async def evaluate(self, trajectory: Trajectory, task: Any) -> EvalResult:
        """Ask the LLM to evaluate the trajectory and extract a score.

        Steps:
        1. Build an evaluation prompt from the rubric + trajectory + task
        2. Send the prompt to the LLM
        3. Parse the response for a "Score: X.XX" pattern
        4. Return an EvalResult with the parsed score

        Args:
            trajectory: The agent's execution record.
            task: The task being evaluated.

        Returns:
            An EvalResult with the LLM's score and explanation.
        """
        messages = self._build_prompt(trajectory, task)
        response = await self._model.complete(messages)

        response_text = response.content if hasattr(response, "content") else str(response)

        try:
            score = self._extract_score(response_text)
        except ValueError:
            return EvalResult(
                passed=False,
                score=0.0,
                reason=f"LLM judge could not extract score. Response: {response_text}",
            )

        passed = score >= self._pass_threshold
        return EvalResult(
            passed=passed,
            score=score,
            reason=response_text,
        )


# ---------------------------------------------------------------------------
# Metric protocol stub (metrics.py may not exist yet)
# ---------------------------------------------------------------------------


@runtime_checkable
class _MetricProtocol(Protocol):
    """Minimal Metric protocol for evaluation stubs.

    A Metric measures one specific aspect of agent performance and returns
    a float score between 0.0 and 1.0.
    """

    @property
    def name(self) -> str:
        """The metric's name."""
        ...

    async def evaluate(self, trajectory: Trajectory, task: Any) -> float:
        """Evaluate and return a score between 0.0 and 1.0."""
        ...


# ---------------------------------------------------------------------------
# MetricJudge — evaluates using a list of Metric objects
# ---------------------------------------------------------------------------


class MetricJudge:
    """Evaluates a trajectory against a list of Metric objects.

    Plain English: This judge is like a rubric with multiple criteria.
    Each Metric measures one specific aspect (speed, quality, correctness),
    and the final score is the average of all metric scores.

    Think of it as a teacher grading an essay with a rubric:
    - Grammar: 0.9
    - Structure: 0.8
    - Content: 0.7
    - Final score: (0.9 + 0.8 + 0.7) / 3 = 0.8

    Attributes:
        metrics: The list of Metric objects to evaluate against.
    """

    def __init__(self, metrics: list[Any]) -> None:
        """Initialize the MetricJudge.

        Args:
            metrics: A list of Metric objects (each with name and evaluate).
        """
        self._metrics = list(metrics)

    @property
    def name(self) -> str:
        """This judge's name: 'metric_judge'."""
        return "metric_judge"

    @property
    def metrics(self) -> list[Any]:
        """The list of metrics being evaluated."""
        return self._metrics

    async def evaluate(self, trajectory: Trajectory, task: Any) -> EvalResult:
        """Run all metrics and compute the average score.

        Steps:
        1. Run each metric's evaluate() method
        2. Collect all scores
        3. Compute the average
        4. Build a reason string showing each metric's score

        Args:
            trajectory: The agent's execution record.
            task: The task being evaluated.

        Returns:
            An EvalResult with the average metric score.
        """
        if not self._metrics:
            return EvalResult(
                passed=False,
                score=0.0,
                reason="No metrics configured.",
            )

        scores: dict[str, float] = {}
        for metric in self._metrics:
            score = await metric.evaluate(trajectory, task)
            scores[metric.name] = score

        avg_score = sum(scores.values()) / len(scores)
        reason_parts = [f"{name}: {score:.2f}" for name, score in scores.items()]
        reason = f"Metric scores — {', '.join(reason_parts)} (avg: {avg_score:.2f})"

        return EvalResult(
            passed=avg_score >= 0.5,
            score=avg_score,
            reason=reason,
        )


# ---------------------------------------------------------------------------
# CompositeJudge — weighted average of multiple judges
# ---------------------------------------------------------------------------


class CompositeJudge:
    """Combines multiple judges with weights into a single score.

    Plain English: This judge is like a panel of experts voting.
    Each expert (judge) gives their score, but some experts' opinions
    count more than others (weights). The final score is the weighted
    average.

    For example:
    - Automated tests (weight 0.6): score = 1.0
    - LLM review (weight 0.4): score = 0.5
    - Final score: 1.0 * 0.6 + 0.5 * 0.4 = 0.8

    Weights don't need to sum to 1.0 — they're normalized internally.
    But it's good practice to have them sum to 1.0 for readability.

    Attributes:
        judges: List of (judge, weight) tuples.
    """

    def __init__(self, judges: list[tuple[Any, float]]) -> None:
        """Initialize the CompositeJudge.

        Args:
            judges: A list of (Judge, weight) tuples. Weight is a float
                   indicating how much this judge's score matters.
        """
        self._judges = list(judges)

    @property
    def name(self) -> str:
        """This judge's name: 'composite'."""
        return "composite"

    @property
    def judges(self) -> list[tuple[Any, float]]:
        """The list of (judge, weight) tuples."""
        return self._judges

    async def evaluate(self, trajectory: Trajectory, task: Any) -> EvalResult:
        """Run all sub-judges and compute the weighted average score.

        Steps:
        1. Run each judge's evaluate() method
        2. Multiply each score by its weight
        3. Sum the weighted scores
        4. Normalize by total weight
        5. Build a reason string with all sub-results

        Args:
            trajectory: The agent's execution record.
            task: The task being evaluated.

        Returns:
            An EvalResult with the weighted average score.
        """
        if not self._judges:
            return EvalResult(
                passed=False,
                score=0.0,
                reason="No judges configured.",
            )

        sub_results: list[tuple[str, float, float, EvalResult]] = []
        total_weight = 0.0
        weighted_sum = 0.0

        for judge, weight in self._judges:
            result = await judge.evaluate(trajectory, task)
            sub_results.append((judge.name, weight, result.score, result))
            weighted_sum += result.score * weight
            total_weight += weight

        if total_weight == 0:
            return EvalResult(
                passed=False,
                score=0.0,
                reason="Total weight is zero.",
            )

        final_score = weighted_sum / total_weight

        # Build detailed reason
        reason_parts = []
        for name, weight, score, _ in sub_results:
            reason_parts.append(f"{name}({weight:.1f}): {score:.2f}")
        reason = f"Composite — {', '.join(reason_parts)} → {final_score:.2f}"

        return EvalResult(
            passed=final_score >= 0.5,
            score=final_score,
            reason=reason,
        )
