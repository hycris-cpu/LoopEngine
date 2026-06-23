/**
 * HarnessConfig is the "blueprint" for building an agent.
 *
 * Plain English: If a Harness (agent) is a house, then HarnessConfig is the
 * architectural blueprint. It lists all the parts:
 * - Which processors (behavioral checkpoints) to install
 * - Which tools (apps) to make available
 * - Which feature flags (light switches) to set
 * - Which config slots (settings) to use
 *
 * The config is SERIALIZABLE — you can save it to YAML and load it back.
 * This is critical for reproducibility: given the same config, you get the
 * same agent behavior every time.
 *
 * It's also CONTENT-ADDRESSABLE: we compute a SHA-256 hash of the config,
 * so two identical configs produce the same fingerprint, and any change
 * produces a different one.
 */

import { createHash } from 'node:crypto';
import { Processor, HOOK_POINTS } from '../primitives/processors';
import { Tool } from '../primitives/tools';

/**
 * Serialize a value to a canonical JSON string matching Python's
 * `json.dumps(value, sort_keys=True, default=str)`.
 *
 * Key properties:
 * - Object keys are sorted recursively.
 * - Non-serializable values (functions, symbols, undefined) fall back to
 *   their `String()` representation, just like Python's `default=str`.
 * - Separators are `', '` and `': '` with no extra whitespace.
 */
function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';

  const type = typeof value;
  if (type === 'number') {
    return Number.isFinite(value) ? String(value) : String(value);
  }
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (type === 'bigint' || type === 'function' || type === 'symbol' || value === undefined) {
    return JSON.stringify(String(value));
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => serialize(item));
    return '[' + items.join(', ') + ']';
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}: ${serialize(obj[key])}`);
  return '{' + pairs.join(', ') + '}';
}

/**
 * A processor registered in a config, with its hook point and priority.
 *
 * Think of this as a job assignment slip — it says WHO (processor),
 * WHERE (hook point — which checkpoint), and WHEN (order — priority).
 */
export class ProcessorEntry {
  /** The Processor instance. */
  processor: Processor;

  /** Which hook point this processor attaches to (e.g., "step_end"). */
  hook: string;

  /** Priority ordering — lower numbers run first within the same hook. */
  order: number;

  /**
   * Initialize a ProcessorEntry.
   *
   * @param processor - The Processor instance.
   * @param hook - Which hook point this processor attaches to.
   * @param order - Priority ordering — lower numbers run first.
   */
  constructor(processor: Processor, hook: string = 'step_end', order: number = 0) {
    this.processor = processor;
    this.hook = hook;
    this.order = order;
  }

  /**
   * Serialize to a plain dict (processor name only — instances aren't serializable).
   *
   * @returns A dict with processor name, hook point, and order.
   */
  to_dict(): Record<string, unknown> {
    return {
      processor: this.processor.name,
      hook: this.hook,
      order: this.order,
    };
  }
}

/**
 * The complete blueprint for building an agent.
 *
 * Plain English: This is the shopping list + assembly instructions for
 * your agent. It holds every piece:
 * - processors: The behavioral checkpoints (what the agent does at each step)
 * - tools: The capabilities (what the agent CAN do)
 * - flags: The feature switches (what's enabled/disabled)
 * - slots: Custom settings (working directory, model name, etc.)
 *
 * Key properties:
 * - SERIALIZABLE: to_dict() gives you a JSON-safe representation
 * - CONTENT-ADDRESSABLE: fingerprint() gives a SHA-256 hash — identical
 *   configs always produce the same hash
 * - VALIDATABLE: validate() checks for common mistakes
 */
export class HarnessConfig {
  /** Ordered list of ProcessorEntry objects. */
  processors: ProcessorEntry[];

  /** List of Tool instances available to the agent. */
  tools: Tool[];

  /** Dict mapping flag names to boolean values. */
  flags: Record<string, boolean>;

  /** Dict of arbitrary config key-value pairs. */
  slots: Record<string, unknown>;

  /**
   * Initialize a HarnessConfig.
   *
   * @param options - Optional initial values.
   * @param options.processors - Processor entries (defaults to empty list).
   * @param options.tools - Tool instances (defaults to empty list).
   * @param options.flags - Feature flag values (defaults to empty dict).
   * @param options.slots - Config slot key-value pairs (defaults to empty dict).
   */
  constructor(options: {
    processors?: ProcessorEntry[];
    tools?: Tool[];
    flags?: Record<string, boolean>;
    slots?: Record<string, unknown>;
  } = {}) {
    this.processors = options.processors ? [...options.processors] : [];
    this.tools = options.tools ? [...options.tools] : [];
    this.flags = options.flags ? { ...options.flags } : {};
    this.slots = options.slots ? { ...options.slots } : {};
  }

  /**
   * Compute a SHA-256 hash of this config for identity comparison.
   *
   * Plain English: This is the config's "DNA" — a unique fingerprint.
   * Two configs with identical contents produce the same fingerprint.
   * Change anything, and the fingerprint changes.
   *
   * This is deterministic: call it 100 times, get the same answer.
   *
   * @returns A hex string (64 chars) representing the SHA-256 hash.
   */
  fingerprint(): string {
    const canonical = canonicalJson(this.to_dict());
    return createHash('sha256').update(canonical, 'utf-8').digest('hex');
  }

  /**
   * Serialize this config to a JSON-safe dictionary.
   *
   * @returns A dict with processors, tools (by name), flags, and slots.
   */
  to_dict(): Record<string, unknown> {
    return {
      processors: this.processors.map((pe) => pe.to_dict()),
      tools: this.tools.map((t) => ({ name: t.name, description: t.description })),
      flags: { ...this.flags },
      slots: { ...this.slots },
    };
  }

  /**
   * Check this config for common mistakes.
   *
   * Plain English: Like a building inspector checking a blueprint
   * before construction begins. Returns a list of problems found.
   *
   * Checks performed:
   * - Processor hook points must be valid HOOK_POINTS
   * - No duplicate processor+hook+order combinations
   * - Tool names must be unique
   * - Flag values must be booleans
   *
   * @returns A list of error message strings. Empty list means valid.
   */
  validate(): string[] {
    const errors: string[] = [];
    const validHooks = new Set<string>(HOOK_POINTS as readonly string[]);

    // Check processor hook points
    const seenCombos = new Set<string>();
    for (const pe of this.processors) {
      if (!validHooks.has(pe.hook)) {
        errors.push(
          `Processor '${pe.processor.name}' has invalid hook '${pe.hook}'. ` +
            `Must be one of: ${JSON.stringify(HOOK_POINTS)}.`
        );
      }
      const combo = `${pe.processor.name}|${pe.hook}|${pe.order}`;
      if (seenCombos.has(combo)) {
        errors.push(
          `Duplicate processor entry: '${pe.processor.name}' ` +
            `at hook '${pe.hook}' with order ${pe.order}`
        );
      }
      seenCombos.add(combo);
    }

    // Check tool names are non-empty and unique
    const toolNames = this.tools.map((t) => t.name);
    for (const t of this.tools) {
      if (!t.name) {
        errors.push(`Tool has empty name (description: '${t.description}')`);
      }
    }
    const seenToolNames = new Set<string>();
    for (const name of toolNames) {
      if (seenToolNames.has(name)) {
        errors.push(`Duplicate tool name: '${name}'`);
      }
      seenToolNames.add(name);
    }

    // Check flag types
    for (const [name, value] of Object.entries(this.flags)) {
      if (typeof value !== 'boolean') {
        errors.push(`Flag '${name}' has non-boolean value: ${typeof value}`);
      }
    }

    return errors;
  }
}
