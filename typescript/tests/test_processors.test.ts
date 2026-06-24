import { describe, test, expect } from 'bun:test';
import { Event } from '../src/primitives/events';
import { Message, MessageType } from '../src/primitives/events';
import { HOOK_POINTS, MultiHookProcessor, ProcessorChain, pipe, pipe_all } from '../src/primitives/processors';
import type { Processor } from '../src/primitives/processors';
import { makeRunId, collectAsync } from './fixtures';

test('HOOK_POINTS defined', () => {
  expect(HOOK_POINTS.length).toBe(8);
  expect(HOOK_POINTS).toContain('task_start');
  expect(HOOK_POINTS).toContain('step_start');
  expect(HOOK_POINTS).toContain('before_model');
  expect(HOOK_POINTS).toContain('after_model');
  expect(HOOK_POINTS).toContain('before_tool');
  expect(HOOK_POINTS).toContain('after_tool');
  expect(HOOK_POINTS).toContain('step_end');
  expect(HOOK_POINTS).toContain('task_end');
});

test('Processor protocol compliance', () => {
  class SimpleProcessor implements Processor {
    get name() { return 'simple'; }
    async *process(event: Event) { yield event; }
  }
  const proc = new SimpleProcessor();
  expect(proc.name).toBe('simple');
});

test('MultiHookProcessor name', () => {
  const proc = new MultiHookProcessor('my_processor');
  expect(proc.name).toBe('my_processor');
});

test('MultiHookProcessor dispatch pass-through', async () => {
  const runId = makeRunId();
  const proc = new MultiHookProcessor('pass_through');
  const event = new Message({ type: 'message', run_id: runId, step_id: 0, role: MessageType.USER, content: 'hello' });
  const results = await collectAsync(proc.dispatch(event, 'task_start'));
  expect(results.length).toBe(1);
  expect(results[0]).toBe(event);
});

test('MultiHookProcessor custom modification', async () => {
  const runId = makeRunId();
  class MetadataAdder extends MultiHookProcessor {
    constructor() { super('metadata_adder'); }
    async *on_after_model(event: Event) {
      if (event instanceof Message) {
        yield new Message({
          ...event,
          metadata: { ...event.metadata, processed: true },
        });
      } else {
        yield event;
      }
    }
  }
  const proc = new MetadataAdder();
  const event = new Message({ type: 'message', run_id: runId, step_id: 0, role: MessageType.ASSISTANT, content: 'I think the answer is 42.' });
  const results = await collectAsync(proc.dispatch(event, 'after_model'));
  expect(results.length).toBe(1);
  expect((results[0] as Message).metadata['processed']).toBe(true);
  expect((results[0] as Message).content).toBe('I think the answer is 42.');
});

test('MultiHookProcessor suppression', async () => {
  const runId = makeRunId();
  class ToolSuppressor extends MultiHookProcessor {
    constructor() { super('tool_suppressor'); }
    async *on_before_tool(_event: Event) {
      // yield nothing — suppress
    }
  }
  const proc = new ToolSuppressor();
  const event = new Event({ type: 'tool_call', run_id: runId, step_id: 0 });
  const results = await collectAsync(proc.dispatch(event, 'before_tool'));
  expect(results.length).toBe(0);
});

test('ProcessorChain empty pass-through', async () => {
  const runId = makeRunId();
  const chain = new ProcessorChain([]);
  const event = new Event({ type: 'test', run_id: runId, step_id: 0 });
  const results = await collectAsync(chain.process(event));
  expect(results.length).toBe(1);
  expect(results[0]).toBe(event);
});

test('ProcessorChain single pass-through', async () => {
  const runId = makeRunId();
  class Passthrough implements Processor {
    get name() { return 'passthrough'; }
    async *process(event: Event) { yield event; }
  }
  const chain = new ProcessorChain([new Passthrough()]);
  const event = new Event({ type: 'test', run_id: runId, step_id: 0 });
  const results = await collectAsync(chain.process(event));
  expect(results.length).toBe(1);
  expect(results[0]).toBe(event);
});

test('ProcessorChain multiple modifiers', async () => {
  const runId = makeRunId();
  class StepAdder implements Processor {
    constructor(private _name: string) {}
    get name() { return this._name; }
    async *process(event: Event) {
      yield new Event({ type: event.type, run_id: event.run_id, step_id: event.step_id + 1, ts: event.ts });
    }
  }
  const chain = new ProcessorChain([new StepAdder('first'), new StepAdder('second')]);
  const event = new Event({ type: 'test', run_id: runId, step_id: 0 });
  const results = await collectAsync(chain.process(event));
  expect(results.length).toBe(1);
  expect(results[0].step_id).toBe(2);
});

test('ProcessorChain suppression stops propagation', async () => {
  const runId = makeRunId();
  class Passthrough implements Processor {
    constructor(private _name: string) {}
    get name() { return this._name; }
    async *process(event: Event) { yield event; }
  }
  class Suppressor implements Processor {
    get name() { return 'suppressor'; }
    async *process(_event: Event) { /* yield nothing */ }
  }
  const chain = new ProcessorChain([new Passthrough('first'), new Suppressor(), new Passthrough('third')]);
  const event = new Event({ type: 'test', run_id: runId, step_id: 0 });
  const results = await collectAsync(chain.process(event));
  expect(results.length).toBe(0);
});

test('ProcessorChain injection', async () => {
  const runId = makeRunId();
  class Duplicator implements Processor {
    get name() { return 'duplicator'; }
    async *process(event: Event) { yield event; yield event; }
  }
  const chain = new ProcessorChain([new Duplicator()]);
  const event = new Event({ type: 'test', run_id: runId, step_id: 0 });
  const results = await collectAsync(chain.process(event));
  expect(results.length).toBe(2);
});

test('pipe helper', async () => {
  const runId = makeRunId();
  class Passthrough implements Processor {
    get name() { return 'passthrough'; }
    async *process(event: Event) { yield event; }
  }
  const event = new Event({ type: 'test', run_id: runId, step_id: 0 });
  const processors: Processor[] = [new Passthrough(), new Passthrough()];
  const results = await pipe(event, processors);
  expect(results.length).toBe(1);
});

test('pipe_all helper', async () => {
  const runId = makeRunId();
  class Passthrough implements Processor {
    get name() { return 'passthrough'; }
    async *process(event: Event) { yield event; }
  }
  const events = [
    new Event({ type: 'test', run_id: runId, step_id: 0 }),
    new Event({ type: 'test', run_id: runId, step_id: 1 }),
    new Event({ type: 'test', run_id: runId, step_id: 2 }),
  ];
  const results = await pipe_all(events, [new Passthrough()]);
  expect(results.length).toBe(3);
  expect(results[0].step_id).toBe(0);
  expect(results[1].step_id).toBe(1);
  expect(results[2].step_id).toBe(2);
});

test('ProcessorChain name', () => {
  class Alpha implements Processor {
    get name() { return 'alpha'; }
    async *process(event: Event) { yield event; }
  }
  class Beta implements Processor {
    get name() { return 'beta'; }
    async *process(event: Event) { yield event; }
  }
  const chain = new ProcessorChain([new Alpha(), new Beta()]);
  expect(chain.name).toContain('alpha');
  expect(chain.name).toContain('beta');
});

test('dispatch invalid hook_point', async () => {
  const runId = makeRunId();
  const proc = new MultiHookProcessor('test');
  const event = new Event({ type: 'test', run_id: runId, step_id: 0 });
  expect(async () => {
    for await (const _ of proc.dispatch(event, 'nonexistent_hook' as any)) {
      // pass
    }
  }).toThrow(/Unknown hook_point/);
});

test('pipe_all with suppression', async () => {
  const runId = makeRunId();
  class StepFilter implements Processor {
    get name() { return 'step_filter'; }
    async *process(event: Event) {
      if (event.step_id === 0) yield event;
    }
  }
  const events = [
    new Event({ type: 'test', run_id: runId, step_id: 0 }),
    new Event({ type: 'test', run_id: runId, step_id: 1 }),
    new Event({ type: 'test', run_id: runId, step_id: 2 }),
  ];
  const results = await pipe_all(events, [new StepFilter()]);
  expect(results.length).toBe(1);
  expect(results[0].step_id).toBe(0);
});
