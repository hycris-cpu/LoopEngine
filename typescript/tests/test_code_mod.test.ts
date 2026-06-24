import { describe, test, expect } from 'bun:test';
import { CodeMod, CodeModSet, parse_unified_diff } from '../src/evolution/code_mod';

describe('CodeMod creation', () => {
  test('defaults', () => {
    const mod = new CodeMod();
    expect(mod.target_file).toBe('');
    expect(mod.description).toBe('');
    expect(mod.diff).toBe('');
    expect(mod.rationale).toBe('');
    expect(mod.expected_impact).toBe('');
  });

  test('explicit fields', () => {
    const mod = new CodeMod({
      target_file: 'loopengine/processors/context/system_prompt.py',
      description: 'Add step counting',
      diff: '--- a/file.py\n+++ b/file.py\n@@ -1 +1 @@\n-old\n+new',
      rationale: 'The agent keeps repeating itself',
      expected_impact: 'Efficiency should go up 10%',
    });
    expect(mod.target_file).toBe('loopengine/processors/context/system_prompt.py');
    expect(mod.description).toBe('Add step counting');
    expect(mod.diff).toContain('old');
    expect(mod.diff).toContain('new');
  });

  test('equality', () => {
    const m1 = new CodeMod({ target_file: 'a.py', diff: '+new' });
    const m2 = new CodeMod({ target_file: 'a.py', diff: '+new' });
    expect(m1.target_file).toBe(m2.target_file);
    expect(m1.diff).toBe(m2.diff);
  });
});

describe('CodeMod serialization', () => {
  test('to_dict', () => {
    const mod = new CodeMod({ target_file: 'a.py', description: 'test', diff: '-old\n+new', rationale: 'because', expected_impact: 'better' });
    const d = mod.to_dict();
    expect(d.target_file).toBe('a.py');
    expect(d.description).toBe('test');
  });

  test('from_dict', () => {
    const d = { target_file: 'a.py', description: 'test', diff: '-old\n+new', rationale: 'because', expected_impact: 'better' };
    const mod = CodeMod.from_dict(d);
    expect(mod.target_file).toBe('a.py');
    expect(mod.description).toBe('test');
  });

  test('roundtrip', () => {
    const original = new CodeMod({ target_file: 'loopengine/foo.py', description: 'Add logging', diff: '-x\n+y', rationale: 'debugging', expected_impact: 'visibility' });
    const restored = CodeMod.from_dict(original.to_dict());
    expect(restored.target_file).toBe(original.target_file);
    expect(restored.description).toBe(original.description);
    expect(restored.diff).toBe(original.diff);
  });

  test('from_dict missing fields', () => {
    const mod = CodeMod.from_dict({ target_file: 'a.py' });
    expect(mod.target_file).toBe('a.py');
    expect(mod.description).toBe('');
    expect(mod.diff).toBe('');
  });
});

describe('CodeMod.apply_to', () => {
  test('simple replacement', () => {
    const diff = '--- a/hello.py\n+++ b/hello.py\n@@ -1 +1 @@\n-old_line\n+new_line\n';
    const mod = new CodeMod({ target_file: 'hello.py', diff });
    const files = { 'hello.py': 'old_line\n' };
    const result = mod.apply_to(files);
    expect(result['hello.py']).toContain('new_line');
    expect(result['hello.py']).not.toContain('old_line');
  });

  test('preserves unmodified files', () => {
    const diff = '--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n';
    const mod = new CodeMod({ target_file: 'a.py', diff });
    const files = { 'a.py': 'old\n', 'b.py': 'untouched\n' };
    const result = mod.apply_to(files);
    expect(result['b.py']).toBe('untouched\n');
  });

  test('missing file returns unchanged', () => {
    const diff = '--- a/missing.py\n+++ b/missing.py\n@@ -1 +1 @@\n-old\n+new\n';
    const mod = new CodeMod({ target_file: 'missing.py', diff });
    const files = { 'other.py': 'content\n' };
    const result = mod.apply_to(files);
    expect(result['other.py']).toBe('content\n');
  });
});

describe('CodeMod.is_safe', () => {
  test('safe mod', () => {
    const mod = new CodeMod({ target_file: 'a.py', description: 'Add logging', diff: '-old\n+new', rationale: 'better debugging' });
    expect(mod.is_safe()).toBe(true);
  });

  test('dangerous os.system', () => {
    const mod = new CodeMod({ target_file: 'a.py', description: 'Run', diff: "+os.system('rm -rf /')" });
    expect(mod.is_safe()).toBe(false);
  });

  test('dangerous rm -rf', () => {
    const mod = new CodeMod({ target_file: 'a.py', diff: "+subprocess.run(['rm', '-rf', '/'])" });
    expect(mod.is_safe()).toBe(false);
  });

  test('dangerous __import__', () => {
    const mod = new CodeMod({ target_file: 'a.py', diff: "+__import__('os')" });
    expect(mod.is_safe()).toBe(false);
  });

  test('dangerous exec', () => {
    const mod = new CodeMod({ target_file: 'a.py', diff: "+exec('import os')" });
    expect(mod.is_safe()).toBe(false);
  });

  test('dangerous eval', () => {
    const mod = new CodeMod({ target_file: 'a.py', diff: "+eval('1+1')" });
    expect(mod.is_safe()).toBe(false);
  });
});

describe('CodeModSet', () => {
  test('creation', () => {
    const m1 = new CodeMod({ target_file: 'a.py' });
    const m2 = new CodeMod({ target_file: 'b.py' });
    const set = new CodeModSet({ mods: [m1, m2] });
    expect(set.mods.length).toBe(2);
  });

  test('apply multiple mods', () => {
    const m1 = new CodeMod({ target_file: 'a.py', diff: '--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n' });
    const m2 = new CodeMod({ target_file: 'b.py', diff: '--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-foo\n+bar\n' });
    const set = new CodeModSet({ mods: [m1, m2] });
    const result = set.apply_to({ 'a.py': 'old\n', 'b.py': 'foo\n' });
    expect(result['a.py']).toContain('new');
    expect(result['b.py']).toContain('bar');
  });

  test('all safe', () => {
    const set = new CodeModSet({ mods: [new CodeMod({ target_file: 'a.py', diff: '-old\n+new' }), new CodeMod({ target_file: 'b.py', diff: '-x\n+y' })] });
    expect(set.is_safe()).toBe(true);
  });

  test('one dangerous', () => {
    const set = new CodeModSet({ mods: [new CodeMod({ target_file: 'a.py', diff: '-old\n+new' }), new CodeMod({ target_file: 'b.py', diff: "+os.system('rm -rf /')" })] });
    expect(set.is_safe()).toBe(false);
  });

  test('roundtrip', () => {
    const m1 = new CodeMod({ target_file: 'a.py', description: 'change a', diff: '-old\n+new' });
    const m2 = new CodeMod({ target_file: 'b.py', description: 'change b', diff: '-x\n+y' });
    const original = new CodeModSet({ mods: [m1, m2] });
    const restored = CodeModSet.from_dict(original.to_dict());
    expect(restored.mods.length).toBe(2);
    expect(restored.mods[0].target_file).toBe('a.py');
  });
});

describe('parse_unified_diff', () => {
  test('simple diff', () => {
    const diff = '--- a/hello.py\n+++ b/hello.py\n@@ -1 +1 @@\n-old_line\n+new_line\n';
    const hunks = parse_unified_diff(diff);
    expect(hunks.length).toBe(1);
    expect(hunks[0][0]).toContain('old_line');
    expect(hunks[0][1]).toContain('new_line');
  });

  test('multi hunk', () => {
    const diff = '--- a/multi.py\n+++ b/multi.py\n@@ -1 +1 @@\n-first_old\n+first_new\n@@ -10 +10 @@\n-second_old\n+second_new\n';
    const hunks = parse_unified_diff(diff);
    expect(hunks.length).toBe(2);
  });

  test('empty diff', () => {
    expect(parse_unified_diff('')).toEqual([]);
  });

  test('no hunks', () => {
    expect(parse_unified_diff('--- a/empty.py\n+++ b/empty.py\n')).toEqual([]);
  });
});
