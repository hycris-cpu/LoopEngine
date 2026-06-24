import { describe, test, expect } from 'bun:test';
import { Message, MessageType, ToolResult } from '../src/primitives/events';
import { State, StateDelta, StateSnapshot } from '../src/primitives/state';
import { Trajectory, TrajectoryStep } from '../src/primitives/trajectory';
import { Insight, analyze_trajectory, summarize_trajectory } from '../src/evolution/analysis';

function makeStep(opts: { actionContent?: string; reward?: number; toolResults?: ToolResult[]; stepId?: number } = {}) {
  const action = new Message({ role: MessageType.ASSISTANT, content: opts.actionContent ?? 'doing something', run_id: 'test-run', step_id: opts.stepId ?? 0 });
  return new TrajectoryStep({
    state_before: new StateSnapshot({ step: opts.stepId ?? 0 }),
    action,
    observations: opts.toolResults ?? [],
    reward: opts.reward ?? 0.5,
    delta: new StateDelta({ messages_added: 1, step_delta: 1 }),
  });
}

function makeTrajectory(steps: TrajectoryStep[], taskId = 'test-task') {
  const traj = new Trajectory({ task_id: taskId });
  for (const step of steps) traj.add_step(step);
  return traj;
}

describe('Insight creation', () => {
  test('defaults', () => {
    const insight = new Insight();
    expect(insight.category).toBe('');
    expect(insight.description).toBe('');
    expect(insight.severity).toBe('low');
    expect(insight.evidence).toBe('');
    expect(insight.suggested_fix).toBe('');
  });

  test('explicit fields', () => {
    const insight = new Insight({ category: 'loop', description: 'Repeated search', severity: 'high', evidence: 'Steps 3-7 identical', suggested_fix: 'Add dedup' });
    expect(insight.category).toBe('loop');
    expect(insight.severity).toBe('high');
  });

  test('equality', () => {
    const i1 = new Insight({ category: 'loop', severity: 'high', description: 'same' });
    const i2 = new Insight({ category: 'loop', severity: 'high', description: 'same' });
    expect(i1.category).toBe(i2.category);
    expect(i1.description).toBe(i2.description);
  });
});

describe('Insight serialization', () => {
  test('to_dict', () => {
    const insight = new Insight({ category: 'loop', description: 'repeated', severity: 'medium', evidence: 'steps 2-5', suggested_fix: 'add check' });
    const d = insight.to_dict();
    expect(d.category).toBe('loop');
  });

  test('from_dict', () => {
    const d = { category: 'error', description: 'tool failures', severity: 'critical', evidence: '8 out of 10', suggested_fix: 'add retry' };
    const insight = Insight.from_dict(d);
    expect(insight.category).toBe('error');
    expect(insight.severity).toBe('critical');
  });

  test('roundtrip', () => {
    const original = new Insight({ category: 'budget_waste', description: 'wasted tokens', severity: 'medium', evidence: 'steps 10-20', suggested_fix: 'narrow scope' });
    const restored = Insight.from_dict(original.to_dict());
    expect(restored.category).toBe(original.category);
    expect(restored.description).toBe(original.description);
  });
});

describe('analyze_trajectory - loop detection', () => {
  test('repeated actions detected', () => {
    const steps = Array.from({ length: 5 }, (_, i) => makeStep({ actionContent: 'search for foo', reward: 0.0, stepId: i }));
    const traj = makeTrajectory(steps);
    const insights = analyze_trajectory(traj);
    const loops = insights.filter(i => i.category === 'loop');
    expect(loops.length).toBeGreaterThanOrEqual(1);
    expect(['medium', 'high']).toContain(loops[0].severity);
  });

  test('no loop with varied actions', () => {
    const steps = [
      makeStep({ actionContent: 'search for foo', stepId: 0 }),
      makeStep({ actionContent: 'read file bar.py', stepId: 1 }),
      makeStep({ actionContent: 'edit the function', stepId: 2 }),
      makeStep({ actionContent: 'run tests', stepId: 3 }),
    ];
    const traj = makeTrajectory(steps);
    const insights = analyze_trajectory(traj);
    expect(insights.filter(i => i.category === 'loop').length).toBe(0);
  });

  test('loop with three repeats', () => {
    const steps = Array.from({ length: 3 }, (_, i) => makeStep({ actionContent: 'same thing', reward: 0.0, stepId: i }));
    const traj = makeTrajectory(steps);
    const insights = analyze_trajectory(traj);
    expect(insights.filter(i => i.category === 'loop').length).toBeGreaterThanOrEqual(1);
  });
});

describe('analyze_trajectory - quality', () => {
  test('low total reward', () => {
    const steps = Array.from({ length: 5 }, (_, i) => makeStep({ reward: 0.0, stepId: i }));
    const traj = makeTrajectory(steps);
    const insights = analyze_trajectory(traj);
    expect(insights.filter(i => i.category === 'quality').length).toBeGreaterThanOrEqual(1);
  });

  test('high quality no insight', () => {
    const steps = Array.from({ length: 5 }, (_, i) => makeStep({ reward: 0.9, stepId: i }));
    const traj = makeTrajectory(steps);
    const insights = analyze_trajectory(traj);
    expect(insights.filter(i => i.category === 'quality').length).toBe(0);
  });
});

describe('analyze_trajectory - errors', () => {
  test('tool errors detected', () => {
    const errorResult = new ToolResult({ run_id: 'test', step_id: 0, call_id: 'c1', output: '', error: 'FileNotFoundError' });
    const steps = [
      makeStep({ reward: -0.1, stepId: 0, toolResults: [errorResult] }),
      makeStep({ reward: -0.1, stepId: 1, toolResults: [new ToolResult({ run_id: 'test', step_id: 1, call_id: 'c2', output: '', error: 'Permission denied' })] }),
    ];
    const traj = makeTrajectory(steps);
    const insights = analyze_trajectory(traj);
    expect(insights.filter(i => i.category === 'error').length).toBeGreaterThanOrEqual(1);
  });

  test('no errors no insight', () => {
    const successResult = new ToolResult({ run_id: 'test', step_id: 0, call_id: 'c1', output: 'success' });
    const steps = [
      makeStep({ reward: 0.5, stepId: 0, toolResults: [successResult] }),
      makeStep({ reward: 0.5, stepId: 1 }),
    ];
    const traj = makeTrajectory(steps);
    const insights = analyze_trajectory(traj);
    expect(insights.filter(i => i.category === 'error').length).toBe(0);
  });
});

describe('analyze_trajectory - inefficiency', () => {
  test('many steps low reward', () => {
    const steps = Array.from({ length: 20 }, (_, i) => makeStep({ reward: 0.01, stepId: i }));
    const traj = makeTrajectory(steps);
    const insights = analyze_trajectory(traj);
    expect(insights.filter(i => i.category === 'inefficiency').length).toBeGreaterThanOrEqual(1);
  });

  test('few steps high reward no inefficiency', () => {
    const steps = Array.from({ length: 3 }, (_, i) => makeStep({ reward: 0.9, stepId: i }));
    const traj = makeTrajectory(steps);
    const insights = analyze_trajectory(traj);
    expect(insights.filter(i => i.category === 'inefficiency').length).toBe(0);
  });
});

describe('analyze_trajectory - empty', () => {
  test('empty trajectory', () => {
    const traj = new Trajectory({ task_id: 'empty' });
    expect(analyze_trajectory(traj)).toEqual([]);
  });
});

describe('summarize_trajectory', () => {
  test('structure', () => {
    const steps = Array.from({ length: 3 }, (_, i) => makeStep({ reward: 0.5, stepId: i }));
    const traj = makeTrajectory(steps, 'summary-test');
    const summary = summarize_trajectory(traj);
    expect(summary.task_id).toBe('summary-test');
    expect(summary.total_steps).toBe(3);
    expect(summary.total_reward).toBeCloseTo(1.5);
    expect(summary.avg_reward).toBeCloseTo(0.5);
  });

  test('empty trajectory', () => {
    const traj = new Trajectory({ task_id: 'empty' });
    const summary = summarize_trajectory(traj);
    expect(summary.task_id).toBe('empty');
    expect(summary.total_steps).toBe(0);
    expect(summary.total_reward).toBeCloseTo(0.0);
  });

  test('includes error count', () => {
    const errorResult = new ToolResult({ run_id: 'test', step_id: 0, call_id: 'c1', output: '', error: 'fail' });
    const steps = [
      makeStep({ reward: -0.1, stepId: 0, toolResults: [errorResult] }),
      makeStep({ reward: 0.5, stepId: 1 }),
    ];
    const traj = makeTrajectory(steps);
    const summary = summarize_trajectory(traj);
    expect(summary.error_count).toBeGreaterThanOrEqual(1);
  });

  test('includes unique actions', () => {
    const steps = [
      makeStep({ actionContent: 'search', stepId: 0 }),
      makeStep({ actionContent: 'search', stepId: 1 }),
      makeStep({ actionContent: 'read', stepId: 2 }),
    ];
    const traj = makeTrajectory(steps);
    const summary = summarize_trajectory(traj);
    expect(summary.unique_actions).toBe(2);
  });
});
