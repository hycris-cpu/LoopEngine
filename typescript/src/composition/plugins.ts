/**
 * Plugins package up reusable capabilities that can be dropped into any agent.
 *
 * Plain English: A Plugin is like a LEGO kit. Each kit comes with:
 * - Processors (behavioral pieces)
 * - Tools (capability pieces)
 * - Flags (configuration switches)
 * - Setup/teardown logic (lifecycle hooks)
 *
 * You "plug in" a kit to your agent, and all the pieces snap into place.
 * Plugins have a TWO-PHASE LIFECYCLE:
 * 1. Build time: the builder reads the plugin's parts (processors, tools, flags)
 * 2. Runtime: setup() is called when the agent starts, teardown() when it stops
 *
 * This separation means the config can be serialized (build-time parts)
 * while runtime resources (database connections, file handles) are managed
 * by setup/teardown.
 */

import { Processor } from '../primitives/processors';
import { Tool } from '../primitives/tools';

/**
 * A single processor entry contributed by a plugin.
 *
 * Either a bare Processor (attached to the default "step_end" hook with order 0)
 * or a (processor, hook_point, order) triple.
 */
export type PluginProcessorItem = Processor | [Processor, string, number];

/**
 * Protocol defining what a Plugin must provide.
 *
 * Plain English: This is the "USB standard" for plugins — any object
 * that has these attributes and methods can be plugged into a builder.
 *
 * A Plugin is a self-contained capability bundle. It declares:
 * - name: its identity
 * - processors: behavioral checkpoints to install
 * - tools: capabilities to make available
 * - flags: configuration switches to set
 * - setup/teardown: lifecycle hooks for runtime resource management
 *
 * The two-phase design separates BUILD-TIME (serializable config)
 * from RUNTIME (resource management):
 * - processors, tools, flags → used at build time (can be serialized)
 * - setup/teardown → called at runtime (manage live resources)
 */
export interface Plugin {
  /** A unique name for this plugin. */
  readonly name: string;

  /** Processors to install, as (processor, hook_point, order) triples. */
  readonly processors: readonly PluginProcessorItem[];

  /** Tools to make available to the agent. */
  readonly tools: readonly Tool[];

  /** Feature flags to set (name → enabled). */
  readonly flags: Readonly<Record<string, boolean>>;

  /**
   * Initialize runtime resources. Called when the agent starts.
   *
   * @param config - The HarnessConfig (as dict) for context.
   */
  setup(config: Record<string, unknown>): Promise<void>;

  /** Release runtime resources. Called when the agent stops. */
  teardown(): Promise<void>;
}

/**
 * A concrete Plugin implementation with list-based configuration.
 *
 * Plain English: This is a "fill-in-the-blanks" plugin template.
 * You give it a name and lists of processors/tools/flags, and it
 * satisfies the Plugin protocol. The setup/teardown methods are
 * no-ops by default — override them for custom lifecycle behavior.
 *
 * Use this as a base class for your own plugins, or create instances
 * directly for simple cases.
 *
 * @example
 * const plugin = new SimplePlugin(
 *   "my_plugin",
 *   [[myProcessor, "step_end", 0]],
 *   [myTool],
 *   { verbose: true }
 * );
 *
 * // Or subclass for custom lifecycle:
 * class DbPlugin extends SimplePlugin {
 *   async setup(config: Record<string, unknown>): Promise<void> {
 *     this.db = await connect(config["db_url"] as string);
 *   }
 *   async teardown(): Promise<void> {
 *     await this.db.close();
 *   }
 * }
 */
export class SimplePlugin implements Plugin {
  private _name: string;
  private _processors: [Processor, string, number][];
  private _tools: Tool[];
  private _flags: Record<string, boolean>;

  /**
   * Initialize a SimplePlugin.
   *
   * @param name - Unique plugin name.
   * @param processors - List of (processor, hook_point, order) triples.
   * @param tools - List of Tool instances.
   * @param flags - Dict mapping flag names to boolean values.
   */
  constructor(
    name: string,
    processors: [Processor, string, number][] | null = null,
    tools: Tool[] | null = null,
    flags: Record<string, boolean> | null = null
  ) {
    this._name = name;
    this._processors = processors ? [...processors] : [];
    this._tools = tools ? [...tools] : [];
    this._flags = flags ? { ...flags } : {};
  }

  /** This plugin's unique name. */
  get name(): string {
    return this._name;
  }

  /** Processors to install, as (processor, hook_point, order) triples. */
  get processors(): readonly [Processor, string, number][] {
    return [...this._processors];
  }

  /** Tools to make available. */
  get tools(): readonly Tool[] {
    return [...this._tools];
  }

  /** Feature flags to set. */
  get flags(): Readonly<Record<string, boolean>> {
    return { ...this._flags };
  }

  /**
   * Initialize runtime resources. Default: no-op.
   *
   * Override in subclasses for custom initialization (e.g., database
   * connections, file handles, cached data).
   *
   * @param _config - The HarnessConfig as a dict, for context during setup.
   */
  async setup(_config: Record<string, unknown>): Promise<void> {
    // Default no-op.
  }

  /**
   * Release runtime resources. Default: no-op.
   *
   * Override in subclasses for custom cleanup (e.g., close connections,
   * flush buffers, release locks).
   */
  async teardown(): Promise<void> {
    // Default no-op.
  }
}

/**
 * A registry that manages plugin instances by name.
 *
 * Think of PluginLoader as the "app store" for plugins. You can:
 * - register(): Install a plugin (like downloading an app)
 * - get(): Look up a plugin by name
 * - list(): See all installed plugin names
 *
 * The loader holds Plugin instances, not classes — the plugins are
 * already constructed and ready to be integrated into a builder.
 */
export class PluginLoader {
  private _plugins: Record<string, Plugin>;

  /** Initialize an empty loader with no plugins. */
  constructor() {
    this._plugins = {};
  }

  /**
   * Register a plugin, making it available for lookup.
   *
   * @param plugin - The Plugin instance to register.
   * @throws Error if a plugin with the same name is already registered.
   */
  register(plugin: Plugin): void {
    if (plugin.name in this._plugins) {
      throw new Error(
        `Plugin '${plugin.name}' is already registered. ` +
          'Use a different name or unregister first.'
      );
    }
    this._plugins[plugin.name] = plugin;
  }

  /**
   * Look up a plugin by name.
   *
   * @param name - The plugin name to search for.
   * @returns The Plugin if found, null otherwise.
   */
  get(name: string): Plugin | null {
    return this._plugins[name] ?? null;
  }

  /**
   * Get a list of all registered plugin names.
   *
   * @returns List of plugin name strings.
   */
  list(): string[] {
    return Object.keys(this._plugins);
  }

  /** Return the number of registered plugins. */
  get length(): number {
    return Object.keys(this._plugins).length;
  }
}
