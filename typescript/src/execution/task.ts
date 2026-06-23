/**
 * A Task defines WHAT the agent should accomplish.
 *
 * Plain English: A Task is like a homework assignment. It has:
 * - prompt: The question or problem to solve
 * - max_steps: How many attempts you get
 * - budget: How many resources (tokens, money) you can spend
 * - is_done(): A way to check if you're finished
 * - evaluate(): A way to grade your work
 *
 * SimpleTask is the basic implementation. You give it a prompt and
 * optionally an evaluation function, and it handles the rest.
 *
 * BatchTask wraps multiple tasks for benchmark runs — like running
 * a full exam instead of a single question.
 */

import { EvalResult } from '../primitives/events';
import { Budget } from '../primitives/state';
import type { State } from '../primitives/state';
import type { Trajectory } from '../primitives/trajectory';

/**
 * Task Protocol — the interface all tasks must satisfy.
 *
 * A Task is the "assignment" that the agent works on. It tells the agent:
 * - What to do (prompt)
 * - How long it has (max_steps, budget)
 * - When it's done (is_done)
 * - How well it did (evaluate)
 *
 * Think of Task as a teacher handing out a worksheet:
 * - prompt: the instructions at the top
 * - max_steps: how many questions you can attempt
 * - budget: how much paper/pencil you can use
 * - is_done(): "Have you answered all the questions?"
 * - evaluate(): "Let me grade your work"
 */
export interface Task {
  /** The instructions or problem statement for this task. */
  readonly prompt: string;

  /** Maximum number of reasoning steps allowed. */
  readonly max_steps: number;

  /** Resource limits (tokens, cost) for this task. */
  readonly budget: Budget;

  /**
   * Check if the task is complete given the current state.
   *
   * Args:
   *   state: The current agent state.
   *
   * Returns:
   *   True if the task is complete, False otherwise.
   */
  is_done(state: State): boolean;

  /**
   * Grade the agent's work on this task.
   *
   * Args:
   *   trajectory: The full execution history.
   *
   * Returns:
   *   An EvalResult with score, pass/fail, and explanation.
   */
  evaluate(trajectory: Trajectory): Promise<EvalResult>;
}

/**
 * A function that checks if a task is done given the current state.
 */
export type DoneCondition = (state: State) => boolean;

/**
 * An async function that evaluates a trajectory against a task.
 */
export type EvalFunction = (trajectory: Trajectory, task: Task) => Promise<EvalResult>;

/**
 * A concrete task implementation with configurable behavior.
 *
 * Plain English: SimpleTask is the "fill in the blanks" version of a task.
 * You provide:
 * - prompt: What to do (required)
 * - max_steps: How many tries (default: 50)
 * - budget: Resource limits (default: generous)
 * - done_condition: Custom function to check completion (optional)
 * - eval_fn: Custom function to grade work (optional)
 *
 * If you don't provide done_condition, the task is never "done" —
 * the agent runs until max_steps or budget is exhausted.
 *
 * If you don't provide eval_fn, the evaluation returns a score of 0.0
 * (use this for tasks where you only care about completion, not quality).
 *
 * Attributes:
 *   prompt: The task description or problem statement.
 *   max_steps: Maximum reasoning steps allowed.
 *   budget: Resource limits for this task.
 *   done_condition: Optional custom completion checker.
 *   eval_fn: Optional custom evaluation function.
 */
export class SimpleTask implements Task {
  prompt: string;
  max_steps: number;
  budget: Budget;
  done_condition: DoneCondition | null;
  eval_fn: EvalFunction | null;

  constructor(options: {
    prompt?: string;
    max_steps?: number;
    budget?: Budget;
    done_condition?: DoneCondition;
    eval_fn?: EvalFunction;
  } = {}) {
    this.prompt = options.prompt ?? '';
    this.max_steps = options.max_steps ?? 50;
    this.budget = options.budget ?? new Budget();
    this.done_condition = options.done_condition ?? null;
    this.eval_fn = options.eval_fn ?? null;
  }

  /**
   * Check if the task is complete.
   *
   * Delegates to the custom done_condition if provided.
   * Otherwise, always returns False (task runs until budget/steps exhausted).
   *
   * Plain English: "Am I finished with this assignment?"
   * - If the teacher gave specific completion criteria, use those.
   * - Otherwise, keep working until time runs out.
   *
   * Args:
   *   state: The current agent state.
   *
   * Returns:
   *   True if the task is complete, False otherwise.
   */
  is_done(state: State): boolean {
    if (this.done_condition !== null) {
      return this.done_condition(state);
    }
    return false;
  }

  /**
   * Grade the agent's work on this task.
   *
   * Delegates to the custom eval_fn if provided.
   * Otherwise, returns a default EvalResult with score 0.0.
   *
   * Plain English: "How well did the student do?"
   * - If there's a grading rubric (eval_fn), use it.
   * - Otherwise, give a default score (0.0 = no grade).
   *
   * Args:
   *   trajectory: The full execution history.
   *
   * Returns:
   *   An EvalResult with score, pass/fail, and explanation.
   */
  async evaluate(trajectory: Trajectory): Promise<EvalResult> {
    if (this.eval_fn !== null) {
      const result = await this.eval_fn(trajectory, this);
      return result;
    }
    return new EvalResult({ passed: false, score: 0.0, reason: 'No evaluation function provided' });
  }
}

/**
 * A container that wraps multiple tasks for benchmark execution.
 *
 * Plain English: If a SimpleTask is one exam question, a BatchTask
 * is the entire exam. It holds a list of tasks that should all be
 * run as part of a benchmark.
 *
 * BatchTask itself is iterable — you can loop over its tasks to
 * run them one at a time, or hand the whole batch to a benchmark
 * runner that handles parallelism.
 *
 * BatchTask also provides prompt, max_steps, and budget by delegating
 * to the first task in the list (useful for inspection).
 *
 * Attributes:
 *   tasks: The list of tasks in this batch.
 */
export class BatchTask implements Task {
  tasks: Task[];

  constructor(options: { tasks?: Task[] } = {}) {
    this.tasks = options.tasks ? [...options.tasks] : [];
  }

  /** The prompt of the first task (for quick inspection). */
  get prompt(): string {
    return this.tasks.length > 0 ? this.tasks[0].prompt : '';
  }

  /** The max_steps of the first task (for quick inspection). */
  get max_steps(): number {
    return this.tasks.length > 0 ? this.tasks[0].max_steps : 0;
  }

  /** The budget of the first task (for quick inspection). */
  get budget(): Budget {
    return this.tasks.length > 0 ? this.tasks[0].budget : new Budget();
  }

  /**
   * Check if the first task is complete.
   *
   * Delegates to the first task's is_done method.
   */
  is_done(state: State): boolean {
    if (this.tasks.length === 0) {
      return false;
    }
    return this.tasks[0].is_done(state);
  }

  /**
   * Grade the first task's work.
   *
   * Delegates to the first task's evaluate method.
   */
  async evaluate(trajectory: Trajectory): Promise<EvalResult> {
    if (this.tasks.length === 0) {
      return new EvalResult({ passed: false, score: 0.0, reason: 'BatchTask is empty' });
    }
    return this.tasks[0].evaluate(trajectory);
  }

  /** Return the number of tasks in the batch. */
  get length(): number {
    return this.tasks.length;
  }

  /** Iterate over tasks in order. */
  *[Symbol.iterator](): Iterator<Task> {
    yield* this.tasks;
  }

  /**
   * Get a task by index (supports negative indexing).
   *
   * Args:
   *   index: The task index to retrieve.
   *
   * Returns:
   *   The Task at the given index.
   */
  at(index: number): Task {
    if (index < 0) {
      return this.tasks[this.tasks.length + index];
    }
    return this.tasks[index];
  }
}
