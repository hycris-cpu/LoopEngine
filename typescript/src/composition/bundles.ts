/**
 * Bundles are pre-composed capability sets — "starter packs" for common use cases.
 *
 * Plain English: If plugins are LEGO kits, bundles are the pre-built models
 * on the box cover. Instead of picking individual pieces, you grab a bundle:
 * - make_coding(): Everything you need for a coding agent
 * - make_reliability(): Safety nets and loop detection
 * - make_evaluation(): Judges and metrics
 * - make_self_improve(): Evolution capabilities
 *
 * You compose bundles with the merge() method:
 *   const config = make_coding().merge(make_reliability()).build();
 */

import { MultiHookProcessor } from '../primitives/processors';
import { Tool, ToolContext } from '../primitives/tools';
import { ToolResult } from '../primitives/events';
import { HarnessBuilder } from './builder';

/**
 * A placeholder processor that passes all events through unchanged.
 *
 * Plain English: This is a "coming soon" sign. The bundle functions need
 * processors to register, but the real implementations live in the
 * processors/ directory (built later). These stubs ensure the configs
 * are structurally valid without any behavioral logic.
 */
class _StubProcessor extends MultiHookProcessor {
  private _hook: string;

  /**
   * Initialize with a descriptive name.
   *
   * @param name - Human-readable name (e.g., "coding.planner").
   * @param hook - The hook point this processor is meant for.
   */
  constructor(name: string, hook: string = 'step_end') {
    super(name);
    this._hook = hook;
  }
}

/**
 * A placeholder tool that satisfies the Tool interface.
 *
 * Used by bundles to provide structural completeness.
 * Real tool implementations live in the tools/ directory.
 */
class _StubTool implements Tool {
  private _name: string;
  private _description: string;

  /**
   * Initialize with a name and optional description.
   *
   * @param name - The tool's unique name.
   * @param description - Human-readable description.
   */
  constructor(name: string, description: string = '') {
    this._name = name;
    this._description = description || `Stub tool: ${name}`;
  }

  /** The tool's unique name (used for dispatch). */
  get name(): string {
    return this._name;
  }

  /** What the tool does (sent to the AI model). */
  get description(): string {
    return this._description;
  }

  /** JSON Schema describing the tool's expected inputs. */
  get input_schema(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }

  /**
   * No-op execution — stubs never run in production.
   *
   * @throws Error always, because StubTool is a placeholder.
   */
  async execute(_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    throw new Error('StubTool is a placeholder; use a real implementation.');
  }
}

/**
 * Create a builder pre-configured for coding tasks.
 *
 * Plain English: This is the "coding agent starter pack." It sets up:
 * - A planner processor (to decompose coding tasks)
 * - A file editor tool (to modify code)
 * - A code runner tool (to execute and test code)
 * - Flags for code-aware features
 * - A working directory slot
 *
 * @param options - Options for the coding bundle.
 * @param options.working_dir - The directory where code lives (default: current dir).
 * @returns A HarnessBuilder with coding capabilities pre-loaded.
 */
export function make_coding(options: { working_dir?: string } = {}): HarnessBuilder {
  const { working_dir = '.' } = options;
  let builder = new HarnessBuilder();

  // Processors
  builder = builder.add(
    new _StubProcessor('coding.planner', 'before_model'),
    'before_model',
    -10
  );
  builder = builder.add(
    new _StubProcessor('coding.patcher', 'after_tool'),
    'after_tool',
    0
  );

  // Tools
  builder = builder.tool(
    new _StubTool('file_editor', 'Edit source files in the working directory')
  );
  builder = builder.tool(new _StubTool('code_runner', 'Execute code and capture output'));
  builder = builder.tool(new _StubTool('test_runner', 'Run test suites and report results'));

  // Flags
  builder = builder.flag('coding.patch_apply', true);
  builder = builder.flag('coding.auto_test', true);

  // Slots
  builder = builder.slot({ working_dir });

  return builder;
}

/**
 * Create a builder with loop detection and safety guards.
 *
 * Plain English: This is the "safety net bundle." It adds:
 * - A loop detector (to catch the agent repeating itself)
 * - A budget guard (to prevent runaway token usage)
 * - A timeout enforcer (to prevent hung steps)
 * - Safety-related flags
 *
 * @param _options - Reserved options object for kwargs parity with Python.
 * @returns A HarnessBuilder with reliability capabilities pre-loaded.
 */
export function make_reliability(_options: Record<string, unknown> = {}): HarnessBuilder {
  let builder = new HarnessBuilder();

  // Processors
  builder = builder.add(
    new _StubProcessor('reliability.loop_detector', 'step_end'),
    'step_end',
    10
  );
  builder = builder.add(
    new _StubProcessor('reliability.budget_guard', 'step_start'),
    'step_start',
    -10
  );

  // Flags
  builder = builder.flag('reliability.loop_detection', true);
  builder = builder.flag('reliability.guard_enabled', true);
  builder = builder.flag('reliability.max_retries', true);

  return builder;
}

/**
 * Create a builder with evaluation processors.
 *
 * Plain English: This is the "judge bundle." It adds:
 * - A step evaluator (to score each step)
 * - A task evaluator (to score the final result)
 * - Evaluation flags
 *
 * @param _options - Reserved options object for kwargs parity with Python.
 * @returns A HarnessBuilder with evaluation capabilities pre-loaded.
 */
export function make_evaluation(_options: Record<string, unknown> = {}): HarnessBuilder {
  let builder = new HarnessBuilder();

  // Processors
  builder = builder.add(
    new _StubProcessor('evaluation.step_judge', 'step_end'),
    'step_end',
    5
  );
  builder = builder.add(
    new _StubProcessor('evaluation.task_judge', 'task_end'),
    'task_end',
    0
  );

  // Flags
  builder = builder.flag('eval.step_scoring', true);
  builder = builder.flag('eval.task_scoring', true);

  return builder;
}

/**
 * Create a builder with self-improvement / evolution capabilities.
 *
 * Plain English: This is the "evolution bundle." It adds:
 * - A strategy selector (to pick improvement strategies)
 * - A code modifier (to apply self-improvements)
 * - Evolution flags
 *
 * @param _options - Reserved options object for kwargs parity with Python.
 * @returns A HarnessBuilder with evolution capabilities pre-loaded.
 */
export function make_self_improve(_options: Record<string, unknown> = {}): HarnessBuilder {
  let builder = new HarnessBuilder();

  // Processors
  builder = builder.add(
    new _StubProcessor('evolution.strategy_selector', 'task_start'),
    'task_start',
    0
  );
  builder = builder.add(
    new _StubProcessor('evolution.code_modifier', 'task_end'),
    'task_end',
    10
  );

  // Flags
  builder = builder.flag('evolution.enabled', true);
  builder = builder.flag('evolution.auto_promote', false);

  return builder;
}
