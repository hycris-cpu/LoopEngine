import { describe, test, expect } from 'bun:test';
import * as le from '../src/index';
import { Event, Message, MessageType, ToolCall, ToolResult, EvalResult } from '../src/primitives/events';
import { Budget, State } from '../src/primitives/state';
import { Trajectory, TrajectoryStep, load_trajectory } from '../src/primitives/trajectory';
import { ToolSchema, ToolRegistry, ToolContext } from '../src/primitives/tools';
import { MultiHookProcessor, ProcessorChain } from '../src/primitives/processors';
import { HarnessBuilder } from '../src/composition/builder';
import { HarnessConfig } from '../src/composition/config';
import { RunResult, run_loop, type ModelProvider } from '../src/execution/runloop';
import { Harness } from '../src/execution/harness';
import { SimpleTask } from '../src/execution/task';
import { BenchmarkResult, compare } from '../src/evaluation/benchmark';
import { CodeMod, CodeModSet } from '../src/evolution/code_mod';
import { analyze_trajectory, Insight } from '../src/evolution/analysis';
import { PromotionGate, PromotionDecision } from '../src/evolution/promotion';
import { makeTmpDir } from './fixtures';
import { join } from 'node:path';

describe('Builder to Harness integration', () => {
  test('compose bundles and build', () => {
    const builder = le.make_coding('/tmp').merge(le.make_reliability());
    const config = builder.build();
    expect(config).toBeInstanceOf(HarnessConfig);
    expect(config.processors.length).toBeGreaterThan(0);
    const fp1 = config.fingerprint();
    const fp2 = config.fingerprint();
    expect(fp1).toBe(fp2);
  });

  test('harness from builder', () => {
    const mockModel: ModelProvider = {
      complete: async () => new Message({ type: 'message', run_id: 'r', step_id: 0, role: MessageType.ASSISTANT, content: 'Done!' }),
      count_tokens: () => 10,
    };
    const builder = le.make_coding();
    const harness = Harness.from_builder(builder, mockModel);
    expect(harness).toBeInstanceOf(Harness);
    expect(harness.model).toBe(mockModel);
  });
});

describe('RunLoop integration', () => {
  test('produces trajectory', async () => {
    const mockModel: ModelProvider = {
      complete: async () => new Message({ type: 'message', run_id: 'test', step_id: 0, role: MessageType.ASSISTANT, content: "I'll help with that." }),
      count_tokens: () => 10,
    };
    const task = new SimpleTask({ prompt: 'Say hello', max_steps: 5 });
    const config = new HarnessConfig();
    const result = await run_loop(task, mockModel, config);
    expect(result).toBeInstanceOf(RunResult);
    expect(result.trajectory).toBeInstanceOf(Trajectory);
    expect(['end_turn', 'max_steps', 'is_done', 'budget']).toContain(result.exit_reason);
    expect(result.total_steps).toBeGreaterThanOrEqual(1);
  });

  test('harness run end to end', async () => {
    const mockModel: ModelProvider = {
      complete: async () => new Message({ type: 'message', run_id: 'r', step_id: 0, role: MessageType.ASSISTANT, content: 'Done' }),
      count_tokens: () => 10,
    };
    const config = le.make_coding().build();
    const harness = new Harness(mockModel, config);
    const task = new SimpleTask({ prompt: 'Write fibonacci', max_steps: 3 });
    const result = await harness.run(task);
    expect(result).toBeInstanceOf(RunResult);
    expect(result.trajectory).toBeDefined();
  });
});

describe('Evaluation integration', () => {
  test('benchmark result comparison', () => {
    const baseline = new BenchmarkResult({
      scores: {
        task1: new EvalResult({ type: 'eval_result', run_id: 'r', step_id: 0, passed: true, score: 0.6, reason: 'ok', reward: 0.6 }),
        task2: new EvalResult({ type: 'eval_result', run_id: 'r', step_id: 0, passed: true, score: 0.4, reason: 'ok', reward: 0.4 }),
      },
      aggregate: { mean_score: 0.5 },
    });
    const candidate = new BenchmarkResult({
      scores: {
        task1: new EvalResult({ type: 'eval_result', run_id: 'r', step_id: 0, passed: true, score: 0.8, reason: 'better', reward: 0.8 }),
        task2: new EvalResult({ type: 'eval_result', run_id: 'r', step_id: 0, passed: true, score: 0.3, reason: 'worse', reward: 0.3 }),
      },
      aggregate: { mean_score: 0.55 },
    });
    const comparison = compare(baseline, candidate);
    expect(comparison).toBeInstanceOf(le.Comparison);
    expect(Object.keys(comparison.improvements).length > 0 || Object.keys(comparison.regressions).length > 0).toBe(true);
  });
});

describe('Evolution integration', () => {
  test('trajectory analysis finds issues', () => {
    const trajectory = new Trajectory();
    const state = new State();
    const snap = state.snapshot();
    for (let i = 0; i < 5; i++) {
      trajectory.add_step(new TrajectoryStep({
        state_before: snap,
        action: new Message({ type: 'message', run_id: 'r', step_id: i, role: MessageType.ASSISTANT, content: 'search(query)' }),
        observations: [new ToolResult({ type: 'tool_result', run_id: 'r', step_id: i, call_id: `tc_${i}`, output: 'same result' })],
        reward: 0.1,
        delta: state.compute_delta(snap),
      }));
    }
    const insights = analyze_trajectory(trajectory);
    expect(insights.length).toBeGreaterThan(0);
    const categories = new Set(insights.map(i => i.category));
    expect(categories.has('loop') || categories.has('inefficiency')).toBe(true);
  });

  test('code mod safety check', () => {
    const safeMod = new CodeMod({
      target_file: 'prompts/system.py',
      description: 'Add a newline',
      diff: '-old\n+new',
      rationale: 'Cleaner',
      expected_impact: 'Marginal',
    });
    const unsafeMod = new CodeMod({
      target_file: 'prompts/system.py',
      description: 'Delete everything',
      diff: "-old\n+import os; os.system('rm -rf /')",
      rationale: 'Evil',
      expected_impact: 'Destruction',
    });
    expect(safeMod.is_safe()).toBe(true);
    expect(unsafeMod.is_safe()).toBe(false);
  });

  test('promotion gate decides correctly', async () => {
    const gate = new PromotionGate(0.05, 0.1);
    const baseline = new BenchmarkResult({
      scores: { t1: new EvalResult({ type: 'eval_result', run_id: 'r', step_id: 0, passed: true, score: 0.5, reason: 'ok', reward: 0.5 }) },
      aggregate: { mean_score: 0.5 },
    });
    const improved = new BenchmarkResult({
      scores: { t1: new EvalResult({ type: 'eval_result', run_id: 'r', step_id: 0, passed: true, score: 0.7, reason: 'better', reward: 0.7 }) },
      aggregate: { mean_score: 0.7 },
    });
    const mod = new CodeMod({ target_file: 'test.py', description: 'Better prompt', diff: '-old\n+new', rationale: 'Improve accuracy', expected_impact: 'Higher score' });
    const decision = gate.validate(baseline, improved, mod);
    expect(decision).toBeInstanceOf(PromotionDecision);
    expect(decision.promoted).toBe(true);
    expect(decision.reason.toLowerCase()).toContain('improvement');
  });
});

describe('Serialization integration', () => {
  test('config fingerprint roundtrip', () => {
    const config1 = le.make_coding().merge(le.make_reliability()).build();
    const config2 = le.make_coding().merge(le.make_reliability()).build();
    expect(config1.fingerprint()).toBe(config2.fingerprint());
    const config3 = le.make_coding().merge(le.make_evaluation()).build();
    expect(config1.fingerprint()).not.toBe(config3.fingerprint());
  });

  test('trajectory jsonl roundtrip', () => {
    const workDir = makeTmpDir();
    const trajectory = new Trajectory();
    const state = new State();
    const snap = state.snapshot();
    trajectory.add_step(new TrajectoryStep({
      state_before: snap,
      action: new Message({ type: 'message', run_id: 'r', step_id: 0, role: MessageType.ASSISTANT, content: 'Hello' }),
      observations: [],
      reward: 0.5,
      delta: state.compute_delta(snap),
    }));
    const path = join(workDir, 'traj.jsonl');
    trajectory.to_jsonl(path);
    const loaded = load_trajectory(path);
    expect(loaded.length).toBe(1);
    expect(loaded.steps[0].reward).toBe(0.5);
  });
});
