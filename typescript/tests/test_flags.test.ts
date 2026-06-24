import { describe, test, expect } from 'bun:test';
import { FeatureFlag, FlagRegistry, flag } from '../src/composition/flags';

describe('FeatureFlag', () => {
  test('create with defaults', () => {
    const f = new FeatureFlag('test_flag');
    expect(f.name).toBe('test_flag');
    expect(f.default).toBe(false);
    expect(f.value).toBe(false);
    expect(f.description).toBe('');
  });

  test('create with custom default', () => {
    const f = new FeatureFlag('verbose', true, true, 'Enable verbose mode');
    expect(f.default).toBe(true);
    expect(f.value).toBe(true);
    expect(f.description).toBe('Enable verbose mode');
  });

  test('is_enabled reflects value', () => {
    const f = new FeatureFlag('x');
    expect(f.is_enabled).toBe(false);
    const f2 = new FeatureFlag('x', true);
    expect(f2.is_enabled).toBe(true);
  });

  test('to_dict', () => {
    const f = new FeatureFlag('debug', true, true, 'debug mode');
    expect(f.to_dict()).toEqual({ name: 'debug', default: true, value: true, description: 'debug mode' });
  });
});

describe('FlagRegistry', () => {
  test('create registry', () => {
    const reg = new FlagRegistry();
    expect(reg.all()).toEqual({});
  });

  test('register and get', () => {
    const reg = new FlagRegistry();
    reg.register(new FeatureFlag('verbose', true));
    const result = reg.get('verbose');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('verbose');
    expect(result!.value).toBe(true);
  });

  test('get nonexistent returns null', () => {
    const reg = new FlagRegistry();
    expect(reg.get('missing')).toBeNull();
  });

  test('set updates value', () => {
    const reg = new FlagRegistry();
    reg.register(new FeatureFlag('x'));
    reg.set('x', true);
    expect(reg.get('x')!.value).toBe(true);
  });

  test('set nonexistent throws', () => {
    const reg = new FlagRegistry();
    expect(() => reg.set('missing', true)).toThrow();
  });

  test('is_enabled', () => {
    const reg = new FlagRegistry();
    reg.register(new FeatureFlag('x'));
    reg.set('x', true);
    expect(reg.is_enabled('x')).toBe(true);
    expect(reg.is_enabled('y')).toBe(false);
  });

  test('is_enabled default false', () => {
    const reg = new FlagRegistry();
    reg.register(new FeatureFlag('x'));
    expect(reg.is_enabled('x')).toBe(false);
  });

  test('reset to default', () => {
    const reg = new FlagRegistry();
    reg.register(new FeatureFlag('x'));
    reg.set('x', true);
    expect(reg.get('x')!.value).toBe(true);
    reg.reset('x');
    expect(reg.get('x')!.value).toBe(false);
  });

  test('reset all', () => {
    const reg = new FlagRegistry();
    reg.register(new FeatureFlag('a'));
    reg.register(new FeatureFlag('b', true));
    reg.set('a', true);
    reg.set('b', false);
    reg.reset();
    expect(reg.get('a')!.value).toBe(false);
    expect(reg.get('b')!.value).toBe(true);
  });

  test('all returns dict', () => {
    const reg = new FlagRegistry();
    reg.register(new FeatureFlag('a'));
    reg.register(new FeatureFlag('b', true));
    const result = reg.all();
    expect(new Set(Object.keys(result))).toEqual(new Set(['a', 'b']));
    expect(result['a']).toBeInstanceOf(FeatureFlag);
  });

  test('register duplicate throws', () => {
    const reg = new FlagRegistry();
    reg.register(new FeatureFlag('x'));
    expect(() => reg.register(new FeatureFlag('x'))).toThrow();
  });
});

describe('flag() convenience', () => {
  test('creates and registers', () => {
    const reg = new FlagRegistry();
    const f = flag(reg, 'x', true, 'test');
    expect(f.name).toBe('x');
    expect(f.value).toBe(true);
    expect(reg.get('x')).toBe(f);
  });

  test('defaults', () => {
    const reg = new FlagRegistry();
    const f = flag(reg, 'x');
    expect(f.default).toBe(false);
    expect(f.description).toBe('');
  });
});
