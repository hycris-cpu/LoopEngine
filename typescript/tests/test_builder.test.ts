import { describe, test, expect } from 'bun:test';
import { HarnessBuilder } from '../src/composition/builder';
import { HarnessConfig, ProcessorEntry } from '../src/composition/config';
import { MultiHookProcessor } from '../src/primitives/processors';
import { ToolResult } from '../src/primitives/events';

function makeProcessor(name = 'mock_proc') { return new MultiHookProcessor(name); }
function makeTool(name = 'mock_tool', description = 'A mock tool') {
  return { name, description, input_schema: { type: 'object', properties: {} }, async execute(): Promise<ToolResult> { return new ToolResult({ call_id: 'mock', output: 'ok' }); } };
}

describe('HarnessBuilder basic', () => {
  test('create empty', () => {
    const builder = new HarnessBuilder();
    const config = builder.build();
    expect(config.processors).toEqual([]);
    expect(config.tools).toEqual([]);
    expect(config.flags).toEqual({});
    expect(config.slots).toEqual({});
  });

  test('add processor', () => {
    const proc = makeProcessor('p1');
    const builder = new HarnessBuilder();
    const builder2 = builder.add(proc, 'step_end', 5);
    expect(builder.build().processors).toEqual([]);
    const config2 = builder2.build();
    expect(config2.processors.length).toBe(1);
    const entry = config2.processors[0];
    expect(entry.processor.name).toBe('p1');
    expect(entry.hook).toBe('step_end');
    expect(entry.order).toBe(5);
  });

  test('add processor defaults', () => {
    const proc = makeProcessor('p1');
    const builder = new HarnessBuilder();
    const builder2 = builder.add(proc);
    const entry = builder2.build().processors[0];
    expect(entry.hook).toBe('step_end');
    expect(entry.order).toBe(0);
  });

  test('add tool', () => {
    const tool = makeTool('search');
    const builder = new HarnessBuilder();
    const builder2 = builder.tool(tool as any);
    expect(builder.build().tools).toEqual([]);
    const config2 = builder2.build();
    expect(config2.tools.length).toBe(1);
    expect(config2.tools[0].name).toBe('search');
  });

  test('set flag', () => {
    const builder = new HarnessBuilder();
    const builder2 = builder.flag('verbose', true);
    expect(builder.build().flags).toEqual({});
    expect(builder2.build().flags).toEqual({ verbose: true });
  });

  test('set flag default enabled', () => {
    const builder = new HarnessBuilder();
    const builder2 = builder.flag('debug');
    expect(builder2.build().flags).toEqual({ debug: true });
  });

  test('set flag disabled', () => {
    const builder = new HarnessBuilder();
    const builder2 = builder.flag('verbose', false);
    expect(builder2.build().flags).toEqual({ verbose: false });
  });

  test('set slot', () => {
    const builder = new HarnessBuilder();
    const builder2 = builder.slot({ model: 'gpt-4', temperature: 0.7 });
    expect(builder.build().slots).toEqual({});
    expect(builder2.build().slots).toEqual({ model: 'gpt-4', temperature: 0.7 });
  });
});

describe('HarnessBuilder immutability', () => {
  test('add returns new instance', () => {
    const builder = new HarnessBuilder();
    const builder2 = builder.add(makeProcessor('p1'));
    expect(builder).not.toBe(builder2);
  });

  test('tool returns new instance', () => {
    const builder = new HarnessBuilder();
    const builder2 = builder.tool(makeTool('t1') as any);
    expect(builder).not.toBe(builder2);
  });

  test('flag returns new instance', () => {
    const builder = new HarnessBuilder();
    const builder2 = builder.flag('x');
    expect(builder).not.toBe(builder2);
  });

  test('slot returns new instance', () => {
    const builder = new HarnessBuilder();
    const builder2 = builder.slot({ x: 1 });
    expect(builder).not.toBe(builder2);
  });

  test('original unchanged after multiple adds', () => {
    const original = new HarnessBuilder();
    original.add(makeProcessor('p1')).tool(makeTool('t1') as any).flag('x');
    const config = original.build();
    expect(config.processors).toEqual([]);
    expect(config.tools).toEqual([]);
    expect(config.flags).toEqual({});
  });

  test('branching from same builder', () => {
    const base = new HarnessBuilder();
    const branchA = base.add(makeProcessor('p1'));
    const branchB = base.add(makeProcessor('p2'));
    expect(branchA.build().processors[0].processor.name).toBe('p1');
    expect(branchB.build().processors[0].processor.name).toBe('p2');
    expect(base.build().processors.length).toBe(0);
  });
});

describe('HarnessBuilder build', () => {
  test('produces config', () => {
    const builder = new HarnessBuilder();
    const config = builder.build();
    expect(config).toBeInstanceOf(HarnessConfig);
  });

  test('build with all parts', () => {
    const proc = makeProcessor('p1');
    const tool = makeTool('search');
    const config = new HarnessBuilder()
      .add(proc, 'after_model', 1)
      .tool(tool as any)
      .flag('verbose')
      .slot({ model: 'gpt-4' })
      .build();
    expect(config.processors.length).toBe(1);
    expect(config.processors[0].processor.name).toBe('p1');
    expect(config.processors[0].hook).toBe('after_model');
    expect(config.processors[0].order).toBe(1);
    expect(config.tools.length).toBe(1);
    expect(config.tools[0].name).toBe('search');
    expect(config.flags).toEqual({ verbose: true });
    expect(config.slots).toEqual({ model: 'gpt-4' });
  });

  test('preserves order', () => {
    const config = new HarnessBuilder()
      .add(makeProcessor('first'), 'step_end', 0)
      .add(makeProcessor('second'), 'step_end', 1)
      .add(makeProcessor('third'), 'step_end', 2)
      .build();
    const names = config.processors.map(pe => pe.processor.name);
    expect(names).toEqual(['first', 'second', 'third']);
  });
});

describe('HarnessBuilder merge', () => {
  test('merge two builders', () => {
    const a = new HarnessBuilder().add(makeProcessor('p1'));
    const b = new HarnessBuilder().add(makeProcessor('p2'));
    const merged = a.merge(b);
    expect(merged.build().processors.length).toBe(2);
  });

  test('merge tools', () => {
    const a = new HarnessBuilder().tool(makeTool('search') as any);
    const b = new HarnessBuilder().tool(makeTool('calc') as any);
    const merged = a.merge(b);
    expect(merged.build().tools.length).toBe(2);
  });

  test('merge flags', () => {
    const a = new HarnessBuilder().flag('verbose');
    const b = new HarnessBuilder().flag('debug');
    const merged = a.merge(b);
    expect(merged.build().flags).toEqual({ verbose: true, debug: true });
  });

  test('merge slots', () => {
    const a = new HarnessBuilder().slot({ model: 'gpt-4' });
    const b = new HarnessBuilder().slot({ temperature: 0.7 });
    const merged = a.merge(b);
    expect(merged.build().slots).toEqual({ model: 'gpt-4', temperature: 0.7 });
  });

  test('merge right overrides flag', () => {
    const a = new HarnessBuilder().flag('verbose', true);
    const b = new HarnessBuilder().flag('verbose', false);
    const merged = a.merge(b);
    expect(merged.build().flags['verbose']).toBe(false);
  });

  test('merge right overrides slot', () => {
    const a = new HarnessBuilder().slot({ model: 'gpt-4' });
    const b = new HarnessBuilder().slot({ model: 'claude-3' });
    const merged = a.merge(b);
    expect(merged.build().slots['model']).toBe('claude-3');
  });

  test('merge originals unchanged', () => {
    const a = new HarnessBuilder().add(makeProcessor('p1'));
    const b = new HarnessBuilder().add(makeProcessor('p2'));
    a.merge(b);
    expect(a.build().processors.length).toBe(1);
    expect(b.build().processors.length).toBe(1);
  });

  test('merge produces valid config', () => {
    const a = new HarnessBuilder().add(makeProcessor('p1')).flag('verbose');
    const b = new HarnessBuilder().tool(makeTool('search') as any).slot({ model: 'gpt-4' });
    const config = a.merge(b).build();
    expect(config.processors.length).toBe(1);
    expect(config.tools.length).toBe(1);
    expect(config.flags).toEqual({ verbose: true });
    expect(config.slots).toEqual({ model: 'gpt-4' });
  });

  test('merge with non-builder throws', () => {
    const builder = new HarnessBuilder();
    expect(() => builder.merge('not a builder' as any)).toThrow();
  });

  test('chained merge', () => {
    const a = new HarnessBuilder().add(makeProcessor('p1'));
    const b = new HarnessBuilder().add(makeProcessor('p2'));
    const c = new HarnessBuilder().add(makeProcessor('p3'));
    const merged = a.merge(b).merge(c);
    expect(merged.build().processors.length).toBe(3);
  });

  test('merge conflict same singleton group throws', () => {
    const proc1 = makeProcessor('p1');
    const proc2 = makeProcessor('p2');
    const a = new HarnessBuilder().add(proc1, 'step_end', 0, 'my_singleton');
    const b = new HarnessBuilder().add(proc2, 'step_end', 0, 'my_singleton');
    expect(() => a.merge(b)).toThrow(/singleton/);
  });
});

describe('HarnessBuilder toString', () => {
  test('empty', () => {
    const builder = new HarnessBuilder();
    const r = builder.toString();
    expect(r).toContain('HarnessBuilder');
    expect(r).toContain('processors=0');
    expect(r).toContain('tools=0');
  });

  test('with contents', () => {
    const builder = new HarnessBuilder()
      .add(makeProcessor('p1'))
      .tool(makeTool('t1') as any)
      .flag('verbose')
      .slot({ model: 'gpt-4' });
    const r = builder.toString();
    expect(r).toContain('processors=1');
    expect(r).toContain('tools=1');
    expect(r).toContain('flags=1');
    expect(r).toContain('slots=1');
  });
});
