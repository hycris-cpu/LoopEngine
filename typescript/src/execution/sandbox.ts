/**
 * The Sandbox provides a safe execution environment for running code.
 *
 * Plain English: A Sandbox is like a children's sandbox in a playground —
 * a controlled area where you can dig, build, and make messes without
 * affecting the rest of the world. In our case, it's where the agent
 * runs shell commands, reads/writes files, and executes code.
 *
 * Three implementations:
 * 1. LocalSandbox — runs commands on YOUR machine (fast but risky)
 * 2. (Future) DockerSandbox — runs in a Docker container (safe but slower)
 * 3. (Future) CloudSandbox — runs in the cloud (scalable but costs money)
 *
 * SandboxProvider manages sandbox lifecycles — creating, reusing, and
 * destroying sandboxes. Think of it as a pool of sandboxes that agents
 * can check out and return.
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Sandbox Protocol — the interface all sandboxes must satisfy.
 *
 * A sandbox is any object that can execute commands and perform file
 * operations in an isolated environment. This Protocol defines the
 * contract that all sandbox implementations must satisfy.
 *
 * Think of Sandbox as a "workshop" — it has tools for:
 * - Running commands (exec)
 * - Reading files (read_file)
 * - Writing files (write_file)
 * - Listing directories (list_dir)
 * - Finding files (glob_files)
 * - Searching file contents (grep_files)
 */
export interface Sandbox {
  /**
   * Execute a shell command and return its output.
   *
   * Args:
   *   command: The shell command to execute.
   *   cwd: Working directory for the command (default: current dir).
   *   timeout: Maximum execution time in seconds (default: 30).
   *
   * Returns:
   *   A tuple of (stdout, stderr, exit_code).
   */
  exec(command: string, cwd?: string, timeout?: number): Promise<[string, string, number]>;

  /**
   * Read the contents of a file.
   *
   * Args:
   *   path: Path to the file to read.
   *
   * Returns:
   *   The file contents as a string.
   *
   * Raises:
   *   Error: If the file doesn't exist.
   */
  read_file(filePath: string): Promise<string>;

  /**
   * Write content to a file, creating parent directories if needed.
   *
   * Args:
   *   path: Path to the file to write.
   *   content: The content to write.
   */
  write_file(filePath: string, content: string): Promise<void>;

  /**
   * List the contents of a directory.
   *
   * Args:
   *   path: Path to the directory to list.
   *
   * Returns:
   *   A list of entry names (files and directories).
   *
   * Raises:
   *   Error: If the directory doesn't exist.
   */
  list_dir(dirPath: string): Promise<string[]>;

  /**
   * Find files matching a glob pattern.
   *
   * Args:
   *   pattern: The glob pattern to match (e.g., '*.py', '*.txt').
   *   path: The directory to search in (default: current dir).
   *
   * Returns:
   *   A list of matching file paths.
   */
  glob_files(pattern: string, basePath?: string): Promise<string[]>;

  /**
   * Search for a regex pattern in file contents.
   *
   * The search is limited to a whitelist of text file extensions
   * (e.g., .py, .ts, .md, .txt, .json).
   *
   * Args:
   *   pattern: The regex pattern to search for.
   *   path: The directory to search in (default: current dir).
   *
   * Returns:
   *   A list of matching lines in "filepath:line_number:content" format.
   */
  grep_files(pattern: string, basePath?: string): Promise<string[]>;
}

/**
 * A sandbox that executes directly on the host machine.
 *
 * Plain English: This is like working at your own desk — fast and
 * convenient, but anything you do affects your real computer.
 * Use this for development and testing. For production, use
 * DockerSandbox or CloudSandbox instead.
 *
 * LocalSandbox uses:
 * - node:child_process.spawn for command execution
 * - node:fs/promises for file operations
 * - a recursive glob implementation for pattern matching
 * - grep via subprocess (grep command)
 *
 * All operations are async so they don't block the event loop.
 */
export class LocalSandbox implements Sandbox {
  /**
   * Execute a shell command on the local machine.
   *
   * Uses spawn to run the command without blocking the event loop.
   * The command is run through a shell to support shell features
   * like pipes and redirects.
   *
   * Args:
   *   command: The shell command to execute.
   *   cwd: Working directory for the command.
   *   timeout: Maximum execution time in seconds.
   *
   * Returns:
   *   A tuple of (stdout, stderr, exit_code).
   *
   * Raises:
   *   Error: If the command exceeds the timeout.
   */
  async exec(command: string, cwd: string = '.', timeout: number = 30): Promise<[string, string, number]> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString('utf-8');
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf-8');
      });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Command timed out after ${timeout}s: ${command}`));
      }, timeout * 1000);

      child.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve([stdout, stderr, code ?? 0]);
      });
    });
  }

  async read_file(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`File not found: ${filePath}`);
    }
  }

  async write_file(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
  }

  async list_dir(dirPath: string): Promise<string[]> {
    const info = await stat(dirPath).catch(() => null);
    if (info === null) {
      throw new Error(`Directory not found: ${dirPath}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Not a directory: ${dirPath}`);
    }
    const entries = await readdir(dirPath);
    return [...entries].sort();
  }

  async glob_files(pattern: string, basePath: string = '.'): Promise<string[]> {
    const matches: string[] = [];
    const base = path.resolve(basePath);
    const recursive = pattern.startsWith('**/');
    const relativePattern = recursive ? pattern.slice(3) : pattern;

    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(base, fullPath);
        if (entry.isDirectory() && recursive) {
          await walk(fullPath);
        } else if (entry.isFile() && matchGlob(entry.name, relativePattern)) {
          matches.push(relPath);
        }
      }
    }

    await walk(base);
    return matches.sort();
  }

  async grep_files(pattern: string, basePath: string = '.'): Promise<string[]> {
    // Try system grep first (faster for large codebases)
    try {
      const result = await runCommand(
        'grep',
        [
          '-rn',
          '--include=*.py',
          '--include=*.txt',
          '--include=*.md',
          '--include=*.json',
          '--include=*.yaml',
          '--include=*.yml',
          '--include=*.toml',
          '--include=*.cfg',
          '--include=*.sh',
          '--include=*.js',
          '--include=*.ts',
          pattern,
          basePath,
        ],
        10
      );
      if (result.exitCode === 0 && result.stdout) {
        return result.stdout.trim().split('\n');
      }
      return [];
    } catch {
      // Fallback to pure-TypeScript implementation
      return this._grepFallback(pattern, basePath);
    }
  }

  /**
   * Pure-TypeScript fallback for searching file contents.
   *
   * Walks the directory tree and scans text files line-by-line when the
   * system `grep` command is unavailable or fails.
   */
  private async _grepFallback(pattern: string, basePath: string): Promise<string[]> {
    const results: string[] = [];
    const regex = new RegExp(pattern);
    const textExtensions = new Set([
      '.py',
      '.txt',
      '.md',
      '.json',
      '.yaml',
      '.yml',
      '.toml',
      '.cfg',
      '.sh',
      '.js',
      '.ts',
    ]);

    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
          const text = await readFile(fullPath, 'utf-8').catch(() => null);
          if (text === null) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(`${fullPath}:${i + 1}:${lines[i]}`);
            }
          }
        }
      }
    }

    await walk(path.resolve(basePath));
    return results;
  }
}

/**
 * SandboxProvider Protocol — managing sandbox lifecycles.
 *
 * Plain English: A SandboxProvider is like a car rental agency.
 * You can:
 * - acquire(): Check out a sandbox (like renting a car)
 * - release(): Return a sandbox (like returning the car)
 * - shutdown(): Close the agency (return all cars, clean up)
 *
 * The provider manages a pool of sandboxes for efficiency —
 * creating new ones on demand and reusing returned ones.
 */
export interface SandboxProvider {
  /**
   * Get a sandbox from the pool.
   *
   * Returns:
   *   A Sandbox instance ready for use.
   *
   * Raises:
   *   Error: If the provider has been shut down.
   */
  acquire(): Promise<Sandbox>;

  /**
   * Return a sandbox to the pool for reuse.
   *
   * Args:
   *   sandbox: The sandbox to return.
   */
  release(sandbox: Sandbox): Promise<void>;

  /**
   * Shut down the provider and clean up all sandboxes.
   *
   * After shutdown, acquire() will raise Error.
   */
  shutdown(): Promise<void>;
}

/**
 * A provider that manages a pool of LocalSandbox instances.
 *
 * Plain English: This is like a library that has multiple copies of
 * the same book. When someone needs a book, they check one out.
 * When they return it, it goes back on the shelf for the next person.
 *
 * The pool:
 * - Creates sandboxes on demand (lazy initialization)
 * - Reuses returned sandboxes (pool recycling)
 * - Cleans up all sandboxes on shutdown
 *
 * This is useful for concurrent task execution — multiple agents
 * can each have their own sandbox without creating/destroying them
 * repeatedly.
 */
export class LocalSandboxProvider implements SandboxProvider {
  private _available: LocalSandbox[];
  private _in_use: Set<LocalSandbox>;
  private _shutdown: boolean;

  constructor() {
    this._available = [];
    this._in_use = new Set();
    this._shutdown = false;
  }

  async acquire(): Promise<LocalSandbox> {
    if (this._shutdown) {
      throw new Error('Cannot acquire sandbox: provider is shut down');
    }

    let sandbox: LocalSandbox;
    if (this._available.length > 0) {
      sandbox = this._available.pop()!;
    } else {
      sandbox = new LocalSandbox();
    }

    this._in_use.add(sandbox);
    return sandbox;
  }

  async release(sandbox: Sandbox): Promise<void> {
    if (sandbox instanceof LocalSandbox && this._in_use.has(sandbox)) {
      this._in_use.delete(sandbox);
      this._available.push(sandbox);
    }
  }

  async shutdown(): Promise<void> {
    this._shutdown = true;
    this._available.length = 0;
    this._in_use.clear();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCommand(command: string, args: string[], timeout: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8');
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8');
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeout}s: ${command}`));
    }, timeout * 1000);

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

/**
 * Match a filename against a glob pattern.
 *
 * Supports * and ? wildcards. Does not support ** here (handled by the walker).
 */
function matchGlob(name: string, pattern: string): boolean {
  // Escape regex special chars, then convert glob wildcards.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexPattern = `^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
  return new RegExp(regexPattern).test(name);
}

// ---------------------------------------------------------------------------
// DockerSandbox — runs commands INSIDE a container for real isolation
// ---------------------------------------------------------------------------

import * as posix from 'node:path/posix';

/**
 * A host-docker runner: given an argv list (and optional stdin + timeout),
 * execute it on the host and return [stdout, stderr, exit_code].
 */
export type DockerRunner = (
  argv: string[],
  stdin?: string | null,
  timeout?: number,
) => Promise<[string, string, number]>;

/** Quote a string for safe use inside a single-quoted sh argument. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Default runner: execute a docker argv on the host without a shell, so
 * arguments are passed literally and cannot be reinterpreted by a host shell.
 */
export const defaultDockerRunner: DockerRunner = (argv, stdin = null, timeout = 30) =>
  new Promise<[string, string, number]>((resolve, reject) => {
    const proc = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('docker command timed out'));
    }, timeout * 1000);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve([out, err, code ?? 0]);
    });
    if (stdin !== null && stdin !== undefined) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });

/**
 * A sandbox that runs every operation INSIDE a Docker container.
 *
 * Unlike LocalSandbox (which runs on the host with no isolation), DockerSandbox
 * confines all execution and file access to a container and to a single working
 * directory inside it. Host docker invocation is delegated to an injected
 * `runner` so the translation logic is unit-testable without a running daemon.
 */
export class DockerSandbox implements Sandbox {
  private readonly _container: string;
  private readonly _workdir: string;
  private readonly _run: DockerRunner;

  constructor(container: string, workdir = '/workspace', runner: DockerRunner = defaultDockerRunner) {
    this._container = container;
    this._workdir = workdir.replace(/\/+$/, '') || '/';
    this._run = runner;
  }

  /** Resolve a path to an absolute path confined to the workdir. */
  private _resolve(p: string): string {
    const candidate = posix.isAbsolute(p) ? p : posix.join(this._workdir, p);
    const normalized = posix.normalize(candidate).replace(/\/+$/, '') || '/';
    if (normalized !== this._workdir && !normalized.startsWith(this._workdir + '/')) {
      throw new Error(`Path escapes sandbox workdir: ${p}`);
    }
    return normalized;
  }

  async exec(command: string, cwd = '.', timeout = 30): Promise<[string, string, number]> {
    const workdir = this._resolve(cwd);
    return this._run(['docker', 'exec', '-w', workdir, this._container, 'sh', '-c', command], null, timeout);
  }

  async read_file(filePath: string): Promise<string> {
    const target = this._resolve(filePath);
    const [out, , code] = await this._run(['docker', 'exec', this._container, 'cat', target], null, 30);
    if (code !== 0) {
      throw new Error(`File not found in container: ${filePath}`);
    }
    return out;
  }

  async write_file(filePath: string, content: string): Promise<void> {
    const target = this._resolve(filePath);
    const parent = posix.dirname(target);
    if (parent) {
      await this._run(['docker', 'exec', this._container, 'mkdir', '-p', parent], null, 30);
    }
    await this._run(
      ['docker', 'exec', '-i', this._container, 'sh', '-c', `cat > ${shSingleQuote(target)}`],
      content,
      30,
    );
  }

  async list_dir(dirPath: string): Promise<string[]> {
    const target = this._resolve(dirPath);
    const [out, , code] = await this._run(['docker', 'exec', this._container, 'ls', '-1A', target], null, 30);
    if (code !== 0) {
      throw new Error(`Directory not found in container: ${dirPath}`);
    }
    return out.split('\n').filter((l) => l.length > 0);
  }

  async glob_files(pattern: string, dirPath = '.'): Promise<string[]> {
    const base = this._resolve(dirPath);
    const [out, , code] = await this._run(
      ['docker', 'exec', this._container, 'sh', '-c', `find ${shSingleQuote(base)} -type f -name ${shSingleQuote(pattern)}`],
      null,
      30,
    );
    if (code !== 0) return [];
    return out.split('\n').filter((l) => l.length > 0);
  }

  async grep_files(pattern: string, dirPath = '.'): Promise<string[]> {
    const base = this._resolve(dirPath);
    const [out, , code] = await this._run(
      ['docker', 'exec', this._container, 'grep', '-rn', pattern, base],
      null,
      30,
    );
    if (code !== 0) return [];
    return out.split('\n').filter((l) => l.length > 0);
  }
}

/**
 * Manages Docker containers, handing out DockerSandbox instances. acquire()
 * starts a detached container; release()/shutdown() force-remove containers.
 */
export class DockerSandboxProvider implements SandboxProvider {
  private readonly _image: string;
  private readonly _workdir: string;
  private readonly _run: DockerRunner;
  private readonly _containers = new Map<DockerSandbox, string>();
  private _shutdown = false;

  constructor(image: string, workdir = '/workspace', runner: DockerRunner = defaultDockerRunner) {
    this._image = image;
    this._workdir = workdir;
    this._run = runner;
  }

  async acquire(): Promise<DockerSandbox> {
    if (this._shutdown) {
      throw new Error('Cannot acquire sandbox: provider is shut down');
    }
    const [out, err, code] = await this._run(
      ['docker', 'run', '-d', '-w', this._workdir, this._image, 'sleep', 'infinity'],
      null,
      60,
    );
    if (code !== 0) {
      throw new Error(`Failed to start container: ${err}`);
    }
    const containerId = out.trim();
    const sandbox = new DockerSandbox(containerId, this._workdir, this._run);
    this._containers.set(sandbox, containerId);
    return sandbox;
  }

  async release(sandbox: DockerSandbox): Promise<void> {
    const containerId = this._containers.get(sandbox);
    if (containerId !== undefined) {
      this._containers.delete(sandbox);
      await this._run(['docker', 'rm', '-f', containerId], null, 30);
    }
  }

  async shutdown(): Promise<void> {
    this._shutdown = true;
    for (const containerId of this._containers.values()) {
      await this._run(['docker', 'rm', '-f', containerId], null, 30);
    }
    this._containers.clear();
  }
}
