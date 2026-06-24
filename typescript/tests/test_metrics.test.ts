import { describe, test, expect } from 'bun:test';
import { Trajectory, TrajectoryStep } from '../src/primitives/trajectory';
import { PassRateMetric, EfficiencyMetric, CustomMetric } from '../src/evaluation/metrics';
import type { Metric } from '../src/evaluation/metrics';

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

describe('Metric protocol', () => {
  test('exists', () => { expect(PassRateMetric).toBeDefined(); });
  test('protocol check', () => {
    class MyMetric implements Metric {
      get name() { return 'my_metric'; }
      async evaluate() { return 0.9; }
    }
    expect(new MyMetric().name).toBe('my_metric');
  });
});

describe('PassRateMetric', () => {
  test('creation', () => {
    const sandbox = mockSandbox(['', '', 0]);
    const metric = new PassRateMetric('pytest', sandbox);
    expect(metric.name).toBe('pass_rate');
    expect(metric.test_command).toBe('pytest');
  });

  test('all pass', async () => {
    const sandbox = mockSandbox(['10 passed in 0.5s', '', 0]);
    const metric = new PassRateMetric('pytest', sandbox);
    const score = await metric.evaluate(new Trajectory(), new StubTask());
    expect(score).toBe(1.0);
  });

  test('mixed results', async () => {
    const sandbox = mockSandbox(['7 passed, 3 failed in 1.0s', '', 1]);
    const metric = new PassRateMetric('pytest', sandbox);
    const score = await metric.evaluate(new Trajectory(), new StubTask());
    expect(score).toBeCloseTo(0.7);
  });
});

describe('EfficiencyMetric', () => {
  test('creation', () => {
    const metric = new EfficiencyMetric();
    expect(metric.name).toBe('efficiency');
  });

  test('few steps high score', async () => {
    const metric = new EfficiencyMetric();
    const traj = new Trajectory();
    for (let i = 0; i < 3; i++) traj.add_step(new TrajectoryStep());
    const score = await metric.evaluate(traj, new StubTask('test', 10));
    expect(score).toBeCloseTo(0.7);
  });

  test('all steps used', async () => {
    const metric = new EfficiencyMetric();
    const traj = new Trajectory();
    for (let i = 0; i < 10; i++) traj.add_step(new TrajectoryStep());
    const score = await metric.evaluate(traj, new StubTask('test', 10));
    expect(score).toBeCloseTo(0.0);
  });

  test('no steps', async () => {
    const metric = new EfficiencyMetric();
    const traj = new Trajectory();
    const score = await metric.evaluate(traj, new StubTask('test', 10));
    expect(score).toBeCloseTo(1.0);
  });
});

describe('CustomMetric', () => {
  test('creation', () => {
    const metric = new CustomMetric('custom_test', async () => 0.5);
    expect(metric.name).toBe('custom_test');
  });

  test('returns fn result', async () => {
    const metric = new CustomMetric('custom_test', async () => 0.42);
    const score = await metric.evaluate(new Trajectory(), new StubTask());
    expect(score).toBeCloseTo(0.42);
  });

  test('sync function', async () => {
    const metric = new CustomMetric('sync_test', () => 0.77);
    const score = await metric.evaluate(new Trajectory(), new StubTask());
    expect(score).toBeCloseTo(0.77);
  });
});
