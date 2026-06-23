/**
 * Metrics define MEASURABLE aspects of agent performance.
 *
 * Plain English: A Metric is like a scoreboard in sports. Each metric
 * tracks one specific thing:
 * - PassRate: What percentage of tests passed?
 * - CodeQuality: How clean/readable is the code?
 * - Efficiency: How many steps/tokens did it take?
 * - Correctness: Does the output match expected results?
 *
 * Metrics are the building blocks that Judges use. A MetricJudge collects
 * scores from multiple Metrics and averages them. Each Metric is focused
 * on ONE thing — like a thermometer only measures temperature.
 */

import type { Trajectory } from '../primitives/trajectory';
import type { Sandbox } from '../execution/sandbox';


// ---------------------------------------------------------------------------
// Minimal stubs (execution layer may not exist yet)
// ---------------------------------------------------------------------------


/** Minimal Task protocol for metrics. */
interface TaskLike {
  /** The instructions or problem statement for this task. */
  readonly prompt: string;

  /** Maximum number of reasoning steps allowed. */
  readonly max_steps: number;

  /**
   * Check if the task is complete given the current state.
   *
   * @param state - The current agent state.
   * @returns True if the task is complete, False otherwise.
   */
  is_done(state: unknown): boolean;
}


/** Minimal Sandbox protocol for metrics. */
interface SandboxLike {
  /**
   * Execute a shell command and return its output.
   *
   * @param command - The shell command to execute.
   * @param cwd - Working directory for the command (default: current dir).
   * @param timeout - Maximum execution time in seconds (default: 30).
   * @returns A tuple of (stdout, stderr, exit_code).
   */
  exec(command: string, cwd?: string, timeout?: number): Promise<[string, string, number]>;
}


// ---------------------------------------------------------------------------
// Metric — the core evaluation protocol
// ---------------------------------------------------------------------------


/**
 * Protocol defining what a metric must provide.
 *
 * A Metric is any object that can evaluate a trajectory and return
 * a float score between 0.0 and 1.0.
 *
 * Think of a Metric as a specific instrument in a medical checkup:
 * - Thermometer measures temperature
 * - Scale measures weight
 * - Blood pressure cuff measures blood pressure
 *
 * Each instrument (Metric) measures ONE thing precisely.
 * The doctor (Judge) combines all measurements into an overall assessment.
 *
 * Real-world analogy: In basketball, each stat is a metric:
 * - Points per game
 * - Free throw percentage
 * - Assists per game
 * The coach (Judge) looks at all stats to evaluate a player.
 */
export interface Metric {
  /** The metric's name (what it measures). */
  readonly name: string;

  /**
   * Evaluate the trajectory and return a score between 0.0 and 1.0.
   *
   * @param trajectory - The agent's execution record.
   * @param task - The task being evaluated.
   * @returns A float score where 0.0 is worst and 1.0 is best.
   */
  evaluate(trajectory: Trajectory, task: unknown): Promise<number>;
}


// ---------------------------------------------------------------------------
// PassRateMetric — runs tests and returns pass rate
// ---------------------------------------------------------------------------


/**
 * Runs a test command in the sandbox and returns the pass rate.
 *
 * Plain English: This metric runs your test suite (like pytest) and
 * checks what percentage passed. It's the same as TestSuiteJudge,
 * but packaged as a Metric so it can be used inside MetricJudge.
 *
 * The score is: passed / (passed + failed)
 * - 10 passed → 1.0
 * - 7 passed, 3 failed → 0.7
 * - 0 passed, 5 failed → 0.0
 *
 * Attributes:
 *   test_command: The shell command to run tests.
 *   sandbox: The sandbox to execute in.
 */
export class PassRateMetric implements Metric {
  private readonly _test_command: string;
  private readonly _sandbox: Sandbox;

  /**
   * Initialize the PassRateMetric.
   *
   * @param test_command - Shell command to run the test suite.
   * @param sandbox - A Sandbox instance to execute the command in.
   */
  constructor(test_command: string, sandbox: Sandbox) {
    this._test_command = test_command;
    this._sandbox = sandbox;
  }

  /** This metric's name: 'pass_rate'. */
  get name(): string {
    return 'pass_rate';
  }

  /** The test command that will be executed. */
  get test_command(): string {
    return this._test_command;
  }

  /** The sandbox used for test execution. */
  get sandbox(): Sandbox {
    return this._sandbox;
  }

  /**
   * Parse pytest-style output for passed/failed counts.
   *
   * @param stdout - Standard output from the test command.
   * @param stderr - Standard error from the test command.
   * @returns A tuple of (passed_count, failed_count).
   */
  static parse_output(stdout: string, stderr: string): [number, number] {
    const combined = `${stdout}\n${stderr}`;
    let passed = 0;
    let failed = 0;

    const passed_match = combined.match(/(\d+)\s+passed/);
    if (passed_match) {
      passed = parseInt(passed_match[1], 10);
    }

    const failed_match = combined.match(/(\d+)\s+failed/);
    if (failed_match) {
      failed = parseInt(failed_match[1], 10);
    }

    return [passed, failed];
  }

  /**
   * Run the test command and return the pass rate.
   *
   * @param trajectory - The agent's execution record (not used).
   * @param task - The task being evaluated (not used).
   * @returns A float score between 0.0 and 1.0.
   */
  async evaluate(trajectory: Trajectory, task: unknown): Promise<number> {
    const [stdout, stderr, exit_code] = await this._sandbox.exec(this._test_command);
    const [passed, failed] = PassRateMetric.parse_output(stdout, stderr);
    const total = passed + failed;

    if (total === 0) {
      return 0.0;
    }

    return passed / total;
  }
}


// ---------------------------------------------------------------------------
// EfficiencyMetric — fewer steps = better score
// ---------------------------------------------------------------------------


/**
 * Measures how efficiently the agent completed the task.
 *
 * Plain English: This metric rewards finishing quickly. If the task
 * allows 10 steps and you finish in 3, you get a high score (0.7).
 * If you use all 10, you get 0.0. If you use 0, you get 1.0.
 *
 * Formula: score = 1.0 - (steps_used / max_steps)
 *
 * Think of it like a timed exam — finishing early with correct answers
 * is better than using all the time.
 *
 * Attributes:
 *   (none — it's stateless)
 */
export class EfficiencyMetric implements Metric {
  /** This metric's name: 'efficiency'. */
  get name(): string {
    return 'efficiency';
  }

  /**
   * Compute efficiency score from the trajectory length vs max_steps.
   *
   * The score is: 1.0 - (len(trajectory) / task.max_steps)
   * Clamped to [0.0, 1.0].
   *
   * @param trajectory - The agent's execution record.
   * @param task - The task being evaluated (uses task.max_steps).
   * @returns A float score between 0.0 and 1.0.
   */
  async evaluate(trajectory: Trajectory, task: unknown): Promise<number> {
    const task_like = task as TaskLike;
    const steps_used = trajectory.steps.length;
    const max_steps = task_like.max_steps && task_like.max_steps > 0 ? task_like.max_steps : 1;

    const score = 1.0 - (steps_used / max_steps);
    return Math.max(0.0, Math.min(1.0, score));
  }
}


// ---------------------------------------------------------------------------
// CustomMetric — wraps a user-provided evaluation function
// ---------------------------------------------------------------------------


/**
 * Wraps a user-provided function as a Metric.
 *
 * Plain English: Sometimes you have a specific thing you want to measure
 * that doesn't fit the standard metrics. CustomMetric lets you plug in
 * your own function. It's like bringing your own measuring tape.
 *
 * The function can be sync or async — CustomMetric handles both.
 *
 * Attributes:
 *   name: The metric's name.
 */
export class CustomMetric implements Metric {
  private readonly _name: string;
  private readonly _eval_fn: (trajectory: Trajectory, task: unknown) => number | Promise<number>;

  /**
   * Initialize the CustomMetric.
   *
   * @param name - The metric's name (what it measures).
   * @param eval_fn - A function (sync or async) that takes (trajectory, task)
   *                  and returns a float score.
   */
  constructor(
    name: string,
    eval_fn: (trajectory: Trajectory, task: unknown) => number | Promise<number>,
  ) {
    this._name = name;
    this._eval_fn = eval_fn;
  }

  /** This metric's name. */
  get name(): string {
    return this._name;
  }

  /**
   * Run the custom evaluation function.
   *
   * If the function is async, it's awaited directly.
   * If the function is sync, it's called and the result is returned.
   *
   * @param trajectory - The agent's execution record.
   * @param task - The task being evaluated.
   * @returns A float score between 0.0 and 1.0.
   */
  async evaluate(trajectory: Trajectory, task: unknown): Promise<number> {
    const result = this._eval_fn(trajectory, task);
    if (result instanceof Promise || (
      result !== null &&
      typeof result === 'object' &&
      typeof (result as PromiseLike<unknown>).then === 'function'
    )) {
      return await (result as Promise<number>);
    }
    return result as number;
  }
}
