/**
 * The Processors module defines the "behavioral building blocks" of the framework.
 *
 * Plain English: A Processor is like a security checkpoint at an airport.
 * Events (passengers) flow through processors (checkpoints), and each processor
 * can:
 * - Let the event pass through unchanged (pass-through)
 * - Modify the event (like adding a stamp to a passport)
 * - Suppress the event (deny entry)
 * - Inject new events (create additional passengers)
 *
 * There are 8 "checkpoint locations" (hook points):
 * 1. task_start — when a new task begins
 * 2. step_start — at the beginning of each step
 * 3. before_model — right before we ask the AI for a response
 * 4. after_model — right after the AI responds
 * 5. before_tool — right before we run a tool
 * 6. after_tool — right after a tool finishes
 * 7. step_end — at the end of each step (read-only observation)
 * 8. task_end — when the task is done
 *
 * MultiHookProcessor is a convenience base class — you override only the hooks you care about.
 * ProcessorChain is a pipeline that runs multiple processors in order.
 */

import { Event } from './events';

/**
 * The 8 hook points where processors can intercept events.
 *
 * Think of these as the 8 security checkpoints in an airport:
 * 1. task_start:    The entrance door (new passenger arriving)
 * 2. step_start:    Entering the terminal (start of a new step)
 * 3. before_model:  Before the flight (about to ask the AI)
 * 4. after_model:   After the flight (AI just responded)
 * 5. before_tool:   Before baggage claim (about to run a tool)
 * 6. after_tool:    After baggage claim (tool just finished)
 * 7. step_end:      Leaving the terminal (step complete, observation only)
 * 8. task_end:      Exiting the airport (task complete)
 */
export const HOOK_POINTS = [
  'task_start',
  'step_start',
  'before_model',
  'after_model',
  'before_tool',
  'after_tool',
  'step_end',
  'task_end',
] as const;

/** The valid hook point names for processors. */
export type HookPoint = typeof HOOK_POINTS[number];

/**
 * Map an event type to the corresponding hook point name.
 *
 * This is the "routing" logic that determines which hook an event triggers.
 * Returns None if the event type doesn't map to any hook.
 */
export function event_to_hook(event: Event): HookPoint | null {
  const mapping: Record<string, HookPoint> = {
    task_start: 'task_start',
    step_start: 'step_start',
    before_model: 'before_model',
    after_model: 'after_model',
    before_tool: 'before_tool',
    after_tool: 'after_tool',
    step_end: 'step_end',
    task_end: 'task_end',
  };
  return mapping[event.type] ?? null;
}

/**
 * Protocol defining what a processor must provide.
 *
 * A processor is any object with a name and an async process() method.
 * The process method receives an event and yields zero or more events.
 * - Yielding the same event = pass-through
 * - Yielding a modified event = modification
 * - Yielding nothing = suppression
 * - Yielding additional events = injection
 */
export interface Processor {
  /** A human-readable name for this processor. */
  readonly name: string;

  /**
   * Process an event, yielding zero or more output events.
   *
   * Args:
   *   event: The event to process.
   *
   * Yields:
   *   Events to pass to the next processor (or the final consumer).
   *   Yield nothing to suppress the event.
   *   Yield multiple events to inject additional ones.
   */
  process(event: Event): AsyncIterable<Event>;
}

/**
 * A base class that routes events to specific hook methods.
 *
 * Instead of implementing a single process() method that handles all event
 * types, you override only the hook methods you care about. The default
 * implementation of each hook is pass-through (yield the event unchanged).
 *
 * Think of this as a receptionist who reads each visitor's purpose and
 * directs them to the right department. If no department handles that
 * purpose, the visitor passes through unchanged.
 *
 * Subclasses override specific hooks:
 *     class MyProcessor extends MultiHookProcessor {
 *         async *on_after_model(event: Event): AsyncGenerator<Event> {
 *             // Do something special after the AI responds
 *             yield event;  // pass through
 *         }
 *     }
 */
export class MultiHookProcessor implements Processor {
  private _name: string;

  /** Initialize with a name for this processor. */
  constructor(name: string = 'multi_hook_processor') {
    this._name = name;
  }

  /** This processor's name. */
  get name(): string {
    return this._name;
  }

  // ---- Hook methods (override these in subclasses) ----

  /** Called when a new task begins. Default: pass-through. */
  async *on_task_start(event: Event): AsyncGenerator<Event> {
    yield event;
  }

  /** Called at the start of each step. Default: pass-through. */
  async *on_step_start(event: Event): AsyncGenerator<Event> {
    yield event;
  }

  /** Called right before asking the AI. Default: pass-through. */
  async *on_before_model(event: Event): AsyncGenerator<Event> {
    yield event;
  }

  /** Called right after the AI responds. Default: pass-through. */
  async *on_after_model(event: Event): AsyncGenerator<Event> {
    yield event;
  }

  /** Called right before running a tool. Default: pass-through. */
  async *on_before_tool(event: Event): AsyncGenerator<Event> {
    yield event;
  }

  /** Called right after a tool finishes. Default: pass-through. */
  async *on_after_tool(event: Event): AsyncGenerator<Event> {
    yield event;
  }

  /** Called at the end of each step (read-only). Default: pass-through. */
  async *on_step_end(event: Event): AsyncGenerator<Event> {
    yield event;
  }

  /** Called when the task ends. Default: pass-through. */
  async *on_task_end(event: Event): AsyncGenerator<Event> {
    yield event;
  }

  // ---- Hook map (shared by dispatch and process) ----

  /**
   * Return the mapping from hook point names to hook methods.
   *
   * Returns:
   *   A dict mapping hook point name strings to async generator methods.
   */
  private _get_hook_map(): Record<HookPoint, (event: Event) => AsyncIterable<Event>> {
    return {
      task_start: (event: Event) => this.on_task_start(event),
      step_start: (event: Event) => this.on_step_start(event),
      before_model: (event: Event) => this.on_before_model(event),
      after_model: (event: Event) => this.on_after_model(event),
      before_tool: (event: Event) => this.on_before_tool(event),
      after_tool: (event: Event) => this.on_after_tool(event),
      step_end: (event: Event) => this.on_step_end(event),
      task_end: (event: Event) => this.on_task_end(event),
    };
  }

  // ---- Dispatch logic ----

  /**
   * Route an event to a specific hook by name.
   *
   * Args:
   *   event: The event to process.
   *   hook_point: Which hook to call (must be one of HOOK_POINTS).
   *
   * Yields:
   *   Events from the hook method.
   *
   * Raises:
   *   Error: If hook_point is not a valid hook name.
   */
  async *dispatch(event: Event, hook_point: HookPoint): AsyncGenerator<Event> {
    const hook_map = this._get_hook_map();
    if (!(hook_point in hook_map)) {
      throw new Error(
        `Unknown hook_point '${hook_point}'. Must be one of: ${Object.keys(hook_map).join(', ')}`
      );
    }
    yield* hook_map[hook_point](event);
  }

  /**
   * Route an event to the appropriate hook method based on event type.
   *
   * This is the main entry point for the Processor protocol. It determines
   * which hook to call based on the event's type field, then delegates to
   * that hook.
   *
   * If the event type doesn't map to any hook, it passes through unchanged.
   */
  async *process(event: Event): AsyncGenerator<Event> {
    const hook_map = this._get_hook_map();
    const hook_fn = (hook_map as Record<string, (event: Event) => AsyncIterable<Event>>)[event.type];
    if (hook_fn !== undefined) {
      yield* hook_fn(event);
    } else {
      // Unknown event type — pass through unchanged
      yield event;
    }
  }
}

/**
 * A pipeline that runs events through a sequence of processors.
 *
 * Think of this as an assembly line. Each processor is a station.
 * Events enter at one end, pass through each station in order,
 * and come out the other end (possibly modified, suppressed, or
 * with additional events injected).
 *
 * The chain is ordered: the first processor gets the original event,
 * and each subsequent processor gets the output of the previous one.
 *
 * Attributes:
 *   processors: The ordered list of processors in the chain.
 */
export class ProcessorChain {
  processors: Processor[];

  /**
   * Initialize the chain with an ordered list of processors.
   *
   * Args:
   *   processors: Processors to run, in order.
   */
  constructor(processors: Processor[]) {
    this.processors = [...processors];
  }

  /** A descriptive name for this chain. */
  get name(): string {
    const names = this.processors.map((p) => p.name);
    return `ProcessorChain(${names.join(' -> ')})`;
  }

  /**
   * Run an event through the entire processor chain.
   *
   * Each processor's output becomes the input for the next processor.
   * If a processor suppresses an event (yields nothing), the chain
   * stops for that event — subsequent processors won't see it.
   *
   * Args:
   *   event: The event to process.
   *
   * Yields:
   *   The final output events after passing through all processors.
   */
  async *process(event: Event): AsyncGenerator<Event> {
    if (this.processors.length === 0) {
      yield event;
      return;
    }

    // Start with the initial event
    let current_events: Event[] = [event];

    for (const processor of this.processors) {
      const next_events: Event[] = [];
      for (const evt of current_events) {
        for await (const out_evt of processor.process(evt)) {
          next_events.push(out_evt);
        }
      }
      current_events = next_events;
    }

    for (const evt of current_events) {
      yield evt;
    }
  }
}

/**
 * Run a single event through a list of processors and collect the results.
 *
 * This is a convenience function that creates a temporary ProcessorChain
 * and collects all output events into a list.
 *
 * Args:
 *   event: The event to process.
 *   processors: The processors to run it through, in order.
 *
 * Returns:
 *   A list of output events (may be empty if the event was suppressed).
 */
export async function pipe(event: Event, processors: Processor[]): Promise<Event[]> {
  const chain = new ProcessorChain(processors);
  const results: Event[] = [];
  for await (const out of chain.process(event)) {
    results.push(out);
  }
  return results;
}

/**
 * Run multiple events through a list of processors.
 *
 * Each event is processed independently (not chained together).
 * The results are concatenated in order.
 *
 * Args:
 *   events: The events to process.
 *   processors: The processors to run each event through.
 *
 * Returns:
 *   A flat list of all output events.
 */
export async function pipe_all(events: Event[], processors: Processor[]): Promise<Event[]> {
  const chain = new ProcessorChain(processors);
  const results: Event[] = [];
  for (const event of events) {
    for await (const out of chain.process(event)) {
      results.push(out);
    }
  }
  return results;
}
