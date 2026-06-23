import { KeyError } from './errors';

/**
 * Feature flags let you turn capabilities on and off without changing code.
 *
 * Plain English: Think of feature flags like light switches in a house.
 * Each switch controls one feature (like "enable self-verification" or
 * "use sliding window memory"). You can flip switches without rewiring
 * the house. This is especially useful for:
 * - A/B testing: try a feature on some runs but not others
 * - Safe rollout: enable a risky feature only after testing
 * - Ablation studies: turn off features one by one to see their impact
 */

/**
 * A single feature flag — a named switch with a default and current value.
 *
 * Plain English: This is one light switch on the wall. It has:
 * - name: the label under the switch (e.g., "verbose_mode")
 * - default: the position the switch starts in (on/off)
 * - value: the current position (may differ from default if flipped)
 * - description: a note explaining what this switch controls
 *
 * The flag's identity is its NAME — two flags with the same name
 * refer to the same capability.
 */
export class FeatureFlag {
  /** Unique identifier for this flag (like "enable_verification"). */
  name: string;

  /** The initial value when the flag is created or reset. */
  default: boolean;

  /** The current value (may have been flipped from the default). */
  value: boolean;

  /** Human-readable explanation of what this flag controls. */
  description: string;

  /**
   * Initialize a feature flag.
   *
   * @param name - Unique identifier for this flag.
   * @param defaultValue - The initial value when the flag is created or reset.
   * @param value - The current value; defaults to `defaultValue`.
   * @param description - Human-readable explanation of what this flag controls.
   */
  constructor(
    name: string,
    defaultValue: boolean = false,
    value: boolean = false,
    description: string = ''
  ) {
    this.name = name;
    this.default = defaultValue;
    this.value = value;
    this.description = description;

    // Ensure current value starts at the default if not explicitly set.
    // If value was not explicitly provided, match it to the default.
    // The default value is False, but if default=True was given and value
    // was not overridden, value should follow default.
    if (!this.value && this.default) {
      this.value = true;
    }
  }

  /**
   * Check if this flag is currently on (value is True).
   *
   * @returns True if the flag's current value is True, False otherwise.
   */
  get is_enabled(): boolean {
    return this.value;
  }

  /**
   * Serialize this flag to a plain dictionary.
   *
   * @returns A dict with name, default, value, and description.
   */
  to_dict(): Record<string, unknown> {
    return {
      name: this.name,
      default: this.default,
      value: this.value,
      description: this.description,
    };
  }
}

/**
 * A registry that manages named feature flags.
 *
 * Plain English: Think of FlagRegistry as the main electrical panel in
 * a building. It holds all the circuit breakers (flags) and lets you:
 * - register(): Install a new breaker
 * - get(): Look up a breaker by label
 * - set(): Flip a breaker on or off
 * - is_enabled(): Check if a breaker is on
 * - reset(): Return a breaker (or all breakers) to default position
 * - all(): See all installed breakers and their states
 */
export class FlagRegistry {
  private _flags: Record<string, FeatureFlag>;

  /** Initialize an empty registry with no flags. */
  constructor() {
    this._flags = {};
  }

  /**
   * Register a new flag in the registry.
   *
   * @param flag - The FeatureFlag to register.
   * @returns The registered FeatureFlag.
   * @throws Error if a flag with the same name is already registered.
   */
  register(flag: FeatureFlag): FeatureFlag {
    if (flag.name in this._flags) {
      throw new Error(
        `Flag '${flag.name}' is already registered. ` +
          'Use set() to change its value or reset() to restore defaults.'
      );
    }
    this._flags[flag.name] = flag;
    return flag;
  }

  /**
   * Look up a flag by name.
   *
   * @param name - The flag name to search for.
   * @returns The FeatureFlag if found, null otherwise.
   */
  get(name: string): FeatureFlag | null {
    return this._flags[name] ?? null;
  }

  /**
   * Set the current value of a flag.
   *
   * @param name - The flag name to update.
   * @param value - The new value (True = enabled, False = disabled).
   * @throws KeyError if the flag is not registered.
   */
  set(name: string, value: boolean): void {
    if (!(name in this._flags)) {
      throw new KeyError(
        `Flag '${name}' is not registered. Register it first with register().`
      );
    }
    this._flags[name].value = value;
  }

  /**
   * Check if a flag is currently enabled.
   *
   * Non-existent flags return False (safe default — if the capability
   * isn't even registered, it's definitely not enabled).
   *
   * @param name - The flag name to check.
   * @returns True if the flag exists and is enabled, False otherwise.
   */
  is_enabled(name: string): boolean {
    const flag = this._flags[name];
    if (flag === undefined) {
      return false;
    }
    return flag.value;
  }

  /**
   * Reset one or all flags to their default values.
   *
   * @param name - The flag to reset. If omitted, resets ALL flags.
   */
  reset(name?: string): void {
    if (name !== undefined) {
      if (name in this._flags) {
        const flag = this._flags[name];
        flag.value = flag.default;
      }
    } else {
      for (const flag of Object.values(this._flags)) {
        flag.value = flag.default;
      }
    }
  }

  /**
   * Return all registered flags as a dict.
   *
   * @returns A dict mapping flag name to FeatureFlag.
   */
  all(): Record<string, FeatureFlag> {
    return { ...this._flags };
  }
}

/**
 * Create a FeatureFlag and register it in one step.
 *
 * This is a convenience shortcut — instead of:
 *   const f = new FeatureFlag('x', true);
 *   registry.register(f);
 *
 * You can write:
 *   const f = flag(registry, 'x', true);
 *
 * @param registry - The FlagRegistry to register the flag in.
 * @param name - Unique name for the flag.
 * @param defaultValue - Initial value (True or False).
 * @param description - Human-readable explanation.
 * @returns The created and registered FeatureFlag.
 */
export function flag(
  registry: FlagRegistry,
  name: string,
  defaultValue: boolean = false,
  description: string = ''
): FeatureFlag {
  const f = new FeatureFlag(name, defaultValue, false, description);
  registry.register(f);
  return f;
}
