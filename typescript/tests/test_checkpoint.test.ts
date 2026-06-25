import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointStore, EvolutionCheckpoint } from '../src/evolution/checkpoint';
import { LoopEngine } from '../src/evolution/loop_engine';
import { BenchmarkResult } from '../src/evaluation/benchmark';
import { EvalResult } from '../src/primitives/events';
import { RunResult } from '../src/execution/runloop';

function benchmarkReturning(mean: number) {
  return {
    run: async () =>
      new BenchmarkResult({
        scores: { task_0: new EvalResult({ passed: true, score: mean }) },
        aggregate: { mean_score: mean, pass_rate: 1.0 },
      }),
  };
}

const mockHarness = {
  run: async () => new RunResult({ total_steps: 1 }),
  run_batch: async (tasks: any[]) => tasks.map(() => new RunResult({ total_steps: 1 })),
};

describe('CheckpointStore', () => {
  test('save then load roundtrips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    const store = new CheckpointStore(join(dir, 'ckpt.json'));
    const cp = new EvolutionCheckpoint({
      iteration: 2,
      history: [{ iteration: 0, score: 0.5, promoted: true }],
      current_source: { 'x.py': 'v\n' },
      current_config: { flag: true },
      improvements: 1,
      rejections: 4,
      final_score: 0.8,
    });
    store.save(cp);
    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.iteration).toBe(2);
    expect(loaded!.history).toEqual(cp.history);
    expect(loaded!.current_source).toEqual({ 'x.py': 'v\n' });
    expect(loaded!.current_config).toEqual({ flag: true });
    expect(loaded!.improvements).toBe(1);
    expect(loaded!.rejections).toBe(4);
    expect(loaded!.final_score).toBe(0.8);
  });

  test('load missing returns null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    const store = new CheckpointStore(join(dir, 'absent.json'));
    expect(store.exists()).toBe(false);
    expect(store.load()).toBeNull();
  });
});

describe('LoopEngine checkpointing', () => {
  test('run writes a checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    const path = join(dir, 'run.json');
    const strategy = { name: 's', propose: async () => [] };
    const engine = new LoopEngine(
      () => mockHarness as any,
      benchmarkReturning(0.5) as any,
      [strategy as any],
      {} as any,
      null,
      5,
      null,
      null,
      path,
    );
    await engine.run([{}] as any, {});
    const store = new CheckpointStore(path);
    expect(store.exists()).toBe(true);
    expect(store.load()).not.toBeNull();
  });

  test('resume restores prior state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    const path = join(dir, 'run.json');
    new CheckpointStore(path).save(
      new EvolutionCheckpoint({
        iteration: 0,
        history: [{ iteration: 0, score: 0.9, promoted: true }],
        current_source: { 'x.py': 'v\n' },
        current_config: {},
        improvements: 3,
        rejections: 2,
        final_score: 0.9,
      }),
    );
    const strategy = { name: 's', propose: async () => [] };
    const engine = new LoopEngine(
      () => mockHarness as any,
      benchmarkReturning(0.5) as any,
      [strategy as any],
      {} as any,
      null,
      5,
      null,
      null,
      path,
    );
    const report = await engine.run([{}] as any, {}, null, true);
    expect(report.improvements).toBe(3);
  });
});
