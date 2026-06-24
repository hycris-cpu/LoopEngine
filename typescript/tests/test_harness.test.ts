import { describe, test, expect } from 'bun:test';
import { Message, MessageType, EvalResult } from '../src/primitives/events';
import { MultiHookProcessor } from '../src/primitives/processors';
import { Budget } from '../src/primitives/state';
import { Trajectory } from '../src/primitives/trajectory';
import { HarnessConfig } from '../src/composition/config';
import { HarnessBuilder } from '../src/composition/builder';
import { RunResult, type ModelProvider } from '../src/execution/runloop';
import { Harness } from '../src/execution/harness';
import type { Task } from '../src/execution/task';

class MockTask implements Task {
  prompt: string;
  max_steps: number;
  budget: Budget;
  private _evalFn: ((trajectory: Trajectory) => EvalResult) | null;
  constructor(opts: { prompt?: string; max_steps?: number; evalFn?: (traj: Trajectory) => EvalResult } = {}) {
    this.prompt = opts.prompt ?? 'test';
    this.max_steps = opts.max_steps ?? 10;
    this.budget = new Budget({ max_steps: opts.max_steps ?? 10 });
    this._evalFn = opts.evalFn ?? null;
  }
  is_done() { return false; }
  async evaluate(trajectory: Trajectory): Promise<EvalResult> {
    if (this._evalFn) return this._evalFn(trajectory);
    return new EvalResult({ passed: true, score: 1.0, reason: 'default pass' });
  }
}

class SimpleModel implements ModelProvider {
  private _content: string;
  private _tokens: number;
  callCount = 0;
  constructor(content = 'done', tokens = 50) {
    this._content = content;
    this._tokens = tokens;
  }
  async complete(): Promise<Message> {
    this.callCount++;
    return new Message({ role: MessageType.ASSISTANT, content: this._content });
  }
  count_tokens() { return this._tokens; }
}

describe('Harness creation', () => {
  test('basic', () => {
    const model = new SimpleModel();
    const config = new HarnessConfig();
    const harness = new Harness(model, config);
    expect(harness.model).toBe(model);
    expect(harness.config).toBe(config);
    expect(harness.sandbox).toBeNull();
  });

  test('with sandbox', () => {
    const model = new SimpleModel();
    const config = new HarnessConfig();
    const sandbox = {} as any;
    const harness = new Harness(model, config, sandbox);
    expect(harness.sandbox).toBe(sandbox);
  });

  test('from_builder', () => {
    const model = new SimpleModel();
    class DummyProcessor extends MultiHookProcessor {
      constructor() { super('dummy'); }
    }
    const builder = new HarnessBuilder()
      .add(new DummyProcessor(), 'step_end')
      .flag('test_flag')
      .slot({ working_dir: '/tmp' });
    const harness = Harness.from_builder(builder, model);
    expect(harness).toBeInstanceOf(Harness);
    expect(harness.model).toBe(model);
    expect(harness.config).not.toBeNull();
    expect(harness.config!.processors.length).toBe(1);
    expect(harness.config!.flags['test_flag']).toBe(true);
    expect(harness.config!.slots['working_dir']).toBe('/tmp');
  });

  test('from_builder with sandbox', () => {
    const model = new SimpleModel();
    const builder = new HarnessBuilder();
    const sandbox = {} as any;
    const harness = Harness.from_builder(builder, model, sandbox);
    expect(harness.sandbox).toBe(sandbox);
  });
});

describe('Harness.run', () => {
  test('delegates to run_loop', async () => {
    const model = new SimpleModel('The answer is 42.');
    const config = new HarnessConfig();
    const harness = new Harness(model, config);
    const task = new MockTask({ prompt: 'What is 2+2?' });
    const result = await harness.run(task);
    expect(result).toBeInstanceOf(RunResult);
    expect(result.total_steps).toBe(1);
    expect(result.exit_reason).toBe('end_turn');
    expect(result.trajectory.steps[0].action!.content).toBe('The answer is 42.');
  });

  test('passes run_id through', async () => {
    const model = new SimpleModel();
    const config = new HarnessConfig();
    const harness = new Harness(model, config);
    const task = new MockTask({ prompt: 'test' });
    const result = await harness.run(task, 'my_run');
    expect(result).toBeInstanceOf(RunResult);
    expect(result.trajectory.steps[0].metadata['run_id']).toBe('my_run');
  });
});

describe('Harness.run_batch', () => {
  test('sequential', async () => {
    const model = new SimpleModel('done');
    const config = new HarnessConfig();
    const harness = new Harness(model, config);
    const tasks = [0, 1, 2].map(i => new MockTask({ prompt: `task ${i}` }));
    const results = await harness.run_batch(tasks, 1);
    expect(results.length).toBe(3);
    for (const result of results) {
      expect(result).toBeInstanceOf(RunResult);
      expect(result.total_steps).toBe(1);
    }
  });

  test('parallel', async () => {
    const model = new SimpleModel('parallel result');
    const config = new HarnessConfig();
    const harness = new Harness(model, config);
    const tasks = [0, 1, 2, 3].map(i => new MockTask({ prompt: `task ${i}` }));
    const results = await harness.run_batch(tasks, 2);
    expect(results.length).toBe(4);
    for (const result of results) {
      expect(result.exit_reason).toBe('end_turn');
    }
  });

  test('empty', async () => {
    const model = new SimpleModel();
    const harness = new Harness(model);
    const results = await harness.run_batch([]);
    expect(results).toEqual([]);
  });
});

describe('Harness toString', () => {
  test('basic', () => {
    const model = new SimpleModel();
    const config = new HarnessConfig();
    const harness = new Harness(model, config);
    const r = harness.toString();
    expect(r).toContain('SimpleModel');
    expect(r).toContain('config=yes');
    expect(r).toContain('sandbox=no');
  });
});
