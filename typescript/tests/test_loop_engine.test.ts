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

    const mod = new CodeMod({ target_file: 'prompt.py', description: 'Improve prompt', diff: '--- a/prompt.py\n+++ b/prompt.py\n@@ -1 +1 @@\n-old\n+new\n', rationale: 'Agent confused', expected_impact: 'Better score' });
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

    const report = await engine.run([{}] as any, { 'prompt.py': 'old\n' });
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

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('LoopEngine hardening (C2, M2, M3, C4)', () => {
  const mockHarness = {
    run: async () => new RunResult({ total_steps: 1 }),
    run_batch: async (tasks: any[]) => tasks.map(() => new RunResult({ total_steps: 1 })),
  };

  test('C2: unsafe mod is never built or run', async () => {
    let builderCalls = 0;
    const builder = () => { builderCalls++; return mockHarness as any; };
    const benchmark = {
      run: async () => new BenchmarkResult({
        scores: { task_0: new EvalResult({ passed: true, score: 0.5, reason: 'ok' }) },
        aggregate: { mean_score: 0.5, pass_rate: 1.0 },
      }),
    };
    const unsafe = 'os.' + 'system';
    const mod = new CodeMod({
      target_file: 'x.py',
      diff: `--- a/x.py\n+++ b/x.py\n@@ -1 +1,2 @@\n a\n+${unsafe}('echo hi')\n`,
    });
    const strategy = { name: 's', propose: async () => [mod] };
    const gate = { validate: async () => { throw new Error('gate ran on unsafe mod'); } };
    const engine = new LoopEngine(builder, benchmark as any, [strategy as any], gate as any, null, 1);
    const report = await engine.run([{}] as any, { 'x.py': 'a\n' });
    expect(builderCalls).toBe(1);
    expect(report.improvements).toBe(0);
    expect(report.rejections).toBeGreaterThanOrEqual(1);
  });

  test('M2: promotes the highest-scoring candidate, not the first', async () => {
    const seq = [0.5, 0.6, 0.9, 0.7];
    let idx = 0;
    const benchmark = {
      run: async () => {
        const s = seq[Math.min(idx, seq.length - 1)];
        idx++;
        return new BenchmarkResult({
          scores: { task_0: new EvalResult({ passed: true, score: s }) },
          aggregate: { mean_score: s, pass_rate: 1.0 },
        });
      },
    };
    const mods = [
      new CodeMod({ target_file: 'x.py', diff: '--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+A\n' }),
      new CodeMod({ target_file: 'x.py', diff: '--- a/x.py\n+++ b/x.py\n@@ -2 +2 @@\n-b\n+B\n' }),
      new CodeMod({ target_file: 'x.py', diff: '--- a/x.py\n+++ b/x.py\n@@ -3 +3 @@\n-c\n+C\n' }),
    ];
    const strategy = { name: 's', propose: async () => mods };
    const gate = { validate: async () => new PromotionDecision({ promoted: true, reason: 'ok' }) };
    const engine = new LoopEngine(() => mockHarness as any, benchmark as any, [strategy as any], gate as any, null, 1);
    const report = await engine.run([{}] as any, { 'x.py': 'a\nb\nc\n' });
    expect(report.improvements).toBe(1);
    expect(report.final_score).toBe(0.9);
  });

  test('M3: patience stops after consecutive non-promotions', async () => {
    const benchmark = {
      run: async () => new BenchmarkResult({
        scores: { task_0: new EvalResult({ passed: true, score: 0.5 }) },
        aggregate: { mean_score: 0.5, pass_rate: 1.0 },
      }),
    };
    const mod = new CodeMod({ target_file: 'x.py', diff: '--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+A\n' });
    const strategy = { name: 's', propose: async () => [mod] };
    const gate = { validate: async () => new PromotionDecision({ promoted: false, reason: 'no' }) };
    const engine = new LoopEngine(() => mockHarness as any, benchmark as any, [strategy as any], gate as any, null, 10, 2);
    const report = await engine.run([{}] as any, { 'x.py': 'a\n' });
    expect(report.iterations).toBe(2);
  });

  test('C4: materializes source to an isolated workspace', () => {
    const engine = new LoopEngine(() => mockHarness as any, { run: async () => new BenchmarkResult() }, [], new PromotionGate());
    const src = { 'pkg/mod.py': 'print(1)\n', 'top.py': 'x = 2\n' };
    const root = mkdtempSync(join(tmpdir(), 'le-ws-'));
    const workspace = (engine as any)._materialize(src, root) as string;
    expect(readFileSync(join(workspace, 'pkg', 'mod.py'), 'utf-8')).toBe('print(1)\n');
    expect(readFileSync(join(workspace, 'top.py'), 'utf-8')).toBe('x = 2\n');
  });
});
