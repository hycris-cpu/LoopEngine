import { describe, test, expect } from 'bun:test';
import { EvalResult } from '../src/primitives/events';
import { Trajectory, TrajectoryStep } from '../src/primitives/trajectory';
import { Benchmark, BenchmarkResult, Comparison, compare } from '../src/evaluation/benchmark';
import type { Judge } from '../src/evaluation/judges';

class StubTask {
  prompt: string;
  max_steps: number;
  constructor(prompt = 'test', maxSteps = 10) {
    this.prompt = prompt;
    this.max_steps = maxSteps;
  }
  is_done() { return false; }
}

describe('BenchmarkResult', () => {
  test('creation', () => {
    const scores: Record<string, EvalResult> = {
      task1: new EvalResult({ passed: true, score: 0.9, reason: 'good' }),
      task2: new EvalResult({ passed: false, score: 0.5, reason: 'ok' }),
    };
    const result = new BenchmarkResult({ scores, aggregate: { mean_score: 0.7, pass_rate: 0.5 } });
    expect(result.scores).toEqual(scores);
    expect(result.aggregate).toEqual({ mean_score: 0.7, pass_rate: 0.5 });
  });
});

describe('Benchmark', () => {
  test('creation', () => {
    const judge = {} as Judge;
    const benchmark = new Benchmark(judge, 2);
    expect(benchmark.judge).toBe(judge);
    expect(benchmark.parallelism).toBe(2);
  });

  test('runs tasks', async () => {
    let callCount = 0;
    const judge = {
      name: 'test_judge',
      evaluate: async () => {
        callCount++;
        const scores = [
          new EvalResult({ passed: true, score: 0.9, reason: 'good' }),
          new EvalResult({ passed: false, score: 0.5, reason: 'ok' }),
          new EvalResult({ passed: true, score: 0.8, reason: 'nice' }),
        ];
        return scores[callCount - 1];
      },
    } as Judge;
    const tasks = Array.from({ length: 3 }, (_, i) => new StubTask(`task ${i}`));
    const benchmark = new Benchmark(judge);
    const result = await benchmark.run(tasks);
    expect(Object.keys(result.scores).length).toBe(3);
    expect(callCount).toBe(3);
  });

  test('aggregates mean', async () => {
    let callCount = 0;
    const judge = {
      name: 'test_judge',
      evaluate: async () => {
        const scores = [
          new EvalResult({ passed: true, score: 0.9 }),
          new EvalResult({ passed: false, score: 0.5 }),
          new EvalResult({ passed: true, score: 0.8 }),
        ];
        return scores[callCount++];
      },
    } as Judge;
    callCount = 0;
    const tasks = Array.from({ length: 3 }, (_, i) => new StubTask(`task ${i}`));
    const benchmark = new Benchmark(judge);
    const result = await benchmark.run(tasks);
    const expectedMean = (0.9 + 0.5 + 0.8) / 3;
    expect(result.aggregate['mean_score']).toBeCloseTo(expectedMean);
  });

  test('aggregates pass_rate', async () => {
    let callCount = 0;
    const judge = {
      name: 'test_judge',
      evaluate: async () => {
        const scores = [
          new EvalResult({ passed: true, score: 0.9 }),
          new EvalResult({ passed: false, score: 0.5 }),
          new EvalResult({ passed: true, score: 0.8 }),
        ];
        return scores[callCount++];
      },
    } as Judge;
    callCount = 0;
    const tasks = Array.from({ length: 3 }, (_, i) => new StubTask(`task ${i}`));
    const benchmark = new Benchmark(judge);
    const result = await benchmark.run(tasks);
    expect(result.aggregate['pass_rate']).toBeCloseTo(2 / 3);
  });
});

describe('compare()', () => {
  test('identical results', () => {
    const scores: Record<string, EvalResult> = {
      task1: new EvalResult({ passed: true, score: 0.8 }),
      task2: new EvalResult({ passed: true, score: 0.9 }),
    };
    const a = new BenchmarkResult({ scores, aggregate: { mean_score: 0.85, pass_rate: 1.0 } });
    const b = new BenchmarkResult({ scores, aggregate: { mean_score: 0.85, pass_rate: 1.0 } });
    const comparison = compare(a, b);
    expect(Object.keys(comparison.improvements).length).toBe(0);
    expect(Object.keys(comparison.regressions).length).toBe(0);
    expect(comparison.unchanged.length).toBe(2);
  });

  test('improvements', () => {
    const aScores = {
      task1: new EvalResult({ passed: false, score: 0.5 }),
      task2: new EvalResult({ passed: true, score: 0.8 }),
    };
    const bScores = {
      task1: new EvalResult({ passed: true, score: 0.9 }),
      task2: new EvalResult({ passed: true, score: 0.8 }),
    };
    const a = new BenchmarkResult({ scores: aScores, aggregate: { mean_score: 0.65 } });
    const b = new BenchmarkResult({ scores: bScores, aggregate: { mean_score: 0.85 } });
    const comparison = compare(a, b);
    expect('task1' in comparison.improvements).toBe(true);
    expect(Object.keys(comparison.regressions).length).toBe(0);
    expect(comparison.improvements['task1']).toBeCloseTo(0.4);
  });

  test('regressions', () => {
    const aScores = { task1: new EvalResult({ passed: true, score: 0.9 }) };
    const bScores = { task1: new EvalResult({ passed: false, score: 0.5 }) };
    const a = new BenchmarkResult({ scores: aScores, aggregate: { mean_score: 0.9 } });
    const b = new BenchmarkResult({ scores: bScores, aggregate: { mean_score: 0.5 } });
    const comparison = compare(a, b);
    expect('task1' in comparison.regressions).toBe(true);
    expect(Object.keys(comparison.improvements).length).toBe(0);
    expect(comparison.regressions['task1']).toBeCloseTo(0.4);
  });

  test('has summary', () => {
    const aScores = { task1: new EvalResult({ passed: true, score: 0.8 }) };
    const bScores = { task1: new EvalResult({ passed: true, score: 0.9 }) };
    const a = new BenchmarkResult({ scores: aScores, aggregate: { mean_score: 0.8 } });
    const b = new BenchmarkResult({ scores: bScores, aggregate: { mean_score: 0.9 } });
    const comparison = compare(a, b);
    expect(typeof comparison.summary).toBe('string');
    expect(comparison.summary.length).toBeGreaterThan(0);
    expect(comparison.summary).toContain('0.80');
    expect(comparison.summary).toContain('0.90');
  });
});
