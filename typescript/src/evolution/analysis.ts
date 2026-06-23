/**
 * Trajectory Analysis — finding patterns in what went wrong.
 *
 * Plain English: After the agent finishes a task, we look at its "diary" (trajectory)
 * to find patterns. Did it get stuck in a loop? Did it waste time on irrelevant
 * searches? Did it make the same mistake multiple times?
 *
 * The analysis produces INSIGHTS — structured observations about failure modes
 * that the evolution strategies can use to propose fixes.
 *
 * Think of this module as the "sports analyst" watching game tape. It doesn't
 * PLAY the game (that's the agent's job) or COACH the team (that's the
 * strategies' job). It just watches the tape and writes up observations like:
 * - "The quarterback threw to the same receiver 5 times in a row" (loop)
 * - "The team spent 80% of the game in their own territory" (inefficiency)
 * - "Three fumbles in the red zone" (error pattern)
 */

import { ToolResult } from '../primitives/events';
import type { Trajectory } from '../primitives/trajectory';

// ---------------------------------------------------------------------------
// Thresholds for pattern detection
// ---------------------------------------------------------------------------

// Plain English: These are the "trip wires" — when a metric crosses one of
// these thresholds, we flag it as an insight.
const MIN_LOOP_LENGTH = 3; // At least 3 identical actions to count as a loop
const LOW_REWARD_THRESHOLD = 0.1; // Average reward below this → quality concern
const HIGH_STEP_COUNT = 15; // More than 15 steps → check for inefficiency
const LOW_EFFICIENCY_RATIO = 0.03; // reward-per-step below this → inefficient

// ---------------------------------------------------------------------------
// Insight — a structured observation about a trajectory
// ---------------------------------------------------------------------------

/**
 * Severity levels for an Insight.
 */
export type InsightSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * A structured observation about a trajectory — a "finding" from the tape review.
 *
 * Plain English: An Insight is like a coach's note after watching game tape.
 * It says:
 * - category: What TYPE of problem is this? (loop, inefficiency, error, etc.)
 * - description: What happened? (plain English summary)
 * - severity: How bad is it? (low → critical)
 * - evidence: What specifically did we see? (step numbers, counts, etc.)
 * - suggested_fix: What should we try? (the evolution strategies use this)
 *
 * Insights are FROZEN (immutable) — they're historical observations that
 * should never be altered after creation.
 *
 * Attributes:
 *   category: The type of pattern detected (loop, inefficiency, error, etc.).
 *   description: Human-readable summary of the finding.
 *   severity: How concerning this is (low, medium, high, critical).
 *   evidence: Specific data supporting this finding.
 *   suggested_fix: A hint for the evolution strategies on how to fix this.
 */
export class Insight {
  readonly category: string;
  readonly description: string;
  readonly severity: InsightSeverity;
  readonly evidence: string;
  readonly suggested_fix: string;

  constructor(options: Partial<Insight> = {}) {
    this.category = options.category ?? '';
    this.description = options.description ?? '';
    this.severity = (options.severity as InsightSeverity) ?? 'low';
    this.evidence = options.evidence ?? '';
    this.suggested_fix = options.suggested_fix ?? '';
  }

  /**
   * Serialize this Insight to a plain dictionary.
   *
   * @returns A dictionary with all Insight fields.
   */
  to_dict(): Record<string, unknown> {
    return {
      category: this.category,
      description: this.description,
      severity: this.severity,
      evidence: this.evidence,
      suggested_fix: this.suggested_fix,
    };
  }

  /**
   * Create an Insight from a plain dictionary.
   *
   * @param d - A dictionary with Insight fields.
   * @returns A new Insight instance.
   */
  static from_dict(d: Record<string, unknown>): Insight {
    return new Insight({
      category: (d['category'] as string) ?? '',
      description: (d['description'] as string) ?? '',
      severity: (d['severity'] as InsightSeverity) ?? 'low',
      evidence: (d['evidence'] as string) ?? '',
      suggested_fix: (d['suggested_fix'] as string) ?? '',
    });
  }
}

// ---------------------------------------------------------------------------
// analyze_trajectory — static analysis of a trajectory
// ---------------------------------------------------------------------------

/**
 * Analyze a trajectory and produce a list of Insights.
 *
 * Plain English: This is the "game tape review." We watch the agent's
 * execution step by step and look for patterns:
 *
 * 1. LOOP DETECTION: Did the agent repeat the same action 3+ times?
 *    Like a broken record — if you hear the same verse 5 times,
 *    something's wrong.
 *
 * 2. QUALITY CHECK: Are the rewards consistently low?
 *    If every step scores near zero, the agent isn't making progress.
 *
 * 3. ERROR DETECTION: Did tools fail repeatedly?
 *    Like a mechanic whose wrench keeps slipping — eventually you need
 *    a different tool or technique.
 *
 * 4. INEFFICIENCY CHECK: Are there too many steps for too little reward?
 *    Like writing a 10-page essay when a paragraph would do.
 *
 * @param trajectory - The Trajectory to analyze.
 * @returns A list of Insights describing patterns found. Empty list means
 *          the trajectory looks healthy.
 */
export function analyze_trajectory(trajectory: Trajectory): Insight[] {
  if (!trajectory || trajectory.length === 0) {
    return [];
  }

  const insights: Insight[] = [];

  // --- Loop detection: find repeated identical actions ---
  insights.push(..._detect_loops(trajectory));

  // --- Error detection: find tool failures ---
  insights.push(..._detect_errors(trajectory));

  // --- Quality check: are rewards consistently low? ---
  insights.push(..._detect_quality_issues(trajectory));

  // --- Inefficiency: too many steps for too little reward ---
  insights.push(..._detect_inefficiency(trajectory));

  return insights;
}

// ---------------------------------------------------------------------------
// Internal detection helpers
// ---------------------------------------------------------------------------

function _detect_loops(trajectory: Trajectory): Insight[] {
  /**
   * Detect repeated identical actions in the trajectory.
   *
   * Plain English: We look for the agent doing the exact same thing
   * multiple times in a row. Like someone trying the same door handle
   * over and over — if it didn't open the first 3 times, try something
   * different!
   *
   * @returns A list of loop-related Insights (may be empty).
   */
  const insights: Insight[] = [];

  // Extract action content from each step
  const actions: string[] = [];
  for (const step of trajectory) {
    actions.push(step.action?.content ?? '');
  }

  // Find the longest run of identical consecutive actions
  if (actions.length < MIN_LOOP_LENGTH) {
    return insights;
  }

  // Use a sliding window to find repeated runs
  // We look for the most egregious loop — the longest run
  let max_run_length = 1;
  let max_run_action = '';
  let current_run_length = 1;
  let current_run_action = actions[0];

  for (let i = 1; i < actions.length; i++) {
    if (actions[i] === current_run_action && actions[i] !== '') {
      current_run_length++;
    } else {
      if (current_run_length > max_run_length) {
        max_run_length = current_run_length;
        max_run_action = current_run_action;
      }
      current_run_action = actions[i];
      current_run_length = 1;
    }
  }

  // Check the final run
  if (current_run_length > max_run_length) {
    max_run_length = current_run_length;
    max_run_action = current_run_action;
  }

  if (max_run_length >= MIN_LOOP_LENGTH) {
    // Determine severity based on loop length
    const severity: InsightSeverity = max_run_length >= 7 ? 'high' : 'medium';

    insights.push(
      new Insight({
        category: 'loop',
        description: `Agent repeated the same action ${max_run_length} times consecutively. This suggests the agent is stuck and unable to make progress.`,
        severity,
        evidence: `Action '${max_run_action.slice(0, 80)}' repeated ${max_run_length} times in a row.`,
        suggested_fix:
          'Add a deduplication check that detects repeated actions and forces ' +
          'the agent to try a different approach after 2 identical attempts.',
      })
    );
  }

  return insights;
}

function _detect_errors(trajectory: Trajectory): Insight[] {
  /**
   * Detect tool errors in the trajectory.
   *
   * Plain English: We count how many tool calls ended in failure.
   * A few errors are normal (file not found, network hiccup), but
   * a pattern of errors means the agent is using the wrong tools
   * or approaching the problem incorrectly.
   *
   * @returns A list of error-related Insights (may be empty).
   */
  let total_observations = 0;
  let error_observations = 0;

  for (const step of trajectory) {
    for (const obs of step.observations) {
      // Count all tool results
      if (obs instanceof ToolResult) {
        total_observations++;
        if (obs.error !== null) {
          error_observations++;
        }
      }
    }
  }

  if (error_observations === 0) {
    return [];
  }

  // Calculate error rate
  const error_rate = total_observations > 0 ? error_observations / total_observations : 0;

  let severity: InsightSeverity;
  if (error_rate > 0.5) {
    severity = 'critical';
  } else if (error_rate > 0.3) {
    severity = 'high';
  } else {
    severity = 'medium';
  }

  return [
    new Insight({
      category: 'error',
      description: `Agent encountered ${error_observations} tool errors out of ${total_observations} tool calls (${(error_rate * 100).toFixed(0)}% error rate).`,
      severity,
      evidence: `${error_observations}/${total_observations} tool calls returned errors.`,
      suggested_fix:
        'Add retry logic for transient errors, and add validation before ' +
        'tool calls to catch predictable failures.',
    }),
  ];
}

function _detect_quality_issues(trajectory: Trajectory): Insight[] {
  /**
   * Detect consistently low reward (poor quality).
   *
   * Plain English: We check if the agent is actually making progress.
   * If every step scores near zero, the agent is just spinning its wheels —
   * doing things without getting results. Like studying for a test but
   * never actually learning anything.
   *
   * @returns A list of quality-related Insights (may be empty).
   */
  if (trajectory.length === 0) {
    return [];
  }

  const total_reward = trajectory.total_reward;
  const avg_reward = total_reward / trajectory.length;

  if (avg_reward >= LOW_REWARD_THRESHOLD) {
    return [];
  }

  // Determine severity based on how low the reward is
  const severity: InsightSeverity = avg_reward <= 0.0 ? 'high' : 'medium';

  return [
    new Insight({
      category: 'quality',
      description: `Average reward per step is ${avg_reward.toFixed(3)}, which is below the threshold of ${LOW_REWARD_THRESHOLD}. The agent is not making meaningful progress.`,
      severity,
      evidence: `Total reward: ${total_reward.toFixed(3)} over ${trajectory.length} steps (avg: ${avg_reward.toFixed(3)}).`,
      suggested_fix:
        'Review the task decomposition — the task may be too complex ' +
        'for the current agent capabilities, or the reward signal may ' +
        'be too sparse.',
    }),
  ];
}

function _detect_inefficiency(trajectory: Trajectory): Insight[] {
  /**
   * Detect excessive steps relative to reward (inefficiency).
   *
   * Plain English: We check if the agent is working hard but not smart.
   * A high step count with low reward means the agent is taking the long
   * way around — like writing a 10-page report when a paragraph would do.
   *
   * @returns A list of inefficiency-related Insights (may be empty).
   */
  const step_count = trajectory.length;
  const total_reward = trajectory.total_reward;

  if (step_count <= HIGH_STEP_COUNT) {
    return [];
  }

  // Efficiency ratio: reward per step
  const efficiency = step_count > 0 ? total_reward / step_count : 0;

  if (efficiency >= LOW_EFFICIENCY_RATIO) {
    return [];
  }

  return [
    new Insight({
      category: 'inefficiency',
      description: `Agent used ${step_count} steps but achieved low reward (efficiency ratio: ${efficiency.toFixed(4)}). This suggests the agent is working hard but not smart.`,
      severity: 'medium',
      evidence: `${step_count} steps, total reward ${total_reward.toFixed(3)}, efficiency ${efficiency.toFixed(4)}.`,
      suggested_fix:
        'Add step pruning or early stopping — if the agent isn\'t making ' +
        'progress after N steps, try a completely different approach.',
    }),
  ];
}

// ---------------------------------------------------------------------------
// summarize_trajectory — produce a human-readable summary dict
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable summary of a trajectory.
 *
 * Plain English: This is the "box score" — a quick overview of how the
 * agent did. It includes the basics (steps, reward) plus some derived
 * metrics (error count, action variety) that help you quickly assess
 * performance without reading the full trajectory.
 *
 * @param trajectory - The Trajectory to summarize.
 * @returns A dict with summary statistics:
 *   - task_id: Which task this was
 *   - total_steps: How many steps the agent took
 *   - total_reward: Sum of all step rewards
 *   - avg_reward: Average reward per step
 *   - error_count: Number of tool calls that resulted in errors
 *   - unique_actions: Number of distinct action contents
 */
export function summarize_trajectory(trajectory: Trajectory): Record<string, unknown> {
  // Count tool errors across all steps
  let error_count = 0;
  for (const step of trajectory) {
    for (const obs of step.observations) {
      if (obs instanceof ToolResult && obs.error !== null) {
        error_count++;
      }
    }
  }

  // Count unique actions (non-empty action contents)
  const action_contents = new Set<string>();
  for (const step of trajectory) {
    const content = step.action?.content;
    if (content) {
      action_contents.add(content);
    }
  }

  const total_steps = trajectory.length;
  const total_reward = trajectory.total_reward;

  return {
    task_id: trajectory.task_id,
    total_steps,
    total_reward,
    avg_reward: total_steps > 0 ? total_reward / total_steps : 0.0,
    error_count,
    unique_actions: action_contents.size,
  };
}
