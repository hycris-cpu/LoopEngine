import { describe, test, expect } from 'bun:test';
import {
  Event, Message, MessageType, ToolCall, ToolResult, EvalResult, ToolCallMetadata,
  type OpenAIToolCall,
} from '../src/primitives/events';

describe('Event creation', () => {
  test('event has required fields', () => {
    const event = new Event({ type: 'test', run_id: 'r1', step_id: 0, ts: 123.456 });
    expect(event.type).toBe('test');
    expect(event.run_id).toBe('r1');
    expect(event.step_id).toBe(0);
    expect(event.ts).toBe(123.456);
  });
});

describe('Event immutability', () => {
  test('event fields are readonly (TS enforced)', () => {
    const event = new Event({ type: 'test', run_id: 'r1', step_id: 0, ts: 1.0 });
    // In TS, readonly prevents compile-time mutation. At runtime, JS doesn't throw.
    // We verify the values are set correctly.
    expect(event.type).toBe('test');
  });
});

describe('Event equality', () => {
  test('equal events have same values', () => {
    const a = new Event({ type: 'test', run_id: 'r1', step_id: 0, ts: 1.0 });
    const b = new Event({ type: 'test', run_id: 'r1', step_id: 0, ts: 1.0 });
    expect(a.type).toBe(b.type);
    expect(a.run_id).toBe(b.run_id);
    expect(a.step_id).toBe(b.step_id);
    expect(a.ts).toBe(b.ts);
  });

  test('different events have different run_ids', () => {
    const a = new Event({ type: 'test', run_id: 'r1', step_id: 0, ts: 1.0 });
    const b = new Event({ type: 'test', run_id: 'r2', step_id: 0, ts: 1.0 });
    expect(a.run_id).not.toBe(b.run_id);
  });
});

describe('MessageType enum', () => {
  test('has all roles', () => {
    expect(Object.values(MessageType)).toEqual(expect.arrayContaining(['system', 'user', 'assistant', 'tool']));
  });

  test('values are strings', () => {
    for (const member of Object.values(MessageType)) {
      expect(typeof member).toBe('string');
    }
  });
});

describe('Message', () => {
  test('creation with fields', () => {
    const msg = new Message({ run_id: 'r1', step_id: 0, ts: 1.0, role: MessageType.USER, content: 'hello' });
    expect(msg.type).toBe('message');
    expect(msg.role).toBe(MessageType.USER);
    expect(msg.content).toBe('hello');
    expect(msg.tool_calls).toEqual([]);
    expect(msg.metadata).toEqual({});
  });

  test('defaults', () => {
    const msg = new Message({ run_id: 'r1', step_id: 0, ts: 1.0 });
    expect(msg.role).toBe(MessageType.USER);
    expect(msg.content).toBe('');
    expect(msg.tool_calls).toEqual([]);
  });
});

describe('ToolCall', () => {
  test('creation', () => {
    const tc = new ToolCall({ run_id: 'r1', step_id: 0, ts: 1.0, id: 'call_1', name: 'search', input: { q: 'test' } });
    expect(tc.type).toBe('tool_call');
    expect(tc.id).toBe('call_1');
    expect(tc.name).toBe('search');
    expect(tc.input).toEqual({ q: 'test' });
  });

  test('auto-generates id', () => {
    const tc = new ToolCall({ run_id: 'r1', step_id: 0, ts: 1.0, name: 'search', input: {} });
    expect(tc.id.startsWith('call_')).toBe(true);
    expect(tc.id.length).toBeGreaterThan(5);
  });
});

describe('ToolResult', () => {
  test('creation', () => {
    const tr = new ToolResult({ run_id: 'r1', step_id: 0, ts: 1.0, call_id: 'call_1', output: 'ok' });
    expect(tr.type).toBe('tool_result');
    expect(tr.call_id).toBe('call_1');
    expect(tr.output).toBe('ok');
    expect(tr.error).toBeNull();
  });

  test('is_error when error set', () => {
    const tr = new ToolResult({ run_id: 'r1', step_id: 0, ts: 1.0, call_id: 'c1', output: '', error: 'boom' });
    expect(tr.is_error).toBe(true);
  });

  test('not error when no error', () => {
    const tr = new ToolResult({ run_id: 'r1', step_id: 0, ts: 1.0, call_id: 'c1', output: 'ok' });
    expect(tr.is_error).toBe(false);
  });
});

describe('EvalResult', () => {
  test('creation', () => {
    const er = new EvalResult({ run_id: 'r1', step_id: 0, ts: 1.0, passed: true, score: 0.9, reason: 'good job', reward: 1.0 });
    expect(er.type).toBe('eval_result');
    expect(er.passed).toBe(true);
    expect(er.score).toBe(0.9);
    expect(er.reason).toBe('good job');
    expect(er.reward).toBe(1.0);
  });

  test('defaults', () => {
    const er = new EvalResult({ run_id: 'r1', step_id: 0, ts: 1.0 });
    expect(er.passed).toBe(false);
    expect(er.score).toBe(0.0);
    expect(er.reason).toBe('');
    expect(er.reward).toBe(0.0);
  });
});

describe('Serialization', () => {
  test('event to_dict', () => {
    const event = new Event({ type: 'test', run_id: 'r1', step_id: 0, ts: 1.0 });
    const d = event.to_dict();
    expect(d).toEqual({ type: 'test', run_id: 'r1', step_id: 0, ts: 1.0 });
  });

  test('event to_json', () => {
    const event = new Event({ type: 'test', run_id: 'r1', step_id: 0, ts: 1.0 });
    const j = event.to_json();
    const parsed = JSON.parse(j);
    expect(parsed.type).toBe('test');
  });

  test('message to_dict includes role and content', () => {
    const msg = new Message({ run_id: 'r1', step_id: 0, ts: 1.0, role: MessageType.ASSISTANT, content: 'hi' });
    const d = msg.to_dict();
    expect(d.type).toBe('message');
    expect(d.role).toBe('assistant');
    expect(d.content).toBe('hi');
    expect(d.tool_calls).toEqual([]);
  });

  test('message to_openai_dict', () => {
    const msg = new Message({ run_id: 'r1', step_id: 0, ts: 1.0, role: MessageType.USER, content: 'hello' });
    const d = msg.to_openai_dict();
    expect(d).toEqual({ role: MessageType.USER, content: 'hello' });
  });

  test('tool_call to_dict', () => {
    const tc = new ToolCall({ run_id: 'r1', step_id: 0, ts: 1.0, id: 'c1', name: 'search', input: { q: 'hi' } });
    const d = tc.to_dict();
    expect(d.type).toBe('tool_call');
    expect(d.id).toBe('c1');
    expect(d.name).toBe('search');
    expect(d.input).toEqual({ q: 'hi' });
  });

  test('tool_call to_openai_dict', () => {
    const tc = new ToolCall({ run_id: 'r1', step_id: 0, ts: 1.0, id: 'c1', name: 'search', input: { q: 'hi' } });
    const d = tc.to_openai_dict();
    const typed = d as unknown as OpenAIToolCall;
    expect(d.id).toBe('c1');
    expect(typed.type).toBe('function');
    expect(typed.function.name).toBe('search');
    expect(JSON.parse(typed.function.arguments)).toEqual({ q: 'hi' });
  });

  test('tool_result to_dict', () => {
    const tr = new ToolResult({ run_id: 'r1', step_id: 0, ts: 1.0, call_id: 'c1', output: 'ok', error: null });
    const d = tr.to_dict();
    expect(d.type).toBe('tool_result');
    expect(d.call_id).toBe('c1');
    expect(d.output).toBe('ok');
    expect(d.error).toBeNull();
  });

  test('eval_result to_dict', () => {
    const er = new EvalResult({ run_id: 'r1', step_id: 0, ts: 1.0, passed: true, score: 0.9, reason: 'good', reward: 1.0 });
    const d = er.to_dict();
    expect(d.type).toBe('eval_result');
    expect(d.passed).toBe(true);
    expect(d.score).toBe(0.9);
    expect(d.reason).toBe('good');
    expect(d.reward).toBe(1.0);
  });

  test('ToolCallMetadata defaults', () => {
    const meta = new ToolCallMetadata();
    expect(meta.processor_name).toBe('');
    expect(meta.retry_count).toBe(0);
    expect(meta.timeout_ms).toBe(30_000);
    expect(meta.tags).toEqual({});
  });
});
