/**
 * Judges evaluate how well the agent performed on a task.
 *
 * Plain English: A Judge is like a teacher grading an exam. Different judges
 * specialize in different aspects:
 * - TestSuiteJudge: Runs the actual tests (like pytest) and counts passes
 * - LLMJudge: Asks another AI to evaluate the quality of the work
 * - MetricJudge: Checks specific measurable criteria (speed, accuracy, etc.)
 * - CompositeJudge: Combines multiple judges with weights (like a panel)
 *
 * Each judge produces an EvalResult with a score (0.0 to 1.0) and explanation.
 */

import { EvalResult, Message, MessageType } from '../primitives/events';
import type { Trajectory } from '../primitives/trajectory';
import type { Sandbox } from '../execution/sandbox';
import type { ModelProvider } from '../execution/runloop';
import type { Metric } from './metrics';


// ---------------------------------------------------------------------------
// Minimal stubs for Task and Sandbox (execution layer may not exist yet)
// ---------------------------------------------------------------------------


/** Minimal Task protocol for evaluation. */
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


function isTaskLike(value: unknown): value is TaskLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    'prompt' in value &&
    typeof (value as { prompt?: unknown }).prompt === 'string' &&
    'max_steps' in value &&
    typeof (value as { max_steps?: unknown }).max_steps === 'number' &&
    'is_done' in value &&
    typeof (value as { is_done?: unknown }).is_done === 'function'
  );
}


// ---------------------------------------------------------------------------
// Judge — the core evaluation protocol
// ---------------------------------------------------------------------------


/**
 * Protocol defining what a judge must provide.
 *
 * A Judge is any object that can evaluate a trajectory against a task
 * and produce an EvalResult (score + explanation).
 *
 * Think of a Judge as a teacher grading homework:
 * - trajectory: The student's complete work (every step they took)
 * - task: The assignment (what they were supposed to do)
 * - EvalResult: The grade (score, pass/fail, explanation)
 *
 * Real-world analogy: Different teachers specialize in different subjects.
 * A math teacher checks calculations, an English teacher checks grammar.
 * Similarly, different judges evaluate different aspects of agent performance.
 */
export interface Judge {
  /** A human-readable name for this judge. */
  readonly name: string;

  /**
   * Evaluate a trajectory against a task and produce a score.
   *
   * @param trajectory - The agent's full execution record.
   * @param task - The task that was being attempted.
   * @returns An EvalResult with score (0.0-1.0), pass/fail, and explanation.
   */
  evaluate(trajectory: Trajectory, task: unknown): Promise<EvalResult>;
}


// ---------------------------------------------------------------------------
// TestSuiteJudge — runs test commands and checks pass rate
// ---------------------------------------------------------------------------


/**
 * Runs a test command in the sandbox and computes pass rate as score.
 *
 * Plain English: This judge is like running `pytest` and counting how many
 * tests passed vs failed. It's the most "objective" judge — either the
 * tests pass or they don't. No opinions, just facts.
 *
 * The score is: passed / (passed + failed)
 * - All pass → 1.0
 * - All fail → 0.0
 * - 8 pass, 2 fail → 0.8
 *
 * It parses pytest-style output like:
 * - "10 passed in 0.5s"
 * - "8 passed, 2 failed in 1.0s"
 * - "5 failed in 0.2s"
 *
 * Attributes:
 *   test_command: The command to run (e.g., "pytest", "pytest tests/").
 *   sandbox: The sandbox to execute the command in.
 */
export class TestSuiteJudge implements Judge {
  private readonly _test_command: string;
  private readonly _sandbox: Sandbox;

  /**
   * Initialize the TestSuiteJudge.
   *
   * @param test_command - Shell command to run the test suite.
   * @param sandbox - A Sandbox instance to execute the command in.
   */
  constructor(test_command: string, sandbox: Sandbox) {
    this._test_command = test_command;
    this._sandbox = sandbox;
  }

  /** This judge's name: 'test_suite'. */
  get name(): string {
    return 'test_suite';
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
   * Parse pytest-style output to extract passed and failed counts.
   *
   * Real-world analogy: Like reading a report card that says
   * "8 out of 10 tests passed". We extract the numbers.
   *
   * @param stdout - Standard output from the test command.
   * @param stderr - Standard error from the test command.
   * @returns A tuple of (passed_count, failed_count).
   */
  static parse_pytest_output(stdout: string, stderr: string): [number, number] {
    const combined = `${stdout}\n${stderr}`;
    let passed = 0;
    let failed = 0;

    // Match "N passed" (with optional comma/space before)
    const passed_match = combined.match(/(\d+)\s+passed/);
    if (passed_match) {
      passed = parseInt(passed_match[1], 10);
    }

    // Match "N failed" (with optional comma/space before)
    const failed_match = combined.match(/(\d+)\s+failed/);
    if (failed_match) {
      failed = parseInt(failed_match[1], 10);
    }

    return [passed, failed];
  }

  /**
   * Run the test command and compute the pass rate.
   *
   * Steps:
   * 1. Execute the test command in the sandbox
   * 2. Parse the output for passed/failed counts
   * 3. Compute score = passed / (passed + failed)
   * 4. Return an EvalResult with the score and explanation
   *
   * @param trajectory - The agent's execution record (not used by this judge,
   *                     but required by the Judge protocol).
   * @param task - The task being evaluated (not used by this judge).
   * @returns An EvalResult with the test pass rate as score.
   */
  async evaluate(trajectory: Trajectory, task: unknown): Promise<EvalResult> {
    const [stdout, stderr, _exit_code] = await this._sandbox.exec(this._test_command);

    const [passed, failed] = TestSuiteJudge.parse_pytest_output(stdout, stderr);
    const total = passed + failed;

    if (total === 0) {
      // No tests found — score is 0
      return new EvalResult({
        passed: false,
        score: 0.0,
        reason: `No tests found. Output: ${stdout.trim() || stderr.trim() || '(empty)'}`,
      });
    }

    const score = passed / total;
    const all_passed = failed === 0;

    const reason = `${passed} passed, ${failed} failed out of ${total} tests`;
    return new EvalResult({
      passed: all_passed,
      score,
      reason,
    });
  }
}


// ---------------------------------------------------------------------------
// LLMJudge — uses an LLM to evaluate quality
// ---------------------------------------------------------------------------


/**
 * Uses an LLM to evaluate the quality of agent work.
 *
 * Plain English: This judge is like asking a second expert to review
 * the work. You give them a rubric (what to look for) and the agent's
 * trajectory (what they did), and the LLM produces a score.
 *
 * The LLM is asked to return a score in the format "Score: X.XX"
 * where X.XX is a float between 0.0 and 1.0.
 *
 * Attributes:
 *   model: The LLM provider with a complete() method.
 *   rubric: The evaluation criteria (what the LLM should look for).
 *   pass_threshold: Minimum score to consider the evaluation as "passed".
 */
export class LLMJudge implements Judge {
  private readonly _model: ModelProvider;
  private readonly _rubric: string;
  private readonly _pass_threshold: number;

  /**
   * Initialize the LLMJudge.
   *
   * @param model - An LLM provider with a complete(messages, tools) method.
   * @param rubric - Evaluation criteria describing what to assess.
   * @param pass_threshold - Score at or above which the evaluation passes.
   */
  constructor(model: ModelProvider, rubric: string, pass_threshold: number = 0.5) {
    this._model = model;
    this._rubric = rubric;
    this._pass_threshold = pass_threshold;
  }

  /** This judge's name: 'llm_judge'. */
  get name(): string {
    return 'llm_judge';
  }

  /** The LLM provider used for evaluation. */
  get model(): ModelProvider {
    return this._model;
  }

  /** The evaluation rubric. */
  get rubric(): string {
    return this._rubric;
  }

  /**
   * Extract a numeric score from LLM response text.
   *
   * Looks for patterns like:
   * - "Score: 0.85"
   * - "score: 0.85"
   * - "SCORE: 0.85"
   * - "Score: 1.0"
   * - "Score: 0.0"
   *
   * If multiple matches exist, returns the last one (the final verdict).
   *
   * @param text - The LLM's response text.
   * @returns The extracted score as a float, clamped to [0.0, 1.0].
   * @throws Error - If no score can be extracted.
   */
  static extract_score(text: string): number {
    const matches = [...text.matchAll(/[Ss]core:\s*(\d+\.?\d*)/g)].map((m) => m[1]);
    if (matches.length === 0) {
      throw new Error(
        `Could not extract score from LLM response. ` +
        `Expected format 'Score: X.XX'. Response: ${text}`,
      );
    }
    const raw_score = parseFloat(matches[matches.length - 1]);
    // Clamp to [0.0, 1.0]
    return Math.max(0.0, Math.min(1.0, raw_score));
  }

  /**
   * Build the evaluation prompt to send to the LLM.
   *
   * Constructs a conversation with a system message (the rubric) and a
   * user message (the task and trajectory summary).
   *
   * @param trajectory - The agent's execution record.
   * @param task - The task being evaluated.
   * @returns A list of Message objects to send to the model.
   */
  build_prompt(trajectory: Trajectory, task: unknown): Message[] {
    if (!isTaskLike(task)) {
      throw new TypeError('task must be TaskLike for LLMJudge.build_prompt');
    }
    const task_like = task;

    // Summarize the trajectory into a readable format
    const step_summaries: string[] = [];
    for (let i = 0; i < trajectory.steps.length; i++) {
      const step = trajectory.steps[i];
      const action_text = step.action?.content ?? '(no action)';
      step_summaries.push(`Step ${i}: ${action_text}`);
    }

    const trajectory_text = step_summaries.length > 0
      ? step_summaries.join('\n')
      : '(no steps taken)';

    const system_msg = new Message({
      role: MessageType.SYSTEM,
      content: (
        `You are an evaluation judge. ${this._rubric}\n\n` +
        `Respond with your analysis and end with 'Score: X.XX' ` +
        `where X.XX is a number between 0.0 and 1.0.`
      ),
    });
    const user_msg = new Message({
      role: MessageType.USER,
      content: (
        `Task: ${task_like.prompt}\n\n` +
        `Agent trajectory:\n${trajectory_text}`
      ),
    });
    return [system_msg, user_msg];
  }

  /**
   * Ask the LLM to evaluate the trajectory and extract a score.
   *
   * Steps:
   * 1. Build an evaluation prompt from the rubric + trajectory + task
   * 2. Send the prompt to the LLM
   * 3. Parse the response for a "Score: X.XX" pattern
   * 4. Return an EvalResult with the parsed score
   *
   * @param trajectory - The agent's execution record.
   * @param task - The task being evaluated.
   * @returns An EvalResult with the LLM's score and explanation.
   */
  async evaluate(trajectory: Trajectory, task: unknown): Promise<EvalResult> {
    const messages = this.build_prompt(trajectory, task);
    const response = await this._model.complete(messages);

    const response_text = typeof response === 'object' && response !== null && 'content' in response
      ? String((response as { content: unknown }).content)
      : String(response);

    let score: number;
    try {
      score = LLMJudge.extract_score(response_text);
    } catch {
      return new EvalResult({
        passed: false,
        score: 0.0,
        reason: `LLM judge could not extract score. Response: ${response_text}`,
      });
    }

    const passed = score >= this._pass_threshold;
    return new EvalResult({
      passed,
      score,
      reason: response_text,
    });
  }
}


// ---------------------------------------------------------------------------
// Metric protocol stub (metrics.py may not exist yet)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// MetricJudge — evaluates using a list of Metric objects
// ---------------------------------------------------------------------------


/**
 * Evaluates a trajectory against a list of Metric objects.
 *
 * Plain English: This judge is like a rubric with multiple criteria.
 * Each Metric measures one specific aspect (speed, quality, correctness),
 * and the final score is the average of all metric scores.
 *
 * Think of it as a teacher grading an essay with a rubric:
 * - Grammar: 0.9
 * - Structure: 0.8
 * - Content: 0.7
 * - Final score: (0.9 + 0.8 + 0.7) / 3 = 0.8
 *
 * Attributes:
 *   metrics: The list of Metric objects to evaluate against.
 */
export class MetricJudge implements Judge {
  private readonly _metrics: Metric[];

  /**
   * Initialize the MetricJudge.
   *
   * @param metrics - A list of Metric objects (each with name and evaluate).
   */
  constructor(metrics: Metric[]) {
    this._metrics = [...metrics];
  }

  /** This judge's name: 'metric_judge'. */
  get name(): string {
    return 'metric_judge';
  }

  /** The list of metrics being evaluated. */
  get metrics(): Metric[] {
    return [...this._metrics];
  }

  /**
   * Run all metrics and compute the average score.
   *
   * Steps:
   * 1. Run each metric's evaluate() method
   * 2. Collect all scores
   * 3. Compute the average
   * 4. Build a reason string showing each metric's score
   *
   * @param trajectory - The agent's execution record.
   * @param task - The task being evaluated.
   * @returns An EvalResult with the average metric score.
   */
  async evaluate(trajectory: Trajectory, task: unknown): Promise<EvalResult> {
    if (this._metrics.length === 0) {
      return new EvalResult({
        passed: false,
        score: 0.0,
        reason: 'No metrics configured.',
      });
    }

    const scores: Record<string, number> = {};
    for (const metric of this._metrics) {
      const score = await metric.evaluate(trajectory, task);
      scores[metric.name] = score;
    }

    const avg_score = Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length;
    const reason_parts = Object.entries(scores).map(([name, score]) => `${name}: ${score.toFixed(2)}`);
    const reason = `Metric scores — ${reason_parts.join(', ')} (avg: ${avg_score.toFixed(2)})`;

    return new EvalResult({
      passed: avg_score >= 0.5,
      score: avg_score,
      reason,
    });
  }
}


// ---------------------------------------------------------------------------
// CompositeJudge — weighted average of multiple judges
// ---------------------------------------------------------------------------


/**
 * Combines multiple judges with weights into a single score.
 *
 * Plain English: This judge is like a panel of experts voting.
 * Each expert (judge) gives their score, but some experts' opinions
 * count more than others (weights). The final score is the weighted
 * average.
 *
 * For example:
 * - Automated tests (weight 0.6): score = 1.0
 * - LLM review (weight 0.4): score = 0.5
 * - Final score: 1.0 * 0.6 + 0.5 * 0.4 = 0.8
 *
 * Weights don't need to sum to 1.0 — they're normalized internally.
 * But it's good practice to have them sum to 1.0 for readability.
 *
 * Attributes:
 *   judges: List of (judge, weight) tuples.
 */
export class CompositeJudge implements Judge {
  private readonly _judges: [Judge, number][];

  /**
   * Initialize the CompositeJudge.
   *
   * @param judges - A list of (Judge, weight) tuples. Weight is a float
   *                 indicating how much this judge's score matters.
   */
  constructor(judges: [Judge, number][]) {
    this._judges = [...judges];
  }

  /** This judge's name: 'composite'. */
  get name(): string {
    return 'composite';
  }

  /** The list of (judge, weight) tuples. */
  get judges(): [Judge, number][] {
    return [...this._judges];
  }

  /**
   * Run all sub-judges and compute the weighted average score.
   *
   * Steps:
   * 1. Run each judge's evaluate() method
   * 2. Multiply each score by its weight
   * 3. Sum the weighted scores
   * 4. Normalize by total weight
   * 5. Build a reason string with all sub-results
   *
   * @param trajectory - The agent's execution record.
   * @param task - The task being evaluated.
   * @returns An EvalResult with the weighted average score.
   */
  async evaluate(trajectory: Trajectory, task: unknown): Promise<EvalResult> {
    if (this._judges.length === 0) {
      return new EvalResult({
        passed: false,
        score: 0.0,
        reason: 'No judges configured.',
      });
    }

    const sub_results: [string, number, number][] = [];
    let total_weight = 0.0;
    let weighted_sum = 0.0;

    for (const [judge, weight] of this._judges) {
      const result = await judge.evaluate(trajectory, task);
      sub_results.push([judge.name, weight, result.score]);
      weighted_sum += result.score * weight;
      total_weight += weight;
    }

    if (total_weight === 0) {
      return new EvalResult({
        passed: false,
        score: 0.0,
        reason: 'Total weight is zero.',
      });
    }

    const final_score = weighted_sum / total_weight;

    // Build detailed reason
    const reason_parts: string[] = [];
    for (const [name, weight, score] of sub_results) {
      reason_parts.push(`${name}(${weight.toFixed(1)}): ${score.toFixed(2)}`);
    }
    const reason = `Composite — ${reason_parts.join(', ')} → ${final_score.toFixed(2)}`;

    return new EvalResult({
      passed: final_score >= 0.5,
      score: final_score,
      reason,
    });
  }
}
