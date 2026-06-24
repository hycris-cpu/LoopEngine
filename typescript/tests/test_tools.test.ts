import { describe, test, expect } from 'bun:test';
import { ToolSchema, ToolContext, ToolRegistry, ToolNotFoundError } from '../src/primitives/tools';
import { ToolResult } from '../src/primitives/events';
import { State } from '../src/primitives/state';
import type { Tool } from '../src/primitives/tools';
import { makeRunId } from './fixtures';

class EchoTool implements Tool {
  constructor(
    private _name = 'echo',
    private _description = 'Echo input back',
  ) {}
  get name() { return this._name; }
  get description() { return this._description; }
  get input_schema() {
    return { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
  }
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return new ToolResult({ run_id: ctx.run_id, step_id: ctx.step_id, call_id: 'echo_call', output: (input.message as string) ?? '' });
  }
}

class FailingTool implements Tool {
  get name() { return 'failing'; }
  get description() { return 'Always fails'; }
  get input_schema() { return { type: 'object', properties: {} }; }
  async execute(): Promise<ToolResult> {
    throw new Error('Tool execution exploded!');
  }
}

describe('ToolSchema creation', () => {
  test('stores name and description', () => {
    const schema = new ToolSchema({ name: 'search', description: 'Search the web', input_schema: { type: 'object', properties: { query: { type: 'string' } } } });
    expect(schema.name).toBe('search');
    expect(schema.description).toBe('Search the web');
  });

  test('stores input_schema', () => {
    const input_schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
    const schema = new ToolSchema({ name: 't', description: 'd', input_schema });
    expect(schema.input_schema).toEqual(input_schema);
  });

  test('default metadata is empty', () => {
    const schema = new ToolSchema({ name: 't', description: 'd' });
    expect(schema.metadata).toEqual({});
  });
});

describe('ToolSchema immutability and serialization', () => {
  test('schema equality by values', () => {
    const a = new ToolSchema({ name: 't', description: 'd', input_schema: { x: 1 } });
    const b = new ToolSchema({ name: 't', description: 'd', input_schema: { x: 1 } });
    expect(a.name).toBe(b.name);
    expect(a.description).toBe(b.description);
  });

  test('schema inequality by name', () => {
    const a = new ToolSchema({ name: 'a', description: 'd' });
    const b = new ToolSchema({ name: 'b', description: 'd' });
    expect(a.name).not.toBe(b.name);
  });

  test('to_openai_dict', () => {
    const schema = new ToolSchema({ name: 'search', description: 'Search the web', input_schema: { type: 'object', properties: { q: { type: 'string' } } } });
    const result = schema.to_openai_dict();
    expect(result).toEqual({
      type: 'function',
      function: {
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    });
  });
});

describe('ToolContext', () => {
  test('stores run and step', () => {
    const runId = makeRunId();
    const ctx = new ToolContext({ run_id: runId, step_id: 3 });
    expect(ctx.run_id).toBe(runId);
    expect(ctx.step_id).toBe(3);
  });

  test('defaults state and sandbox to undefined', () => {
    const ctx = new ToolContext({ run_id: makeRunId(), step_id: 0 });
    expect(ctx.state).toBeUndefined();
    expect(ctx.sandbox).toBeUndefined();
  });

  test('accepts state and sandbox', () => {
    const fakeState = new State();
    const fakeSandbox = { y: 2 };
    const ctx = new ToolContext({ run_id: makeRunId(), step_id: 1, state: fakeState, sandbox: fakeSandbox });
    expect(ctx.state).toBe(fakeState);
    expect(ctx.sandbox).toBe(fakeSandbox);
  });
});

describe('ToolRegistry register and get', () => {
  test('register then get', () => {
    const registry = new ToolRegistry();
    const tool = new EchoTool();
    registry.register(tool);
    expect(registry.get('echo')).toBe(tool);
  });

  test('get unregistered returns null', () => {
    const registry = new ToolRegistry();
    expect(registry.get('nonexistent')).toBeNull();
  });

  test('register returns schema', () => {
    const registry = new ToolRegistry();
    const schema = registry.register(new EchoTool());
    expect(schema).toBeInstanceOf(ToolSchema);
    expect(schema.name).toBe('echo');
    expect(schema.description).toBe('Echo input back');
  });

  test('register duplicate throws', () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    expect(() => registry.register(new EchoTool())).toThrow(/already registered/);
  });
});

describe('ToolRegistry listing', () => {
  test('list_schemas returns all', () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool('echo'));
    registry.register(new EchoTool('echo2', 'Second echo'));
    const schemas = registry.list_schemas();
    expect(schemas.length).toBe(2);
    const names = new Set(schemas.map(s => s.name));
    expect(names).toEqual(new Set(['echo', 'echo2']));
  });

  test('list_schemas empty', () => {
    const registry = new ToolRegistry();
    expect(registry.list_schemas()).toEqual([]);
  });

  test('has returns true for registered', () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    expect(registry.has('echo')).toBe(true);
  });

  test('has returns false for unregistered', () => {
    const registry = new ToolRegistry();
    expect(registry.has('echo')).toBe(false);
  });

  test('names returns all registered', () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool('a'));
    registry.register(new EchoTool('b'));
    expect(registry.names().sort()).toEqual(['a', 'b']);
  });

  test('length returns count', () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool('a'));
    registry.register(new EchoTool('b'));
    expect(registry.length).toBe(2);
  });
});

describe('ToolRegistry execute dispatch', () => {
  test('dispatches to correct tool', async () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    const runId = makeRunId();
    const ctx = new ToolContext({ run_id: runId, step_id: 0 });
    const result = await registry.execute('echo', { message: 'hello' }, ctx);
    expect(result).toBeInstanceOf(ToolResult);
    expect(result.output).toBe('hello');
  });

  test('missing tool throws ToolNotFoundError', async () => {
    const registry = new ToolRegistry();
    const ctx = new ToolContext({ run_id: makeRunId(), step_id: 0 });
    expect(registry.execute('ghost', {}, ctx)).rejects.toThrow(ToolNotFoundError);
  });

  test('ToolNotFoundError contains name', () => {
    const err = new ToolNotFoundError('my_tool');
    expect(err.tool_name).toBe('my_tool');
    expect(err.message).toContain('my_tool');
  });
});

describe('Registry OpenAI format', () => {
  test('schemas to openai list', () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool('echo', 'Echo back'));
    registry.register(new EchoTool('search', 'Search web'));
    const openaiTools = registry.list_schemas().map(s => s.to_openai_dict());
    expect(openaiTools.length).toBe(2);
    for (const tool of openaiTools) {
      expect(tool.type).toBe('function');
      expect((tool as any).function.name).toBeDefined();
      expect((tool as any).function.description).toBeDefined();
      expect((tool as any).function.parameters).toBeDefined();
    }
  });

  test('empty registry produces empty list', () => {
    const registry = new ToolRegistry();
    expect(registry.list_schemas().map(s => s.to_openai_dict())).toEqual([]);
  });
});

describe('Tool execute errors', () => {
  test('tool exception propagates', async () => {
    const registry = new ToolRegistry();
    registry.register(new FailingTool());
    const ctx = new ToolContext({ run_id: makeRunId(), step_id: 0 });
    expect(registry.execute('failing', {}, ctx)).rejects.toThrow(/exploded/);
  });
});
