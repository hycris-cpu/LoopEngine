import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GradeResult,
  IsolatedGrader,
  is_better,
  make_subprocess_runner,
} from '../src/evaluation/grader';

describe('GradeResult', () => {
  test('invalid maximize is -Infinity', () => {
    const r = GradeResult.invalid('maximize');
    expect(r.valid).toBe(false);
    expect(r.score).toBe(-Infinity);
  });
  test('invalid minimize is +Infinity', () => {
    const r = GradeResult.invalid('minimize');
    expect(r.valid).toBe(false);
    expect(r.score).toBe(Infinity);
  });
});

describe('is_better', () => {
  test('valid beats invalid when maximizing', () => {
    const good = new GradeResult({ score: 0.1, valid: true });
    const bad = GradeResult.invalid('maximize');
    expect(is_better(good, bad, 'maximize')).toBe(true);
    expect(is_better(bad, good, 'maximize')).toBe(false);
  });
  test('valid beats invalid when minimizing', () => {
    const good = new GradeResult({ score: 999, valid: true });
    const bad = GradeResult.invalid('minimize');
    expect(is_better(good, bad, 'minimize')).toBe(true);
    expect(is_better(bad, good, 'minimize')).toBe(false);
  });
  test('direction controls comparison', () => {
    const a = new GradeResult({ score: 0.3, valid: true });
    const b = new GradeResult({ score: 0.7, valid: true });
    expect(is_better(b, a, 'maximize')).toBe(true);
    expect(is_better(a, b, 'minimize')).toBe(true);
  });
});

describe('IsolatedGrader', () => {
  test('valid result is parsed', async () => {
    const grader = new IsolatedGrader(async () => ({ score: 0.7, valid: true, metrics: { n: 1 } }));
    const r = await grader.grade({ x: 1 });
    expect(r.valid).toBe(true);
    expect(r.score).toBe(0.7);
    expect(r.metrics).toEqual({ n: 1 });
  });
  test('runner crash yields invalid', async () => {
    const grader = new IsolatedGrader(async () => { throw new Error('blew up'); }, 'maximize');
    const r = await grader.grade({ x: 1 });
    expect(r.valid).toBe(false);
    expect(r.score).toBe(-Infinity);
  });
  test('non-finite score yields invalid', async () => {
    const grader = new IsolatedGrader(async () => ({ score: NaN }));
    const r = await grader.grade({ x: 1 });
    expect(r.valid).toBe(false);
  });
  test('missing score yields invalid', async () => {
    const grader = new IsolatedGrader(async () => ({ metrics: {} }));
    const r = await grader.grade({ x: 1 });
    expect(r.valid).toBe(false);
  });
});

describe('subprocess runner', () => {
  test('grades in a separate process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grader-'));
    const script = join(dir, 'grader.js');
    writeFileSync(
      script,
      "const t = await Bun.stdin.text();\n" +
        "const sub = JSON.parse(t);\n" +
        "process.stdout.write(JSON.stringify({ score: sub.x * 2, valid: true }));\n",
    );
    const runner = make_subprocess_runner(script, 'bun');
    const grader = new IsolatedGrader(runner);
    const r = await grader.grade({ x: 3 });
    expect(r.valid).toBe(true);
    expect(r.score).toBe(6);
  });
});
