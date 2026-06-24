import { describe, test, expect } from 'bun:test';
import { HarnessBuilder } from '../src/composition/builder';
import { HarnessConfig } from '../src/composition/config';
import { make_coding, make_reliability, make_evaluation, make_self_improve } from '../src/composition/bundles';

describe('make_coding', () => {
  test('returns HarnessBuilder', () => {
    expect(make_coding()).toBeInstanceOf(HarnessBuilder);
  });

  test('produces valid config', () => {
    const config = make_coding().build();
    expect(config).toBeInstanceOf(HarnessConfig);
    expect(config.validate()).toEqual([]);
  });

  test('has processors', () => {
    const config = make_coding().build();
    expect(config.processors.length).toBeGreaterThanOrEqual(1);
  });

  test('has tools', () => {
    const config = make_coding().build();
    expect(config.tools.length).toBeGreaterThanOrEqual(1);
  });

  test('has coding flags', () => {
    const config = make_coding().build();
    expect(typeof config.flags).toBe('object');
  });

  test('accepts working_dir', () => {
    const config = make_coding('/tmp/project').build();
    expect(config.slots['working_dir']).toBe('/tmp/project');
  });

  test('default working_dir is dot', () => {
    const config = make_coding().build();
    expect(config.slots['working_dir']).toBe('.');
  });
});

describe('make_reliability', () => {
  test('returns HarnessBuilder', () => {
    expect(make_reliability()).toBeInstanceOf(HarnessBuilder);
  });

  test('produces valid config', () => {
    const config = make_reliability().build();
    expect(config.validate()).toEqual([]);
  });

  test('has processors', () => {
    const config = make_reliability().build();
    expect(config.processors.length).toBeGreaterThanOrEqual(1);
  });

  test('has reliability flags', () => {
    const config = make_reliability().build();
    expect(Object.keys(config.flags).some(k => /loop|safe|guard/i.test(k))).toBe(true);
  });
});

describe('make_evaluation', () => {
  test('returns HarnessBuilder', () => {
    expect(make_evaluation()).toBeInstanceOf(HarnessBuilder);
  });

  test('produces valid config', () => {
    const config = make_evaluation().build();
    expect(config.validate()).toEqual([]);
  });

  test('has processors', () => {
    const config = make_evaluation().build();
    expect(config.processors.length).toBeGreaterThanOrEqual(1);
  });

  test('has evaluation flags', () => {
    const config = make_evaluation().build();
    expect(Object.keys(config.flags).some(k => /eval/i.test(k))).toBe(true);
  });
});

describe('make_self_improve', () => {
  test('returns HarnessBuilder', () => {
    expect(make_self_improve()).toBeInstanceOf(HarnessBuilder);
  });

  test('produces valid config', () => {
    const config = make_self_improve().build();
    expect(config.validate()).toEqual([]);
  });

  test('has processors', () => {
    const config = make_self_improve().build();
    expect(config.processors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Bundle composition', () => {
  test('coding and reliability compose', () => {
    const builder = make_coding().merge(make_reliability());
    const config = builder.build();
    expect(config).toBeInstanceOf(HarnessConfig);
    expect(config.processors.length).toBeGreaterThanOrEqual(2);
  });

  test('coding and evaluation compose', () => {
    const builder = make_coding().merge(make_evaluation());
    const config = builder.build();
    expect(config).toBeInstanceOf(HarnessConfig);
    expect(config.processors.length).toBeGreaterThanOrEqual(2);
  });

  test('merges flags', () => {
    const config = make_coding().merge(make_reliability()).build();
    expect(Object.keys(config.flags).length).toBeGreaterThanOrEqual(2);
  });

  test('merges tools', () => {
    const config = make_coding().merge(make_reliability()).build();
    expect(config.tools.length).toBeGreaterThanOrEqual(1);
  });

  test('triple compose', () => {
    const config = make_coding().merge(make_reliability()).merge(make_evaluation()).build();
    expect(config.validate()).toEqual([]);
    expect(config.processors.length).toBeGreaterThanOrEqual(3);
  });

  test('all four compose', () => {
    const config = make_coding().merge(make_reliability()).merge(make_evaluation()).merge(make_self_improve()).build();
    expect(config.validate()).toEqual([]);
  });
});

describe('Bundle determinism', () => {
  test('coding fingerprint is stable', () => {
    const c1 = make_coding().build();
    const c2 = make_coding().build();
    expect(c1.fingerprint()).toBe(c2.fingerprint());
  });

  test('reliability fingerprint is stable', () => {
    const r1 = make_reliability().build();
    const r2 = make_reliability().build();
    expect(r1.fingerprint()).toBe(r2.fingerprint());
  });

  test('evaluation fingerprint is stable', () => {
    const e1 = make_evaluation().build();
    const e2 = make_evaluation().build();
    expect(e1.fingerprint()).toBe(e2.fingerprint());
  });

  test('self_improve fingerprint is stable', () => {
    const s1 = make_self_improve().build();
    const s2 = make_self_improve().build();
    expect(s1.fingerprint()).toBe(s2.fingerprint());
  });

  test('different bundles have different fingerprints', () => {
    const c = make_coding().build();
    const r = make_reliability().build();
    expect(c.fingerprint()).not.toBe(r.fingerprint());
  });
});
