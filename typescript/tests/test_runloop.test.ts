import { describe, test, expect } from 'bun:test';
import { Event, Message, MessageType, ToolCall, ToolResult, EvalResult } from '../src/primitives/events';
import { HOOK_POINTS, MultiHookProcessor } from '../src/primitives/processors';
import type { Processor } from '../src/primitives/processors';
import { Budget, State } from '../src/primitives/state';
import { Trajectory } from '../src/primitives/trajectory';
import { RunResult, run_loop, type ModelProvider } from '../src/execution/runloop';
import { HarnessConfig, ProcessorEntry } from '../src/composition/config';
import type { Task } from '../src/execution/task';
import type { Tool, ToolContext } from '../src/primitives/tools';
import { makeRunId } from './fixtures';

class MockTask implements Task {
  prompt: string;
  max_steps: number;
  budget: Budget;
  private _doneCondition: ((state: State) => boolean) | null;
  private _evalFn: ((trajectory: Trajectory) => EvalResult) | null;

  constructor(opts: { prompt?: string; max_steps?: number; budget?: Budget; doneCondition?: (state: State) => boolean; evalFn?: (trajectory: Trajectory) => EvalResult } = {}) {
    this.prompt = opts.prompt ?? 'What is 2+2?';
    this.max_steps = opts.max_steps ?? 10;
    this.budget = opts.budget ?? new Budget({ max_steps: opts.max_steps ?? 10 });
    this._doneCondition = opts.doneCondition ?? null;
    this._evalFn = opts.evalFn ?? null;
  }

  is_done(state: State): boolean {
    if (this._doneCondition) return this._doneCondition(state);
    return false;
  }

  async evaluate(trajectory: Trajectory): Promise<EvalResult> {
    if (this._evalFn) return this._evalFn(trajectory);
    return new EvalResult({ passed: true, score: 1.0, reason: 'default pass' });
  }
}

class SimpleMockModel implements ModelProvider {
  private _responses: Message[];
  private _callCount = 0;
  private _tokensPerCall: number;

  constructor(responses: Message[], tokensPerCall = 50) {
    this._responses = [...responses];
    this._tokensPerCall = tokensPerCall;
  }

  async complete(messages: readonly Message[], tools?: Record<string, unknown>[] | null): Promise<Message> {
    const idx = Math.min(this._callCount, this._responses.length - 1);
    this._callCount++;
    return this._responses[idx];
  }

  count_tokens(_messages: readonly Message[]): number {
    return this._tokensPerCall;
  }
}

describe('RunResult', () => {
  test('defaults', () => {
    const result = new RunResult();
    expect(result.trajectory).toBeInstanceOf(Trajectory);
    expect(result.trajectory.length).toBe(0);
    expect(result.eval_result).toBeNull();
    expect(result.total_steps).toBe(0);
    expect(result.total_tokens).toBe(0);
    expect(result.exit_reason).toBe('end_turn');
  });

  test('custom values', () => {
    const traj = new Trajectory({ task_id: 't1' });
    const evalR = new EvalResult({ passed: true, score: 0.9, reason: 'great job' });
    const result = new RunResult({ trajectory: traj, eval_result: evalR, total_steps: 7, total_tokens: 1500, exit_reason: 'done' });
    expect(result.trajectory).toBe(traj);
    expect(result.trajectory.task_id).toBe('t1');
    expect(result.eval_result).toBe(evalR);
    expect(result.eval_result!.passed).toBe(true);
    expect(result.eval_result!.score).toBe(0.9);
    expect(result.total_steps).toBe(7);
    expect(result.total_tokens).toBe(1500);
    expect(result.exit_reason).toBe('done');
  });
});

describe('ModelProvider protocol', () => {
  test('protocol compliance', () => {
    class FakeModel implements ModelProvider {
      async complete(messages: readonly Message[], tools?: Record<string, unknown>[] | null): Promise<Message> {
        return new Message({ role: MessageType.ASSISTANT, content: 'hello' });
      }
      count_tokens(_messages: readonly Message[]): number { return 42; }
    }
    const model = new FakeModel();
    expect(typeof model.complete).toBe('function');
    expect(typeof model.count_tokens).toBe('function');
  });
});

describe('run_loop basic flow', () => {
  test('basic no tools', async () => {
    const response = new Message({ role: MessageType.ASSISTANT, content: 'The answer is 42.' });
    const model = new SimpleMockModel([response]);
    const task = new MockTask({ prompt: 'What is the meaning of life?' });
    const result = await run_loop(task, model);
    expect(result).toBeInstanceOf(RunResult);
    expect(result.total_steps).toBe(1);
    expect(result.exit_reason).toBe('end_turn');
    expect(result.trajectory.length).toBe(1);
    expect(result.trajectory.steps[0].action).not.toBeNull();
    expect(result.trajectory.steps[0].action!.content).toBe('The answer is 42.');
  });
});

describe('run_loop with tool calls', () => {
  test('model calls tool then finishes', async () => {
    class EchoTool implements Tool {
      get name() { return 'echo'; }
      get description() { return 'Echo the input back'; }
      get input_schema() { return { type: 'function', function: { name: 'echo', description: 'Echo the input back', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }; }
      async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        return new ToolResult({ call_id: 'call_1', output: (input.text as string) ?? '' });
      }
    }

    const toolCall = new ToolCall({ name: 'echo', input: { text: 'hello world' } });
    const step1Response = new Message({ role: MessageType.ASSISTANT, content: '', tool_calls: [toolCall] });
    const step2Response = new Message({ role: MessageType.ASSISTANT, content: 'The echo said: hello world' });
    const model = new SimpleMockModel([step1Response, step2Response]);
    const task = new MockTask({ prompt: "Echo 'hello world' and tell me the result." });
    const config = new HarnessConfig({ tools: [new EchoTool()] });
    const result = await run_loop(task, model, config);
    expect(result.total_steps).toBe(2);
    expect(result.exit_reason).toBe('end_turn');
    expect(result.trajectory.length).toBe(2);
    const step1 = result.trajectory.steps[0];
    expect(step1.action).not.toBeNull();
    expect(step1.action!.tool_calls.length).toBe(1);
    expect(step1.action!.tool_calls[0].name).toBe('echo');
    expect(step1.observations.length).toBe(1);
    expect(step1.observations[0]).toBeInstanceOf(ToolResult);
    expect((step1.observations[0] as ToolResult).output).toBe('hello world');
  });
});

describe('run_loop respects max_steps', () => {
  test('stops when limit hit', async () => {
    class NoopTool implements Tool {
      get name() { return 'noop'; }
      get description() { return 'Does nothing'; }
      get input_schema() { return { type: 'object', properties: {} }; }
      async execute(): Promise<ToolResult> { return new ToolResult({ call_id: 'noop_1', output: 'ok' }); }
    }

    const toolCall = new ToolCall({ name: 'noop', input: {} });
    class AlwaysCallModel implements ModelProvider {
      async complete(): Promise<Message> {
        return new Message({ role: MessageType.ASSISTANT, content: '', tool_calls: [toolCall] });
      }
      count_tokens() { return 10; }
    }

    const model = new AlwaysCallModel();
    const task = new MockTask({ prompt: 'Do something forever.', max_steps: 3, budget: new Budget({ max_steps: 3 }) });
    const config = new HarnessConfig({ tools: [new NoopTool()] });
    const result = await run_loop(task, model, config);
    expect(result.total_steps).toBe(3);
    expect(result.exit_reason).toBe('max_steps');
  });
});

describe('run_loop respects task.is_done', () => {
  test('stops when task signals done', async () => {
    class NoopTool implements Tool {
      get name() { return 'noop'; }
      get description() { return 'Does nothing'; }
      get input_schema() { return { type: 'object', properties: {} }; }
      async execute(): Promise<ToolResult> { return new ToolResult({ call_id: 'noop_1', output: 'ok' }); }
    }

    const toolCall = new ToolCall({ name: 'noop', input: {} });
    class AlwaysCallModel implements ModelProvider {
      async complete(): Promise<Message> {
        return new Message({ role: MessageType.ASSISTANT, content: '', tool_calls: [toolCall] });
      }
      count_tokens() { return 10; }
    }

    let stepCounter = 0;
    const doneAfterTwo = (_state: State) => { stepCounter++; return stepCounter >= 2; };
    const model = new AlwaysCallModel();
    const task = new MockTask({ prompt: 'Keep going until I say stop.', max_steps: 100, doneCondition: doneAfterTwo });
    const config = new HarnessConfig({ tools: [new NoopTool()] });
    const result = await run_loop(task, model, config);
    expect(result.exit_reason).toBe('done');
    expect(result.total_steps).toBe(2);
  });
});

describe('run_loop tool not found', () => {
  test('handles gracefully', async () => {
    const toolCall = new ToolCall({ name: 'nonexistent_tool', input: { x: 1 } });
    const step1 = new Message({ role: MessageType.ASSISTANT, content: '', tool_calls: [toolCall] });
    const step2 = new Message({ role: MessageType.ASSISTANT, content: "I couldn't find that tool." });
    const model = new SimpleMockModel([step1, step2]);
    const task = new MockTask({ prompt: 'Use the nonexistent tool.' });
    const config = new HarnessConfig({ tools: [] });
    const result = await run_loop(task, model, config);
    expect(result.total_steps).toBe(2);
    expect(result.exit_reason).toBe('end_turn');
    const obs = result.trajectory.steps[0].observations;
    expect(obs.length).toBe(1);
    expect(obs[0]).toBeInstanceOf(ToolResult);
    expect((obs[0] as ToolResult).is_error).toBe(true);
    expect((obs[0] as ToolResult).error).toContain('nonexistent_tool');
  });
});

describe('run_loop tool execution error', () => {
  test('handles gracefully', async () => {
    class BrokenTool implements Tool {
      get name() { return 'broken'; }
      get description() { return 'A tool that always fails'; }
      get input_schema() { return { type: 'object', properties: {} }; }
      async execute(): Promise<ToolResult> { throw new Error('Something went terribly wrong!'); }
    }

    const toolCall = new ToolCall({ name: 'broken', input: {} });
    const step1 = new Message({ role: MessageType.ASSISTANT, content: '', tool_calls: [toolCall] });
    const step2 = new Message({ role: MessageType.ASSISTANT, content: 'The tool broke.' });
    const model = new SimpleMockModel([step1, step2]);
    const task = new MockTask({ prompt: 'Try the broken tool.' });
    const config = new HarnessConfig({ tools: [new BrokenTool()] });
    const result = await run_loop(task, model, config);
    expect(result.total_steps).toBe(2);
    expect(result.exit_reason).toBe('end_turn');
    const obs = result.trajectory.steps[0].observations;
    expect((obs[0] as ToolResult).is_error).toBe(true);
    expect((obs[0] as ToolResult).error).toContain('terribly wrong');
  });
});

describe('run_loop no config', () => {
  test('works with null config', async () => {
    const response = new Message({ role: MessageType.ASSISTANT, content: 'Hello!' });
    const model = new SimpleMockModel([response]);
    const task = new MockTask({ prompt: 'Say hello.' });
    const result = await run_loop(task, model, null);
    expect(result.total_steps).toBe(1);
    expect(result.exit_reason).toBe('end_turn');
    expect(result.eval_result).not.toBeNull();
  });
});

describe('run_loop processors at hook points', () => {
  test('processors called at correct hooks', async () => {
    const calledHooks: string[] = [];
    class TrackingProcessor implements Processor {
      constructor(private _name: string, private _hook: string) {}
      get name() { return this._name; }
      async *process(event: Event) { calledHooks.push(event.type); yield event; }
    }

    const entries = HOOK_POINTS.map(hook => new ProcessorEntry(new TrackingProcessor(`tracker_${hook}`, hook), hook, 0));
    const config = new HarnessConfig({ processors: entries });
    const response = new Message({ role: MessageType.ASSISTANT, content: 'done' });
    const model = new SimpleMockModel([response]);
    const task = new MockTask({ prompt: 'test' });
    calledHooks.length = 0;
    await run_loop(task, model, config);
    expect(calledHooks).toContain('task_start');
    expect(calledHooks).toContain('step_start');
    expect(calledHooks).toContain('before_model');
    expect(calledHooks).toContain('after_model');
    expect(calledHooks).toContain('step_end');
    expect(calledHooks).toContain('task_end');
    expect(calledHooks).not.toContain('before_tool');
    expect(calledHooks).not.toContain('after_tool');
  });
});

describe('RunResult fields populated', () => {
  test('fields correct after real run', async () => {
    class EchoTool implements Tool {
      get name() { return 'echo'; }
      get description() { return 'Echo input'; }
      get input_schema() { return { type: 'object', properties: { text: { type: 'string' } } }; }
      async execute(input: Record<string, unknown>): Promise<ToolResult> {
        return new ToolResult({ call_id: 'c1', output: (input.text as string) ?? '' });
      }
    }

    const toolCall = new ToolCall({ name: 'echo', input: { text: 'hi' } });
    const step1 = new Message({ role: MessageType.ASSISTANT, content: '', tool_calls: [toolCall] });
    const step2 = new Message({ role: MessageType.ASSISTANT, content: 'Done!' });
    const model = new SimpleMockModel([step1, step2], 100);
    const customEval = (traj: Trajectory) => new EvalResult({ passed: true, score: 0.85, reason: 'well done' });
    const task = new MockTask({ prompt: 'Say hi', evalFn: customEval });
    const config = new HarnessConfig({ tools: [new EchoTool()] });
    const result = await run_loop(task, model, config);
    expect(result.total_steps).toBe(2);
    expect(result.total_tokens).toBe(200);
    expect(result.exit_reason).toBe('end_turn');
    expect(result.trajectory.length).toBe(2);
    expect(result.eval_result).not.toBeNull();
    expect(result.eval_result!.passed).toBe(true);
    expect(result.eval_result!.score).toBe(0.85);
    expect(result.eval_result!.reason).toBe('well done');
  });
});
