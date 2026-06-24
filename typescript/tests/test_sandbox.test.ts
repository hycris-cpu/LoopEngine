import { describe, test, expect } from 'bun:test';
import { LocalSandbox, LocalSandboxProvider } from '../src/execution/sandbox';
import type { Sandbox, SandboxProvider } from '../src/execution/sandbox';
import { makeTmpDir } from './fixtures';

describe('Sandbox protocol', () => {
  test('exists', () => {
    expect(LocalSandbox).toBeDefined();
  });

  test('LocalSandbox satisfies protocol', () => {
    const sandbox = new LocalSandbox();
    expect(sandbox).toBeDefined();
  });
});

describe('LocalSandbox.exec', () => {
  test('echo command', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    const [stdout, stderr, exitCode] = await sandbox.exec('echo hello', workDir);
    expect(stdout.trim()).toBe('hello');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('command with stderr', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    const [stdout, stderr, exitCode] = await sandbox.exec('echo error >&2 && exit 1', workDir);
    expect(stderr).toContain('error');
    expect(exitCode).toBe(1);
  });

  test('returns tuple', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    const result = await sandbox.exec('echo test', workDir);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(3);
    expect(typeof result[0]).toBe('string');
    expect(typeof result[1]).toBe('string');
    expect(typeof result[2]).toBe('number');
  });

  test('with default cwd', async () => {
    const sandbox = new LocalSandbox();
    const [stdout, stderr, exitCode] = await sandbox.exec('pwd');
    expect(exitCode).toBe(0);
    expect(stdout.trim().length).toBeGreaterThan(0);
  });
});

describe('LocalSandbox file ops', () => {
  test('write and read file', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    const filePath = `${workDir}/test.txt`;
    await sandbox.write_file(filePath, 'Hello, World!');
    const content = await sandbox.read_file(filePath);
    expect(content).toBe('Hello, World!');
  });

  test('write creates parent dirs', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    const filePath = `${workDir}/subdir/nested/file.txt`;
    await sandbox.write_file(filePath, 'nested content');
    const content = await sandbox.read_file(filePath);
    expect(content).toBe('nested content');
  });

  test('read nonexistent throws', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    expect(sandbox.read_file(`${workDir}/nonexistent.txt`)).rejects.toThrow();
  });

  test('write overwrites', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    const filePath = `${workDir}/overwrite.txt`;
    await sandbox.write_file(filePath, 'original');
    await sandbox.write_file(filePath, 'updated');
    const content = await sandbox.read_file(filePath);
    expect(content).toBe('updated');
  });

  test('multiline', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    const filePath = `${workDir}/multiline.txt`;
    const multiline = 'line1\nline2\nline3';
    await sandbox.write_file(filePath, multiline);
    const content = await sandbox.read_file(filePath);
    expect(content).toBe(multiline);
  });
});

describe('LocalSandbox.list_dir', () => {
  test('returns entries', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    await sandbox.write_file(`${workDir}/file1.txt`, 'a');
    await sandbox.write_file(`${workDir}/file2.txt`, 'b');
    const entries = await sandbox.list_dir(workDir);
    expect(entries).toContain('file1.txt');
    expect(entries).toContain('file2.txt');
  });

  test('includes directories', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    const { mkdirSync } = require('node:fs');
    mkdirSync(`${workDir}/subdir`);
    const entries = await sandbox.list_dir(workDir);
    expect(entries).toContain('subdir');
  });

  test('empty directory', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    const { mkdirSync } = require('node:fs');
    mkdirSync(`${workDir}/empty`);
    const entries = await sandbox.list_dir(`${workDir}/empty`);
    expect(entries).toEqual([]);
  });

  test('nonexistent throws', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    expect(sandbox.list_dir(`${workDir}/nonexistent`)).rejects.toThrow();
  });
});

describe('LocalSandbox.glob_files', () => {
  test('finds matching files', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    await sandbox.write_file(`${workDir}/main.py`, "print('hi')");
    await sandbox.write_file(`${workDir}/utils.py`, 'def helper(): pass');
    await sandbox.write_file(`${workDir}/readme.txt`, 'docs');
    const results = await sandbox.glob_files('*.py', workDir);
    expect(results.length).toBe(2);
    expect(results.some(r => r.includes('main.py'))).toBe(true);
    expect(results.some(r => r.includes('utils.py'))).toBe(true);
  });

  test('empty for no match', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    await sandbox.write_file(`${workDir}/file.txt`, 'text');
    const results = await sandbox.glob_files('*.xyz', workDir);
    expect(results).toEqual([]);
  });

  test('recursive pattern', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    const { mkdirSync } = require('node:fs');
    mkdirSync(`${workDir}/sub`);
    await sandbox.write_file(`${workDir}/top.py`, 'top');
    await sandbox.write_file(`${workDir}/sub/nested.py`, 'nested');
    const results = await sandbox.glob_files('**/*.py', workDir);
    expect(results.length).toBe(2);
  });
});

describe('SandboxProvider', () => {
  test('exists', () => {
    expect(LocalSandboxProvider).toBeDefined();
  });

  test('acquire returns sandbox', async () => {
    const provider = new LocalSandboxProvider();
    const sandbox = await provider.acquire();
    expect(sandbox).toBeDefined();
  });

  test('acquire returns unique instances', async () => {
    const provider = new LocalSandboxProvider();
    const s1 = await provider.acquire();
    const s2 = await provider.acquire();
    expect(s1).not.toBe(s2);
  });

  test('release and reacquire', async () => {
    const provider = new LocalSandboxProvider();
    const s1 = await provider.acquire();
    await provider.release(s1);
    const s2 = await provider.acquire();
    expect(s1).toBe(s2);
  });

  test('shutdown', async () => {
    const provider = new LocalSandboxProvider();
    await provider.acquire();
    await provider.acquire();
    await provider.shutdown();
  });

  test('acquire after shutdown throws', async () => {
    const provider = new LocalSandboxProvider();
    await provider.shutdown();
    expect(provider.acquire()).rejects.toThrow();
  });
});

describe('LocalSandbox integration', () => {
  test('full workflow exec write read', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    const scriptPath = `${workDir}/script.py`;
    await sandbox.write_file(scriptPath, 'print(2 + 2)');
    const [stdout, stderr, exitCode] = await sandbox.exec(`python3 ${scriptPath}`, workDir);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('4');
  });

  test('list_dir after write', async () => {
    const sandbox = new LocalSandbox();
    const workDir = makeTmpDir();
    await sandbox.write_file(`${workDir}/a.txt`, 'content_a');
    await sandbox.write_file(`${workDir}/b.txt`, 'content_b');
    const entries = await sandbox.list_dir(workDir);
    expect(entries).toContain('a.txt');
    expect(entries).toContain('b.txt');
  });
});
