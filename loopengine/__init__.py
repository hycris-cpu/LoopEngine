"""LoopEngine — A self-improving loop engineer agent framework.

Plain English: LoopEngine is a framework for building AI agents that can
IMPROVE THEMSELVES by modifying their own code. Think of it as giving an AI
the ability to be its own software engineer — it writes code, tests it,
evaluates the results, and keeps the changes that work.

The framework has 5 layers, each building on the one below:

┌─────────────────────────────────────────────────────┐
│  Layer 5: EVOLUTION   — Self-improvement engine     │
├─────────────────────────────────────────────────────┤
│  Layer 4: EVALUATION  — Judges, metrics, benchmarks │
├─────────────────────────────────────────────────────┤
│  Layer 3: EXECUTION   — Run loop, sandbox, harness  │
├─────────────────────────────────────────────────────┤
│  Layer 2: COMPOSITION — Builder, plugins, bundles   │
├─────────────────────────────────────────────────────┤
│  Layer 1: PRIMITIVES  — Events, state, tools, etc.  │
└─────────────────────────────────────────────────────┘

Quick start:

    import loopengine as le

    # Build an agent
    config = (le.make_coding() | le.make_reliability()).build()
    harness = le.Harness(model=my_model, config=config)

    # Run a task
    result = await harness.run(le.SimpleTask(prompt="Write a hello world"))

    # Or run the full self-improvement loop
    engine = le.LoopEngine(
        agent_builder=le.make_coding() | le.make_self_improve(),
        benchmark=le.Benchmark(judge=my_judge),
        strategies=[le.PromptEvolver(model=my_model)],
        gate=le.PromotionGate(),
    )
    report = await engine.run()
"""

# === Layer 1: Primitives ===
from loopengine.primitives import (
    Event,
    EvalResult,
    Message,
    MessageType,
    ToolCall,
    ToolCallMetadata,
    ToolResult,
    HOOK_POINTS,
    MultiHookProcessor,
    Processor,
    ProcessorChain,
    pipe,
    pipe_all,
)
from loopengine.primitives.tools import (
    Tool,
    ToolContext,
    ToolNotFoundError,
    ToolRegistry,
    ToolSchema,
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

# === Layer 2: Composition ===
from loopengine.composition import (
    FeatureFlag,
    FlagRegistry,
    HarnessBuilder,
    HarnessConfig,
    Plugin,
    PluginLoader,
    ProcessorEntry,
    SimplePlugin,
    flag,
    make_coding,
    make_evaluation,
    make_reliability,
    make_self_improve,
)

# === Layer 3: Execution ===
from loopengine.execution import (
    Harness,
    ModelProvider,
    RunResult,
    run_loop,
)
from loopengine.execution.sandbox import (
    LocalSandbox,
    LocalSandboxProvider,
    Sandbox,
    SandboxProvider,
)
from loopengine.execution.task import (
    BatchTask,
    SimpleTask,
    Task,
)

# === Layer 4: Evaluation ===
from loopengine.evaluation import (
    Benchmark,
    BenchmarkResult,
    Comparison,
    CompositeJudge,
    CustomMetric,
    EfficiencyMetric,
    Judge,
    LLMJudge,
    Metric,
    MetricJudge,
    PassRateMetric,
    TestSuiteJudge,
    compare,
)
from loopengine.evaluation.grader import (
    GradeResult,
    IsolatedGrader,
    is_better,
    make_subprocess_runner,
)

# === Layer 5: Evolution ===
from loopengine.evolution import (
    CodeMod,
    CodeModSet,
    CompositeEvolutionStrategy,
    ConfigEvolver,
    EvolutionReport,
    EvolutionStrategy,
    Insight,
    LoopEngine,
    PromptEvolver,
    PromotionDecision,
    PromotionGate,
    analyze_trajectory,
    parse_unified_diff,
    summarize_trajectory,
)
from loopengine.evolution.checkpoint import (
    CheckpointStore,
    EvolutionCheckpoint,
)
from loopengine.evolution.diagnostics import (
    DiagnosticContext,
    ExecutionResult,
    LspDiagnostic,
    LoopDetector,
    LoopWarning,
    failure,
    format_for_llm,
    success,
)

__all__ = [
    # Layer 1: Primitives
    "Event", "Message", "MessageType", "ToolCall", "ToolCallMetadata",
    "ToolResult", "EvalResult",
    "HOOK_POINTS", "Processor", "MultiHookProcessor", "ProcessorChain",
    "pipe", "pipe_all",
    "Tool", "ToolSchema", "ToolContext", "ToolRegistry", "ToolNotFoundError",
    "State", "Budget", "StateSlot", "StateSnapshot", "StateDelta",
    "Trajectory", "TrajectoryStep", "load_trajectory",
    # Layer 2: Composition
    "FeatureFlag", "FlagRegistry", "flag",
    "HarnessConfig", "ProcessorEntry",
    "HarnessBuilder",
    "Plugin", "SimplePlugin", "PluginLoader",
    "make_coding", "make_reliability", "make_evaluation", "make_self_improve",
    # Layer 3: Execution
    "RunResult", "ModelProvider", "run_loop",
    "Harness",
    "Sandbox", "LocalSandbox", "SandboxProvider", "LocalSandboxProvider",
    "Task", "SimpleTask", "BatchTask",
    # Layer 4: Evaluation
    "Judge", "TestSuiteJudge", "LLMJudge", "MetricJudge", "CompositeJudge",
    "Metric", "PassRateMetric", "EfficiencyMetric", "CustomMetric",
    "Benchmark", "BenchmarkResult", "Comparison", "compare",
    "GradeResult", "IsolatedGrader", "is_better", "make_subprocess_runner",
    # Layer 5: Evolution
    "CodeMod", "CodeModSet", "parse_unified_diff",
    "Insight", "analyze_trajectory", "summarize_trajectory",
    "EvolutionStrategy", "PromptEvolver", "ConfigEvolver", "CompositeEvolutionStrategy",
    "PromotionDecision", "PromotionGate",
    "EvolutionReport", "LoopEngine",
    "CheckpointStore", "EvolutionCheckpoint",
    "ExecutionResult", "LspDiagnostic", "LoopDetector", "LoopWarning",
    "DiagnosticContext", "format_for_llm", "success", "failure",
]

__version__ = "0.1.0"
