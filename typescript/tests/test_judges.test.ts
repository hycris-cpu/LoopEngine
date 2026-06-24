import { describe, test, expect } from 'bun:test';
import { EvalResult, Message, MessageType } from '../src/primitives/events';
import { Trajectory, TrajectoryStep } from '../src/primitives/trajectory';
import { TestSuiteJudge, LLMJudge, MetricJudge, CompositeJudge } from '../src/evaluation/judges';
import type { Judge } from '../src/evaluation/judges';
import type { Metric } from '../src/evaluation/metrics';

// Mock Sandbox
function mockSandbox(execResult: [string, string, number]) {
  return { exec: async () => execResult } as any;
}

class StubTask {
  prompt: string;
  max_steps: number;
  constructor(prompt = 'test', maxSteps = 10) {
    this.prompt = prompt;
    this.max_steps = maxSteps;
  }
  is_done() { return false; }
}

class StubMetric implements Metric {
  private _name: string;
  private _score: number;
  constructor(name: string, score: number) { this._name = name; this._score = score; }
  get name() { return this._name; }
  async evaluate() { return this._score; }
}

describe('Judge protocol', () => {
  test('exists', () => {
    expect(TestSuiteJudge).toBeDefined();
  });

  test('protocol check', () => {
    class MyJudge implements Judge {
      get name() { return 'my_judge'; }
      async evaluate() { return new EvalResult({ passed: true, score: 1.0, reason: 'ok' }); }
    }
    const judge = new MyJudge();
    expect(judge.name).toBe('my_judge');
  });
});

describe('TestSuiteJudge', () => {
  test('creation', () => {
    const sandbox = mockSandbox(['', '', 0]);
    const judge = new TestSuiteJudge('pytest', sandbox);
    expect(judge.name).toBe('test_suite');
    expect(judge.test_command).toBe('pytest');
    expect(judge.sandbox).toBe(sandbox);
  });

  test('all pass', async () => {
    const sandbox = mockSandbox(['10 passed in 0.5s', '', 0]);
    const judge = new TestSuiteJudge('pytest', sandbox);
    const result = await judge.evaluate(new Trajectory(), new StubTask());
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
    expect(result.reason).toContain('10 passed');
  });

  test('mixed results', async () => {
    const sandbox = mockSandbox(['8 passed, 2 failed in 1.0s', '', 1]);
    const judge = new TestSuiteJudge('pytest', sandbox);
    const result = await judge.evaluate(new Trajectory(), new StubTask());
    expect(result.score).toBeCloseTo(0.8);
    expect(result.passed).toBe(false);
  });

  test('all fail', async () => {
    const sandbox = mockSandbox(['', '5 failed in 0.2s', 1]);
    const judge = new TestSuiteJudge('pytest', sandbox);
    const result = await judge.evaluate(new Trajectory(), new StubTask());
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });
});

describe('LLMJudge', () => {
  test('creation', () => {
    const model = {} as any;
    const judge = new LLMJudge(model, 'Rate quality', 0.5);
    expect(judge.name).toBe('llm_judge');
    expect(judge.model).toBe(model);
    expect(judge.rubric).toBe('Rate quality');
  });

  test('parses score', async () => {
    const response = new Message({ role: MessageType.ASSISTANT, content: 'The code is good.\nScore: 0.85' });
    const model = { complete: async () => response } as any;
    const judge = new LLMJudge(model, 'Rate quality 0-1', 0.5);
    const result = await judge.evaluate(new Trajectory(), new StubTask('Write a hello world'));
    expect(result.score).toBeCloseTo(0.85);
    expect(result.reason).toContain('Score: 0.85');
  });

  test('passes when score above threshold', async () => {
    const response = new Message({ role: MessageType.ASSISTANT, content: 'Score: 0.9' });
    const model = { complete: async () => response } as any;
    const judge = new LLMJudge(model, 'Rate quality', 0.8);
    const result = await judge.evaluate(new Trajectory(), new StubTask());
    expect(result.passed).toBe(true);
  });

  test('fails when score below threshold', async () => {
    const response = new Message({ role: MessageType.ASSISTANT, content: 'Score: 0.3' });
    const model = { complete: async () => response } as any;
    const judge = new LLMJudge(model, 'Rate quality', 0.8);
    const result = await judge.evaluate(new Trajectory(), new StubTask());
    expect(result.passed).toBe(false);
    expect(result.score).toBeCloseTo(0.3);
  });
});

describe('MetricJudge', () => {
  test('creation', () => {
    const metrics = [new StubMetric('speed', 0.8), new StubMetric('quality', 0.9)];
    const judge = new MetricJudge(metrics);
    expect(judge.name).toBe('metric_judge');
    expect(judge.metrics.length).toBe(2);
  });

  test('averages scores', async () => {
    const metrics = [new StubMetric('speed', 0.8), new StubMetric('quality', 0.9)];
    const judge = new MetricJudge(metrics);
    const result = await judge.evaluate(new Trajectory(), new StubTask());
    expect(result.score).toBeCloseTo(0.85);
    expect(result.reason).toContain('speed');
    expect(result.reason).toContain('quality');
  });
});

describe('CompositeJudge', () => {
  test('creation', () => {
    const j1 = { name: 'j1', evaluate: async () => new EvalResult({ passed: true, score: 1.0 }) } as Judge;
    const j2 = { name: 'j2', evaluate: async () => new EvalResult({ passed: true, score: 0.5 }) } as Judge;
    const composite = new CompositeJudge([[j1, 0.6], [j2, 0.4]]);
    expect(composite.name).toBe('composite');
    expect(composite.judges.length).toBe(2);
  });

  test('weighted average', async () => {
    const j1 = { name: 'judge1', evaluate: async () => new EvalResult({ passed: true, score: 1.0, reason: 'perfect' }) } as Judge;
    const j2 = { name: 'judge2', evaluate: async () => new EvalResult({ passed: false, score: 0.5, reason: 'ok' }) } as Judge;
    const composite = new CompositeJudge([[j1, 0.6], [j2, 0.4]]);
    const result = await composite.evaluate(new Trajectory(), new StubTask());
    expect(result.score).toBeCloseTo(0.8);
  });

  test('equal weights', async () => {
    const j1 = { name: 'judge1', evaluate: async () => new EvalResult({ passed: true, score: 0.6, reason: 'a' }) } as Judge;
    const j2 = { name: 'judge2', evaluate: async () => new EvalResult({ passed: true, score: 1.0, reason: 'b' }) } as Judge;
    const composite = new CompositeJudge([[j1, 0.5], [j2, 0.5]]);
    const result = await composite.evaluate(new Trajectory(), new StubTask());
    expect(result.score).toBeCloseTo(0.8);
  });
});
