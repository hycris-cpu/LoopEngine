import { describe, test, expect } from 'bun:test';
import { EvalResult, Message, MessageType } from '../src/primitives/events';
import { Trajectory, TrajectoryStep } from '../src/primitives/trajectory';
import { EvolutionReport, LoopEngine } from '../src/evolution/loop_engine';
import { PromotionGate, PromotionDecision } from '../src/evolution/promotion';
import { BenchmarkResult } from '../src/evaluation/benchmark';
import { CodeMod } from '../src/evolution/code_mod';
import { Harness } from '../src/execution/harness';
import { HarnessConfig } from '../src/composition/config';
import { RunResult, type ModelProvider } from '../src/execution/runloop';

describe('LoopEngine creation', () => {
  test('stores components', () => {
    const mockHarness = {
      run: async () => new RunResult({ total_steps: 1 }),
      run_batch: async (tasks: unknown[]) => tasks.map(() => new RunResult({ total_steps: 1 })),
    };
    const engine = new LoopEngine(
      () => mockHarness as any,
      { run: async () => new BenchmarkResult() },
      [],
      new PromotionGate(),
      null,
      10,
    );
    expect(engine.max_iterations).toBe(10);
  });

  test('default max_iterations', () => {
    const mockHarness = {
      run: async () => new RunResult({ total_steps: 1 }),
      run_batch: async (tasks: unknown[]) => tasks.map(() => new RunResult({ total_steps: 1 })),
    };
    const engine = new LoopEngine(
      () => mockHarness as any,
      { run: async () => new BenchmarkResult() },
      [],
      new PromotionGate(),
    );
    expect(engine.max_iterations).toBe(100);
  });
});

describe('EvolutionReport', () => {
  test('summary basic', () => {
    const report = new EvolutionReport({
      iterations: 3,
      history: [
        { iteration: 0, score: 0.5, proposals: 1, promoted: true },
        { iteration: 1, score: 0.7, proposals: 2, promoted: false },
        { iteration: 2, score: 0.7, proposals: 0, promoted: false },
      ],
      final_score: 0.7,
      improvements: 1,
      rejections: 2,
    });
    const summary = report.summary();
    expect(summary).toContain('3');
    expect(summary).toContain('0.7');
    expect(summary).toContain('1');
    expect(summary).toContain('2');
    expect(summary).toContain('PROMOTED');
    expect(summary).toContain('REJECTED');
  });

  test('summary no improvements', () => {
    const report = new EvolutionReport({ iterations: 0, history: [], final_score: 0.0, improvements: 0, rejections: 0 });
    const summary = report.summary();
    expect(summary.toLowerCase()).toContain('no improvements');
  });

  test('summary calculates total improvement', () => {
    const report = new EvolutionReport({
      iterations: 2,
      history: [
        { iteration: 0, score: 0.5, proposals: 1, promoted: true },
        { iteration: 1, score: 0.8, proposals: 1, promoted: true },
      ],
      final_score: 0.8,
      improvements: 2,
      rejections: 0,
    });
    const summary = report.summary();
    expect(summary).toContain('+0.3');
  });
});

describe('LoopEngine run basic', () => {
  test('basic cycle', async () => {
    let callCount = 0;
    const benchmark = {
      run: async () => {
        callCount++;
        if (callCount <= 1) {
          return new BenchmarkResult({
            scores: { task_0: new EvalResult({ passed: true, score: 0.5, reason: 'ok' }) },
            aggregate: { mean_score: 0.5, pass_rate: 1.0 },
          });
        }
        return new BenchmarkResult({
          scores: { task_0: new EvalResult({ passed: true, score: 0.8, reason: 'better' }) },
          aggregate: { mean_score: 0.8, pass_rate: 1.0 },
        });
      },
    };

    const mod = new CodeMod({ target_file: 'prompt.py', description: 'Improve prompt', diff: '...', rationale: 'Agent confused', expected_impact: 'Better score' });
    const strategy = {
      name: 'test_strategy',
      propose: async () => [mod],
    };

    const gate = new PromotionGate();
    const originalValidate = gate.validate.bind(gate);
    gate.validate = (baseline: any, candidate: any, mods: any) => {
      const decision = originalValidate(baseline, candidate, mods);
      return decision;
    };

    const mockHarness = {
      run: async () => new RunResult({ total_steps: 1 }),
      run_batch: async (tasks: any[]) => tasks.map(() => new RunResult({ total_steps: 1 })),
    };

    const engine = new LoopEngine(
      () => mockHarness as any,
      benchmark as any,
      [strategy as any],
      gate,
      null,
      5,
    );

    const report = await engine.run([{}] as any, { 'prompt.py': 'old' });
    expect(report).toBeInstanceOf(EvolutionReport);
    expect(report.improvements).toBeGreaterThanOrEqual(1);
    expect(report.iterations).toBeGreaterThanOrEqual(1);
  });

  test('records history', async () => {
    const benchmark = {
      run: async () => new BenchmarkResult({
        scores: { task_0: new EvalResult({ passed: true, score: 0.5 }) },
        aggregate: { mean_score: 0.5, pass_rate: 1.0 },
      }),
    };

    const strategy = {
      name: 'test',
      propose: async () => [new CodeMod({ target_file: 'x.py', description: 'mod', diff: '...' })],
    };

    const gate = new PromotionGate();

    const mockHarness = {
      run: async () => new RunResult({ total_steps: 1 }),
      run_batch: async (tasks: any[]) => tasks.map(() => new RunResult({ total_steps: 1 })),
    };

    const engine = new LoopEngine(() => mockHarness as any, benchmark as any, [strategy as any], gate, null, 3);
    const report = await engine.run([{}] as any, {});
    expect(report.history.length).toBeGreaterThanOrEqual(1);
    for (const entry of report.history) {
      expect(entry).toHaveProperty('iteration');
      expect(entry).toHaveProperty('score');
      expect(entry).toHaveProperty('proposals');
      expect(entry).toHaveProperty('promoted');
    }
  });
});

describe('LoopEngine with rejection', () => {
  test('rejections recorded', async () => {
    const benchmark = {
      run: async () => new BenchmarkResult({
        scores: { task_0: new EvalResult({ passed: true, score: 0.5 }) },
        aggregate: { mean_score: 0.5, pass_rate: 1.0 },
      }),
    };

    const strategy = {
      name: 'test',
      propose: async () => [new CodeMod({ target_file: 'x.py', description: 'mod', diff: '...' })],
    };

    const gate = new PromotionGate(0.99); // Very high threshold — always rejects
    const mockHarness = {
      run: async () => new RunResult({ total_steps: 1 }),
      run_batch: async (tasks: any[]) => tasks.map(() => new RunResult({ total_steps: 1 })),
    };

    const engine = new LoopEngine(() => mockHarness as any, benchmark as any, [strategy as any], gate, null, 3);
    const report = await engine.run([{}] as any, {});
    expect(report.rejections).toBeGreaterThanOrEqual(1);
    expect(report.improvements).toBe(0);
  });
});

describe('LoopEngine with no proposals', () => {
  test('stops on no proposals', async () => {
    const benchmark = {
      run: async () => new BenchmarkResult({
        scores: { task_0: new EvalResult({ passed: true, score: 0.5 }) },
        aggregate: { mean_score: 0.5, pass_rate: 1.0 },
      }),
    };

    const strategy = { name: 'empty', propose: async () => [] };
    const gate = new PromotionGate();
    const mockHarness = {
      run: async () => new RunResult({ total_steps: 1 }),
      run_batch: async (tasks: any[]) => tasks.map(() => new RunResult({ total_steps: 1 })),
    };

    const engine = new LoopEngine(() => mockHarness as any, benchmark as any, [strategy as any], gate, null, 100);
    const report = await engine.run([{}] as any, {});
    expect(report.iterations).toBeLessThanOrEqual(3);
    expect(report.improvements).toBe(0);
  });
});

describe('LoopEngine max_iterations', () => {
  test('respects max_iterations', async () => {
    const benchmark = {
      run: async () => new BenchmarkResult({
        scores: { task_0: new EvalResult({ passed: true, score: 0.5 }) },
        aggregate: { mean_score: 0.5, pass_rate: 1.0 },
      }),
    };

    const strategy = {
      name: 'persistent',
      propose: async () => [new CodeMod({ target_file: 'x.py', description: 'mod', diff: '...' })],
    };

    const gate = new PromotionGate();
    const mockHarness = {
      run: async () => new RunResult({ total_steps: 1 }),
      run_batch: async (tasks: any[]) => tasks.map(() => new RunResult({ total_steps: 1 })),
    };

    const engine = new LoopEngine(() => mockHarness as any, benchmark as any, [strategy as any], gate, null, 2);
    const report = await engine.run([{}] as any, {});
    expect(report.iterations).toBeLessThanOrEqual(2);
  });
});

describe('LoopEngine all rejected', () => {
  test('keeps baseline score', async () => {
    const benchmark = {
      run: async () => new BenchmarkResult({
        scores: { task_0: new EvalResult({ passed: true, score: 0.6 }) },
        aggregate: { mean_score: 0.6, pass_rate: 1.0 },
      }),
    };

    const strategy = {
      name: 'bad_strategy',
      propose: async () => [new CodeMod({ target_file: 'x.py', description: 'bad mod', diff: '...' })],
    };

    const gate = new PromotionGate(0.99);
    const mockHarness = {
      run: async () => new RunResult({ total_steps: 1 }),
      run_batch: async (tasks: any[]) => tasks.map(() => new RunResult({ total_steps: 1 })),
    };

    const engine = new LoopEngine(() => mockHarness as any, benchmark as any, [strategy as any], gate, null, 5);
    const report = await engine.run([{}] as any, {});
    expect(report.improvements).toBe(0);
    expect(report.final_score).toBeCloseTo(0.6);
  });
});
