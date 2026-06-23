/**
 * LoopEngine — THE SELF-IMPROVEMENT ORCHESTRATOR.
 *
 * Plain English: This is the big one. LoopEngine is like a factory assembly line
 * for self-improvement. It runs a cycle:
 *
 * 1. MEASURE: "How good am I right now?" (run benchmark → baseline)
 * 2. ANALYZE: "What am I doing wrong?" (analyze trajectories → insights)
 * 3. PROPOSE: "What should I change?" (evolution strategies → CodeMods)
 * 4. TEST: "Does the change help?" (apply mods in sandbox → candidate)
 * 5. DECIDE: "Should I keep this change?" (promotion gate → yes/no)
 * 6. APPLY: "Update the real code." (if promoted)
 * 7. REPEAT: Go back to step 1.
 *
 * The LoopEngine doesn't know HOW to improve — that's what the strategies are for.
 * It just orchestrates the cycle: measure → propose → test → decide → apply → repeat.
 *
 * Real-world analogy: Imagine a sports team's training program. The coach (LoopEngine)
 * doesn't play the game. Instead, they:
 * 1. Watch game tape (measure current performance)
 * 2. Identify weaknesses (analyze trajectories)
 * 3. Design new drills (propose changes via strategies)
 * 4. Test the drills in practice (run benchmark with modifications)
 * 5. Decide if the drill worked (promotion gate)
 * 6. Add it to the permanent training plan (apply if promoted)
 * 7. Repeat next week
 *
 * This is the "meta-harness" pattern: the agent that improves agents.
 */

import type { BenchmarkResult } from '../evaluation/benchmark';
import type { Harness } from '../execution/harness';
import type { Task } from '../execution/task';
import type { RunResult } from '../execution/runloop';
import { Trajectory } from '../primitives/trajectory';
import { CodeMod } from './code_mod';
import { PromotionDecision, PromotionGate } from './promotion';
import type { EvolutionStrategy } from './strategies';

// ---------------------------------------------------------------------------
// EvolutionReport — the outcome of the entire evolution run
// ---------------------------------------------------------------------------

/**
 * The complete report from a LoopEngine run — what happened and why.
 *
 * Plain English: After the self-improvement factory finishes its shifts,
 * this is the summary report. It tells you:
 * - How many iterations were attempted
 * - What happened in each iteration (history)
 * - The final score after all improvements
 * - How many changes were promoted vs rejected
 *
 * This report is the "graduation certificate" of the evolution process.
 * You can use it to understand what changed, why, and whether it helped.
 *
 * Attributes:
 *   iterations: Total number of iterations performed.
 *   history: List of dicts, one per iteration, with details.
 *   final_score: The final aggregate score after all improvements.
 *   improvements: Number of successful promotions.
 *   rejections: Number of rejected proposals.
 */
export class EvolutionReport {
  readonly iterations: number;
  readonly history: Record<string, unknown>[];
  readonly final_score: number;
  readonly improvements: number;
  readonly rejections: number;

  constructor(options: {
    iterations?: number;
    history?: Record<string, unknown>[];
    final_score?: number;
    improvements?: number;
    rejections?: number;
  } = {}) {
    this.iterations = options.iterations ?? 0;
    this.history = options.history ? [...options.history] : [];
    this.final_score = options.final_score ?? 0.0;
    this.improvements = options.improvements ?? 0;
    this.rejections = options.rejections ?? 0;
  }

  /**
   * Generate a human-readable summary of the evolution run.
   *
   * Plain English: This is the "executive summary" — a short text
   * that tells you the key results without needing to read the full history.
   *
   * @returns A formatted multi-line string with the key metrics.
   */
  summary(): string {
    const parts = [
      '=== Evolution Report ===',
      `Iterations:   ${this.iterations}`,
      `Final Score:  ${this.final_score.toFixed(4)}`,
      `Improvements: ${this.improvements}`,
      `Rejections:   ${this.rejections}`,
    ];

    if (this.history.length > 0) {
      parts.push('\n--- Iteration History ---');
      for (const entry of this.history) {
        const iter_num = entry['iteration'] ?? '?';
        const score = (entry['score'] as number) ?? 0.0;
        const promoted = Boolean(entry['promoted']);
        const proposals = (entry['proposals'] as number) ?? 0;
        const status = promoted ? 'PROMOTED' : 'REJECTED';
        parts.push(
          `  Iter ${iter_num}: score=${score.toFixed(4)}, proposals=${proposals}, status=${status}`
        );
      }
    }

    if (this.improvements > 0) {
      const first_score = (this.history[0]?.['score'] as number) ?? 0.0;
      const delta = this.final_score - first_score;
      parts.push(`\nTotal improvement: ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`);
    } else {
      parts.push('\nNo improvements were promoted.');
    }

    return parts.join('\n');
  }
}

// ---------------------------------------------------------------------------
// LoopEngine — the self-improvement orchestrator
// ---------------------------------------------------------------------------

/**
 * THE SELF-IMPROVEMENT ORCHESTRATOR — runs the measure→propose→test→decide→apply cycle.
 *
 * Plain English: LoopEngine is the factory manager who oversees the entire
 * self-improvement assembly line. It doesn't do the work itself — it
 * coordinates:
 *
 * 1. The Benchmark (measures current performance)
 * 2. The Strategies (propose improvements)
 * 3. The PromotionGate (decides what to keep)
 * 4. The Sandbox (tests changes safely)
 * 5. The Agent Builder (creates agents from configs)
 *
 * At each iteration, it follows the cycle:
 * - Run the benchmark on the CURRENT code → baseline score
 * - Ask strategies what to change → CodeMods
 * - Apply mods in sandbox, run benchmark again → candidate score
 * - Let the PromotionGate compare baseline vs candidate
 * - If promoted, apply mods to real code
 *
 * The cycle stops when:
 * - No more proposals (strategies return empty)
 * - Max iterations reached
 * - All proposals are rejected (strategies exhausted)
 *
 * Attributes:
 *   _agent_builder: Callable that creates a Harness from a config dict.
 *   _benchmark: The Benchmark for measuring agent performance.
 *   _strategies: List of EvolutionStrategy instances.
 *   _gate: The PromotionGate for validating improvements.
 *   _sandbox: Optional sandbox for safe testing.
 *   _max_iterations: Maximum number of improvement iterations.
 */
export class LoopEngine {
  private readonly _agent_builder: (config: Record<string, unknown>) => Harness;
  private readonly _benchmark: { run(tasks: unknown[]): Promise<BenchmarkResult> };
  private readonly _strategies: EvolutionStrategy[];
  private readonly _gate: PromotionGate;
  private readonly _sandbox: unknown;
  private readonly _max_iterations: number;

  /**
   * Initialize the LoopEngine.
   *
   * @param agent_builder - Callable that takes a config dict and returns a Harness.
   * @param benchmark - A Benchmark instance for measuring performance.
   * @param strategies - List of EvolutionStrategy instances.
   * @param gate - A PromotionGate for validating improvements.
   * @param sandbox - Optional sandbox for testing modifications.
   * @param max_iterations - Maximum improvement iterations (default 100).
   */
  constructor(
    agent_builder: (config: Record<string, unknown>) => Harness,
    benchmark: { run(tasks: unknown[]): Promise<BenchmarkResult> },
    strategies: EvolutionStrategy[],
    gate: PromotionGate,
    sandbox: unknown = null,
    max_iterations: number = 100
  ) {
    this._agent_builder = agent_builder;
    this._benchmark = benchmark;
    this._strategies = [...strategies];
    this._gate = gate;
    this._sandbox = sandbox;
    this._max_iterations = max_iterations;
  }

  /**
   * Run the full self-improvement loop.
   *
   * Plain English: "Start the factory! Let's make this agent better."
   *
   * The loop:
   * 1. Build an agent from the current config
   * 2. Run the benchmark to measure baseline performance
   * 3. Ask strategies for improvement proposals
   * 4. If no proposals → stop (nothing to improve)
   * 5. For each proposal:
   *    a. Apply the mod to source files
   *    b. Build a new agent from the modified source
   *    c. Run the benchmark on the new agent
   *    d. Let the PromotionGate decide
   *    e. If promoted, update the real source files
   *    f. Record in history
   * 6. Repeat from step 2
   *
   * @param tasks - Optional list of tasks for the benchmark. If omitted, uses
   *                whatever tasks the benchmark was configured with.
   * @param source_files - Dict mapping filename to content. This is the
   *                       "source code" of the agent being improved.
   * @param config - Optional config dict passed to the agent builder.
   * @returns An EvolutionReport with the full history and final results.
   */
  async run(
    tasks: unknown[] | null = null,
    source_files: Record<string, string> | null = null,
    config: Record<string, unknown> | null = null
  ): Promise<EvolutionReport> {
    // Initialize tracking state
    const current_source: Record<string, string> = source_files ? { ...source_files } : {};
    let current_config: Record<string, unknown> = config ? { ...config } : {};

    const history: Record<string, unknown>[] = [];
    let improvements = 0;
    let rejections = 0;
    let final_score = 0.0;
    let no_proposals_count = 0;
    const max_no_proposals = 2; // Stop after N consecutive iterations with no proposals

    for (let iteration = 0; iteration < this._max_iterations; iteration++) {
      // Step 1: MEASURE — build baseline harness and run benchmark on current code
      const baseline = await this._run_benchmark(tasks, current_config, current_source);

      // Step 2: ANALYZE + PROPOSE — get proposals from strategies
      const proposals = await this._get_proposals(baseline, current_source, current_config);

      // Step 3: Check if we have any proposals
      if (proposals.length === 0) {
        no_proposals_count++;
        const score = baseline.aggregate['mean_score'] ?? 0.0;
        if (no_proposals_count >= max_no_proposals) {
          // No more proposals from any strategy — done improving
          history.push({
            iteration,
            score,
            proposals: 0,
            promoted: false,
            reason: 'No proposals — stopping.',
          });
          final_score = score;
          break;
        } else {
          // Might be transient — record and continue
          history.push({
            iteration,
            score,
            proposals: 0,
            promoted: false,
            reason: 'No proposals from strategies.',
          });
          final_score = score;
          continue;
        }
      }

      // Reset no-proposals counter
      no_proposals_count = 0;

      // Step 4: TEST + DECIDE — try each proposal
      let iteration_promoted = false;
      let iteration_score = baseline.aggregate['mean_score'] ?? 0.0;

      for (const mod of proposals) {
        // Apply mod to get candidate source
        const candidate_source = this._apply_mods([mod], current_source);

        // Build candidate config with modified source files and sandbox
        const candidate_config = this._build_candidate_config(current_config, candidate_source);

        // Run benchmark with candidate harness
        const candidate = await this._run_benchmark(tasks, candidate_config, candidate_source);

        // Let the PromotionGate decide
        const decision = await this._gate.validate(baseline, candidate, mod);

        if (decision.promoted) {
          // Promoted! Update the real source and config
          Object.assign(current_source, candidate_source);
          current_config = candidate_config;
          improvements++;
          iteration_promoted = true;
          iteration_score = candidate.aggregate['mean_score'] ?? 0.0;
          // Only promote one mod per iteration (most impactful)
          break;
        } else {
          rejections++;
        }
      }

      // Record iteration history
      history.push({
        iteration,
        score: iteration_score,
        proposals: proposals.length,
        promoted: iteration_promoted,
        reason: iteration_promoted
          ? 'Promoted a modification.'
          : `All ${proposals.length} proposals rejected.`,
      });

      final_score = iteration_score;
    }

    return new EvolutionReport({
      iterations: history.length,
      history,
      final_score,
      improvements,
      rejections,
    });
  }

  /**
   * Run the benchmark to measure current performance.
   *
   * Builds a Harness from the supplied config (merged with source files and the
   * sandbox), runs each task through it, then evaluates the resulting RunResults
   * with the configured Benchmark. Trajectories from the harness runs are
   * attached to the returned BenchmarkResult so strategies can analyze them.
   *
   * @param tasks - Optional tasks for the benchmark.
   * @param config - Config dict for the agent builder.
   * @param source_files - Current source code files used by the agent builder.
   * @returns A BenchmarkResult with scores and aggregates.
   */
  private async _run_benchmark(
    tasks: unknown[] | null,
    config: Record<string, unknown>,
    source_files: Record<string, string>
  ): Promise<BenchmarkResult> {
    const taskList = tasks !== null ? tasks : this._resolve_default_tasks();

    // Build a harness from the current config + source files + sandbox
    const harnessConfig: Record<string, unknown> = {
      ...config,
      source_files: { ...source_files },
      sandbox: this._sandbox,
    };
    const harness = this._agent_builder(harnessConfig);

    // Run tasks through the harness to produce RunResults
    const runResults: RunResult[] = await harness.run_batch(taskList as Task[]);

    // Evaluate the run results with the benchmark
    const result = await this._benchmark.run(runResults);

    // Preserve trajectories for strategy analysis
    const trajectories = runResults.map((runResult) => runResult.trajectory);
    (result as BenchmarkResult & { trajectories: Trajectory[] }).trajectories = trajectories;

    return result;
  }

  /**
   * Resolve the default task list from the benchmark, if available.
   *
   * @returns The benchmark's configured tasks, or an empty list.
   */
  private _resolve_default_tasks(): unknown[] {
    if ('tasks' in this._benchmark && Array.isArray((this._benchmark as { tasks: unknown[] }).tasks)) {
      return (this._benchmark as { tasks: unknown[] }).tasks;
    }
    return [];
  }

  /**
   * Collect proposals from all strategies.
   *
   * Uses the baseline's first trajectory (if available) for analysis.
   * If no trajectory is available, passes a minimal one.
   *
   * @param baseline - The current benchmark result.
   * @param source_code - Current source code files.
   * @param config - Current configuration.
   * @returns A combined list of CodeMod proposals from all strategies.
   */
  private async _get_proposals(
    baseline: BenchmarkResult,
    source_code: Record<string, string>,
    config: Record<string, unknown>
  ): Promise<CodeMod[]> {
    // Get a trajectory for analysis (from the first scored task)
    const trajectory = this._extract_trajectory(baseline);
    const eval_result = this._extract_eval_result(baseline);

    const all_mods: CodeMod[] = [];
    for (const strategy of this._strategies) {
      try {
        const mods = await strategy.propose(trajectory, eval_result, config, source_code);
        all_mods.push(...mods);
      } catch {
        // Strategy failed — skip it
      }
    }

    return all_mods;
  }

  /**
   * Extract a trajectory from the benchmark result for analysis.
   *
   * Benchmark runs performed by this engine attach the raw trajectories to the
   * result object. If that attachment is missing, we fall back to looking for a
   * trajectory field on any EvalResult.
   *
   * @param baseline - The benchmark result to extract from.
   * @returns A Trajectory object, or an empty one if none available.
   */
  private _extract_trajectory(baseline: BenchmarkResult): Trajectory {
    const extended = baseline as BenchmarkResult & {
      trajectories?: Trajectory[];
      details?: { trajectories?: Trajectory[] };
    };

    // Primary source: trajectories captured by _run_benchmark
    if (extended.trajectories && extended.trajectories.length > 0) {
      return extended.trajectories[0];
    }

    // Secondary source: trajectories stored in result details
    if (extended.details?.trajectories && extended.details.trajectories.length > 0) {
      return extended.details.trajectories[0];
    }

    // Fallback: some EvalResult implementations may carry a trajectory
    for (const eval_result of Object.values(baseline.scores)) {
      if (
        eval_result !== null &&
        typeof eval_result === 'object' &&
        'trajectory' in eval_result
      ) {
        const traj = (eval_result as { trajectory: unknown }).trajectory;
        if (traj instanceof Trajectory) {
          return traj;
        }
      }
    }

    return new Trajectory();
  }

  /**
   * Extract the first eval result from the benchmark for strategy use.
   *
   * @param baseline - The benchmark result to extract from.
   * @returns The first EvalResult, or null if none available.
   */
  private _extract_eval_result(baseline: BenchmarkResult): unknown {
    const values = Object.values(baseline.scores);
    if (values.length > 0) {
      return values[0];
    }
    return null;
  }

  /**
   * Apply a list of CodeMods to source files.
   *
   * This creates a MODIFIED COPY of the source files — the originals
   * are not touched until the PromotionGate approves.
   *
   * @param mods - List of CodeMods to apply.
   * @param source_files - Current source code files.
   * @returns A new dict with the modifications applied.
   */
  private _apply_mods(
    mods: CodeMod[],
    source_files: Record<string, string>
  ): Record<string, string> {
    // Deep copy so we don't modify the original
    let result = { ...source_files };

    for (const mod of mods) {
      if (typeof mod.apply_to === 'function') {
        result = mod.apply_to(result);
      }
    }

    return result;
  }

  /**
   * Build a candidate config that includes modified source files.
   *
   * This guarantees that the candidate harness receives a different config
   * than the baseline, even if the agent builder does not directly consume
   * source_files.
   *
   * @param base_config - The current configuration.
   * @param source_files - The candidate source code files.
   * @returns A new config dict for the candidate harness.
   */
  private _build_candidate_config(
    base_config: Record<string, unknown>,
    source_files: Record<string, string>
  ): Record<string, unknown> {
    return {
      ...base_config,
      source_files: { ...source_files },
    };
  }
}
