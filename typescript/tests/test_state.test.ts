import { describe, test, expect } from 'bun:test';
import { Budget, State, StateSlot, StateSnapshot, StateDelta } from '../src/primitives/state';
import { Message, MessageType } from '../src/primitives/events';
import { makeRunId } from './fixtures';

function makeMsg(opts: { role?: MessageType; content?: string; run_id?: string; step_id?: number } = {}) {
  return new Message({
    role: opts.role ?? MessageType.USER,
    content: opts.content ?? 'hello',
    run_id: opts.run_id ?? 'test-run',
    step_id: opts.step_id ?? 0,
    ts: 1234567890.0,
  });
}

describe('Budget', () => {
  test('creation with defaults', () => {
    const budget = new Budget();
    expect(budget.max_tokens).toBe(128_000);
    expect(budget.max_cost_usd).toBe(10.0);
    expect(budget.max_steps).toBe(100);
  });

  test('creation with custom values', () => {
    const budget = new Budget({ max_tokens: 4096, max_cost_usd: 1.0, max_steps: 10 });
    expect(budget.max_tokens).toBe(4096);
    expect(budget.max_cost_usd).toBe(1.0);
    expect(budget.max_steps).toBe(10);
  });

  test('equality', () => {
    const b1 = new Budget({ max_tokens: 4096, max_cost_usd: 1.0, max_steps: 10 });
    const b2 = new Budget({ max_tokens: 4096, max_cost_usd: 1.0, max_steps: 10 });
    expect(b1.max_tokens).toBe(b2.max_tokens);
    expect(b1.max_cost_usd).toBe(b2.max_cost_usd);
    expect(b1.max_steps).toBe(b2.max_steps);
  });

  test('inequality', () => {
    const b1 = new Budget({ max_tokens: 4096 });
    const b2 = new Budget({ max_tokens: 8192 });
    expect(b1.max_tokens).not.toBe(b2.max_tokens);
  });
});

describe('StateSlot', () => {
  test('creation with defaults', () => {
    const slot = new StateSlot();
    expect(slot.key).toBe('');
    expect(slot.value).toBeNull();
    expect(slot.slot_type).toBe('general');
    expect(slot.metadata).toEqual({});
  });

  test('creation with values', () => {
    const slot = new StateSlot({ key: 'retry_count', value: 3, slot_type: 'counter', metadata: { processor: 'retry' } });
    expect(slot.key).toBe('retry_count');
    expect(slot.value).toBe(3);
    expect(slot.slot_type).toBe('counter');
    expect(slot.metadata).toEqual({ processor: 'retry' });
  });

  test('mutable', () => {
    const slot = new StateSlot({ key: 'x', value: 1 });
    slot.value = 2;
    expect(slot.value).toBe(2);
  });
});

describe('State creation', () => {
  test('defaults', () => {
    const state = new State();
    expect(state.raw_messages).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.slots).toEqual({});
    expect(state.step).toBe(0);
    expect(state.budget).toBeInstanceOf(Budget);
    expect(state.usage_tokens).toBe(0);
    expect(state.usage_cost_usd).toBe(0.0);
  });

  test('custom budget', () => {
    const budget = new Budget({ max_tokens: 4096, max_steps: 10 });
    const state = new State({ budget });
    expect(state.budget.max_tokens).toBe(4096);
    expect(state.budget.max_steps).toBe(10);
  });
});

describe('State messages (dual-track)', () => {
  test('add_message dual track', () => {
    const state = new State();
    const msg = makeMsg({ run_id: makeRunId() });
    state.add_message(msg);
    expect(state.raw_messages.length).toBe(1);
    expect(state.messages.length).toBe(1);
    expect(state.raw_messages[0]).toBe(msg);
    expect(state.messages[0]).toBe(msg);
  });

  test('add_raw_event only', () => {
    const state = new State();
    const msg = makeMsg({ run_id: makeRunId() });
    state.add_raw_event(msg);
    expect(state.raw_messages.length).toBe(1);
    expect(state.messages.length).toBe(0);
  });

  test('inject_message only', () => {
    const state = new State();
    const hint = makeMsg({ role: MessageType.SYSTEM, content: 'Be concise.', run_id: makeRunId() });
    state.inject_message(hint);
    expect(state.messages.length).toBe(1);
    expect(state.raw_messages.length).toBe(0);
  });

  test('dual-track divergence', () => {
    const state = new State();
    const runId = makeRunId();
    const realMsg = makeMsg({ content: 'real', run_id: runId });
    const hint = makeMsg({ role: MessageType.SYSTEM, content: 'hint', run_id: runId });
    state.add_message(realMsg);
    state.inject_message(hint);
    expect(state.raw_messages.length).toBe(1);
    expect(state.messages.length).toBe(2);
    expect((state.messages[1] as Message).content).toBe('hint');
  });

  test('multiple adds preserve order', () => {
    const state = new State();
    const runId = makeRunId();
    const msg1 = makeMsg({ content: 'first', run_id: runId, step_id: 0 });
    const msg2 = makeMsg({ content: 'second', run_id: runId, step_id: 1 });
    state.add_message(msg1);
    state.add_message(msg2);
    expect((state.raw_messages[0] as Message).content).toBe('first');
    expect((state.raw_messages[1] as Message).content).toBe('second');
  });
});

describe('State slot CRUD', () => {
  test('set and get slot', () => {
    const state = new State();
    state.set_slot('retry_count', 3, 'counter');
    const slot = state.get_slot('retry_count');
    expect(slot).not.toBeNull();
    expect(slot!.key).toBe('retry_count');
    expect(slot!.value).toBe(3);
    expect(slot!.slot_type).toBe('counter');
  });

  test('get missing slot returns null', () => {
    const state = new State();
    expect(state.get_slot('nonexistent')).toBeNull();
  });

  test('set slot overwrites value', () => {
    const state = new State();
    state.set_slot('x', 1);
    state.set_slot('x', 2);
    expect(state.get_slot('x')!.value).toBe(2);
    expect(Object.keys(state.slots).length).toBe(1);
  });

  test('delete existing slot', () => {
    const state = new State();
    state.set_slot('x', 42);
    const result = state.delete_slot('x');
    expect(result).toBe(true);
    expect(state.get_slot('x')).toBeNull();
  });

  test('delete missing slot', () => {
    const state = new State();
    const result = state.delete_slot('x');
    expect(result).toBe(false);
  });

  test('multiple slots independent', () => {
    const state = new State();
    state.set_slot('a', 1);
    state.set_slot('b', 2);
    state.set_slot('c', 3);
    expect(state.get_slot('a')!.value).toBe(1);
    expect(state.get_slot('b')!.value).toBe(2);
    expect(state.get_slot('c')!.value).toBe(3);
    expect(Object.keys(state.slots).length).toBe(3);
  });

  test('set slot with metadata', () => {
    const state = new State();
    state.set_slot('hint', 'be concise', 'general', { from: 'processor' });
    const slot = state.get_slot('hint');
    expect(slot!.metadata).toEqual({ from: 'processor' });
  });
});

describe('StateSnapshot', () => {
  test('captures state', () => {
    const state = new State();
    const runId = makeRunId();
    const msg = new Message({ role: MessageType.USER, content: 'hi', run_id: runId, step_id: 0, ts: 1.0 });
    state.add_message(msg);
    state.set_slot('x', 42);
    state.step = 3;

    const snap = state.snapshot();
    expect(snap.raw_messages.length).toBe(1);
    expect(snap.messages.length).toBe(1);
    expect(snap.slots['x'].value).toBe(42);
    expect(snap.step).toBe(3);
  });

  test('is independent of state', () => {
    const state = new State();
    const runId = makeRunId();
    state.set_slot('x', 1);
    const snap = state.snapshot();
    state.set_slot('x', 2);
    state.add_message(new Message({ role: MessageType.USER, content: 'new', run_id: runId, step_id: 0, ts: 1.0 }));
    expect(snap.slots['x'].value).toBe(1);
    expect(snap.raw_messages.length).toBe(0);
  });

  test('default is empty', () => {
    const snap = new StateSnapshot();
    expect(snap.raw_messages).toEqual([]);
    expect(snap.messages).toEqual([]);
    expect(snap.slots).toEqual({});
    expect(snap.step).toBe(0);
  });
});

describe('State snapshot/restore roundtrip', () => {
  test('restore roundtrip', () => {
    const state = new State();
    const runId = makeRunId();
    const msg = new Message({ role: MessageType.USER, content: 'hello', run_id: runId, step_id: 0, ts: 1.0 });
    state.add_message(msg);
    state.set_slot('key', 'value');
    state.step = 5;

    const snap = state.snapshot();

    state.set_slot('key', 'CHANGED');
    state.step = 99;
    state.add_message(new Message({ role: MessageType.USER, content: 'noise', run_id: runId, step_id: 1, ts: 2.0 }));

    state.restore(snap);

    expect(state.raw_messages.length).toBe(1);
    expect((state.raw_messages[0] as Message).content).toBe('hello');
    expect(state.get_slot('key')!.value).toBe('value');
    expect(state.step).toBe(5);
  });

  test('restore clears current state', () => {
    const state = new State();
    const runId = makeRunId();
    const snapEmpty = state.snapshot();

    state.add_message(new Message({ role: MessageType.USER, content: 'added', run_id: runId, step_id: 0, ts: 1.0 }));
    state.set_slot('x', 1);
    expect(state.raw_messages.length).toBe(1);

    state.restore(snapEmpty);
    expect(state.raw_messages.length).toBe(0);
    expect(Object.keys(state.slots).length).toBe(0);
  });
});

describe('StateDelta', () => {
  test('detects new slots', () => {
    const state = new State();
    const snap = state.snapshot();
    state.set_slot('a', 1);
    state.set_slot('b', 2);
    const delta = state.compute_delta(snap);
    expect([...delta.created_slots].sort()).toEqual(['a', 'b']);
    expect(delta.updated_slots).toEqual([]);
    expect(delta.deleted_slots).toEqual([]);
  });

  test('detects updated slots', () => {
    const state = new State();
    state.set_slot('x', 1);
    const snap = state.snapshot();
    state.set_slot('x', 2);
    const delta = state.compute_delta(snap);
    expect(delta.updated_slots).toEqual(['x']);
    expect(delta.created_slots).toEqual([]);
    expect(delta.deleted_slots).toEqual([]);
  });

  test('detects deleted slots', () => {
    const state = new State();
    state.set_slot('x', 1);
    state.set_slot('y', 2);
    const snap = state.snapshot();
    state.delete_slot('y');
    const delta = state.compute_delta(snap);
    expect(delta.deleted_slots).toEqual(['y']);
    expect(delta.created_slots).toEqual([]);
    expect(delta.updated_slots).toEqual([]);
  });

  test('detects new messages', () => {
    const state = new State();
    const snap = state.snapshot();
    const runId = makeRunId();
    state.add_message(new Message({ role: MessageType.USER, content: 'a', run_id: runId, step_id: 0, ts: 1.0 }));
    state.add_message(new Message({ role: MessageType.ASSISTANT, content: 'b', run_id: runId, step_id: 1, ts: 2.0 }));
    const delta = state.compute_delta(snap);
    expect(delta.messages_added).toBe(2);
  });

  test('detects step change', () => {
    const state = new State();
    state.step = 0;
    const snap = state.snapshot();
    state.step = 3;
    const delta = state.compute_delta(snap);
    expect(delta.step_delta).toBe(3);
  });

  test('empty when no changes', () => {
    const state = new State();
    state.set_slot('x', 1);
    const snap = state.snapshot();
    const delta = state.compute_delta(snap);
    expect(delta.created_slots).toEqual([]);
    expect(delta.updated_slots).toEqual([]);
    expect(delta.deleted_slots).toEqual([]);
    expect(delta.messages_added).toBe(0);
    expect(delta.step_delta).toBe(0);
  });
});

describe('State budget tracking', () => {
  test('record usage', () => {
    const state = new State();
    state.record_usage(100, 0.50);
    expect(state.usage_tokens).toBe(100);
    expect(state.usage_cost_usd).toBe(0.50);
  });

  test('record usage accumulates', () => {
    const state = new State();
    state.record_usage(100, 0.50);
    state.record_usage(200, 1.00);
    expect(state.usage_tokens).toBe(300);
    expect(state.usage_cost_usd).toBe(1.50);
  });

  test('budget not exhausted initially', () => {
    const state = new State();
    expect(state.is_budget_exhausted).toBe(false);
  });

  test('budget exhausted by tokens', () => {
    const state = new State({ budget: new Budget({ max_tokens: 100 }) });
    state.usage_tokens = 100;
    expect(state.is_budget_exhausted).toBe(true);
  });

  test('budget exhausted by cost', () => {
    const state = new State({ budget: new Budget({ max_cost_usd: 5.0 }) });
    state.usage_cost_usd = 5.0;
    expect(state.is_budget_exhausted).toBe(true);
  });

  test('budget exhausted by steps', () => {
    const state = new State({ budget: new Budget({ max_steps: 10 }) });
    state.step = 10;
    expect(state.is_budget_exhausted).toBe(true);
  });
});
