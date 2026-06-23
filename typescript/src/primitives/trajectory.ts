/**
 * The Trajectory module records the agent's full "life story" during a task.
 *
 * Plain English: A Trajectory is like a diary. Each entry (TrajectoryStep) records:
 * - What the situation was before acting (state_before)
 * - What the agent decided to do (action)
 * - What happened as a result (observations)
 * - How well it did (reward)
 * - What changed (delta)
 *
 * The Trajectory is a FIRST-CLASS OUTPUT — not just a log side-product.
 * It can be:
 * - Saved to JSONL for analysis
 * - Converted to SFT training records (supervised fine-tuning)
 * - Converted to RL training records (reinforcement learning)
 * - Compared across runs to measure improvement
 *
 * Think of it as the "black box flight recorder" — after a crash (or success),
 * you can replay exactly what happened, step by step.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Event, Message, ToolResult } from './events';
import { StateDelta, StateSnapshot } from './state';

/**
 * One step in the agent's trajectory — a single "diary entry".
 *
 * Each step captures a complete snapshot of what happened during one
 * think-act cycle:
 * - state_before: What the world looked like before acting (frozen snapshot)
 * - action: What the agent decided to do (a Message, typically assistant response)
 * - observations: What came back from tool calls (tuple of ToolResults)
 * - reward: How good this step was (0.0 = neutral, positive = good, negative = bad)
 * - delta: What changed in the state as a result of this step
 * - metadata: Any extra info (attempt number, model used, latency, etc.)
 *
 * Frozen (immutable) because once a step is recorded, it should never change.
 * This is a historical record — you can't rewrite history.
 *
 * Attributes:
 *   state_before: Snapshot of State before this step's action.
 *   action: The agent's action (typically an assistant Message).
 *   observations: Results from tool calls made during this step.
 *   reward: Scalar reward signal (for RL training).
 *   delta: What changed in the state during this step.
 *   metadata: Arbitrary extra data about this step.
 */
export class TrajectoryStep {
  readonly state_before: StateSnapshot;
  readonly action: Message | null;
  readonly observations: readonly Event[];
  readonly reward: number;
  readonly delta: StateDelta;
  readonly metadata: Record<string, unknown>;

  constructor(options: Partial<TrajectoryStep> = {}) {
    this.state_before = options.state_before ?? new StateSnapshot();
    this.action = options.action ?? null;
    this.observations = options.observations ?? [];
    this.reward = options.reward ?? 0.0;
    this.delta = options.delta ?? new StateDelta();
    this.metadata = options.metadata ?? {};
  }

  /**
   * Serialize this step to a dictionary.
   *
   * Converts the step into a JSON-serializable dict. Events are converted
   * using their own to_dict() methods. The state_before is serialized
   * using its own to_dict() method for JSONL roundtrip support.
   */
  to_dict(): Record<string, unknown> {
    return {
      state_before: this.state_before.to_dict(),
      action: this.action?.to_dict() ?? null,
      observations: this.observations.map((obs) => obs.to_dict()),
      reward: this.reward,
      delta: {
        created_slots: [...this.delta.created_slots],
        updated_slots: [...this.delta.updated_slots],
        deleted_slots: [...this.delta.deleted_slots],
        messages_added: this.delta.messages_added,
        step_delta: this.delta.step_delta,
        budget_delta: { ...this.delta.budget_delta },
      },
      metadata: { ...this.metadata },
    };
  }
}

/**
 * The complete record of an agent's execution during a task.
 *
 * A Trajectory is an ordered collection of TrajectorySteps — one per
 * think-act cycle. It's the agent's "flight recorder" or "diary".
 *
 * Trajectories are FIRST-CLASS OUTPUTS, not just logging artifacts.
 * They can be saved, analyzed, compared, and used for training.
 *
 * Unlike TrajectoryStep, Trajectory is MUTABLE — you add steps as
 * the execution progresses.
 *
 * Attributes:
 *   steps: The ordered list of trajectory steps.
 *   task_id: Which task this trajectory belongs to.
 *   metadata: Extra info about the trajectory (task description, config, etc.).
 */
export class Trajectory {
  steps: TrajectoryStep[];
  task_id: string;
  metadata: Record<string, unknown>;

  constructor(options: Partial<Trajectory> = {}) {
    this.steps = options.steps ?? [];
    this.task_id = options.task_id ?? '';
    this.metadata = options.metadata ?? {};
  }

  // ---- Collection operations ----

  /**
   * Append a step to the trajectory.
   *
   * This is the primary way to build a trajectory during execution.
   * Steps should be added in chronological order.
   *
   * Args:
   *   step: The TrajectoryStep to append.
   */
  add_step(step: TrajectoryStep): void {
    this.steps.push(step);
  }

  /** The most recent step, or None if the trajectory is empty. */
  get last_step(): TrajectoryStep | null {
    return this.steps.length > 0 ? this.steps[this.steps.length - 1] : null;
  }

  /**
   * Sum of all step rewards — the trajectory's overall score.
   *
   * This is the primary metric for comparing trajectories. A higher
   * total_reward means the agent performed better overall.
   */
  get total_reward(): number {
    return this.steps.reduce((sum, step) => sum + step.reward, 0);
  }

  /** Number of steps in the trajectory. */
  get length(): number {
    return this.steps.length;
  }

  /** Iterate over steps in chronological order. */
  *[Symbol.iterator](): Iterator<TrajectoryStep> {
    yield* this.steps;
  }

  /**
   * Get a step by index (supports negative indexing).
   *
   * Args:
   *   index: The step index to retrieve.
   *
   * Returns:
   *   The TrajectoryStep at the given index.
   */
  at(index: number): TrajectoryStep {
    if (index < 0) {
      return this.steps[this.steps.length + index];
    }
    return this.steps[index];
  }

  // ---- Serialization ----

  /**
   * Serialize the entire trajectory to a dictionary.
   *
   * The first line is metadata (task_id, step count, total reward).
   * Each subsequent line is a serialized step.
   */
  to_dict(): Record<string, unknown> {
    return {
      task_id: this.task_id,
      step_count: this.steps.length,
      total_reward: this.total_reward,
      metadata: { ...this.metadata },
      steps: this.steps.map((step) => step.to_dict()),
    };
  }

  /**
   * Save the trajectory to a JSONL file.
   *
   * JSONL format: one JSON object per line. The first line is the
   * trajectory metadata, and each subsequent line is one step.
   *
   * This format is chosen because:
   * - Streaming: you can read one step at a time without loading everything
   * - Appendable: new steps can be added without rewriting the file
   * - Tooling: standard format for ML training pipelines
   *
   * Args:
   *   path: File path to write to. Parent directory must exist.
   */
  to_jsonl(path: string): void {
    const lines: string[] = [];

    // First line: trajectory metadata
    const meta_line = {
      type: 'trajectory_meta',
      task_id: this.task_id,
      step_count: this.steps.length,
      total_reward: this.total_reward,
      metadata: { ...this.metadata },
    };
    lines.push(JSON.stringify(meta_line));

    // Subsequent lines: one per step
    for (const step of this.steps) {
      const step_data = step.to_dict();
      step_data.type = 'trajectory_step';
      lines.push(JSON.stringify(step_data));
    }

    writeFileSync(path, lines.join('\n') + '\n');
  }

  // ---- Training record stubs ----

  /**
   * Convert trajectory to SFT (supervised fine-tuning) training records.
   *
   * SFT records are input-output pairs where the model learns to reproduce
   * the "correct" assistant response given the conversation history.
   *
   * Each record would look like:
   *     {"messages": [...history...], "completion": "the assistant's response"}
   *
   * Currently a stub — returns empty list. Will be implemented when the
   * training pipeline is ready.
   */
  to_sft_records(): Record<string, unknown>[] {
    return [];
  }

  /**
   * Convert trajectory to RL (reinforcement learning) training records.
   *
   * RL records include the action taken and the reward received, so the
   * model can learn which actions lead to good outcomes.
   *
   * Each record would look like:
   *     {"state": {...}, "action": {...}, "reward": 0.8, "next_state": {...}}
   *
   * Currently a stub — returns empty list. Will be implemented when the
   * training pipeline is ready.
   */
  to_rl_records(): Record<string, unknown>[] {
    return [];
  }
}

/**
 * Load a Trajectory from a JSONL file.
 *
 * This is the inverse of Trajectory.to_jsonl(). It reads the metadata
 * line and all step lines, reconstructing the Trajectory object.
 *
 * Note: The loaded trajectory's steps will have simplified state_before
 * and delta objects (just dicts, not fully reconstructed StateSnapshots).
 * For full fidelity, use the in-memory objects directly.
 *
 * Args:
 *   path: Path to the JSONL file.
 *
 * Returns:
 *   A Trajectory object with the loaded data.
 *
 * Raises:
 *   Error: If the file doesn't exist.
 *   SyntaxError: If the file contains invalid JSON.
 */
export function load_trajectory(path: string): Trajectory {
  if (!existsSync(path)) {
    throw new Error(`Trajectory file not found: ${path}`);
  }

  const text = readFileSync(path, 'utf-8');
  const lines = text.trim().split('\n');
  if (lines.length === 0 || !lines[0].trim()) {
    // Empty file — return empty trajectory
    return new Trajectory({ task_id: 'unknown' });
  }

  // Parse metadata from first line
  const meta = JSON.parse(lines[0]) as Record<string, unknown>;
  const traj = new Trajectory({
    task_id: (meta.task_id as string) ?? '',
    metadata: (meta.metadata as Record<string, unknown>) ?? {},
  });

  // Parse steps from subsequent lines
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    const step_data = JSON.parse(line) as Record<string, unknown>;

    // Reconstruct the action (Message) if present
    let action: Message | null = null;
    const action_data = step_data.action as Record<string, unknown> | null;
    if (action_data !== null && action_data !== undefined) {
      action = new Message({
        role: (action_data.role as 'system' | 'user' | 'assistant' | 'tool') ?? 'assistant',
        content: (action_data.content as string) ?? '',
        run_id: (action_data.run_id as string) ?? '',
        step_id: (action_data.step_id as number) ?? 0,
        ts: (action_data.ts as number) ?? 0.0,
      });
    }

    // Reconstruct observations
    const observations: Event[] = [];
    const obs_list = (step_data.observations as Record<string, unknown>[]) ?? [];
    for (const obs_data of obs_list) {
      if (obs_data.type === 'tool_result') {
        observations.push(
          new ToolResult({
            run_id: (obs_data.run_id as string) ?? '',
            step_id: (obs_data.step_id as number) ?? 0,
            ts: (obs_data.ts as number) ?? 0.0,
            call_id: (obs_data.call_id as string) ?? '',
            output: (obs_data.output as string) ?? '',
            error: (obs_data.error as string | null) ?? null,
          })
        );
      }
    }

    // Reconstruct delta
    const delta_data = (step_data.delta as Record<string, unknown>) ?? {};
    const delta = new StateDelta({
      created_slots: (delta_data.created_slots as string[]) ?? [],
      updated_slots: (delta_data.updated_slots as string[]) ?? [],
      deleted_slots: (delta_data.deleted_slots as string[]) ?? [],
      messages_added: (delta_data.messages_added as number) ?? 0,
      step_delta: (delta_data.step_delta as number) ?? 0,
      budget_delta: (delta_data.budget_delta as Record<string, unknown>) ?? {},
    });

    // Reconstruct state_before summary as a StateSnapshot
    const state_data = (step_data.state_before as Record<string, unknown>) ?? {};
    const state_before = new StateSnapshot({
      step: (state_data.step as number) ?? 0,
    });

    const step = new TrajectoryStep({
      state_before,
      action,
      observations,
      reward: (step_data.reward as number) ?? 0.0,
      delta,
      metadata: (step_data.metadata as Record<string, unknown>) ?? {},
    });
    traj.add_step(step);
  }

  return traj;
}
