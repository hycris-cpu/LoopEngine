/**
 * The RunLoop is the HEART of the framework — the main execution loop.
 *
 * Plain English: The RunLoop is like a game loop in a video game.
 * Each "frame" (step):
 * 1. We look at the current situation (step_start processors assemble context)
 * 2. We think about what to do (before_model processors make final adjustments)
 * 3. We ask the AI for a decision (call the model)
 * 4. We process the AI's response (after_model processors review it)
 * 5. We execute any tools the AI requested (before_tool → execute → after_tool)
 * 6. We observe what happened (step_end processors record observations)
 * 7. We check if we're done (budget exhausted? max steps? task complete?)
 * 8. If done, evaluate the whole run (task_end processors)
 *
 * The loop is PURE — all behavior is driven by processors.
 * If you want different behavior, you add/change processors, not the loop itself.
 * This is the "single source of truth" principle from Harness-1.
 */

import { randomUUID } from 'node:crypto';
import type { ProcessorEntry } from '../composition/config';
import type { HarnessConfig } from '../composition/config';
import type { Sandbox } from './sandbox';
import { Event, EvalResult, Message, MessageType, ToolCall, ToolResult } from '../primitives/events';
import { HOOK_POINTS, ProcessorChain } from '../primitives/processors';
import { State } from '../primitives/state';
import type { Tool } from '../primitives/tools';
import { ToolContext } from '../primitives/tools';
import { Trajectory, TrajectoryStep } from '../primitives/trajectory';
import type { Task } from './task';

/**
 * Protocol defining the interface to a language model.
 *
 * Plain English: A ModelProvider is like a phone call to a smart friend.
 * You give them the conversation so far (messages) and a list of things
 * they can do (tools), and they tell you what they'd say or do next.
 *
 * Implementations could wrap OpenAI, Anthropic, local models, or even
 * a human in the loop. The RunLoop doesn't care — it just calls
 * complete() and gets a Message back.
 */
export interface ModelProvider {
  /**
   * Generate the next assistant response.
   *
   * Args:
   *   messages: The conversation history (what the model sees).
   *   tools: Optional list of tool schemas in OpenAI format.
   *
   * Returns:
   *   A Message (role=assistant) with the model's response.
   *   If the model wants to call tools, they appear in tool_calls.
   */
  complete(messages: readonly Message[], tools?: Record<string, unknown>[] | null): Promise<Message>;

  /**
   * Estimate the token count for a list of messages.
   *
   * This is used for budget tracking — we need to know how many
   * tokens each step consumed to enforce the budget limit.
   *
   * Args:
   *   messages: The messages to count tokens for.
   *
   * Returns:
   *   Estimated number of tokens.
   */
  count_tokens(messages: readonly Message[]): number;
}

/**
 * The outcome of a single agent run — immutable and complete.
 *
 * Plain English: After the agent finishes a task (or runs out of budget),
 * a RunResult captures everything that happened:
 * - trajectory: The full step-by-step record of what the agent did
 * - eval_result: How well the agent scored (if evaluated)
 * - total_steps: How many steps the agent took
 * - total_tokens: How many tokens were consumed
 * - exit_reason: WHY the run ended (end_turn, max_steps, budget, done)
 *
 * Frozen means it can never be changed after creation — the run's outcome
 * is carved in stone, like a final exam score.
 */
export class RunResult {
  readonly trajectory: Trajectory;
  readonly eval_result: EvalResult | null;
  readonly total_steps: number;
  readonly total_tokens: number;
  readonly exit_reason: string;

  constructor(options: {
    trajectory?: Trajectory;
    eval_result?: EvalResult | null;
    total_steps?: number;
    total_tokens?: number;
    exit_reason?: string;
  } = {}) {
    this.trajectory = options.trajectory ?? new Trajectory();
    this.eval_result = options.eval_result ?? null;
    this.total_steps = options.total_steps ?? 0;
    this.total_tokens = options.total_tokens ?? 0;
    this.exit_reason = options.exit_reason ?? 'end_turn';
  }
}

/**
 * Execute the main agent loop — the heart of LoopEngine.
 *
 * Plain English: This is the "game loop" that drives the agent. It goes
 * step by step, asking the AI what to do, executing tools, and checking
 * if we're done. Think of it like a very methodical assistant:
 * 1. Read the task (set up initial state)
 * 2. For each step:
 *    a. Prepare context (step_start processors)
 *    b. Final adjustments (before_model processors)
 *    c. Ask the AI (call model.complete)
 *    d. Process the answer (after_model processors)
 *    e. Run any tools the AI requested
 *    f. Record what happened (step_end processors)
 *    g. Check if done
 * 3. Evaluate the full run (task_end processors)
 *
 * The loop is driven by processors — the same loop with different
 * processors produces completely different agent behavior.
 *
 * Args:
 *   task: The task to execute (defines prompt, limits, evaluation).
 *   model: The language model provider to call.
 *   config: Optional HarnessConfig with processors and tools.
 *   sandbox: Optional sandboxed execution environment.
 *   run_id: Optional unique identifier for this run (auto-generated if None).
 *
 * Returns:
 *   A RunResult with the trajectory, evaluation, and run statistics.
 */
export async function run_loop(
  task: Task,
  model: ModelProvider,
  config: HarnessConfig | null = null,
  sandbox: Sandbox | null = null,
  run_id: string | null = null
): Promise<RunResult> {
  if (run_id === null) {
    run_id = `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  // Extract processors and tools from config
  const processorEntries: ProcessorEntry[] = config?.processors ?? [];
  const tools: Tool[] = config?.tools ?? [];

  // Build processor chains for each hook point
  // Sort by order so lower-order processors run first
  const hookChains: Record<string, ProcessorChain> = {};
  for (const hook of HOOK_POINTS) {
    const hookProcs = processorEntries
      .filter((pe) => pe.hook === hook)
      .sort((a, b) => a.order - b.order);
    hookChains[hook] = new ProcessorChain(hookProcs.map((pe) => pe.processor));
  }

  // Initialize state from the task
  const state = new State({ budget: task.budget });

  // Build tool schemas for the model
  const toolSchemas = tools.length > 0 ? tools.map((t) => t.input_schema) : null;

  // Build a tool name → tool mapping for dispatch
  const toolMap: Record<string, Tool> = {};
  for (const t of tools) {
    toolMap[t.name] = t;
  }

  // Initialize trajectory
  const trajectory = new Trajectory({ task_id: run_id });

  // Add the initial user message with the task prompt
  const initialMsg = new Message({
    type: 'message',
    run_id,
    step_id: 0,
    role: MessageType.USER,
    content: task.prompt,
  });
  state.add_message(initialMsg);

  // Emit task_start event
  const taskStartEvent = new Event({ type: 'task_start', run_id, step_id: 0 });
  await _emit_event(taskStartEvent, hookChains, state);

  let exitReason = 'end_turn';
  let totalTokens = 0;
  let brokeEarly = false;

  // ---- Main loop ----
  for (let step = 0; step < task.max_steps; step++) {
    state.step = step;

    // 1. step_start — assemble context
    const stepStartEvent = new Event({ type: 'step_start', run_id, step_id: step });
    await _emit_event(stepStartEvent, hookChains, state);

    // Take a snapshot for the trajectory step
    const snapshotBefore = state.snapshot();

    // 2. before_model — final adjustments before calling AI
    const beforeModelEvent = new Event({ type: 'before_model', run_id, step_id: step });
    await _emit_event(beforeModelEvent, hookChains, state);

    // 3. Call the model
    const assistantMsg = await model.complete([...state.messages], toolSchemas);

    // Record the assistant message
    state.add_message(assistantMsg);

    // Track token usage
    const stepTokens = model.count_tokens(state.messages);
    totalTokens += stepTokens;
    state.record_usage(stepTokens);

    // 4. after_model — processors review the response
    const afterModelEvent = new Event({ type: 'after_model', run_id, step_id: step });
    await _emit_event(afterModelEvent, hookChains, state);

    // Collect observations (tool results) for the trajectory step
    const observations: ToolResult[] = [];

    // 5. Execute tool calls (if any)
    if (assistantMsg.tool_calls.length > 0) {
      for (const toolCall of assistantMsg.tool_calls) {
        // before_tool
        const beforeToolEvent = new Event({ type: 'before_tool', run_id, step_id: step });
        await _emit_event(beforeToolEvent, hookChains, state);

        // Execute the tool
        const toolResult = await _execute_tool(toolCall, toolMap, state, sandbox, run_id, step);
        observations.push(toolResult);

        // Record tool result as a message the model can see
        const toolResultMsg = new Message({
          type: 'message',
          run_id,
          step_id: step,
          role: MessageType.TOOL,
          content: toolResult.is_error ? (toolResult.error ?? '') : toolResult.output,
        });
        state.add_message(toolResultMsg);

        // after_tool
        const afterToolEvent = new Event({ type: 'after_tool', run_id, step_id: step });
        await _emit_event(afterToolEvent, hookChains, state);
      }
    }

    // 6. step_end — record observations
    const stepEndEvent = new Event({ type: 'step_end', run_id, step_id: step });
    await _emit_event(stepEndEvent, hookChains, state);

    // Record the trajectory step
    const delta = state.compute_delta(snapshotBefore);
    const trajStep = new TrajectoryStep({
      state_before: snapshotBefore,
      action: assistantMsg,
      observations,
      reward: 0.0,
      delta,
      metadata: { step, run_id },
    });
    trajectory.add_step(trajStep);

    // 7. Check termination conditions
    if (assistantMsg.tool_calls.length === 0) {
      exitReason = 'end_turn';
      brokeEarly = true;
      break;
    }

    if (task.is_done(state)) {
      exitReason = 'done';
      brokeEarly = true;
      break;
    }

    if (state.is_budget_exhausted) {
      exitReason = 'budget';
      brokeEarly = true;
      break;
    }
  }

  // If the loop completed without a break, we hit max_steps.
  if (!brokeEarly) {
    exitReason = 'max_steps';
  }

  // 8. task_end — evaluate and wrap up
  const taskEndEvent = new Event({ type: 'task_end', run_id, step_id: state.step });
  await _emit_event(taskEndEvent, hookChains, state);

  // Evaluate the task (if the task has an evaluate method)
  const evalResult = await task.evaluate(trajectory);

  return new RunResult({
    trajectory,
    eval_result: evalResult,
    total_steps: trajectory.length,
    total_tokens: totalTokens,
    exit_reason: exitReason,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Emit an event through the appropriate hook chain.
 *
 * This is the "routing" logic — each event type maps to a specific
 * hook point, and the event is processed through that hook's chain.
 *
 * Args:
 *   event: The event to emit.
 *   hookChains: Mapping from hook point name to ProcessorChain.
 *   state: The current agent state (processors may modify it).
 */
async function _emit_event(
  event: Event,
  hookChains: Record<string, ProcessorChain>,
  state: State
): Promise<void> {
  const chain = hookChains[event.type];
  if (chain === undefined) {
    return;
  }
  for await (const _ of chain.process(event)) {
    // Processors may mutate state as a side effect; emitted events are discarded.
  }
}

/**
 * Execute a single tool call and return the result.
 *
 * Plain English: This is the "work order fulfillment" step.
 * The assistant submitted a work order (ToolCall), and this function
 * finds the right worker (tool), gives them the order, and collects
 * the result.
 *
 * Args:
 *   toolCall: The tool call to execute.
 *   toolMap: Mapping from tool name to tool instance.
 *   state: The current agent state.
 *   sandbox: Optional sandbox for execution.
 *   runId: The current run identifier.
 *   step: The current step number.
 *
 * Returns:
 *   A ToolResult with the tool's output or an error message.
 */
async function _execute_tool(
  toolCall: ToolCall,
  toolMap: Record<string, Tool>,
  state: State,
  sandbox: Sandbox | null,
  runId: string,
  step: number
): Promise<ToolResult> {
  const tool = toolMap[toolCall.name];
  if (tool === undefined) {
    return new ToolResult({
      run_id: runId,
      step_id: step,
      call_id: toolCall.id,
      output: '',
      error: `Tool not found: ${toolCall.name}`,
    });
  }

  const ctx = new ToolContext({
    run_id: runId,
    step_id: step,
    state,
    sandbox,
  });

  try {
    return await tool.execute(toolCall.input, ctx);
  } catch (exc) {
    return new ToolResult({
      run_id: runId,
      step_id: step,
      call_id: toolCall.id,
      output: '',
      error: `Tool execution error: ${exc}`,
    });
  }
}
