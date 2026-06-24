import { describe, test, expect } from 'bun:test';
import { Trajectory, TrajectoryStep, load_trajectory } from '../src/primitives/trajectory';
import { Message, MessageType, ToolResult } from '../src/primitives/events';
import { State, StateDelta, StateSnapshot } from '../src/primitives/state';
import { makeRunId, makeTmpDir, approx } from './fixtures';
import { join } from 'node:path';

describe('TrajectoryStep creation', () => {
  test('defaults', () => {
    const step = new TrajectoryStep();
    expect(step.state_before).toBeInstanceOf(StateSnapshot);
    expect(step.action).toBeNull();
    expect(step.observations).toEqual([]);
    expect(step.reward).toBe(0.0);
    expect(step.delta).toBeInstanceOf(StateDelta);
    expect(step.metadata).toEqual({});
  });

  test('explicit fields', () => {
    const runId = makeRunId();
    const state = new State();
    const msg = new Message({ role: MessageType.USER, content: 'hello', run_id: runId, step_id: 0 });
    state.add_message(msg);
    const snap = state.snapshot();

    const action = new Message({ role: MessageType.ASSISTANT, content: 'hi there', run_id: runId, step_id: 0 });
    const observation = new ToolResult({ run_id: runId, step_id: 0, call_id: 'c1', output: 'done' });
    const delta = new StateDelta({ messages_added: 1 });

    const step = new TrajectoryStep({
      state_before: snap,
      action,
      observations: [observation],
      reward: 0.8,
      delta,
      metadata: { attempt: 1 },
    });

    expect(step.state_before).toBe(snap);
    expect(step.action).toBe(action);
    expect(step.observations).toContain(observation);
    expect(step.reward).toBe(0.8);
    expect(step.delta).toBe(delta);
    expect(step.metadata).toEqual({ attempt: 1 });
  });
});

describe('Trajectory basic', () => {
  test('creation', () => {
    const traj = new Trajectory({ task_id: 'test-task-1' });
    expect(traj.length).toBe(0);
    expect(traj.total_reward).toBe(0.0);
    expect(traj.last_step).toBeNull();
    expect(traj.task_id).toBe('test-task-1');
  });

  test('add step', () => {
    const traj = new Trajectory({ task_id: 't1' });
    const step = new TrajectoryStep({ reward: 0.5 });
    traj.add_step(step);
    expect(traj.length).toBe(1);
    expect(traj.last_step).toBe(step);
    expect(traj.total_reward).toBe(0.5);
  });

  test('multiple steps', () => {
    const traj = new Trajectory({ task_id: 't1' });
    const s1 = new TrajectoryStep({ reward: 0.3 });
    const s2 = new TrajectoryStep({ reward: 0.7 });
    const s3 = new TrajectoryStep({ reward: -0.2 });
    traj.add_step(s1);
    traj.add_step(s2);
    traj.add_step(s3);
    expect(traj.length).toBe(3);
    expect(traj.last_step).toBe(s3);
    expect(traj.total_reward).toBeCloseTo(0.8);
    expect([...traj]).toEqual([s1, s2, s3]);
  });

  test('mutable metadata', () => {
    const traj = new Trajectory({ task_id: 't1' });
    traj.metadata['env'] = 'test';
    expect(traj.metadata['env']).toBe('test');
  });
});

describe('Trajectory JSONL', () => {
  test('jsonl roundtrip', () => {
    const runId = makeRunId();
    const workDir = makeTmpDir();
    const state = new State();
    state.add_message(new Message({ role: MessageType.USER, content: 'hello', run_id: runId, step_id: 0 }));
    const snap = state.snapshot();
    const action = new Message({ role: MessageType.ASSISTANT, content: 'hi', run_id: runId, step_id: 0 });
    const delta = new StateDelta({ messages_added: 1 });

    const traj = new Trajectory({ task_id: 'roundtrip-test' });
    traj.add_step(new TrajectoryStep({ state_before: snap, action, observations: [], reward: 0.5, delta, metadata: { attempt: 1 } }));
    traj.add_step(new TrajectoryStep({ state_before: snap, action, observations: [], reward: 0.8, delta, metadata: { attempt: 2 } }));

    const path = join(workDir, 'trajectory.jsonl');
    traj.to_jsonl(path);

    const lines = require('node:fs').readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(3); // 1 metadata + 2 steps

    const loaded = load_trajectory(path);
    expect(loaded.task_id).toBe(traj.task_id);
    expect(loaded.length).toBe(traj.length);
    expect(loaded.total_reward).toBeCloseTo(traj.total_reward);
  });

  test('jsonl empty trajectory', () => {
    const workDir = makeTmpDir();
    const traj = new Trajectory({ task_id: 'empty' });
    const path = join(workDir, 'empty.jsonl');
    traj.to_jsonl(path);
    const loaded = load_trajectory(path);
    expect(loaded.task_id).toBe('empty');
    expect(loaded.length).toBe(0);
  });

  test('load nonexistent file throws', () => {
    const workDir = makeTmpDir();
    expect(() => load_trajectory(join(workDir, 'does_not_exist.jsonl'))).toThrow();
  });
});

describe('Trajectory records', () => {
  test('sft records stub', () => {
    const traj = new Trajectory({ task_id: 't1' });
    const records = traj.to_sft_records();
    expect(Array.isArray(records)).toBe(true);
  });

  test('rl records stub', () => {
    const traj = new Trajectory({ task_id: 't1' });
    const records = traj.to_rl_records();
    expect(Array.isArray(records)).toBe(true);
  });
});

describe('Trajectory integration', () => {
  test('full lifecycle', () => {
    const runId = makeRunId();
    const workDir = makeTmpDir();
    const state = new State();
    const traj = new Trajectory({ task_id: 'integration-test' });

    // Step 0
    const userMsg = new Message({ role: MessageType.USER, content: 'What is 2+2?', run_id: runId, step_id: 0 });
    const snapBefore = state.snapshot();
    state.add_message(userMsg);
    const assistantMsg = new Message({ role: MessageType.ASSISTANT, content: '4', run_id: runId, step_id: 0 });
    state.add_message(assistantMsg);
    const delta = state.compute_delta(snapBefore);
    traj.add_step(new TrajectoryStep({ state_before: snapBefore, action: assistantMsg, observations: [], reward: 1.0, delta }));

    // Step 1
    const snapBefore2 = state.snapshot();
    const userMsg2 = new Message({ role: MessageType.USER, content: 'And 3+3?', run_id: runId, step_id: 1 });
    state.add_message(userMsg2);
    const assistantMsg2 = new Message({ role: MessageType.ASSISTANT, content: '6', run_id: runId, step_id: 1 });
    state.add_message(assistantMsg2);
    const delta2 = state.compute_delta(snapBefore2);
    traj.add_step(new TrajectoryStep({ state_before: snapBefore2, action: assistantMsg2, observations: [], reward: 0.9, delta: delta2 }));

    expect(traj.length).toBe(2);
    expect(traj.total_reward).toBeCloseTo(1.9);
    expect(traj.last_step).not.toBeNull();
    expect(traj.last_step!.delta.messages_added).toBe(2);

    const path = join(workDir, 'integration.jsonl');
    traj.to_jsonl(path);
    const loaded = load_trajectory(path);
    expect(loaded.task_id).toBe('integration-test');
    expect(loaded.length).toBe(2);
  });
});
