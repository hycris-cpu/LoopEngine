import { describe, test, expect } from 'bun:test';
import {
  ExecutionResult, LspDiagnostic, LoopDetector, LoopWarning,
  DiagnosticContext, format_for_llm, success, failure,
} from '../src/evolution/diagnostics';

describe('ExecutionResult', () => {
  test('creation', () => {
    const r = new ExecutionResult({ stdout: 'hello', stderr: '', exit_code: 0, duration_seconds: 1.5, tool_name: 'shell', tool_input: { command: 'echo hello' } });
    expect(r.stdout).toBe('hello');
    expect(r.stderr).toBe('');
    expect(r.exit_code).toBe(0);
    expect(r.duration_seconds).toBe(1.5);
    expect(r.tool_name).toBe('shell');
  });

  test('succeeded true', () => {
    expect(new ExecutionResult({ exit_code: 0 }).succeeded).toBe(true);
  });

  test('succeeded false', () => {
    expect(new ExecutionResult({ exit_code: 1 }).succeeded).toBe(false);
  });

  test('output_text prefers stdout', () => {
    expect(new ExecutionResult({ stdout: 'output', stderr: 'error' }).output_text).toBe('output');
  });

  test('output_text fallback to stderr', () => {
    expect(new ExecutionResult({ stdout: '', stderr: 'error message' }).output_text).toBe('error message');
  });

  test('has_output true', () => {
    expect(new ExecutionResult({ stdout: 'something' }).has_output).toBe(true);
  });

  test('has_output false', () => {
    expect(new ExecutionResult().has_output).toBe(false);
  });

  test('fingerprint deterministic', () => {
    const r1 = new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: 'ls' } });
    const r2 = new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: 'ls' } });
    expect(r1.fingerprint()).toBe(r2.fingerprint());
  });

  test('fingerprint different inputs', () => {
    const r1 = new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: 'ls' } });
    const r2 = new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: 'pwd' } });
    expect(r1.fingerprint()).not.toBe(r2.fingerprint());
  });

  test('fingerprint different tools', () => {
    const r1 = new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: 'ls' } });
    const r2 = new ExecutionResult({ tool_name: 'read', tool_input: { path: 'ls' } });
    expect(r1.fingerprint()).not.toBe(r2.fingerprint());
  });
});

describe('LspDiagnostic', () => {
  test('creation', () => {
    const d = new LspDiagnostic({ file_path: 'main.py', line: 42, message: "Undefined variable 'foo'", severity: 'error', source: 'pyright' });
    expect(d.file_path).toBe('main.py');
    expect(d.line).toBe(42);
    expect(d.severity).toBe('error');
  });
});

describe('LoopDetector', () => {
  test('no loop on different calls', () => {
    const detector = new LoopDetector(5, 3);
    const r1 = new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: 'ls' } });
    const r2 = new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: 'pwd' } });
    expect(detector.check(r1)).toBeNull();
    expect(detector.check(r2)).toBeNull();
  });

  test('loop detected at threshold', () => {
    const detector = new LoopDetector(10, 3);
    const r = new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: 'ls' } });
    expect(detector.check(r)).toBeNull(); // 1st
    expect(detector.check(r)).toBeNull(); // 2nd
    const warning = detector.check(r); // 3rd — trigger!
    expect(warning).not.toBeNull();
    expect(warning!.repeat_count).toBeGreaterThanOrEqual(3);
    expect(warning!.tool_name).toBe('shell');
  });

  test('loop warning fields', () => {
    const detector = new LoopDetector(20, 2);
    const r = new ExecutionResult({ tool_name: 'search', tool_input: { query: 'fibonacci' } });
    detector.check(r);
    const warning = detector.check(r);
    expect(warning).not.toBeNull();
    expect(warning!.tool_name).toBe('search');
    expect(warning!.tool_input).toEqual({ query: 'fibonacci' });
    expect(warning!.total_loops).toBe(1);
  });

  test('reset clears window', () => {
    const detector = new LoopDetector(20, 3);
    const r = new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: 'ls' } });
    detector.check(r);
    detector.check(r);
    detector.reset();
    expect(detector.check(r)).toBeNull();
  });

  test('window size limits memory', () => {
    const detector = new LoopDetector(3, 3);
    for (let i = 0; i < 5; i++) {
      detector.check(new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: `cmd_${i}` } }));
    }
    const r = new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: 'cmd_0' } });
    expect(detector.check(r)).toBeNull();
  });
});

describe('DiagnosticContext', () => {
  test('all available', () => {
    const result = new ExecutionResult({ stdout: 'ok', stderr: 'also ok' });
    const lsp = [new LspDiagnostic({ message: 'an error' })];
    const output = JSON.parse(format_for_llm(result, lsp));
    expect(output.context.available.stdout).toBe(true);
    expect(output.context.available.stderr).toBe(true);
    expect(output.context.available.lsp_diagnostics).toBe(true);
    expect(output.context.missing).toEqual([]);
  });

  test('missing stdout', () => {
    const result = new ExecutionResult({ stdout: '', stderr: 'error msg', exit_code: 1 });
    const output = JSON.parse(format_for_llm(result));
    expect(output.context.available.stdout).toBe(false);
    expect(output.context.missing.some((m: string) => m.includes('stdout'))).toBe(true);
  });

  test('missing lsp', () => {
    const result = new ExecutionResult({ stdout: 'ok' });
    const output = JSON.parse(format_for_llm(result));
    expect(output.context.available.lsp_diagnostics).toBe(false);
    expect(output.context.missing.some((m: string) => m.includes('lsp'))).toBe(true);
  });
});

describe('format_for_llm', () => {
  test('basic success', () => {
    const result = success('Hello, World!', 'shell');
    const output = JSON.parse(format_for_llm(result));
    expect(output.output).toBe('Hello, World!');
    expect(output.metadata.exit_code).toBe(0);
    expect(output.metadata.tool).toBe('shell');
  });

  test('basic failure', () => {
    const result = failure('Error: file not found', '', 1, 'read_file');
    const output = JSON.parse(format_for_llm(result));
    expect(output.output).toContain('Error: file not found');
    expect(output.metadata.exit_code).toBe(1);
  });

  test('with lsp diagnostics', () => {
    const result = success('', 'edit_file');
    const diagnostics = [
      new LspDiagnostic({ file_path: 'main.py', line: 10, message: "Undefined name 'x'" }),
      new LspDiagnostic({ file_path: 'main.py', line: 20, message: 'Type error' }),
    ];
    const output = JSON.parse(format_for_llm(result, diagnostics));
    expect(output.diagnostics.length).toBe(2);
    expect(output.diagnostics[0].file).toBe('main.py');
    expect(output.diagnostics[0].line).toBe(10);
  });

  test('with loop warning', () => {
    const result = new ExecutionResult({ tool_name: 'shell', tool_input: { cmd: 'ls' } });
    const warning = new LoopWarning({ tool_name: 'shell', tool_input: { cmd: 'ls' }, repeat_count: 5, total_loops: 1 });
    const output = JSON.parse(format_for_llm(result, null, warning));
    expect(output.loop_warning).toBeDefined();
    expect(output.loop_warning.repeats).toBe(5);
    expect(output.loop_warning.message).toContain('different approach');
  });

  test('truncation', () => {
    const longOutput = 'x'.repeat(20000);
    const result = new ExecutionResult({ stdout: longOutput });
    const output = JSON.parse(format_for_llm(result, null, null, 1000));
    expect(output.output.length).toBeLessThan(1100);
    expect(output.output).toContain('truncated');
  });

  test('lsp diagnostics capped', () => {
    const result = success();
    const diagnostics = Array.from({ length: 50 }, (_, i) => new LspDiagnostic({ message: `error ${i}` }));
    const output = JSON.parse(format_for_llm(result, diagnostics, null, 10000, 20));
    expect(output.diagnostics.length).toBe(20);
  });
});

describe('Convenience functions', () => {
  test('success', () => {
    const r = success('ok', 'shell', null, 0.5);
    expect(r.succeeded).toBe(true);
    expect(r.stdout).toBe('ok');
    expect(r.duration_seconds).toBe(0.5);
  });

  test('failure', () => {
    const r = failure('err', '', 1, 'shell');
    expect(r.succeeded).toBe(false);
    expect(r.stderr).toBe('err');
    expect(r.exit_code).toBe(1);
  });

  test('success default tool_input', () => {
    expect(success().tool_input).toEqual({});
  });
});

describe('Integration', () => {
  test('full flow success', () => {
    const result = success('4 files found', 'shell', { command: "find . -name '*.py'" }, 0.3);
    const output = JSON.parse(format_for_llm(result));
    expect(output.output).toBe('4 files found');
    expect(output.metadata.exit_code).toBe(0);
    expect(output.metadata.duration_seconds).toBe(0.3);
    expect(output.diagnostics).toBeUndefined();
    expect(output.loop_warning).toBeUndefined();
  });

  test('full flow failure with lsp', () => {
    const result = failure('SyntaxError: invalid syntax', '', 1, 'edit_file', { path: 'main.py' });
    const diagnostics = [new LspDiagnostic({ file_path: 'main.py', line: 15, message: "Expected ':'" })];
    const output = JSON.parse(format_for_llm(result, diagnostics));
    expect(output.metadata.exit_code).toBe(1);
    expect(output.diagnostics.length).toBe(1);
    expect(output.diagnostics[0].message).toContain('Expected');
  });

  test('full flow loop detection', () => {
    const detector = new LoopDetector(20, 3);
    const results: [ExecutionResult, LoopWarning | null][] = [];
    for (let i = 0; i < 4; i++) {
      const result = new ExecutionResult({ tool_name: 'search', tool_input: { query: 'fibonacci python' } });
      const warning = detector.check(result);
      results.push([result, warning]);
    }
    expect(results[2][1]).not.toBeNull();
    expect(results[3][1]).not.toBeNull();
    const output = JSON.parse(format_for_llm(results[3][0], null, results[3][1]));
    expect(output.loop_warning).toBeDefined();
    expect(output.loop_warning.repeats).toBeGreaterThanOrEqual(3);
  });
});
