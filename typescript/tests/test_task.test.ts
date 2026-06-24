import { describe, test, expect } from 'bun:test';
import { EvalResult, Message, MessageType } from '../src/primitives/events';
import { Budget, State } from '../src/primitives/state';
import { Trajectory, TrajectoryStep } from '../src/primitives/trajectory';
import { SimpleTask, BatchTask } from '../src/execution/task';
import type { Task } from '../src/execution/task';

describe('Task protocol', () => {
  test('exists', () => {
    expect(SimpleTask).toBeDefined();
  });

  test('SimpleTask satisfies protocol', () => {
    const task = new SimpleTask({ prompt: 'Hello' });
    expect(task.prompt).toBe('Hello');
    expect(task.max_steps).toBeDefined();
    expect(typeof task.is_done).toBe('function');
    expect(typeof task.evaluate).toBe('function');
  });
});

describe('SimpleTask creation', () => {
  test('defaults', () => {
    const task = new SimpleTask({ prompt: 'Solve this problem' });
    expect(task.prompt).toBe('Solve this problem');
    expect(task.max_steps).toBe(50);
    expect(task.budget).toBeInstanceOf(Budget);
  });

  test('custom values', () => {
    const budget = new Budget({ max_tokens: 4096, max_cost_usd: 1.0, max_steps: 10 });
    const task = new SimpleTask({ prompt: 'Custom task', max_steps: 10, budget });
    expect(task.prompt).toBe('Custom task');
    expect(task.max_steps).toBe(10);
    expect(task.budget.max_tokens).toBe(4096);
    expect(task.budget.max_cost_usd).toBe(1.0);
  });

  test('empty prompt default', () => {
    const task = new SimpleTask();
    expect(task.prompt).toBe('');
  });

  test('has default budget', () => {
    const task = new SimpleTask({ prompt: 'test' });
    expect(task.budget.max_tokens).toBe(128_000);
    expect(task.budget.max_cost_usd).toBe(10.0);
  });
});

describe('SimpleTask.is_done', () => {
  test('default returns false', () => {
    const task = new SimpleTask({ prompt: 'infinite task' });
    const state = new State();
    expect(task.is_done(state)).toBe(false);
  });

  test('default never done even with messages', () => {
    const task = new SimpleTask({ prompt: 'task' });
    const state = new State();
    state.add_message(new Message({ role: MessageType.ASSISTANT, content: 'working on it...' }));
    expect(task.is_done(state)).toBe(false);
  });

  test('custom condition', () => {
    const checkDone = (state: State) => {
      const doneSlot = state.get_slot('done');
      return doneSlot !== null && doneSlot.value === true;
    };
    const task = new SimpleTask({ prompt: 'task', done_condition: checkDone });
    const state = new State();
    expect(task.is_done(state)).toBe(false);
    state.set_slot('done', true);
    expect(task.is_done(state)).toBe(true);
  });

  test('content condition', () => {
    const checkDone = (state: State) => {
      for (const msg of state.messages) {
        if (msg instanceof Message && msg.role === MessageType.ASSISTANT && msg.content.includes('DONE')) return true;
      }
      return false;
    };
    const task = new SimpleTask({ prompt: 'task', done_condition: checkDone });
    const state = new State();
    state.add_message(new Message({ role: MessageType.ASSISTANT, content: 'Still working...' }));
    expect(task.is_done(state)).toBe(false);
    state.add_message(new Message({ role: MessageType.ASSISTANT, content: 'DONE' }));
    expect(task.is_done(state)).toBe(true);
  });
});

describe('SimpleTask.evaluate', () => {
  test('default returns zero', async () => {
    const task = new SimpleTask({ prompt: 'task' });
    const trajectory = new Trajectory();
    const result = await task.evaluate(trajectory);
    expect(result).toBeInstanceOf(EvalResult);
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  test('custom function', async () => {
    const myEval = async (trajectory: Trajectory, task: Task) => {
      return new EvalResult({ passed: true, score: 0.95, reason: 'Great work!' });
    };
    const task = new SimpleTask({ prompt: 'task', eval_fn: myEval });
    const trajectory = new Trajectory();
    const result = await task.evaluate(trajectory);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.95);
    expect(result.reason).toBe('Great work!');
  });

  test('eval with trajectory steps', async () => {
    const countStepsEval = async (trajectory: Trajectory, task: Task) => {
      const steps = trajectory.length;
      const score = steps > 0 ? 1.0 : 0.0;
      return new EvalResult({ passed: score > 0, score, reason: `${steps} steps` });
    };
    const task = new SimpleTask({ prompt: 'task', eval_fn: countStepsEval });
    const empty = new Trajectory();
    let result = await task.evaluate(empty);
    expect(result.score).toBe(0.0);

    const withStep = new Trajectory();
    withStep.add_step(new TrajectoryStep({ action: new Message({ role: MessageType.ASSISTANT, content: 'I did it' }) }));
    result = await task.evaluate(withStep);
    expect(result.score).toBe(1.0);
    expect(result.reason).toBe('1 steps');
  });
});

describe('BatchTask', () => {
  test('creation', () => {
    const tasks = [
      new SimpleTask({ prompt: 'task 1' }),
      new SimpleTask({ prompt: 'task 2' }),
      new SimpleTask({ prompt: 'task 3' }),
    ];
    const batch = new BatchTask({ tasks });
    expect(batch.tasks.length).toBe(3);
  });

  test('iterable', () => {
    const tasks = [new SimpleTask({ prompt: 'first' }), new SimpleTask({ prompt: 'second' })];
    const batch = new BatchTask({ tasks });
    const items = [...batch];
    expect(items[0].prompt).toBe('first');
    expect(items[1].prompt).toBe('second');
  });

  test('has length', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => new SimpleTask({ prompt: `task ${i}` }));
    const batch = new BatchTask({ tasks });
    expect(batch.length).toBe(5);
  });

  test('getitem', () => {
    const tasks = [
      new SimpleTask({ prompt: 'a' }),
      new SimpleTask({ prompt: 'b' }),
      new SimpleTask({ prompt: 'c' }),
    ];
    const batch = new BatchTask({ tasks });
    expect(batch.at(0).prompt).toBe('a');
    expect(batch.at(2).prompt).toBe('c');
  });

  test('empty', () => {
    const batch = new BatchTask({ tasks: [] });
    expect(batch.length).toBe(0);
    expect([...batch]).toEqual([]);
  });

  test('delegates to first task', () => {
    const tasks = [new SimpleTask({ prompt: 'test' })];
    const batch = new BatchTask({ tasks });
    expect(batch.prompt).toBe('test');
    expect(batch.max_steps).toBe(50);
  });
});

describe('SimpleTask edge cases', () => {
  test('max_steps zero', () => {
    const task = new SimpleTask({ prompt: 'instant', max_steps: 0 });
    expect(task.max_steps).toBe(0);
  });

  test('custom budget', () => {
    const budget = new Budget({ max_tokens: 1000, max_cost_usd: 0.01, max_steps: 3 });
    const task = new SimpleTask({ prompt: 'cheap task', budget });
    expect(task.budget.max_tokens).toBe(1000);
    expect(task.budget.max_cost_usd).toBe(0.01);
    expect(task.budget.max_steps).toBe(3);
  });
});
