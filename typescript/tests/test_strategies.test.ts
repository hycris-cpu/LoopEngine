import { describe, test, expect } from 'bun:test';
import { EvalResult, Message, MessageType, ToolResult } from '../src/primitives/events';
import { Trajectory, TrajectoryStep } from '../src/primitives/trajectory';
import { PromptEvolver, ConfigEvolver, CompositeEvolutionStrategy } from '../src/evolution/strategies';
import type { EvolutionStrategy } from '../src/evolution/strategies';
import { CodeMod, CodeModSet } from '../src/evolution/code_mod';

describe('EvolutionStrategy protocol', () => {
  test('protocol has name', () => {
    expect(PromptEvolver).toBeDefined();
    expect(ConfigEvolver).toBeDefined();
    expect(CompositeEvolutionStrategy).toBeDefined();
  });

  test('PromptEvolver satisfies protocol', () => {
    const model = { complete: async () => new Message({ role: MessageType.ASSISTANT, content: '{}' }) } as any;
    const evolver = new PromptEvolver(model);
    expect(evolver.name).toBe('prompt_evolver');
    expect(typeof evolver.propose).toBe('function');
  });

  test('ConfigEvolver satisfies protocol', () => {
    const evolver = new ConfigEvolver();
    expect(evolver.name).toBe('config_evolver');
  });

  test('CompositeEvolutionStrategy satisfies protocol', () => {
    const composite = new CompositeEvolutionStrategy([]);
    expect(composite.name).toBe('composite');
  });
});

describe('PromptEvolver', () => {
  test('creation', () => {
    const model = {} as any;
    const evolver = new PromptEvolver(model);
    expect((evolver as any)._model).toBe(model);
    expect(evolver.name).toBe('prompt_evolver');
  });

  test('propose returns code mods', async () => {
    const modJson = JSON.stringify({
      target_file: 'system_prompt.py',
      description: 'Add step counting',
      diff: '--- a/system_prompt.py\n+++ b/system_prompt.py\n...',
      rationale: 'Agent repeats itself',
      expected_impact: '10% fewer steps',
    });
    const response = new Message({ role: MessageType.ASSISTANT, content: modJson });
    const model = { complete: async () => response } as any;
    const evolver = new PromptEvolver(model);
    const trajectory = new Trajectory();
    trajectory.add_step(new TrajectoryStep({ reward: -0.5 }));
    trajectory.add_step(new TrajectoryStep({ reward: -0.3 }));
    const evalResult = new EvalResult({ passed: false, score: 0.3, reason: 'poor performance' });
    const mods = await evolver.propose(trajectory, evalResult, {}, { 'system_prompt.py': 'You are a helpful assistant.' });
    expect(mods.length).toBeGreaterThanOrEqual(1);
    expect(mods[0].target_file).toBe('system_prompt.py');
  });

  test('propose returns empty for good score', async () => {
    const model = {} as any;
    const evolver = new PromptEvolver(model);
    const trajectory = new Trajectory();
    const evalResult = new EvalResult({ passed: true, score: 0.95, reason: 'excellent' });
    const mods = await evolver.propose(trajectory, evalResult, {}, {});
    expect(mods).toEqual([]);
  });

  test('propose handles list response', async () => {
    const modsJson = JSON.stringify([
      { target_file: 'prompt_a.py', description: 'First improvement', diff: 'diff1', rationale: 'reason1', expected_impact: 'impact1' },
      { target_file: 'prompt_b.py', description: 'Second improvement', diff: 'diff2', rationale: 'reason2', expected_impact: 'impact2' },
    ]);
    const response = new Message({ role: MessageType.ASSISTANT, content: modsJson });
    const model = { complete: async () => response } as any;
    const evolver = new PromptEvolver(model);
    const trajectory = new Trajectory();
    trajectory.add_step(new TrajectoryStep({ reward: -0.5 }));
    const evalResult = new EvalResult({ passed: false, score: 0.3, reason: 'poor' });
    const mods = await evolver.propose(trajectory, evalResult, {}, { 'prompt_a.py': 'old prompt', 'prompt_b.py': 'old prompt' });
    expect(mods.length).toBe(2);
    expect(mods[0].target_file).toBe('prompt_a.py');
    expect(mods[1].target_file).toBe('prompt_b.py');
  });
});

describe('ConfigEvolver', () => {
  test('defaults', () => {
    const evolver = new ConfigEvolver();
    expect((evolver as any)._score_threshold).toBe(0.7);
    expect((evolver as any)._step_threshold).toBe(50);
  });

  test('custom thresholds', () => {
    const evolver = new ConfigEvolver(0.5, 30);
    expect((evolver as any)._score_threshold).toBe(0.5);
    expect((evolver as any)._step_threshold).toBe(30);
  });

  test('low score proposes budget increase', async () => {
    const evolver = new ConfigEvolver(0.7);
    const trajectory = new Trajectory();
    const evalResult = new EvalResult({ passed: false, score: 0.3, reason: 'low score' });
    const mods = await evolver.propose(trajectory, evalResult, {}, {});
    expect(mods.length).toBeGreaterThanOrEqual(1);
    expect(mods.some(m => m.description.toLowerCase().includes('budget'))).toBe(true);
  });

  test('high score returns empty', async () => {
    const evolver = new ConfigEvolver(0.7, 50);
    const trajectory = new Trajectory();
    trajectory.add_step(new TrajectoryStep({ reward: 1.0 }));
    const evalResult = new EvalResult({ passed: true, score: 0.9, reason: 'great' });
    const mods = await evolver.propose(trajectory, evalResult, {}, {});
    expect(mods).toEqual([]);
  });

  test('many steps proposes efficiency', async () => {
    const evolver = new ConfigEvolver(0.7, 50);
    const trajectory = new Trajectory();
    for (let i = 0; i < 60; i++) trajectory.add_step(new TrajectoryStep({ reward: 0.01 }));
    const evalResult = new EvalResult({ passed: true, score: 0.8, reason: 'ok but slow' });
    const mods = await evolver.propose(trajectory, evalResult, {}, {});
    expect(mods.length).toBeGreaterThanOrEqual(1);
    expect(mods.some(m => m.description.toLowerCase().includes('efficiency'))).toBe(true);
  });

  test('tool errors propose recovery', async () => {
    const evolver = new ConfigEvolver(0.7, 50);
    const trajectory = new Trajectory();
    for (let i = 0; i < 3; i++) {
      trajectory.add_step(new TrajectoryStep({
        reward: -0.1,
        observations: [new ToolResult({ run_id: 'test', call_id: 'call_1', output: '', error: 'Tool failed' })],
      }));
    }
    const evalResult = new EvalResult({ passed: false, score: 0.4, reason: 'tool failures' });
    const mods = await evolver.propose(trajectory, evalResult, {}, {});
    expect(mods.length).toBeGreaterThanOrEqual(1);
    expect(mods.some(m => m.description.toLowerCase().includes('error'))).toBe(true);
  });
});

describe('CompositeEvolutionStrategy', () => {
  test('creation', () => {
    const strategies = [new ConfigEvolver(), new ConfigEvolver()];
    const composite = new CompositeEvolutionStrategy(strategies);
    expect(composite.strategies.length).toBe(2);
    expect(composite.name).toBe('composite');
  });

  test('aggregates', async () => {
    const strategyA = {
      name: 'a',
      propose: async () => [new CodeMod({ target_file: 'a.py', description: 'mod from a' })],
    } as EvolutionStrategy;
    const strategyB = {
      name: 'b',
      propose: async () => [new CodeMod({ target_file: 'b.py', description: 'mod from b' })],
    } as EvolutionStrategy;
    const composite = new CompositeEvolutionStrategy([strategyA, strategyB]);
    const mods = await composite.propose(new Trajectory(), new EvalResult({ passed: false, score: 0.3 }), {}, {});
    expect(mods.length).toBe(2);
    expect(mods[0].target_file).toBe('a.py');
    expect(mods[1].target_file).toBe('b.py');
  });

  test('handles strategy failure', async () => {
    const strategyA = {
      name: 'failing',
      propose: async () => { throw new Error('boom'); },
    } as EvolutionStrategy;
    const strategyB = {
      name: 'working',
      propose: async () => [new CodeMod({ target_file: 'b.py', description: 'mod from b' })],
    } as EvolutionStrategy;
    const composite = new CompositeEvolutionStrategy([strategyA, strategyB]);
    const mods = await composite.propose(new Trajectory(), new EvalResult({ passed: false, score: 0.3 }), {}, {});
    expect(mods.length).toBe(1);
    expect(mods[0].target_file).toBe('b.py');
  });

  test('empty strategies', async () => {
    const composite = new CompositeEvolutionStrategy([]);
    const mods = await composite.propose(new Trajectory(), new EvalResult({ passed: false, score: 0.3 }), {}, {});
    expect(mods).toEqual([]);
  });
});

describe('ConfigEvolver targeting (bug M4)', () => {
  test('targets an existing source file', async () => {
    const evolver = new ConfigEvolver(0.7);
    const trajectory = new Trajectory();
    const evalResult = new EvalResult({ passed: false, score: 0.5, reason: 'low' });
    const source = { 'loopengine/config.py': 'budget = 1\n' };
    const mods = await evolver.propose(trajectory, evalResult, {}, source);
    expect(mods.length).toBeGreaterThan(0);
    expect(mods.every((m) => m.target_file === 'loopengine/config.py')).toBe(true);
  });
});
