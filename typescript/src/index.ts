// Layer 1: Primitives
export {
  Event, Message, MessageType, ToolCall, ToolCallMetadata, ToolResult, EvalResult,
  HOOK_POINTS, Processor, MultiHookProcessor, ProcessorChain, pipe, pipe_all,
} from './primitives';
export type { Tool } from './primitives/tools';
export {
  ToolSchema, ToolContext, ToolRegistry, ToolNotFoundError,
} from './primitives/tools';
export {
  State, Budget, StateSlot, StateSnapshot, StateDelta,
} from './primitives/state';
export {
  Trajectory, TrajectoryStep, load_trajectory,
} from './primitives/trajectory';

// Layer 2: Composition
export {
  FeatureFlag, FlagRegistry, flag, HarnessConfig, ProcessorEntry, HarnessBuilder,
  Plugin, SimplePlugin, PluginLoader, make_coding, make_reliability, make_evaluation, make_self_improve,
} from './composition';

// Layer 3: Execution
export { RunResult, ModelProvider, run_loop, Harness } from './execution';
export { Sandbox, LocalSandbox, SandboxProvider, LocalSandboxProvider } from './execution/sandbox';
export { Task, SimpleTask, BatchTask } from './execution/task';

// Layer 4: Evaluation
export {
  Judge, TestSuiteJudge, LLMJudge, MetricJudge, CompositeJudge,
  Metric, PassRateMetric, EfficiencyMetric, CustomMetric,
  Benchmark, BenchmarkResult, Comparison, compare,
} from './evaluation';

// Layer 5: Evolution
export {
  CodeMod, CodeModSet, parse_unified_diff,
  Insight, analyze_trajectory, summarize_trajectory,
  EvolutionStrategy, PromptEvolver, ConfigEvolver, CompositeEvolutionStrategy,
  PromotionDecision, PromotionGate,
  EvolutionReport, LoopEngine,
} from './evolution';
