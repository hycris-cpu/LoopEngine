import { describe, test, expect } from 'bun:test';
import { EvalResult } from '../src/primitives/events';
import { BenchmarkResult } from '../src/evaluation/benchmark';
import { PromotionGate, PromotionDecision } from '../src/evolution/promotion';
import { CodeMod } from '../src/evolution/code_mod';

describe('PromotionGate', () => {
  test('defaults', () => {
    const gate = new PromotionGate();
    expect((gate as any)._min_improvement).toBe(0.01);
    expect((gate as any)._no_regression).toBe(0.02);
    expect((gate as any)._require_safety).toBe(true);
  });

  test('custom params', () => {
    const gate = new PromotionGate(0.05, 0.10, false);
    expect((gate as any)._min_improvement).toBe(0.05);
    expect((gate as any)._no_regression).toBe(0.10);
    expect((gate as any)._require_safety).toBe(false);
  });
});

describe('PromotionDecision', () => {
  test('creation', () => {
    const decision = new PromotionDecision({ promoted: true, reason: 'Improved by 5%', details: { improvement: 0.05 } });
    expect(decision.promoted).toBe(true);
    expect(decision.reason).toBe('Improved by 5%');
    expect((decision.details as any).improvement).toBe(0.05);
  });
});

describe('Validate with improvement', () => {
  test('promotes on improvement', async () => {
    const gate = new PromotionGate(0.01, 0.02);
    const baseline = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.6, reason: 'ok' }) },
      aggregate: { mean_score: 0.6, pass_rate: 1.0 },
    });
    const candidate = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.7, reason: 'better' }) },
      aggregate: { mean_score: 0.7, pass_rate: 1.0 },
    });
    const mod = new CodeMod({ target_file: 'prompt.py', description: 'Better prompt', diff: '...', rationale: 'Test', expected_impact: 'Better score' });
    const decision = gate.validate(baseline, candidate, mod);
    expect(decision.promoted).toBe(true);
    expect(decision.reason.toLowerCase()).toContain('approved');
  });

  test('tracks improvement details', async () => {
    const gate = new PromotionGate(0.01);
    const baseline = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.5, reason: 'ok' }) },
      aggregate: { mean_score: 0.5 },
    });
    const candidate = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.8, reason: 'better' }) },
      aggregate: { mean_score: 0.8 },
    });
    const mod = new CodeMod({ target_file: 'x.py' });
    const decision = gate.validate(baseline, candidate, mod);
    const imp = decision.details['improvement'] as any;
    expect(imp.baseline_score).toBe(0.5);
    expect(imp.candidate_score).toBe(0.8);
    expect(imp.delta).toBeCloseTo(0.3);
    expect(imp.passed).toBe(true);
  });
});

describe('Validate with regression', () => {
  test('rejects on regression', async () => {
    const gate = new PromotionGate(0.01, 0.02);
    const baseline = new BenchmarkResult({
      scores: {
        task_0: new EvalResult({ passed: true, score: 0.8 }),
        task_1: new EvalResult({ passed: true, score: 0.6 }),
      },
      aggregate: { mean_score: 0.7 },
    });
    const candidate = new BenchmarkResult({
      scores: {
        task_0: new EvalResult({ passed: false, score: 0.5 }),
        task_1: new EvalResult({ passed: true, score: 0.95 }),
      },
      aggregate: { mean_score: 0.725 },
    });
    const mod = new CodeMod({ target_file: 'x.py' });
    const decision = gate.validate(baseline, candidate, mod);
    expect(decision.promoted).toBe(false);
    expect(decision.reason.toLowerCase()).toContain('regression');
  });

  test('regression details', async () => {
    const gate = new PromotionGate(0.0, 0.05);
    const baseline = new BenchmarkResult({
      scores: {
        task_0: new EvalResult({ passed: true, score: 0.9 }),
        task_1: new EvalResult({ passed: true, score: 0.5 }),
      },
      aggregate: { mean_score: 0.7 },
    });
    const candidate = new BenchmarkResult({
      scores: {
        task_0: new EvalResult({ passed: true, score: 0.6 }),
        task_1: new EvalResult({ passed: true, score: 0.95 }),
      },
      aggregate: { mean_score: 0.775 },
    });
    const mod = new CodeMod({ target_file: 'x.py' });
    const decision = gate.validate(baseline, candidate, mod);
    const reg = decision.details['regression'] as any;
    expect(reg.has_regression).toBe(true);
    expect(reg.regressed_tasks).toContain('task_0');
    expect(reg.worst_task).toBe('task_0');
  });
});

describe('Validate with unsafe mod', () => {
  test('rejects unsafe mod', async () => {
    const gate = new PromotionGate(0.01, 0.02, true);
    const baseline = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.5 }) },
      aggregate: { mean_score: 0.5 },
    });
    const candidate = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.9 }) },
      aggregate: { mean_score: 0.9 },
    });
    class UnsafeMod {
      is_safe() { return false; }
    }
    const decision = gate.validate(baseline, candidate, new UnsafeMod());
    expect(decision.promoted).toBe(false);
    expect(decision.reason.toLowerCase()).toContain('safety');
    expect((decision.details['safety'] as any).passed).toBe(false);
  });

  test('skips safety when disabled', async () => {
    const gate = new PromotionGate(0.01, 0.02, false);
    const baseline = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.5 }) },
      aggregate: { mean_score: 0.5 },
    });
    const candidate = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.9 }) },
      aggregate: { mean_score: 0.9 },
    });
    class UnsafeMod {
      is_safe() { return false; }
    }
    const decision = gate.validate(baseline, candidate, new UnsafeMod());
    expect(decision.promoted).toBe(true);
  });
});

describe('Marginal improvement', () => {
  test('rejects marginal improvement', async () => {
    const gate = new PromotionGate(0.01, 0.02);
    const baseline = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.6 }) },
      aggregate: { mean_score: 0.6 },
    });
    const candidate = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.605 }) },
      aggregate: { mean_score: 0.605 },
    });
    const mod = new CodeMod({ target_file: 'x.py' });
    const decision = gate.validate(baseline, candidate, mod);
    expect(decision.promoted).toBe(false);
    expect(decision.reason.toLowerCase()).toContain('insufficient');
  });

  test('exact threshold is promoted', async () => {
    const gate = new PromotionGate(0.01, 0.02);
    const baseline = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.6 }) },
      aggregate: { mean_score: 0.6 },
    });
    const candidate = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.61 }) },
      aggregate: { mean_score: 0.61 },
    });
    const mod = new CodeMod({ target_file: 'x.py' });
    const decision = gate.validate(baseline, candidate, mod);
    expect(decision.promoted).toBe(true);
  });
});

describe('Zero regression tolerance', () => {
  test('rejects any regression', async () => {
    const gate = new PromotionGate(0.0, 0.0);
    const baseline = new BenchmarkResult({
      scores: {
        task_0: new EvalResult({ passed: true, score: 0.7 }),
        task_1: new EvalResult({ passed: true, score: 0.5 }),
      },
      aggregate: { mean_score: 0.6 },
    });
    const candidate = new BenchmarkResult({
      scores: {
        task_0: new EvalResult({ passed: true, score: 0.699 }),
        task_1: new EvalResult({ passed: true, score: 0.9 }),
      },
      aggregate: { mean_score: 0.7995 },
    });
    const mod = new CodeMod({ target_file: 'x.py' });
    const decision = gate.validate(baseline, candidate, mod);
    expect(decision.promoted).toBe(false);
    expect(decision.reason.toLowerCase()).toContain('regression');
  });

  test('allows no regression', async () => {
    const gate = new PromotionGate(0.0, 0.0);
    const baseline = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.7 }) },
      aggregate: { mean_score: 0.7 },
    });
    const candidate = new BenchmarkResult({
      scores: { task_0: new EvalResult({ passed: true, score: 0.8 }) },
      aggregate: { mean_score: 0.8 },
    });
    const mod = new CodeMod({ target_file: 'x.py' });
    const decision = gate.validate(baseline, candidate, mod);
    expect(decision.promoted).toBe(true);
  });
});
