// Layer 1: Primitives
export type { Processor } from './primitives';
export {
  Event, Message, MessageType, ToolCall, ToolCallMetadata, ToolResult, EvalResult,
  HOOK_POINTS, MultiHookProcessor, ProcessorChain, pipe, pipe_all,
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
export type { Plugin } from './composition';
export {
  FeatureFlag, FlagRegistry, flag, HarnessConfig, ProcessorEntry, HarnessBuilder,
  SimplePlugin, PluginLoader, make_coding, make_reliability, make_evaluation, make_self_improve,
} from './composition';

// Layer 3: Execution
export type { ModelProvider, Sandbox, SandboxProvider, Task } from './execution';
export { RunResult, run_loop, Harness } from './execution';
export { LocalSandbox, LocalSandboxProvider } from './execution/sandbox';
export { SimpleTask, BatchTask } from './execution/task';

// Layer 4: Evaluation
export type { Judge, Metric } from './evaluation';
export {
  TestSuiteJudge, LLMJudge, MetricJudge, CompositeJudge,
  PassRateMetric, EfficiencyMetric, CustomMetric,
  Benchmark, BenchmarkResult, Comparison, compare,
} from './evaluation';

// Layer 5: Evolution
export type { EvolutionStrategy } from './evolution';
export {
  CodeMod, CodeModSet, parse_unified_diff,
  Insight, analyze_trajectory, summarize_trajectory,
  PromptEvolver, ConfigEvolver, CompositeEvolutionStrategy,
  PromotionDecision, PromotionGate,
  EvolutionReport, LoopEngine,
} from './evolution';
