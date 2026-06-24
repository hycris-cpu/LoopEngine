import { describe, test, expect } from 'bun:test';
import { SimplePlugin, PluginLoader } from '../src/composition/plugins';
import { MultiHookProcessor } from '../src/primitives/processors';
import { HarnessBuilder } from '../src/composition/builder';
import type { Tool, ToolContext } from '../src/primitives/tools';
import type { ToolResult } from '../src/primitives/events';

class PassThroughProcessor extends MultiHookProcessor {
  constructor() { super('passthrough'); }
}

class StubTool implements Tool {
  constructor(private _name = 'stub', private _description = 'A stub tool') {}
  get name() { return this._name; }
  get description() { return this._description; }
  get input_schema() { return { type: 'object', properties: {} }; }
  async execute(_input: Record<string, unknown>, _ctx: ToolContext): Promise<any> {
    return { output: 'stub_result' };
  }
}

describe('SimplePlugin creation', () => {
  test('stores name', () => {
    const plugin = new SimplePlugin('test_plugin');
    expect(plugin.name).toBe('test_plugin');
  });

  test('default processors is empty', () => {
    const plugin = new SimplePlugin('test');
    expect(plugin.processors).toEqual([]);
  });

  test('default tools is empty', () => {
    const plugin = new SimplePlugin('test');
    expect(plugin.tools).toEqual([]);
  });

  test('default flags is empty', () => {
    const plugin = new SimplePlugin('test');
    expect(plugin.flags).toEqual({});
  });
});

describe('SimplePlugin with fields', () => {
  test('stores processors', () => {
    const proc = new PassThroughProcessor();
    const plugin = new SimplePlugin('test', [[proc, 'step_end', 0]]);
    expect(plugin.processors.length).toBe(1);
  });

  test('stores tools', () => {
    const tool = new StubTool();
    const plugin = new SimplePlugin('test', null, [tool]);
    expect(plugin.tools.length).toBe(1);
    expect(plugin.tools[0]).toBe(tool);
  });

  test('stores flags', () => {
    const plugin = new SimplePlugin('test', null, null, { verbose: true, debug: false });
    expect(plugin.flags).toEqual({ verbose: true, debug: false });
  });
});

describe('Plugin lifecycle', () => {
  test('setup returns void by default', async () => {
    const plugin = new SimplePlugin('test');
    const result = await plugin.setup({});
    expect(result).toBeUndefined();
  });

  test('teardown returns void by default', async () => {
    const plugin = new SimplePlugin('test');
    const result = await plugin.teardown();
    expect(result).toBeUndefined();
  });

  test('setup with config', async () => {
    const plugin = new SimplePlugin('test');
    await plugin.setup({ working_dir: '/tmp', model: 'gpt-4' });
    // no error = success
  });

  test('custom setup/teardown', async () => {
    class TrackingPlugin extends SimplePlugin {
      setupCalled = false;
      teardownCalled = false;
      constructor() { super('tracker'); }
      async setup(_config: Record<string, unknown>) { this.setupCalled = true; }
      async teardown() { this.teardownCalled = true; }
    }
    const plugin = new TrackingPlugin();
    expect(plugin.setupCalled).toBe(false);
    expect(plugin.teardownCalled).toBe(false);
    await plugin.setup({});
    expect(plugin.setupCalled).toBe(true);
    expect(plugin.teardownCalled).toBe(false);
    await plugin.teardown();
    expect(plugin.teardownCalled).toBe(true);
  });
});

describe('PluginLoader', () => {
  test('register then get', () => {
    const loader = new PluginLoader();
    const plugin = new SimplePlugin('my_plugin');
    loader.register(plugin);
    expect(loader.get('my_plugin')).toBe(plugin);
  });

  test('get missing returns null', () => {
    const loader = new PluginLoader();
    expect(loader.get('ghost')).toBeNull();
  });

  test('list returns all registered', () => {
    const loader = new PluginLoader();
    loader.register(new SimplePlugin('alpha'));
    loader.register(new SimplePlugin('beta'));
    expect(loader.list().sort()).toEqual(['alpha', 'beta']);
  });

  test('list empty loader', () => {
    const loader = new PluginLoader();
    expect(loader.list()).toEqual([]);
  });

  test('register duplicate throws', () => {
    const loader = new PluginLoader();
    loader.register(new SimplePlugin('dup'));
    expect(() => loader.register(new SimplePlugin('dup'))).toThrow(/already registered/);
  });

  test('length returns count', () => {
    const loader = new PluginLoader();
    loader.register(new SimplePlugin('a'));
    loader.register(new SimplePlugin('b'));
    loader.register(new SimplePlugin('c'));
    expect(loader.length).toBe(3);
  });
});

describe('Plugin builder integration', () => {
  test('plugin adds processor to builder', () => {
    const proc = new PassThroughProcessor();
    const plugin = new SimplePlugin('test', [[proc, 'step_end', 0]]);
    const builder = new HarnessBuilder().plugin(plugin);
    const config = builder.build();
    expect(config.processors.length).toBe(1);
    expect(config.processors[0].processor).toBe(proc);
  });

  test('plugin adds tool to builder', () => {
    const tool = new StubTool('search');
    const plugin = new SimplePlugin('test', null, [tool]);
    const builder = new HarnessBuilder().plugin(plugin);
    const config = builder.build();
    expect(config.tools.length).toBe(1);
    expect(config.tools[0].name).toBe('search');
  });

  test('plugin adds flags to builder', () => {
    const plugin = new SimplePlugin('test', null, null, { verbose: true, debug: false });
    const builder = new HarnessBuilder().plugin(plugin);
    const config = builder.build();
    expect(config.flags['verbose']).toBe(true);
    expect(config.flags['debug']).toBe(false);
  });

  test('plugin does not mutate builder', () => {
    const original = new HarnessBuilder();
    const plugin = new SimplePlugin('test', null, [new StubTool()], { x: true });
    original.plugin(plugin);
    const config = original.build();
    expect(config.tools.length).toBe(0);
    expect(Object.keys(config.flags).length).toBe(0);
  });

  test('multiple plugins compose', () => {
    const p1 = new SimplePlugin('p1', null, [new StubTool('t1')]);
    const p2 = new SimplePlugin('p2', null, [new StubTool('t2')]);
    const builder = new HarnessBuilder().plugin(p1).plugin(p2);
    const config = builder.build();
    expect(config.tools.length).toBe(2);
    const names = new Set(config.tools.map(t => t.name));
    expect(names).toEqual(new Set(['t1', 't2']));
  });
});
