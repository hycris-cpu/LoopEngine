/**
 * HarnessBuilder is an IMMUTABLE factory for assembling agent configs.
 *
 * Plain English: Think of HarnessBuilder like ordering a custom car.
 * Each method call adds a feature, but instead of modifying your current order,
 * you get a NEW order with the feature added. Your old order is unchanged.
 *
 * This "immutable" design prevents a huge class of bugs:
 * - No accidental shared state between different configs
 * - Safe to compose builders: coding_builder.merge(reliability_builder)
 * - Thread-safe by design
 *
 * The merge() method lets you MERGE two builders:
 *   const builder = make_coding().merge(make_reliability());
 * This creates a new builder with processors/tools from both.
 * If there are conflicts (same singleton group), it raises an error.
 */

import type { Processor } from '../primitives/processors';
import type { Tool } from '../primitives/tools';
import { HarnessConfig, ProcessorEntry } from './config';
import type { Plugin, PluginProcessorItem } from './plugins';
import { ValueError } from './errors';

/**
 * An immutable builder for assembling HarnessConfig objects.
 *
 * Plain English: This is like a car configurator website. Each click
 * (method call) creates a NEW configuration — your previous selections
 * are never modified. When you're done, you hit "Build" (build())
 * and get the final config.
 *
 * IMMUTABILITY GUARANTEE:
 * Every method (add, tool, flag, slot) returns a NEW HarnessBuilder.
 * The original builder is NEVER modified. This is enforced by copying
 * all internal lists/dicts on each method call.
 *
 * MERGE METHOD:
 *   const builder = coding.merge(reliability);
 * Creates a new builder combining both. Raises Error if there are
 * singleton group conflicts (two processors claiming the same exclusive role).
 */
export class HarnessBuilder {
  private _processors: ProcessorEntry[];
  private _tools: Tool[];
  private _flags: Record<string, boolean>;
  private _slots: Record<string, unknown>;
  private _singletonGroups: Set<string>;

  /**
   * Initialize a HarnessBuilder (usually via the no-arg constructor).
   *
   * @param options - Optional initial values.
   * @param options.processors - Initial processor entries (defaults to empty).
   * @param options.tools - Initial tools (defaults to empty).
   * @param options.flags - Initial flags (defaults to empty).
   * @param options.slots - Initial slots (defaults to empty).
   * @param options.singletonGroups - Singleton group names for merge conflict detection.
   */
  constructor(options: {
    processors?: ProcessorEntry[];
    tools?: Tool[];
    flags?: Record<string, boolean>;
    slots?: Record<string, unknown>;
    singletonGroups?: string[];
  } = {}) {
    this._processors = options.processors ? [...options.processors] : [];
    this._tools = options.tools ? [...options.tools] : [];
    this._flags = options.flags ? { ...options.flags } : {};
    this._slots = options.slots ? { ...options.slots } : {};
    this._singletonGroups = new Set(options.singletonGroups ?? []);
  }

  /**
   * Register a processor at a hook point. Returns a NEW builder.
   *
   * BDD: Given a builder, When I add a processor, Then build() produces
   *      a config containing that processor. The original builder is unchanged.
   *
   * @param processor - The Processor to register.
   * @param hook - Which hook point (e.g., "step_end", "after_model").
   * @param order - Priority within the hook (lower = runs first).
   * @param singletonGroup - Optional group name for merge conflict detection.
   *   If two builders both add a processor in the same singletonGroup,
   *   merging them raises ValueError.
   * @returns A NEW HarnessBuilder with the processor added.
   * @throws ValueError if singletonGroup already has a processor in this builder.
   */
  add(
    processor: Processor,
    hook: string = 'step_end',
    order: number = 0,
    singletonGroup?: string
  ): HarnessBuilder {
    const entry = new ProcessorEntry(processor, hook, order);
    const newGroups = new Set(this._singletonGroups);
    if (singletonGroup !== undefined) {
      if (this._singletonGroups.has(singletonGroup)) {
        throw new ValueError(
          `Singleton group '${singletonGroup}' already has a processor ` +
            `in this builder. Cannot add '${processor.name}'.`
        );
      }
      newGroups.add(singletonGroup);
    }
    return new HarnessBuilder({
      processors: [...this._processors, entry],
      tools: [...this._tools],
      flags: { ...this._flags },
      slots: { ...this._slots },
      singletonGroups: [...newGroups],
    });
  }

  /**
   * Register a tool. Returns a NEW builder.
   *
   * BDD: Given a builder, When I add a tool, Then build() produces
   *      a config containing that tool. The original builder is unchanged.
   *
   * @param toolInstance - The Tool to make available to the agent.
   * @returns A NEW HarnessBuilder with the tool added.
   */
  tool(toolInstance: Tool): HarnessBuilder {
    return new HarnessBuilder({
      processors: [...this._processors],
      tools: [...this._tools, toolInstance],
      flags: { ...this._flags },
      slots: { ...this._slots },
      singletonGroups: [...this._singletonGroups],
    });
  }

  /**
   * Set a feature flag. Returns a NEW builder.
   *
   * BDD: Given a builder, When I set flag "x" to True,
   *      Then build() produces a config where flags["x"] is True.
   *
   * @param name - The flag name.
   * @param enabled - Whether the flag is on (True) or off (False).
   * @returns A NEW HarnessBuilder with the flag set.
   */
  flag(name: string, enabled: boolean = true): HarnessBuilder {
    const newFlags = { ...this._flags };
    newFlags[name] = enabled;
    return new HarnessBuilder({
      processors: [...this._processors],
      tools: [...this._tools],
      flags: newFlags,
      slots: { ...this._slots },
      singletonGroups: [...this._singletonGroups],
    });
  }

  /**
   * Set config slots. Returns a NEW builder.
   *
   * BDD: Given a builder, When I set slot working_dir="/tmp",
   *      Then build() produces a config where slots["working_dir"] is "/tmp".
   *
   * @param slots - Key-value pairs to set as config slots.
   * @returns A NEW HarnessBuilder with the slots set.
   */
  slot(slots: Record<string, unknown>): HarnessBuilder {
    const newSlots = { ...this._slots };
    for (const [key, value] of Object.entries(slots)) {
      newSlots[key] = value;
    }
    return new HarnessBuilder({
      processors: [...this._processors],
      tools: [...this._tools],
      flags: { ...this._flags },
      slots: newSlots,
      singletonGroups: [...this._singletonGroups],
    });
  }

  /**
   * Integrate a Plugin into this builder. Returns a NEW builder.
   *
   * Plain English: This is like plugging a USB device into your computer.
   * The plugin contributes its processors, tools, and flags, and they
   * all snap into place in the builder.
   *
   * A Plugin must provide:
   * - name: string
   * - processors: list of (processor, hook, order) tuples, or bare Processor items
   * - tools: list of Tool instances
   * - flags: dict of flag name → boolean
   *
   * @param pluginInstance - An object implementing the Plugin interface.
   * @returns A NEW HarnessBuilder with the plugin's parts integrated.
   */
  plugin(pluginInstance: Plugin): HarnessBuilder {
    let builder = new HarnessBuilder({
      processors: [...this._processors],
      tools: [...this._tools],
      flags: { ...this._flags },
      slots: { ...this._slots },
      singletonGroups: [...this._singletonGroups],
    });

    // Add plugin's processors
    for (const item of pluginInstance.processors) {
      if (isProcessorTuple(item)) {
        const [proc, hook, order] = item;
        builder = builder.add(proc, hook, order);
      } else {
        builder = builder.add(item);
      }
    }

    // Add plugin's tools
    for (const t of pluginInstance.tools) {
      builder = builder.tool(t);
    }

    // Add plugin's flags
    for (const [fname, fval] of Object.entries(pluginInstance.flags)) {
      builder = builder.flag(fname, fval);
    }

    return builder;
  }

  /**
   * Produce the final immutable HarnessConfig.
   *
   * BDD: Given a builder with processors, tools, flags, and slots,
   *      When I call build(), Then I get a HarnessConfig with all those parts.
   *
   * @returns A HarnessConfig containing all accumulated parts.
   */
  build(): HarnessConfig {
    return new HarnessConfig({
      processors: [...this._processors],
      tools: [...this._tools],
      flags: { ...this._flags },
      slots: { ...this._slots },
    });
  }

  /**
   * Merge two builders.
   *
   * Plain English: "I want a coding agent AND reliability safety nets."
   * coding.merge(reliability) gives you a new builder with everything from both.
   *
   * Raises ValueError if both builders have processors in the same
   * singleton group (conflict detection).
   *
   * @param other - Another HarnessBuilder to merge with.
   * @returns A NEW HarnessBuilder combining both builders' parts.
   * @throws TypeError if `other` is not a HarnessBuilder.
   * @throws ValueError if there are singleton group conflicts.
   */
  merge(other: HarnessBuilder): HarnessBuilder {
    if (!(other instanceof HarnessBuilder)) {
      throw new TypeError(
        `Cannot merge HarnessBuilder with ${Object.prototype.toString.call(other).slice(8, -1)}. Use .merge() only between two HarnessBuilder instances.`
      );
    }

    // Check for singleton group conflicts
    const conflicts = new Set<string>();
    for (const group of this._singletonGroups) {
      if (other._singletonGroups.has(group)) {
        conflicts.add(group);
      }
    }
    if (conflicts.size > 0) {
      const conflictsStr = conflicts.size === 1
        ? `{'${Array.from(conflicts)[0]}'}`
        : `{${Array.from(conflicts).map(c => `'${c}'`).join(', ')}}`;
      throw new ValueError(
        `Cannot merge builders: singleton group conflict(s) in ${conflictsStr}. ` +
          'Both builders have processors claiming the same exclusive role.'
      );
    }

    // Merge all flags (other's flags override self's for same key)
    const mergedFlags = { ...this._flags, ...other._flags };

    // Merge all slots (other's slots override self's for same key)
    const mergedSlots = { ...this._slots, ...other._slots };

    const mergedGroups = new Set(this._singletonGroups);
    for (const group of other._singletonGroups) {
      mergedGroups.add(group);
    }

    return new HarnessBuilder({
      processors: [...this._processors, ...other._processors],
      tools: [...this._tools, ...other._tools],
      flags: mergedFlags,
      slots: mergedSlots,
      singletonGroups: [...mergedGroups],
    });
  }

  /** Return a human-readable representation for debugging. */
  toString(): string {
    return (
      `HarnessBuilder(` +
      `processors=${this._processors.length}, ` +
      `tools=${this._tools.length}, ` +
      `flags=${Object.keys(this._flags).length}, ` +
      `slots=${Object.keys(this._slots).length})`
    );
  }
}

/**
 * Type guard for plugin processor entries.
 *
 * Distinguishes a (processor, hook, order) tuple from a bare Processor.
 */
function isProcessorTuple(item: PluginProcessorItem): item is [Processor, string, number] {
  return (
    Array.isArray(item) &&
    item.length === 3 &&
    typeof item[1] === 'string' &&
    typeof item[2] === 'number'
  );
}
