/**
 * The Tools module defines what the agent CAN DO.
 *
 * Plain English: Tools are like apps on a phone. Each tool has:
 * - A name (what to call it)
 * - A description (what it does, for the AI to understand)
 * - An input schema (what arguments it needs, in JSON Schema format)
 * - An execute method (the actual code that runs when called)
 *
 * The ToolRegistry is like the phone's app store — it holds all available tools
 * and lets you look them up by name.
 */

import { ToolResult } from './events';

/**
 * The immutable definition of a tool's interface.
 *
 * Think of a ToolSchema as a job posting — it describes what the tool is
 * called, what it does, and what inputs it expects (in JSON Schema format).
 * It does NOT contain the tool's implementation — just its contract.
 *
 * This is frozen (immutable) because a tool's interface should not change
 * after it's registered. If you need a different interface, create a new tool.
 *
 * Attributes:
 *   name: The tool's unique identifier (like an app name on a phone).
 *   description: Human-readable explanation of what the tool does.
 *       This is sent to the AI model so it knows when to use the tool.
 *   input_schema: A JSON Schema dict defining the expected inputs.
 *       Example: {"type": "object", "properties": {"query": {"type": "string"}}}
 *   metadata: Arbitrary extra info (version, author, category, etc.).
 */
export class ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;

  constructor(options: {
    name: string;
    description: string;
    input_schema?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }) {
    this.name = options.name;
    this.description = options.description;
    this.input_schema = options.input_schema ?? {};
    this.metadata = options.metadata ?? {};
  }

  /**
   * Convert this schema to OpenAI's function-calling format.
   *
   * The OpenAI API expects tools in a specific nested structure:
   * {"type": "function", "function": {"name": ..., "description": ..., "parameters": ...}}
   *
   * Returns:
   *   A dict matching the OpenAI tool definition format.
   */
  to_openai_dict(): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.input_schema,
      },
    };
  }
}

/**
 * The context passed to a tool when it executes.
 *
 * Think of ToolContext as the "briefing packet" a contractor receives
 * before starting a job. It tells them which job this is (run_id),
 * what step they're on (step_id), the current state of the workspace,
 * and where they can run code (sandbox).
 *
 * Attributes:
 *   run_id: Unique identifier for the current execution run.
 *   step_id: Which step in the run this tool call belongs to.
 *   state: The current State (working memory) — tools can read/write it.
 *   sandbox: The sandboxed execution environment (for code-running tools).
 */
export class ToolContext {
  run_id: string;
  step_id: number;
  state: unknown;
  sandbox: unknown;

  constructor(options: {
    run_id: string;
    step_id: number;
    state?: unknown;
    sandbox?: unknown;
  }) {
    this.run_id = options.run_id;
    this.step_id = options.step_id;
    this.state = options.state ?? undefined;
    this.sandbox = options.sandbox ?? undefined;
  }
}

/**
 * The interface that any tool implementation must satisfy.
 *
 * Think of Tool as a "contract" — if something claims to be a tool,
 * it must have these attributes and methods. The Protocol approach
 * means you don't need to inherit from anything; just implement
 * the right methods (duck typing with type checking).
 *
 * A Tool is like a vending machine:
 * - name: what's written on the front (e.g., "search", "calculator")
 * - description: the instruction label
 * - input_schema: the coin slot shape (what inputs it accepts)
 * - execute(): put coins in, get a snack out (input → ToolResult)
 */
export interface Tool {
  /** The tool's unique name (used for dispatch). */
  readonly name: string;

  /** What the tool does (sent to the AI model). */
  readonly description: string;

  /** JSON Schema describing the tool's expected inputs. */
  readonly input_schema: Record<string, unknown>;

  /**
   * Run the tool with the given input and context.
   *
   * Args:
   *   input: The arguments to the tool (matching input_schema).
   *   ctx: Execution context (run_id, step_id, state, sandbox).
   *
   * Returns:
   *   A ToolResult with the output (or error if something went wrong).
   */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Raised when trying to execute a tool that isn't registered.
 *
 * Like trying to open an app that's not installed on your phone.
 */
export class ToolNotFoundError extends Error {
  /** The name of the tool that wasn't found. */
  tool_name: string;

  /**
   * Initialize with the missing tool's name.
   *
   * Args:
   *   name: The name of the tool that wasn't found.
   */
  constructor(name: string) {
    super(`Tool not found: '${name}'`);
    this.tool_name = name;
  }
}

/**
 * A dict-like container that holds all available tools.
 *
 * Think of ToolRegistry as the phone's app store. You can:
 * - register(): Install a new tool (like downloading an app)
 * - get(): Look up a tool by name (like searching for an app)
 * - list_schemas(): See all installed tools' interfaces
 * - execute(): Find a tool and run it in one step
 *
 * The registry is the single source of truth for what tools are available.
 */
export class ToolRegistry {
  private _tools: Record<string, Tool>;

  /** Initialize an empty registry with no tools. */
  constructor() {
    this._tools = {};
  }

  /**
   * Register a tool, making it available for execution.
   *
   * Args:
   *   tool: The tool to register. Must have name, description,
   *         input_schema, and execute().
   *
   * Returns:
   *   The ToolSchema extracted from the tool (useful for serialization).
   *
   * Raises:
   *   ValueError: If a tool with the same name is already registered.
   */
  register(tool: Tool): ToolSchema {
    if (tool.name in this._tools) {
      throw new Error(
        `Tool '${tool.name}' is already registered. ` +
          "Use a different name or unregister first."
      );
    }
    this._tools[tool.name] = tool;
    return new ToolSchema({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    });
  }

  /**
   * Look up a tool by name.
   *
   * Args:
   *   name: The tool name to search for.
   *
   * Returns:
   *   The tool if found, None otherwise.
   */
  get(name: string): Tool | null {
    return this._tools[name] ?? null;
  }

  /**
   * Check if a tool with the given name is registered.
   *
   * Args:
   *   name: The tool name to check.
   *
   * Returns:
   *   True if the tool is registered, False otherwise.
   */
  has(name: string): boolean {
    return name in this._tools;
  }

  /**
   * Get schemas for all registered tools.
   *
   * This is what you'd send to the AI model so it knows what tools
   * are available. Each schema tells the model the tool's name,
   * description, and expected input format.
   *
   * Returns:
   *   A list of ToolSchema objects, one per registered tool.
   */
  list_schemas(): ToolSchema[] {
    return Object.values(this._tools).map(
      (tool) =>
        new ToolSchema({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
        })
    );
  }

  /**
   * Find a tool by name and execute it.
   *
   * This is a convenience method that combines get() + execute().
   * If the tool isn't found, returns an error ToolResult instead
   * of raising an exception (so the agent can recover gracefully).
   *
   * Args:
   *   name: The name of the tool to execute.
   *   input: The arguments to pass to the tool.
   *   ctx: Execution context (run_id, step_id, state, sandbox).
   *
   * Returns:
   *   A ToolResult with the tool's output, or an error if the
   *   tool wasn't found or execution failed.
   *
   * Raises:
   *   ToolNotFoundError: If the tool is not registered.
   */
  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.get(name);
    if (tool === null) {
      throw new ToolNotFoundError(name);
    }
    return tool.execute(input, ctx);
  }

  /** Return the number of registered tools. */
  get length(): number {
    return Object.keys(this._tools).length;
  }

  /** Support `name in registry` syntax. */
  contains(name: string): boolean {
    return name in this._tools;
  }

  /**
   * Get a list of all registered tool names.
   *
   * Returns:
   *   List of tool name strings.
   */
  names(): string[] {
    return Object.keys(this._tools);
  }
}
