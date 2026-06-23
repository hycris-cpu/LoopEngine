/**
 * The Harness ties everything together — it's the "agent" you actually use.
 *
 * Plain English: If the RunLoop is the engine, the Harness is the complete car.
 * It combines:
 * - A model (the driver)
 * - A config (the blueprint)
 * - A sandbox (the road)
 *
 * You create a Harness, then call it with a task to get a result.
 * It's the top-level API that users interact with.
 *
 * Usage:
 *     // Create from a builder
 *     const builder = make_coding().merge(make_reliability());
 *     const harness = Harness.from_builder(builder, my_model);
 *
 *     // Run a single task
 *     const result = await harness.run(task);
 *
 *     // Run a batch of tasks
 *     const results = await harness.run_batch(tasks, 4);
 */

import { RunResult, ModelProvider, run_loop } from './runloop';
import type { Task } from './task';

/**
 * The complete agent — top-level API for running tasks.
 *
 * Plain English: A Harness is like a self-driving car. You give it:
 * - A model (the driver's brain)
 * - A config (the car's setup — sensors, safety systems, etc.)
 * - Optionally a sandbox (the road environment)
 *
 * Then you call harness.run(task) and it drives the task to completion,
 * returning a RunResult with everything that happened.
 *
 * The Harness is the ONLY class most users need. It hides the complexity
 * of the RunLoop, processors, and state management behind a clean API.
 */
export class Harness {
  model: ModelProvider;
  config: unknown;
  sandbox: unknown;

  /**
   * Initialize a Harness.
   *
   * Args:
   *   model: The language model provider (OpenAI, Anthropic, etc.).
   *   config: A HarnessConfig with processors, tools, flags, and slots.
   *   sandbox: Optional sandboxed execution environment.
   */
  constructor(model: ModelProvider, config: unknown = null, sandbox: unknown = null) {
    this.model = model;
    this.config = config;
    this.sandbox = sandbox;
  }

  /**
   * Execute a single task and return the result.
   *
   * Plain English: "Hey agent, here's your assignment. Go!"
   * The Harness delegates to run_loop, which handles all the
   * step-by-step complexity.
   *
   * Args:
   *   task: The task to execute.
   *   run_id: Optional unique identifier for this run.
   *
   * Returns:
   *   A RunResult with the trajectory, evaluation, and statistics.
   */
  async run(task: Task, run_id: string | null = null): Promise<RunResult> {
    return run_loop(task, this.model, this.config, this.sandbox, run_id);
  }

  /**
   * Run multiple tasks, optionally in parallel.
   *
   * Plain English: "Hey agent, here's a stack of assignments.
   * Work through them, maybe with some friends helping."
   * parallelism=1 means one at a time (sequential).
   * parallelism=4 means up to 4 tasks running at once.
   *
   * Args:
   *   tasks: The list of tasks to execute.
   *   parallelism: Maximum number of concurrent tasks (default: 1).
   *
   * Returns:
   *   A list of RunResults, one per task, in the same order as input.
   */
  async run_batch(tasks: Task[], parallelism: number = 1): Promise<RunResult[]> {
    if (parallelism <= 1) {
      // Sequential execution
      const results: RunResult[] = [];
      for (const task of tasks) {
        const result = await this.run(task);
        results.push(result);
      }
      return results;
    }

    // Parallel execution with semaphore-based concurrency control
    const semaphore = new Semaphore(parallelism);

    const runWithSemaphore = async (task: Task): Promise<RunResult> => {
      await semaphore.acquire();
      try {
        return await this.run(task);
      } finally {
        semaphore.release();
      }
    };

    return Promise.all(tasks.map((task) => runWithSemaphore(task)));
  }

  /**
   * Create a Harness from a HarnessBuilder (convenience factory).
   *
   * Plain English: Instead of manually assembling a config, you can
   * use a builder (which has a nice fluent API) and convert it to
   * a Harness in one step.
   *
   * Args:
   *   builder: A HarnessBuilder instance.
   *   model: The language model provider.
   *   sandbox: Optional sandboxed execution environment.
   *
   * Returns:
   *   A new Harness configured from the builder's blueprint.
   */
  static from_builder(builder: { build(): unknown }, model: ModelProvider, sandbox: unknown = null): Harness {
    const config = builder.build();
    return new Harness(model, config, sandbox);
  }

  /** Human-readable representation for debugging. */
  toString(): string {
    const modelName = this.model.constructor.name;
    const hasConfig = this.config !== null && this.config !== undefined;
    const hasSandbox = this.sandbox !== null && this.sandbox !== undefined;
    return `Harness(model=${modelName}, config=${hasConfig ? 'yes' : 'no'}, sandbox=${hasSandbox ? 'yes' : 'no'})`;
  }
}

/**
 * A simple Promise-based semaphore for limiting concurrent execution.
 */
class Semaphore {
  private _permits: number;
  private _queue: Array<() => void>;

  constructor(permits: number) {
    this._permits = permits;
    this._queue = [];
  }

  async acquire(): Promise<void> {
    if (this._permits > 0) {
      this._permits--;
      return;
    }
    await new Promise<void>((resolve) => this._queue.push(resolve));
  }

  release(): void {
    const next = this._queue.shift();
    if (next !== undefined) {
      next();
    } else {
      this._permits++;
    }
  }
}
