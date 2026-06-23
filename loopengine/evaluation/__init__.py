"""Evaluation — judges, metrics, and benchmarks for assessing agent performance.

Plain English: This package is the "grading department" of LoopEngine.
It answers the question: "How well did the agent do?"

Three levels of evaluation:
- Metrics: Measure ONE specific aspect (pass rate, efficiency, etc.)
- Judges: Combine metrics or use other strategies to produce EvalResults
- Benchmarks: Run judges across many tasks and aggregate the results

Think of it as a school grading system:
- Metrics = individual test scores (math quiz, spelling test)
- Judges = subject grades (combining multiple test scores)
- Benchmarks = report card (all subjects, overall GPA)
"""

from loopengine.evaluation.judges import (
    Judge,
    TestSuiteJudge,
    LLMJudge,
    MetricJudge,
    CompositeJudge,
)
from loopengine.evaluation.metrics import (
    Metric,
    PassRateMetric,
    EfficiencyMetric,
    CustomMetric,
)
from loopengine.evaluation.benchmark import (
    Benchmark,
    BenchmarkResult,
    Comparison,
    compare,
)

__all__ = [
    # Judges
    "Judge",
    "TestSuiteJudge",
    "LLMJudge",
    "MetricJudge",
    "CompositeJudge",
    # Metrics
    "Metric",
    "PassRateMetric",
    "EfficiencyMetric",
    "CustomMetric",
    # Benchmarks
    "Benchmark",
    "BenchmarkResult",
    "Comparison",
    "compare",
]
