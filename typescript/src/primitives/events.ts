/**
 * The Events module defines every "thing that happens" in the system.
 *
 * Plain English: Imagine the agent's life as a movie. Each frame of that movie
 * is an Event. There are different types of frames:
 * - Message: someone says something (user, assistant, system, tool)
 * - ToolCall: the assistant wants to use a tool
 * - ToolResult: the tool gives back a result
 * - EvalResult: someone judges how well we did
 *
 * All Events are IMMUTABLE (frozen=True). Once created, they can never be changed.
 * This is like a historical record — you can't rewrite history, only add new entries.
 */

import { randomUUID } from 'node:crypto';

/**
 * The four "speaking roles" in a conversation.
 *
 * Think of a play with four actors:
 * - SYSTEM: the stage director (sets the scene, gives instructions)
 * - USER: the audience (asks questions, gives tasks)
 * - ASSISTANT: the lead actor (responds, thinks, acts)
 * - TOOL: the props department (returns results from tool calls)
 */
export enum MessageType {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
}


/**
 * Base class for all events in the system.
 *
 * An Event is the atomic unit of history. Every action, message, and result
 * is recorded as an Event. Events are immutable — once created, they're
 * carved in stone. This ensures the integrity of the execution history.
 *
 * Attributes:
 *   type: What kind of event this is (e.g., "message", "tool_call").
 *   run_id: Which execution run this belongs to (like a case number).
 *   step_id: Which step in the run this happened at (0-indexed).
 *   ts: Unix timestamp of when this event occurred.
 */
export class Event {
  readonly type: string;
  readonly run_id: string;
  readonly step_id: number;
  readonly ts: number;

  constructor(options: Partial<Event> = {}) {
    this.type = options.type ?? '';
    this.run_id = options.run_id ?? '';
    this.step_id = options.step_id ?? 0;
    this.ts = options.ts ?? Date.now() / 1000;
  }

  /**
   * Serialize this event to a plain dictionary.
   *
   * Useful for JSON serialization and logging. Subclasses should override
   * to add their specific fields.
   */
  to_dict(): Record<string, unknown> {
    return {
      type: this.type,
      run_id: this.run_id,
      step_id: this.step_id,
      ts: this.ts,
    };
  }

  /** Serialize this event to a JSON string. */
  to_json(): string {
    return JSON.stringify(this.to_dict());
  }
}

/**
 * Metadata attached to a tool call for tracking and debugging.
 *
 * Think of this as the "envelope" around a tool request — it carries
 * routing information, timing data, and other context that helps
 * diagnose issues and measure performance.
 *
 * Attributes:
 *   processor_name: Which processor generated or modified this call.
 *   retry_count: How many times this call has been retried.
 *   timeout_ms: Maximum allowed execution time in milliseconds.
 *   tags: Arbitrary key-value pairs for filtering and analysis.
 */
export class ToolCallMetadata {
  readonly processor_name: string;
  readonly retry_count: number;
  readonly timeout_ms: number;
  readonly tags: Record<string, string>;

  constructor(options: Partial<ToolCallMetadata> = {}) {
    this.processor_name = options.processor_name ?? '';
    this.retry_count = options.retry_count ?? 0;
    this.timeout_ms = options.timeout_ms ?? 30_000;
    this.tags = options.tags ?? {};
  }
}

/**
 * A message in the conversation — someone says something.
 *
 * Messages are the primary communication unit. A conversation is just a
 * sequence of Messages with different roles (system, user, assistant, tool).
 *
 * Attributes:
 *   role: Who is speaking (system, user, assistant, or tool).
 *   content: What they said (text content).
 *   tool_calls: Any tool calls the assistant wants to make (empty for non-assistant).
 *   metadata: Additional structured data (token counts, model info, etc.).
 */
export class Message extends Event {
  readonly role: MessageType;
  readonly content: string;
  readonly tool_calls: readonly ToolCall[];
  readonly metadata: Record<string, unknown>;
  readonly type = 'message';

  constructor(options: Partial<Message> = {}) {
    super(options);
    this.role = options.role ?? MessageType.USER;
    this.content = options.content ?? '';
    this.tool_calls = options.tool_calls ? [...options.tool_calls] : [];
    this.metadata = options.metadata ? { ...options.metadata } : {};
  }

  /** Serialize to dict, including role, content, and tool calls. */
  to_dict(): Record<string, unknown> {
    return {
      ...super.to_dict(),
      role: this.role,
      content: this.content,
      tool_calls: this.tool_calls.map((tc) => tc.to_dict()),
      metadata: { ...this.metadata },
    };
  }

  /**
   * Convert to OpenAI-compatible message format.
   *
   * This is the format expected by the OpenAI Chat Completions API.
   * Other providers (Anthropic, etc.) may need different conversions.
   */
  to_openai_dict(): Record<string, unknown> {
    const d: Record<string, unknown> = {
      role: this.role,
      content: this.content,
    };
    if (this.tool_calls.length > 0) {
      d.tool_calls = this.tool_calls.map((tc) => tc.to_openai_dict());
    }
    return d;
  }
}

/**
 * A request from the assistant to execute a tool.
 *
 * Think of this as a "work order" — the assistant fills out a form saying
 * "I need tool X with these inputs" and hands it to the system.
 *
 * Attributes:
 *   id: Unique identifier for this specific tool call (like a ticket number).
 *   name: Which tool to call (must match a registered tool name).
 *   input: The arguments to pass to the tool (as a dict).
 */
export class ToolCall extends Event {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly type = 'tool_call';

  constructor(options: Partial<ToolCall> = {}) {
    super(options);
    this.name = options.name ?? '';
    this.input = options.input ? { ...options.input } : {};
    this.id = options.id || `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  /** Serialize to dict including id, name, and input. */
  to_dict(): Record<string, unknown> {
    return {
      ...super.to_dict(),
      id: this.id,
      name: this.name,
      input: { ...this.input },
    };
  }

  /** Convert to OpenAI-compatible tool_call format. */
  to_openai_dict(): Record<string, unknown> {
    return {
      id: this.id,
      type: 'function',
      function: {
        name: this.name,
        arguments: JSON.stringify(this.input),
      },
    };
  }
}

/**
 * The result returned after a tool executes.
 *
 * Think of this as the "completed work order" — the tool did its job
 * and here's what came back (or what went wrong).
 *
 * Attributes:
 *   call_id: Which ToolCall this is a response to (links request to result).
 *   output: The tool's output (text, data, whatever it produced).
 *   error: If the tool failed, the error message. None means success.
 */
export class ToolResult extends Event {
  readonly call_id: string;
  readonly output: string;
  readonly error: string | null;
  readonly type = 'tool_result';

  constructor(options: Partial<ToolResult> = {}) {
    super(options);
    this.call_id = options.call_id ?? '';
    this.output = options.output ?? '';
    this.error = options.error ?? null;
  }

  /**
   * Check if this result represents an error.
   *
   * Returns True if the tool execution failed.
   */
  get is_error(): boolean {
    return this.error !== null;
  }

  /** Serialize to dict including call_id, output, and error. */
  to_dict(): Record<string, unknown> {
    return {
      ...super.to_dict(),
      call_id: this.call_id,
      output: this.output,
      error: this.error,
    };
  }
}

/**
 * An evaluation outcome — someone judged how well the agent did.
 *
 * Think of this as a "report card" — after the agent completes a step
 * or task, an evaluator assigns a score and explains why.
 *
 * Attributes:
 *   passed: Whether the evaluation passed (True) or failed (False).
 *   score: Numeric score (0.0 to 1.0, higher is better).
 *   reason: Human-readable explanation of the evaluation.
 *   reward: Numeric reward signal for RL training (can be negative).
 */
export class EvalResult extends Event {
  readonly passed: boolean;
  readonly score: number;
  readonly reason: string;
  readonly reward: number;
  readonly type = 'eval_result';

  constructor(options: Partial<EvalResult> = {}) {
    super(options);
    this.passed = options.passed ?? false;
    this.score = options.score ?? 0.0;
    this.reason = options.reason ?? '';
    this.reward = options.reward ?? 0.0;
  }

  /** Serialize to dict including evaluation details. */
  to_dict(): Record<string, unknown> {
    return {
      ...super.to_dict(),
      passed: this.passed,
      score: this.score,
      reason: this.reason,
      reward: this.reward,
    };
  }
}
