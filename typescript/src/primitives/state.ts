/**
 * The State module manages the agent's "working memory" during execution.
 *
 * Plain English: Think of State as the agent's desk while it's working.
 * It has:
 * - raw_messages: A notebook where EVERYTHING is written down (append-only, factual)
 * - messages: The "clean" version the AI actually sees (processors may modify this)
 * - slots: Sticky notes for passing info between processors
 * - step: Which step number we're on
 * - budget: How many tokens/money we've spent
 *
 * The DUAL-TRACK design (raw_messages vs messages) is key:
 * - raw_messages = what actually happened (ground truth)
 * - messages = what the model sees (may include processor-injected hints)
 */

import { Event, Message } from './events';

/**
 * Immutable resource limits for a run (like a spending limit on a credit card).
 *
 * Plain English: Think of Budget as your "allowance" for the agent.
 * It sets hard ceilings:
 * - max_tokens: How many tokens the AI can consume (tokens ≈ words)
 * - max_cost_usd: How much money you're willing to spend (in dollars)
 * - max_steps: How many reasoning steps the agent can take
 *
 * Budget is FROZEN (immutable) — once set, limits never change during a run.
 * Usage tracking lives in State itself, not in Budget.
 */
export class Budget {
  readonly max_tokens: number;
  readonly max_cost_usd: number;
  readonly max_steps: number;

  constructor(options: Partial<Budget> = {}) {
    this.max_tokens = options.max_tokens ?? 128_000;
    this.max_cost_usd = options.max_cost_usd ?? 10.0;
    this.max_steps = options.max_steps ?? 100;
  }
}

/**
 * A named slot for passing information between processors (like a sticky note).
 *
 * Plain English: Processors need to talk to each other, but they can't
 * directly see each other's internal state. StateSlots are the mailbox
 * system — any processor can write to a slot, and any later processor
 * can read it.
 *
 * Attributes:
 *   key: Unique name for this slot (like a sticky note label).
 *   value: The data stored in this slot (can be anything).
 *   slot_type: Category tag for filtering (e.g., "context", "hint", "tool_result").
 *   metadata: Extra key-value pairs for debugging and analysis.
 */
export class StateSlot {
  key: string;
  value: unknown;
  slot_type: string;
  metadata: Record<string, unknown>;

  constructor(options: Partial<StateSlot> = {}) {
    this.key = options.key ?? '';
    this.value = options.value ?? null;
    this.slot_type = options.slot_type ?? 'general';
    this.metadata = options.metadata ?? {};
  }
}

/**
 * Records what changed in a State between two points in time (like a diff).
 *
 * Plain English: When the State changes, a StateDelta captures exactly
 * what was different:
 * - created_slots: New sticky notes added
 * - updated_slots: Sticky notes whose values changed
 * - deleted_slots: Sticky notes that were removed
 * - messages_added: Number of new messages added to raw_messages
 * - step_delta: Change in step number (usually +1)
 * - budget_delta: Change in resource usage (tokens, cost)
 *
 * This is useful for debugging ("what changed?") and for training
 * ("what did the agent experience?").
 */
export class StateDelta {
  created_slots: string[];
  updated_slots: string[];
  deleted_slots: string[];
  messages_added: number;
  step_delta: number;
  budget_delta: Record<string, unknown>;

  constructor(options: Partial<StateDelta> = {}) {
    this.created_slots = options.created_slots ?? [];
    this.updated_slots = options.updated_slots ?? [];
    this.deleted_slots = options.deleted_slots ?? [];
    this.messages_added = options.messages_added ?? 0;
    this.step_delta = options.step_delta ?? 0;
    this.budget_delta = options.budget_delta ?? {};
  }
}

/**
 * An immutable snapshot of a State at a point in time (like a photograph).
 *
 * Plain English: Sometimes you want to "save" the current state — like
 * taking a photo of your desk before you leave for lunch. A StateSnapshot
 * captures everything exactly as it was. You can use snapshots to:
 * - Roll back to a previous state (retry after failure)
 * - Compare states across steps (did things improve?)
 * - Fork a state (try multiple strategies from the same starting point)
 *
 * It's frozen (immutable) so the snapshot can never be accidentally changed.
 */
export class StateSnapshot {
  readonly raw_messages: readonly Event[];
  readonly messages: readonly Message[];
  readonly slots: Readonly<Record<string, StateSlot>>;
  readonly step: number;
  readonly budget: Budget;

  constructor(options: Partial<StateSnapshot> = {}) {
    this.raw_messages = options.raw_messages ?? [];
    this.messages = options.messages ?? [];
    this.slots = options.slots ?? {};
    this.step = options.step ?? 0;
    this.budget = options.budget ?? new Budget();
  }

  /**
   * Serialize this snapshot to a plain dictionary.
   *
   * Useful for JSON serialization (e.g., saving trajectory steps to JSONL).
   *
   * Returns:
   *   A dictionary with all snapshot fields converted to basic types.
   */
  to_dict(): Record<string, unknown> {
    return {
      raw_messages: this.raw_messages.map((m) => m.to_dict()),
      messages: this.messages.map((m) => m.to_dict()),
      slots: Object.fromEntries(
        Object.entries(this.slots).map(([k, s]) => [
          k,
          {
            key: s.key,
            value: s.value,
            slot_type: s.slot_type,
            metadata: s.metadata,
          },
        ])
      ),
      step: this.step,
      budget: {
        max_tokens: this.budget.max_tokens,
        max_cost_usd: this.budget.max_cost_usd,
        max_steps: this.budget.max_steps,
      },
    };
  }
}

/**
 * The agent's mutable working memory during a task execution (like a desk).
 *
 * Plain English: This is where all the action happens. The State holds:
 * - raw_messages: What ACTUALLY happened (append-only truth)
 * - messages: What the MODEL sees (may differ due to processors)
 * - slots: Sticky notes for cross-processor communication
 * - step: Current step number (0, 1, 2, ...)
 * - budget: Immutable resource limits
 * - usage_tokens: Actual tokens consumed so far
 * - usage_cost_usd: Actual dollars spent so far
 *
 * DUAL-TRACK DESIGN:
 * The key insight is that raw_messages and messages can diverge.
 * A processor might inject a "system hint" into messages that doesn't
 * appear in raw_messages. This lets us:
 * - Keep ground truth (raw_messages) for auditing/training
 * - Give the model helpful context (messages) for better responses
 *
 * State is MUTABLE — it changes as the agent works. But you can take
 * a frozen StateSnapshot at any time to checkpoint the current state.
 */
export class State {
  raw_messages: Event[];
  messages: Message[];
  slots: Record<string, StateSlot>;
  step: number;
  budget: Budget;
  usage_tokens: number;
  usage_cost_usd: number;

  constructor(options: Partial<State> = {}) {
    this.raw_messages = options.raw_messages ?? [];
    this.messages = options.messages ?? [];
    this.slots = options.slots ?? {};
    this.step = options.step ?? 0;
    this.budget = options.budget ?? new Budget();
    this.usage_tokens = options.usage_tokens ?? 0;
    this.usage_cost_usd = options.usage_cost_usd ?? 0.0;
  }

  // ------------------------------------------------------------------
  // Message operations (dual-track)
  // ------------------------------------------------------------------

  /**
   * Add a message to BOTH raw_messages and messages (dual-track append).
   *
   * This is the standard way to add a message that actually happened.
   * The message goes into raw_messages (ground truth) AND messages
   * (what the model sees). If a processor needs to modify only what
   * the model sees, it should modify self.messages directly.
   *
   * BDD: Given a fresh state, When I add a message,
   *      Then raw_messages and messages both contain it.
   *
   * Args:
   *   message: The Message event to record.
   */
  add_message(message: Message): void {
    this.raw_messages.push(message);
    this.messages.push(message);
  }

  /**
   * Add an event to raw_messages only (not to messages).
   *
   * Use this for events that should be recorded in history but are
   * NOT conversation messages (e.g., ToolCall, ToolResult, EvalResult).
   *
   * BDD: Given a fresh state, When I add a raw event,
   *      Then raw_messages contains it but messages does not.
   *
   * Args:
   *   event: The Event to record in raw history.
   */
  add_raw_event(event: Event): void {
    this.raw_messages.push(event);
  }

  /**
   * Add a message to messages ONLY (not raw_messages).
   *
   * Use this for processor-injected hints that the model should see
   * but that aren't part of the "real" conversation history.
   *
   * BDD: Given a fresh state, When I inject a message,
   *      Then messages contains it but raw_messages does not.
   *
   * Args:
   *   message: The Message to inject into the model's view.
   */
  inject_message(message: Message): void {
    this.messages.push(message);
  }

  // ------------------------------------------------------------------
  // Slot operations (cross-processor communication)
  // ------------------------------------------------------------------

  /**
   * Create or update a named slot.
   *
   * BDD: Given a state, When I set a slot with a key and value,
   *      Then get_slot returns that slot with the correct value.
   *
   * Args:
   *   key: Unique name for this slot.
   *   value: The data to store.
   *   slot_type: Category tag for filtering.
   *   metadata: Optional extra key-value pairs.
   *
   * Returns:
   *   The created/updated StateSlot.
   */
  set_slot(
    key: string,
    value: unknown,
    slot_type: string = 'general',
    metadata: Record<string, unknown> | null = null
  ): StateSlot {
    const slot = new StateSlot({
      key,
      value,
      slot_type,
      metadata: metadata ?? {},
    });
    this.slots[key] = slot;
    return slot;
  }

  /**
   * Retrieve a slot by key, or None if it doesn't exist.
   *
   * BDD: Given a state with slot "x", When I get_slot("x"),
   *      Then I get the slot. When I get_slot("missing"), Then I get None.
   *
   * Args:
   *   key: The slot name to look up.
   *
   * Returns:
   *   The StateSlot if found, None otherwise.
   */
  get_slot(key: string): StateSlot | null {
    return this.slots[key] ?? null;
  }

  /**
   * Remove a slot by key.
   *
   * BDD: Given a state with slot "x", When I delete_slot("x"),
   *      Then the slot is gone and True is returned.
   *      Deleting a non-existent slot returns False.
   *
   * Args:
   *   key: The slot name to remove.
   *
   * Returns:
   *   True if the slot existed and was removed, False otherwise.
   */
  delete_slot(key: string): boolean {
    if (key in this.slots) {
      delete this.slots[key];
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Budget / usage tracking
  // ------------------------------------------------------------------

  /**
   * Record resource consumption after a model call.
   *
   * BDD: Given a fresh state, When I record 100 tokens and $0.50,
   *      Then usage_tokens is 100 and usage_cost_usd is 0.50.
   *
   * Args:
   *   tokens: Number of tokens consumed in this step.
   *   cost_usd: Dollar cost of this step.
   */
  record_usage(tokens: number = 0, cost_usd: number = 0.0): void {
    this.usage_tokens += tokens;
    this.usage_cost_usd += cost_usd;
  }

  /**
   * Check if any resource limit has been reached or exceeded.
   *
   * BDD: Given a state with usage >= budget limits,
   *      When I check is_budget_exhausted, Then it returns True.
   */
  get is_budget_exhausted(): boolean {
    return (
      this.usage_tokens >= this.budget.max_tokens ||
      this.usage_cost_usd >= this.budget.max_cost_usd ||
      this.step >= this.budget.max_steps
    );
  }

  // ------------------------------------------------------------------
  // Snapshot / restore
  // ------------------------------------------------------------------

  /**
   * Create a frozen snapshot of the current state.
   *
   * Use this for checkpointing — saving the exact state at a point in time
   * so you can restore it later (e.g., for rollback or retry).
   *
   * BDD: Given a state with some messages and slots,
   *      When I take a snapshot, Then it captures everything exactly.
   *
   * Returns:
   *   An immutable StateSnapshot capturing this moment.
   */
  snapshot(): StateSnapshot {
    return new StateSnapshot({
      raw_messages: [...this.raw_messages],
      messages: [...this.messages],
      slots: { ...this.slots },
      step: this.step,
      budget: this.budget,
    });
  }

  /**
   * Restore state from a frozen snapshot.
   *
   * This overwrites the current state entirely with the snapshot's data.
   * Like rewinding a video to a saved point.
   *
   * BDD: Given a snapshot from earlier, When I restore it,
   *      Then the state matches exactly what was snapshotted.
   *
   * Args:
   *   snapshot: The StateSnapshot to restore from.
   */
  restore(snapshot: StateSnapshot): void {
    this.raw_messages = [...snapshot.raw_messages];
    this.messages = [...snapshot.messages];
    this.slots = { ...snapshot.slots };
    this.step = snapshot.step;
    this.budget = snapshot.budget;
  }

  // ------------------------------------------------------------------
  // Delta computation
  // ------------------------------------------------------------------

  /**
   * Compute what changed since a previous snapshot.
   *
   * BDD: Given a snapshot and then modifications to the state,
   *      When I compute_delta(snapshot), Then it lists all changes.
   *
   * Args:
   *   snapshot: The earlier snapshot to compare against.
   *
   * Returns:
   *   A StateDelta describing all changes.
   */
  compute_delta(snapshot: StateSnapshot): StateDelta {
    const old_keys = new Set(Object.keys(snapshot.slots));
    const new_keys = new Set(Object.keys(this.slots));

    const created = [...new_keys].filter((k) => !old_keys.has(k));
    const deleted = [...old_keys].filter((k) => !new_keys.has(k));

    const updated: string[] = [];
    for (const key of old_keys) {
      if (new_keys.has(key) && snapshot.slots[key].value !== this.slots[key].value) {
        updated.push(key);
      }
    }

    return new StateDelta({
      created_slots: created,
      updated_slots: updated,
      deleted_slots: deleted,
      messages_added: this.raw_messages.length - snapshot.raw_messages.length,
      step_delta: this.step - snapshot.step,
    });
  }

  /**
   * Alias for compute_delta — compute what changed since a snapshot.
   *
   * Args:
   *   snapshot: The earlier snapshot to compare against.
   *
   * Returns:
   *   A StateDelta describing all changes.
   */
  diff(snapshot: StateSnapshot): StateDelta {
    return this.compute_delta(snapshot);
  }
}
