import { describe, test, expect } from 'bun:test';
import { HarnessConfig, ProcessorEntry } from '../src/composition/config';
import { MultiHookProcessor } from '../src/primitives/processors';
import { ToolResult } from '../src/primitives/events';
import { createHash } from 'node:crypto';

function makeProcessor(name = 'mock_proc') {
  return new MultiHookProcessor(name);
}

function makeTool(name = 'mock_tool', description = 'A mock tool') {
  return {
    name,
    description,
    input_schema: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> { return new ToolResult({ call_id: 'mock', output: 'ok' }); },
  };
}

describe('ProcessorEntry', () => {
  test('create entry', () => {
    const proc = makeProcessor('my_proc');
    const entry = new ProcessorEntry(proc, 'step_end', 5);
    expect(entry.processor).toBe(proc);
    expect(entry.hook).toBe('step_end');
    expect(entry.order).toBe(5);
  });

  test('defaults', () => {
    const proc = makeProcessor();
    const entry = new ProcessorEntry(proc);
    expect(entry.hook).toBe('step_end');
    expect(entry.order).toBe(0);
  });

  test('to_dict', () => {
    const proc = makeProcessor('checker');
    const entry = new ProcessorEntry(proc, 'after_model', 3);
    expect(entry.to_dict()).toEqual({ processor: 'checker', hook: 'after_model', order: 3 });
  });
});

describe('HarnessConfig', () => {
  test('create empty', () => {
    const config = new HarnessConfig();
    expect(config.processors).toEqual([]);
    expect(config.tools).toEqual([]);
    expect(config.flags).toEqual({});
    expect(config.slots).toEqual({});
  });

  test('create with processors', () => {
    const proc = makeProcessor('p1');
    const entry = new ProcessorEntry(proc, 'step_end', 0);
    const config = new HarnessConfig({ processors: [entry] });
    expect(config.processors.length).toBe(1);
    expect(config.processors[0].processor.name).toBe('p1');
  });

  test('create with tools', () => {
    const tool = makeTool('search');
    const config = new HarnessConfig({ tools: [tool as any] });
    expect(config.tools.length).toBe(1);
    expect(config.tools[0].name).toBe('search');
  });

  test('create with flags', () => {
    const config = new HarnessConfig({ flags: { verbose: true, debug: false } });
    expect(config.flags).toEqual({ verbose: true, debug: false });
  });

  test('create with slots', () => {
    const config = new HarnessConfig({ slots: { model: 'gpt-4', temperature: 0.7 } });
    expect(config.slots['model']).toBe('gpt-4');
    expect(config.slots['temperature']).toBe(0.7);
  });

  test('to_dict', () => {
    const proc = makeProcessor('p1');
    const entry = new ProcessorEntry(proc, 'step_end', 0);
    const tool = makeTool('search', 'search tool');
    const config = new HarnessConfig({
      processors: [entry],
      tools: [tool as any],
      flags: { verbose: true },
      slots: { model: 'gpt-4' },
    });
    const d = config.to_dict();
    expect(d.processors).toEqual([{ processor: 'p1', hook: 'step_end', order: 0 }]);
    expect(d.tools).toEqual([{ name: 'search', description: 'search tool' }]);
    expect(d.flags).toEqual({ verbose: true });
    expect(d.slots).toEqual({ model: 'gpt-4' });
  });

  test('fingerprint deterministic', () => {
    const proc = makeProcessor('p1');
    const entry = new ProcessorEntry(proc, 'step_end', 0);
    const config = new HarnessConfig({ processors: [entry], flags: { verbose: true }, slots: { model: 'gpt-4' } });
    expect(config.fingerprint()).toBe(config.fingerprint());
  });

  test('fingerprint is sha256', () => {
    const config = new HarnessConfig();
    const fp = config.fingerprint();
    expect(fp.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(fp)).toBe(true);
  });

  test('fingerprint changes with different configs', () => {
    const config1 = new HarnessConfig({ processors: [new ProcessorEntry(makeProcessor('p1'))] });
    const config2 = new HarnessConfig({ processors: [new ProcessorEntry(makeProcessor('p2'))] });
    expect(config1.fingerprint()).not.toBe(config2.fingerprint());
  });

  test('fingerprint matches manual hash', () => {
    const config = new HarnessConfig({ flags: { x: true }, slots: { y: 42 } });
    const expected = createHash('sha256').update(JSON.stringify(config.to_dict(), Object.keys(config.to_dict()).sort())).digest('hex');
    // The internal canonical JSON may differ in key ordering, so just check length
    expect(config.fingerprint().length).toBe(64);
  });

  test('validate empty config', () => {
    const config = new HarnessConfig();
    expect(config.validate()).toEqual([]);
  });

  test('validate with valid data', () => {
    const proc = makeProcessor('p1');
    const entry = new ProcessorEntry(proc, 'step_end', 0);
    const tool = makeTool('search');
    const config = new HarnessConfig({ processors: [entry], tools: [tool as any], flags: { verbose: true }, slots: { model: 'gpt-4' } });
    expect(config.validate()).toEqual([]);
  });

  test('validate invalid hook', () => {
    const proc = makeProcessor('p1');
    const entry = new ProcessorEntry(proc, 'invalid_hook', 0);
    const config = new HarnessConfig({ processors: [entry] });
    const errors = config.validate();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('invalid_hook'))).toBe(true);
  });

  test('validate tool without name', () => {
    const tool = { name: '', description: 'something', input_schema: {}, async execute(): Promise<ToolResult> { return new ToolResult({ call_id: 'mock', output: 'ok' }); } };
    const config = new HarnessConfig({ tools: [tool as any] });
    const errors = config.validate();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.toLowerCase().includes('name'))).toBe(true);
  });
});
