"""Tests for the Metrics module — measurable aspects of agent performance.

BDD Scenarios:
- Given a class with name and evaluate, When checked against Metric protocol, Then it satisfies it
- Given a passing test suite, When PassRateMetric evaluates, Then score is 1.0
- Given a mixed test suite, When PassRateMetric evaluates, Then score is pass rate
- Given 3 steps used out of 10 max, When EfficiencyMetric evaluates, Then score is high
- Given all steps used, When EfficiencyMetric evaluates, Then score is low
- Given a custom eval function, When CustomMetric evaluates, Then score comes from function
"""

import pytest
from unittest.mock import AsyncMock

from loopengine.primitives.trajectory import Trajectory, TrajectoryStep
from typing import Any


# ---------------------------------------------------------------------------
# Minimal stubs (execution layer may not exist yet)
# ---------------------------------------------------------------------------


class _StubTask:
    """A simple task stub for testing metrics."""
    def __init__(self, prompt: str = "test", max_steps: int = 10) -> None:
        self.prompt = prompt
        self.max_steps = max_steps

    def is_done(self, state: Any) -> bool:
        return False


# ---------------------------------------------------------------------------
# Slice 5: Metric Protocol
# ---------------------------------------------------------------------------


class TestMetricProtocol:
    """Given a class with name and evaluate, When checked against Metric protocol, Then it satisfies it."""

    def test_metric_protocol_exists(self):
        """Given the metrics module, When imported, Then Metric protocol is available."""
        from loopengine.evaluation.metrics import Metric
        assert Metric is not None

    def test_metric_protocol_check(self):
        """Given a class with name and async evaluate, When checked against Metric, Then it's a Metric."""
        from loopengine.evaluation.metrics import Metric

        class MyMetric:
            @property
            def name(self) -> str:
                return "my_metric"

            async def evaluate(self, trajectory: Trajectory, task: Any) -> float:
                return 0.9

        metric = MyMetric()
        assert isinstance(metric, Metric)


# ---------------------------------------------------------------------------
# Slice 6: PassRateMetric
# ---------------------------------------------------------------------------


class TestPassRateMetricCreation:
    """Given a test command and sandbox, When I create a PassRateMetric, Then it stores them."""

    def test_pass_rate_metric_creation(self):
        """Given a test command and sandbox, When I create PassRateMetric, Then fields are set."""
        from loopengine.evaluation.metrics import PassRateMetric
        sandbox = AsyncMock()
        metric = PassRateMetric(test_command="pytest", sandbox=sandbox)
        assert metric.name == "pass_rate"
        assert metric.test_command == "pytest"
        assert metric.sandbox is sandbox


class TestPassRateMetricAllPass:
    """Given all tests pass, When PassRateMetric evaluates, Then score is 1.0."""

    async def test_all_pass(self):
        """Given sandbox returns '10 passed', When I evaluate, Then score is 1.0."""
        from loopengine.evaluation.metrics import PassRateMetric
        sandbox = AsyncMock()
        sandbox.exec = AsyncMock(return_value=("10 passed in 0.5s", "", 0))
        metric = PassRateMetric(test_command="pytest", sandbox=sandbox)
        trajectory = Trajectory()
        task = _StubTask()

        score = await metric.evaluate(trajectory, task)
        assert score == 1.0


class TestPassRateMetricMixed:
    """Given mixed results, When PassRateMetric evaluates, Then score is pass rate."""

    async def test_mixed_results(self):
        """Given '7 passed, 3 failed', When I evaluate, Then score is 0.7."""
        from loopengine.evaluation.metrics import PassRateMetric
        sandbox = AsyncMock()
        sandbox.exec = AsyncMock(return_value=("7 passed, 3 failed in 1.0s", "", 1))
        metric = PassRateMetric(test_command="pytest", sandbox=sandbox)
        trajectory = Trajectory()
        task = _StubTask()

        score = await metric.evaluate(trajectory, task)
        assert score == pytest.approx(0.7)


# ---------------------------------------------------------------------------
# Slice 7: EfficiencyMetric
# ---------------------------------------------------------------------------


class TestEfficiencyMetricCreation:
    """Given defaults, When I create an EfficiencyMetric, Then it has the right name."""

    def test_efficiency_metric_creation(self):
        """Given defaults, When I create EfficiencyMetric, Then name is 'efficiency'."""
        from loopengine.evaluation.metrics import EfficiencyMetric
        metric = EfficiencyMetric()
        assert metric.name == "efficiency"


class TestEfficiencyMetricFewSteps:
    """Given 3 steps used out of 10 max, When EfficiencyMetric evaluates, Then score is high."""

    async def test_few_steps_high_score(self):
        """Given 3 steps in trajectory, max_steps=10, When I evaluate, Then score ~ 0.7."""
        from loopengine.evaluation.metrics import EfficiencyMetric
        metric = EfficiencyMetric()

        # Build a trajectory with 3 steps
        trajectory = Trajectory()
        for _ in range(3):
            trajectory.add_step(TrajectoryStep())

        task = _StubTask(max_steps=10)
        score = await metric.evaluate(trajectory, task)
        # efficiency = 1.0 - (3 / 10) = 0.7
        assert score == pytest.approx(0.7)


class TestEfficiencyMetricAllSteps:
    """Given all steps used, When EfficiencyMetric evaluates, Then score is 0.0."""

    async def test_all_steps_used(self):
        """Given 10 steps in trajectory, max_steps=10, When I evaluate, Then score is 0.0."""
        from loopengine.evaluation.metrics import EfficiencyMetric
        metric = EfficiencyMetric()

        trajectory = Trajectory()
        for _ in range(10):
            trajectory.add_step(TrajectoryStep())

        task = _StubTask(max_steps=10)
        score = await metric.evaluate(trajectory, task)
        # efficiency = 1.0 - (10 / 10) = 0.0
        assert score == pytest.approx(0.0)


class TestEfficiencyMetricNoSteps:
    """Given 0 steps used, When EfficiencyMetric evaluates, Then score is 1.0."""

    async def test_no_steps(self):
        """Given empty trajectory, max_steps=10, When I evaluate, Then score is 1.0."""
        from loopengine.evaluation.metrics import EfficiencyMetric
        metric = EfficiencyMetric()

        trajectory = Trajectory()
        task = _StubTask(max_steps=10)
        score = await metric.evaluate(trajectory, task)
        # efficiency = 1.0 - (0 / 10) = 1.0
        assert score == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Slice 8: CustomMetric
# ---------------------------------------------------------------------------


class TestCustomMetricCreation:
    """Given a name and function, When I create a CustomMetric, Then it stores them."""

    def test_custom_metric_creation(self):
        """Given name and eval_fn, When I create CustomMetric, Then fields are set."""
        from loopengine.evaluation.metrics import CustomMetric

        async def my_fn(trajectory: Trajectory, task: Any) -> float:
            return 0.5

        metric = CustomMetric(name="custom_test", eval_fn=my_fn)
        assert metric.name == "custom_test"


class TestCustomMetricEvaluation:
    """Given a custom function, When CustomMetric evaluates, Then score comes from function."""

    async def test_custom_metric_returns_fn_result(self):
        """Given a function returning 0.42, When I evaluate, Then score is 0.42."""
        from loopengine.evaluation.metrics import CustomMetric

        async def my_fn(trajectory: Trajectory, task: Any) -> float:
            return 0.42

        metric = CustomMetric(name="custom_test", eval_fn=my_fn)
        trajectory = Trajectory()
        task = _StubTask()

        score = await metric.evaluate(trajectory, task)
        assert score == pytest.approx(0.42)

    async def test_custom_metric_sync_function(self):
        """Given a sync function returning 0.77, When I evaluate, Then score is 0.77."""
        from loopengine.evaluation.metrics import CustomMetric

        def my_sync_fn(trajectory: Trajectory, task: Any) -> float:
            return 0.77

        metric = CustomMetric(name="sync_test", eval_fn=my_sync_fn)
        trajectory = Trajectory()
        task = _StubTask()

        score = await metric.evaluate(trajectory, task)
        assert score == pytest.approx(0.77)
