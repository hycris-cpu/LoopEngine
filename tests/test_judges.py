"""Tests for the Judges module — evaluates how well the agent performed on a task.

BDD Scenarios:
- Given a class with evaluate method, When checked against Judge protocol, Then it satisfies it
- Given a test suite that all passes, When TestSuiteJudge evaluates, Then score is 1.0
- Given a test suite with mixed results, When TestSuiteJudge evaluates, Then score is pass rate
- Given a test suite that all fails, When TestSuiteJudge evaluates, Then score is 0.0
- Given an LLM model and rubric, When LLMJudge evaluates, Then score comes from model response
- Given a list of metrics, When MetricJudge evaluates, Then score is average of metrics
- Given weighted judges, When CompositeJudge evaluates, Then score is weighted average
"""

import pytest
from unittest.mock import AsyncMock, MagicMock

from loopengine.primitives import EvalResult, Message
from loopengine.primitives.trajectory import Trajectory, TrajectoryStep


# ---------------------------------------------------------------------------
# Minimal stubs for Task (execution layer may not exist yet)
# ---------------------------------------------------------------------------

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class Task(Protocol):
    """Minimal Task stub for evaluation tests."""
    prompt: str
    max_steps: int
    def is_done(self, state: Any) -> bool: ...


class _StubTask:
    """A simple task stub for testing judges."""
    def __init__(self, prompt: str = "test", max_steps: int = 10) -> None:
        self.prompt = prompt
        self.max_steps = max_steps

    def is_done(self, state: Any) -> bool:
        return False


# ---------------------------------------------------------------------------
# Slice 1: Judge Protocol
# ---------------------------------------------------------------------------


class TestJudgeProtocol:
    """Given a class with evaluate method, When checked against Judge protocol, Then it satisfies it."""

    def test_judge_protocol_exists(self):
        """Given the judges module, When imported, Then Judge protocol is available."""
        from loopengine.evaluation.judges import Judge
        assert Judge is not None

    def test_judge_protocol_check(self):
        """Given a class with async evaluate, When checked against Judge, Then it's a Judge."""
        from loopengine.evaluation.judges import Judge

        class MyJudge:
            @property
            def name(self) -> str:
                return "my_judge"

            async def evaluate(self, trajectory: Trajectory, task: Any) -> EvalResult:
                return EvalResult(passed=True, score=1.0, reason="ok")

        judge = MyJudge()
        assert isinstance(judge, Judge)


# ---------------------------------------------------------------------------
# Slice 2: TestSuiteJudge
# ---------------------------------------------------------------------------


class TestSuiteJudgeCreation:
    """Given a test command and sandbox, When I create a TestSuiteJudge, Then it stores them."""

    def test_test_suite_judge_creation(self):
        """Given a test command and sandbox, When I create TestSuiteJudge, Then fields are set."""
        from loopengine.evaluation.judges import TestSuiteJudge
        sandbox = AsyncMock()
        judge = TestSuiteJudge(test_command="pytest", sandbox=sandbox)
        assert judge.name == "test_suite"
        assert judge.test_command == "pytest"
        assert judge.sandbox is sandbox


class TestSuiteJudgeAllPass:
    """Given a test suite where all tests pass, When TestSuiteJudge evaluates, Then score is 1.0."""

    async def test_all_pass(self):
        """Given sandbox returns '10 passed', When I evaluate, Then score is 1.0 and passed is True."""
        from loopengine.evaluation.judges import TestSuiteJudge

        sandbox = AsyncMock()
        sandbox.exec = AsyncMock(return_value=("10 passed in 0.5s", "", 0))
        judge = TestSuiteJudge(test_command="pytest", sandbox=sandbox)
        trajectory = Trajectory()
        task = _StubTask()

        result = await judge.evaluate(trajectory, task)

        assert result.score == 1.0
        assert result.passed is True
        assert "10 passed" in result.reason


class TestSuiteJudgeMixedResults:
    """Given a test suite with mixed pass/fail, When TestSuiteJudge evaluates, Then score is pass rate."""

    async def test_mixed_results(self):
        """Given sandbox returns '8 passed, 2 failed', When I evaluate, Then score is 0.8."""
        from loopengine.evaluation.judges import TestSuiteJudge

        sandbox = AsyncMock()
        sandbox.exec = AsyncMock(return_value=("8 passed, 2 failed in 1.0s", "", 1))
        judge = TestSuiteJudge(test_command="pytest", sandbox=sandbox)
        trajectory = Trajectory()
        task = _StubTask()

        result = await judge.evaluate(trajectory, task)

        assert result.score == pytest.approx(0.8)
        assert result.passed is False


class TestSuiteJudgeAllFail:
    """Given a test suite where all tests fail, When TestSuiteJudge evaluates, Then score is 0.0."""

    async def test_all_fail(self):
        """Given sandbox returns '0 passed, 5 failed', When I evaluate, Then score is 0.0."""
        from loopengine.evaluation.judges import TestSuiteJudge

        sandbox = AsyncMock()
        sandbox.exec = AsyncMock(return_value=("", "5 failed in 0.2s", 1))
        judge = TestSuiteJudge(test_command="pytest", sandbox=sandbox)
        trajectory = Trajectory()
        task = _StubTask()

        result = await judge.evaluate(trajectory, task)

        assert result.score == 0.0
        assert result.passed is False


# ---------------------------------------------------------------------------
# Slice 3: LLMJudge
# ---------------------------------------------------------------------------


class TestLLMJudgeCreation:
    """Given a model and rubric, When I create an LLMJudge, Then fields are stored."""

    def test_llm_judge_creation(self):
        """Given a model and rubric, When I create LLMJudge, Then fields are set."""
        from loopengine.evaluation.judges import LLMJudge
        model = AsyncMock()
        rubric = "Rate the code quality from 0 to 1."
        judge = LLMJudge(model=model, rubric=rubric)
        assert judge.name == "llm_judge"
        assert judge.model is model
        assert judge.rubric == rubric


class TestLLMJudgeEvaluation:
    """Given an LLM model that returns a score, When LLMJudge evaluates, Then score is extracted."""

    async def test_llm_judge_parses_score(self):
        """Given model returns 'Score: 0.85', When I evaluate, Then score is 0.85."""
        from loopengine.evaluation.judges import LLMJudge

        # Model returns a message with a score in the content
        response = Message(role="assistant", content="The code is good.\nScore: 0.85")
        model = AsyncMock()
        model.complete = AsyncMock(return_value=response)

        judge = LLMJudge(model=model, rubric="Rate quality 0-1")
        trajectory = Trajectory()
        task = _StubTask(prompt="Write a hello world function")

        result = await judge.evaluate(trajectory, task)

        assert result.score == pytest.approx(0.85)
        assert "Score: 0.85" in result.reason

    async def test_llm_judge_passes_when_score_above_threshold(self):
        """Given model returns score 0.9, When I evaluate with threshold 0.8, Then passed is True."""
        from loopengine.evaluation.judges import LLMJudge

        response = Message(role="assistant", content="Score: 0.9")
        model = AsyncMock()
        model.complete = AsyncMock(return_value=response)

        judge = LLMJudge(model=model, rubric="Rate quality", pass_threshold=0.8)
        trajectory = Trajectory()
        task = _StubTask()

        result = await judge.evaluate(trajectory, task)

        assert result.passed is True

    async def test_llm_judge_fails_when_score_below_threshold(self):
        """Given model returns score 0.3, When I evaluate with threshold 0.8, Then passed is False."""
        from loopengine.evaluation.judges import LLMJudge

        response = Message(role="assistant", content="Score: 0.3")
        model = AsyncMock()
        model.complete = AsyncMock(return_value=response)

        judge = LLMJudge(model=model, rubric="Rate quality", pass_threshold=0.8)
        trajectory = Trajectory()
        task = _StubTask()

        result = await judge.evaluate(trajectory, task)

        assert result.passed is False
        assert result.score == pytest.approx(0.3)


# ---------------------------------------------------------------------------
# Slice 4: MetricJudge
# ---------------------------------------------------------------------------


class _StubMetric:
    """A stub metric for testing MetricJudge."""

    def __init__(self, metric_name: str, score: float) -> None:
        self._name = metric_name
        self._score = score

    @property
    def name(self) -> str:
        return self._name

    async def evaluate(self, trajectory: Trajectory, task: Any) -> float:
        return self._score


class TestMetricJudgeCreation:
    """Given a list of metrics, When I create a MetricJudge, Then it stores them."""

    def test_metric_judge_creation(self):
        """Given a list of metrics, When I create MetricJudge, Then fields are set."""
        from loopengine.evaluation.judges import MetricJudge
        metrics = [_StubMetric("speed", 0.8), _StubMetric("quality", 0.9)]
        judge = MetricJudge(metrics=metrics)
        assert judge.name == "metric_judge"
        assert len(judge.metrics) == 2


class TestMetricJudgeEvaluation:
    """Given metrics that return scores, When MetricJudge evaluates, Then score is average."""

    async def test_metric_judge_averages_scores(self):
        """Given metrics returning 0.8 and 0.9, When I evaluate, Then score is 0.85."""
        from loopengine.evaluation.judges import MetricJudge
        metrics = [_StubMetric("speed", 0.8), _StubMetric("quality", 0.9)]
        judge = MetricJudge(metrics=metrics)
        trajectory = Trajectory()
        task = _StubTask()

        result = await judge.evaluate(trajectory, task)

        assert result.score == pytest.approx(0.85)
        assert "speed" in result.reason
        assert "quality" in result.reason


class TestCompositeJudgeCreation:
    """Given weighted judges, When I create a CompositeJudge, Then it stores them."""

    def test_composite_judge_creation(self):
        """Given judges with weights, When I create CompositeJudge, Then fields are set."""
        from loopengine.evaluation.judges import CompositeJudge, TestSuiteJudge

        sandbox = AsyncMock()
        j1 = TestSuiteJudge(test_command="pytest", sandbox=sandbox)
        j2 = TestSuiteJudge(test_command="pytest tests/integration/", sandbox=sandbox)

        composite = CompositeJudge(judges=[(j1, 0.6), (j2, 0.4)])
        assert composite.name == "composite"
        assert len(composite.judges) == 2


class TestCompositeJudgeEvaluation:
    """Given weighted judges with scores, When CompositeJudge evaluates, Then score is weighted avg."""

    async def test_composite_weighted_average(self):
        """Given judge1=1.0 (weight 0.6) and judge2=0.5 (weight 0.4), When I evaluate, Then score is 0.8."""
        from loopengine.evaluation.judges import CompositeJudge

        # Create mock judges that return specific scores
        judge1 = AsyncMock()
        judge1.name = "judge1"
        judge1.evaluate = AsyncMock(return_value=EvalResult(passed=True, score=1.0, reason="perfect"))

        judge2 = AsyncMock()
        judge2.name = "judge2"
        judge2.evaluate = AsyncMock(return_value=EvalResult(passed=False, score=0.5, reason="ok"))

        composite = CompositeJudge(judges=[(judge1, 0.6), (judge2, 0.4)])
        trajectory = Trajectory()
        task = _StubTask()

        result = await composite.evaluate(trajectory, task)

        # Weighted: 1.0 * 0.6 + 0.5 * 0.4 = 0.6 + 0.2 = 0.8
        assert result.score == pytest.approx(0.8)
        assert result.passed is True  # all sub-judges passed weighted threshold

    async def test_composite_equal_weights(self):
        """Given two judges with equal weights, When I evaluate, Then score is simple average."""
        from loopengine.evaluation.judges import CompositeJudge

        judge1 = AsyncMock()
        judge1.name = "judge1"
        judge1.evaluate = AsyncMock(return_value=EvalResult(passed=True, score=0.6, reason="a"))

        judge2 = AsyncMock()
        judge2.name = "judge2"
        judge2.evaluate = AsyncMock(return_value=EvalResult(passed=True, score=1.0, reason="b"))

        composite = CompositeJudge(judges=[(judge1, 0.5), (judge2, 0.5)])
        trajectory = Trajectory()
        task = _StubTask()

        result = await composite.evaluate(trajectory, task)

        # Equal weights: 0.6 * 0.5 + 1.0 * 0.5 = 0.8
        assert result.score == pytest.approx(0.8)
