/**
 * Benchmarks run the agent on multiple tasks and aggregate results.
 *
 * Plain English: If a single test is one exam question, a benchmark is the
 * full exam. It runs the agent on many tasks, collects all the results,
 * and produces a summary report.
 *
 * The Benchmark class also supports COMPARISON — given two benchmark runs,
 * it shows which one was better and by how much. This is essential for the
 * evolution layer to decide if a self-modification was an improvement.
 *
 * Real-world analogy: A benchmark is like a school report card that shows
 * your grade in every subject, plus the overall GPA. Comparing two report
 * cards tells you which subjects improved and which got worse.
 */

import type { EvalResult } from '../primitives/events';
import { Trajectory } from '../primitives/trajectory';
import type { Judge } from './judges';


// ---------------------------------------------------------------------------
// BenchmarkResult — the outcome of a benchmark run
// ---------------------------------------------------------------------------


/**
 * The result of running a benchmark — scores for every task plus aggregates.
 *
 * Plain English: This is the "report card" after a full benchmark run.
 * It contains:
 * - scores: Individual scores for each task (like subject grades)
 * - aggregate: Summary statistics (like GPA, pass rate, etc.)
 *
 * Frozen (immutable) because once a benchmark is run, its results should
 * never change. You can compare two BenchmarkResults to see progress.
 *
 * Attributes:
 *   scores: Dict mapping task identifier to EvalResult.
 *   aggregate: Dict of summary statistics (mean_score, pass_rate, etc.).
 */
export class BenchmarkResult {
  readonly scores: Record<string, EvalResult>;
  readonly aggregate: Record<string, number>;

  constructor(options: {
    scores?: Record<string, EvalResult>;
    aggregate?: Record<string, number>;
  } = {}) {
    this.scores = options.scores ? { ...options.scores } : {};
    this.aggregate = options.aggregate ? { ...options.aggregate } : {};
  }
}


// ---------------------------------------------------------------------------
// Comparison — the diff between two benchmark runs
// ---------------------------------------------------------------------------


/**
 * The difference between two BenchmarkResults — what improved, regressed, or stayed the same.
 *
 * Plain English: This is like comparing two report cards side by side.
 * It tells you:
 * - improvements: Tasks where the new run scored higher
 * - regressions: Tasks where the new run scored lower
 * - unchanged: Tasks where scores are the same
 *
 * The summary is a human-readable string you can print or log.
 *
 * Attributes:
 *   improvements: Dict of task_id → score improvement (positive delta).
 *   regressions: Dict of task_id → score regression (negative delta, stored as positive).
 *   unchanged: List of task_ids where scores didn't change.
 *   summary: A human-readable summary of the comparison.
 */
export class Comparison {
  readonly improvements: Record<string, number>;
  readonly regressions: Record<string, number>;
  readonly unchanged: string[];
  readonly summary: string;

  constructor(options: {
    improvements?: Record<string, number>;
    regressions?: Record<string, number>;
    unchanged?: string[];
    summary?: string;
  } = {}) {
    this.improvements = options.improvements ? { ...options.improvements } : {};
    this.regressions = options.regressions ? { ...options.regressions } : {};
    this.unchanged = options.unchanged ? [...options.unchanged] : [];
    this.summary = options.summary ?? '';
  }
}


// ---------------------------------------------------------------------------
// Benchmark — runs agent on multiple tasks and collects results
// ---------------------------------------------------------------------------


/**
 * Runs the agent on multiple tasks and produces a BenchmarkResult.
 *
 * Plain English: A Benchmark is like a test administrator. You give it:
 * - A judge (how to grade)
 * - A list of tasks (what to test)
 *
 * It runs each task through the judge and collects all the scores.
 * Then it computes aggregate statistics (mean, pass rate, etc.).
 *
 * The parallelism parameter controls how many tasks run concurrently.
 * parallelism=1 means sequential (one at a time).
 * parallelism=4 means up to 4 tasks run in parallel.
 *
 * Attributes:
 *   judge: The Judge to evaluate each task's trajectory.
 *   parallelism: Maximum number of concurrent task evaluations.
 */
export class Benchmark {
  private readonly _judge: Judge;
  private readonly _parallelism: number;

  /**
   * Initialize the Benchmark.
   *
   * @param judge - A Judge instance to evaluate trajectories.
   * @param parallelism - Maximum concurrent evaluations (default 1 = sequential).
   */
  constructor(judge: Judge, parallelism: number = 1) {
    this._judge = judge;
    this._parallelism = parallelism;
  }

  /** The judge used for evaluation. */
  get judge(): Judge {
    return this._judge;
  }

  /** Maximum concurrent task evaluations. */
  get parallelism(): number {
    return this._parallelism;
  }

  /**
   * Run all tasks through the judge and produce a BenchmarkResult.
   *
   * Steps:
   * 1. For each task, evaluate its trajectory with the judge
   * 2. Collect all EvalResults
   * 3. Compute aggregate statistics (mean score, pass rate)
   * 4. Return a frozen BenchmarkResult
   *
   * @param tasks - A list of Task objects to evaluate.
   * @returns A BenchmarkResult with individual scores and aggregates.
   */
  async run(tasks: unknown[]): Promise<BenchmarkResult> {
    const scores: Record<string, EvalResult> = {};

    // Evaluate each task
    if (this._parallelism <= 1) {
      // Sequential mode
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const task_id = `task_${i}`;
        const trajectory = _get_trajectory(task);
        const result = await this._judge.evaluate(trajectory, task);
        scores[task_id] = result;
      }
    } else {
      // Parallel mode
      const eval_one = async (index: number, task: unknown): Promise<[string, EvalResult]> => {
        const task_id = `task_${index}`;
        const trajectory = _get_trajectory(task);
        const result = await this._judge.evaluate(trajectory, task);
        return [task_id, result];
      };

      // Run in batches of parallelism
      for (let batch_start = 0; batch_start < tasks.length; batch_start += this._parallelism) {
        const batch = tasks.slice(batch_start, batch_start + this._parallelism);
        const batch_results = await Promise.all(
          batch.map((task, i) => eval_one(batch_start + i, task)),
        );
        for (const [task_id, result] of batch_results) {
          scores[task_id] = result;
        }
      }
    }

    // Compute aggregates
    const aggregate = _compute_aggregate(scores);

    return new BenchmarkResult({ scores, aggregate });
  }
}


// ---------------------------------------------------------------------------
// compare() — diff two benchmark results
// ---------------------------------------------------------------------------


/**
 * Compare two BenchmarkResults and produce a diff report.
 *
 * Plain English: This is like holding two report cards side by side.
 * For each task (subject), it checks:
 * - Did the score go up? (improvement)
 * - Did it go down? (regression)
 * - Did it stay the same? (unchanged)
 *
 * The Comparison also includes an overall summary comparing the
 * aggregate scores.
 *
 * @param a - The baseline BenchmarkResult (the "before").
 * @param b - The new BenchmarkResult (the "after").
 * @returns A Comparison showing improvements, regressions, and unchanged tasks.
 */
export function compare(a: BenchmarkResult, b: BenchmarkResult): Comparison {
  const improvements: Record<string, number> = {};
  const regressions: Record<string, number> = {};
  const unchanged: string[] = [];

  // Compare individual task scores
  const all_tasks = new Set([...Object.keys(a.scores), ...Object.keys(b.scores)]);
  for (const task_id of [...all_tasks].sort()) {
    const score_a = task_id in a.scores ? a.scores[task_id].score : 0.0;
    const score_b = task_id in b.scores ? b.scores[task_id].score : 0.0;

    const delta = score_b - score_a;
    if (delta > 0.001) {
      // threshold to avoid floating-point noise
      improvements[task_id] = delta;
    } else if (delta < -0.001) {
      regressions[task_id] = Math.abs(delta);
    } else {
      unchanged.push(task_id);
    }
  }

  // Build summary
  const mean_a = a.aggregate['mean_score'] ?? 0.0;
  const mean_b = b.aggregate['mean_score'] ?? 0.0;
  const pass_rate_a = a.aggregate['pass_rate'] ?? 0.0;
  const pass_rate_b = b.aggregate['pass_rate'] ?? 0.0;

  const summary_parts = [
    'Benchmark comparison:',
    `  Mean score: ${mean_a.toFixed(2)} → ${mean_b.toFixed(2)} (delta: ${(mean_b - mean_a) >= 0 ? '+' : ''}${(mean_b - mean_a).toFixed(2)})`,
    `  Pass rate:  ${pass_rate_a.toFixed(2)} → ${pass_rate_b.toFixed(2)} (delta: ${(pass_rate_b - pass_rate_a) >= 0 ? '+' : ''}${(pass_rate_b - pass_rate_a).toFixed(2)})`,
    `  Tasks improved:   ${Object.keys(improvements).length}`,
    `  Tasks regressed:  ${Object.keys(regressions).length}`,
    `  Tasks unchanged:  ${unchanged.length}`,
  ];

  if (Object.keys(improvements).length > 0) {
    for (const [task_id, delta] of Object.entries(improvements)) {
      summary_parts.push(`    ✓ ${task_id}: +${delta.toFixed(2)}`);
    }
  }
  if (Object.keys(regressions).length > 0) {
    for (const [task_id, delta] of Object.entries(regressions)) {
      summary_parts.push(`    ✗ ${task_id}: -${delta.toFixed(2)}`);
    }
  }

  return new Comparison({
    improvements,
    regressions,
    unchanged,
    summary: summary_parts.join('\n'),
  });
}


// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------


/**
 * Extract a trajectory from a task or RunResult.
 *
 * If the task has a 'trajectory' attribute, return it.
 * Otherwise, return an empty Trajectory.
 *
 * @param task - A task or RunResult object.
 * @returns A Trajectory object.
 */
function _get_trajectory(task: unknown): Trajectory {
  if (
    task !== null &&
    typeof task === 'object' &&
    'trajectory' in task &&
    task.trajectory instanceof Trajectory
  ) {
    return task.trajectory;
  }
  return new Trajectory();
}


/**
 * Compute aggregate statistics from a dict of EvalResults.
 *
 * @param scores - Dict mapping task_id to EvalResult.
 * @returns A dict with 'mean_score' and 'pass_rate'.
 */
function _compute_aggregate(scores: Record<string, EvalResult>): Record<string, number> {
  const values = Object.values(scores);
  if (values.length === 0) {
    return { mean_score: 0.0, pass_rate: 0.0 };
  }

  const total_score = values.reduce((sum, r) => sum + r.score, 0);
  const total_passed = values.filter((r) => r.passed).length;
  const count = values.length;

  return {
    mean_score: total_score / count,
    pass_rate: total_passed / count,
  };
}
