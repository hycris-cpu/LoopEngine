/**
 * The Promotion Gate — the quality control checkpoint for self-modifications.
 *
 * Plain English: Think of the Promotion Gate as a code review process.
 * Before any self-modification is applied to the real codebase, it must pass
 * through this gate. The gate checks:
 *
 * 1. Does the modification actually improve performance?
 * 2. Does it avoid breaking anything that currently works?
 * 3. Is it safe? (no destructive operations)
 * 4. Is the improvement statistically significant? (not just noise)
 *
 * If a modification passes all checks, it's "promoted" — applied to the
 * real codebase. If it fails, it's "rolled back" — discarded, and we try
 * something else.
 *
 * Real-world analogy: This is like a product review before launch.
 * - "Does the new feature make users happier?" (improvement check)
 * - "Did we break anything that was working?" (regression check)
 * - "Is the product safe to use?" (safety check)
 * - "Is the improvement real or just a fluke?" (significance check)
 *
 * Only when ALL checks pass does the product ship.
 */

import type { BenchmarkResult } from '../evaluation/benchmark';
import { CodeMod, CodeModSet } from './code_mod';

// ---------------------------------------------------------------------------
// PromotionDecision — the gate's verdict
// ---------------------------------------------------------------------------

/**
 * The promotion gate's verdict — promote or reject a self-modification.
 *
 * Plain English: This is like a judge's ruling. It tells you:
 * - promoted: True = "Ship it!" / False = "Back to the drawing board."
 * - reason: A human-readable explanation of the decision.
 * - details: Extra data about each check that was performed.
 *
 * Frozen (immutable) because once a decision is made, it shouldn't change.
 * You can't un-ring a bell.
 *
 * Attributes:
 *   promoted: Whether the modification is approved for application.
 *   reason: Human-readable explanation of the decision.
 *   details: Dict with details of each check performed.
 */
export class PromotionDecision {
  readonly promoted: boolean;
  readonly reason: string;
  readonly details: Record<string, unknown>;

  constructor(options: Partial<PromotionDecision> = {}) {
    this.promoted = options.promoted ?? false;
    this.reason = options.reason ?? '';
    this.details = options.details ? { ...options.details } : {};
  }
}

// ---------------------------------------------------------------------------
// PromotionGate — the gatekeeper
// ---------------------------------------------------------------------------

/**
 * The quality control checkpoint for self-modifications.
 *
 * Plain English: This is the "bouncer at the club door." Every proposed
 * change (CodeMod) must convince the bouncer that it's worth letting in.
 * The bouncer checks:
 *
 * 1. IMPROVEMENT: "Is this change actually better?" — the candidate's
 *    aggregate score must improve by at least min_improvement.
 * 2. NO REGRESSION: "Does this change break anything?" — no individual
 *    task score may regress by more than no_regression.
 * 3. SAFETY: "Is this change dangerous?" — all mods must pass is_safe().
 * 4. SIGNIFICANCE: "Is this improvement real or just noise?" — the
 *    improvement must exceed the threshold.
 *
 * If ANY check fails, the modification is rejected with a detailed
 * explanation. The evolution loop uses this feedback to try again.
 *
 * Attributes:
 *   _min_improvement: Minimum aggregate score improvement required.
 *   _no_regression: Maximum allowed regression per individual task.
 *   _require_safety: Whether to enforce the is_safe() check.
 */
export class PromotionGate {
  private readonly _min_improvement: number;
  private readonly _no_regression: number;
  private readonly _require_safety: boolean;

  /**
   * Initialize the PromotionGate.
   *
   * Args:
   *   min_improvement: Minimum aggregate score delta to approve (default 0.01).
   *   no_regression: Maximum allowed per-task regression (default 0.02).
   *   require_safety: Whether mods must pass is_safe() (default True).
   */
  constructor(
    min_improvement: number = 0.01,
    no_regression: number = 0.02,
    require_safety: boolean = true
  ) {
    this._min_improvement = min_improvement;
    this._no_regression = no_regression;
    this._require_safety = require_safety;
  }

  /**
   * Validate a proposed modification against the baseline.
   *
   * Plain English: "Before we ship this change, let's run the tests
   * on both the old version and the new version, then compare."
   *
   * Steps:
   * 1. Check safety (if required)
   * 2. Check aggregate improvement
   * 3. Check per-task regression
   * 4. Return a PromotionDecision with full reasoning
   *
   * Args:
   *   baseline: The BenchmarkResult from the current (unmodified) agent.
   *   candidate: The BenchmarkResult from the modified agent.
   *   mods: The CodeMod or CodeModSet that was applied.
   *
   * Returns:
   *   A PromotionDecision indicating whether to promote or reject.
   */
  async validate(
    baseline: BenchmarkResult,
    candidate: BenchmarkResult,
    mods: unknown
  ): Promise<PromotionDecision> {
    const details: Record<string, unknown> = {};

    // --- Check 1: Safety ---
    if (this._require_safety) {
      const is_safe = this._check_safety(mods);
      details['safety'] = {
        passed: is_safe,
        require_safety: this._require_safety,
      };
      if (!is_safe) {
        return new PromotionDecision({
          promoted: false,
          reason: 'Safety check failed: one or more mods contain dangerous operations.',
          details,
        });
      }
    }

    // --- Check 2: Aggregate improvement ---
    const baseline_score = baseline.aggregate['mean_score'] ?? 0.0;
    const candidate_score = candidate.aggregate['mean_score'] ?? 0.0;
    const improvement = candidate_score - baseline_score;

    details['improvement'] = {
      baseline_score,
      candidate_score,
      delta: improvement,
      threshold: this._min_improvement,
      passed: improvement >= this._min_improvement,
    };

    if (improvement < this._min_improvement) {
      return new PromotionDecision({
        promoted: false,
        reason: `Insufficient improvement: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(4)} (need >= ${this._min_improvement >= 0 ? '+' : ''}${this._min_improvement.toFixed(4)}). Baseline: ${baseline_score.toFixed(4)}, Candidate: ${candidate_score.toFixed(4)}.`,
        details,
      });
    }

    // --- Check 3: Per-task regression ---
    const regression_details = this._check_regressions(baseline, candidate);
    details['regression'] = regression_details;

    if (regression_details['has_regression']) {
      const worst = regression_details['worst_regression'] as number;
      const task = regression_details['worst_task'] as string;
      return new PromotionDecision({
        promoted: false,
        reason: `Regression detected on task '${task}': ${worst >= 0 ? '+' : ''}${worst.toFixed(4)} exceeds tolerance ${this._no_regression >= 0 ? '+' : ''}${this._no_regression.toFixed(4)}. The improvement must not come at the cost of breaking existing functionality.`,
        details,
      });
    }

    // --- All checks passed: promote! ---
    details['verdict'] = 'promoted';
    return new PromotionDecision({
      promoted: true,
      reason: `Approved: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(4)} improvement, no regressions exceeding ${this._no_regression >= 0 ? '+' : ''}${this._no_regression.toFixed(4)}, safety check ${this._require_safety ? 'passed' : 'skipped'}.`,
      details,
    });
  }

  private _check_safety(mods: unknown): boolean {
    /**
     * Check if all mods pass the safety check.
     *
     * Args:
     *   mods: A CodeMod or CodeModSet to check.
     *
     * Returns:
     *   True if safe, False if any mod is dangerous.
     */
    if (mods !== null && typeof mods === 'object' && 'is_safe' in mods) {
      const is_safe = (mods as { is_safe: () => boolean }).is_safe;
      if (typeof is_safe === 'function') {
        return is_safe.call(mods);
      }
    }

    // If it's a list, check each one
    if (Array.isArray(mods)) {
      return mods.every((m) => {
        if (m !== null && typeof m === 'object' && 'is_safe' in m) {
          const is_safe = (m as { is_safe: () => boolean }).is_safe;
          if (typeof is_safe === 'function') {
            return is_safe.call(m);
          }
        }
        return true;
      });
    }

    return true;
  }

  private _check_regressions(
    baseline: BenchmarkResult,
    candidate: BenchmarkResult
  ): Record<string, unknown> {
    /**
     * Check for per-task regressions between baseline and candidate.
     *
     * A regression means a specific task scored WORSE with the modification
     * than without it. Small regressions might be acceptable (noise), but
     * large regressions are a red flag.
     *
     * Args:
     *   baseline: The baseline BenchmarkResult.
     *   candidate: The candidate BenchmarkResult.
     *
     * Returns:
     *   A dict with regression details.
     */
    let worst_regression = 0.0;
    let worst_task = '';
    const regressed_tasks: string[] = [];

    // Compare each task's score
    const all_tasks = new Set([
      ...Object.keys(baseline.scores),
      ...Object.keys(candidate.scores),
    ]);
    for (const task_id of [...all_tasks].sort()) {
      const baseline_score = baseline.scores[task_id]?.score ?? 0.0;
      const candidate_score = candidate.scores[task_id]?.score ?? 0.0;

      const delta = candidate_score - baseline_score;
      if (delta < 0) {
        const regression_magnitude = Math.abs(delta);
        if (regression_magnitude > worst_regression) {
          worst_regression = regression_magnitude;
          worst_task = task_id;
        }
        if (regression_magnitude > this._no_regression) {
          regressed_tasks.push(task_id);
        }
      }
    }

    return {
      has_regression: regressed_tasks.length > 0,
      regressed_tasks,
      worst_regression,
      worst_task,
      tolerance: this._no_regression,
    };
  }
}
