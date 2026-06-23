/**
 * Execution Feedback — Codex-style diagnostic capture and formatting.
 *
 * Plain English: When the agent runs a command or uses a tool, we need to
 * tell the LLM what happened. This module captures EVERYTHING (stdout, stderr,
 * exit codes, LSP errors) and formats it as structured JSON for the LLM.
 *
 * The key insight from GitHub Codex CLI: DON'T try to diagnose the problem
 * yourself. Just capture the raw output, format it well, and let the LLM
 * figure out what went wrong. The LLM is better at diagnosis than heuristics.
 *
 * What we DO:
 * 1. Capture raw execution output (stdout, stderr, exit_code, duration)
 * 2. Capture LSP diagnostics (code-level errors after file edits)
 * 3. Detect loops via fingerprinting (same tool + same args = loop)
 * 4. Track what data we have vs what we're missing
 * 5. Format everything as structured JSON for the LLM
 *
 * What we DON'T do:
 * - Pre-classify failures (the LLM does this better)
 * - Run heuristic probes (may mislead the LLM)
 * - Try to determine "sufficiency" (the LLM knows when it needs more info)
 *
 * Architecture:
 *     ExecutionResult → format_for_llm() → JSON string → LLM
 *     LspDiagnostic  ──────────────────────↗
 *     LoopDetector   ──────────────────────↗
 *
 * Inspired by:
 * - GitHub Codex CLI: raw-exec.ts, handle-exec-command.ts, agent-loop.ts
 * - "Building AI Coding Agents for the Terminal" (arxiv 2603.05344)
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// ExecutionResult — raw capture of a tool/command execution
// ---------------------------------------------------------------------------

/**
 * Raw execution output — everything the LLM needs to diagnose issues.
 *
 * Plain English: This is like taking a photo of the terminal after running
 * a command. We capture:
 * - stdout: What the command printed (normal output)
 * - stderr: What the command complained about (error output)
 * - exit_code: Whether it succeeded (0) or failed (non-zero)
 * - duration_seconds: How long it took (helps detect timeouts)
 * - tool_name: Which tool was called (for loop detection)
 * - tool_input: What arguments were passed (for loop detection)
 *
 * We capture EVERYTHING because we don't know what the LLM will need.
 * Filtering happens later, not here.
 *
 * Attributes:
 *   stdout: Standard output from the command.
 *   stderr: Standard error from the command.
 *   exit_code: Exit code (0 = success, non-zero = failure).
 *   duration_seconds: How long the command took.
 *   tool_name: Which tool was called (e.g., "shell", "read_file").
 *   tool_input: What arguments were passed to the tool.
 *   timestamp: When this execution happened (Unix timestamp).
 */
export class ExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number;
  readonly duration_seconds: number;
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly timestamp: number;

  constructor(options: Partial<ExecutionResult> = {}) {
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
    this.exit_code = options.exit_code ?? 0;
    this.duration_seconds = options.duration_seconds ?? 0.0;
    this.tool_name = options.tool_name ?? '';
    this.tool_input = options.tool_input ? { ...options.tool_input } : {};
    this.timestamp = options.timestamp ?? Date.now() / 1000;
  }

  /** Did the command succeed? (exit_code == 0) */
  get succeeded(): boolean {
    return this.exit_code === 0;
  }

  /**
   * The best output to show the LLM — prefer stdout, fallback to stderr.
   *
   * This follows Codex CLI's pattern: if there's stdout, use it.
   * If stdout is empty but there's stderr, use that (the error IS the output).
   */
  get output_text(): string {
    return this.stdout || this.stderr;
  }

  /** Is there any output at all? */
  get has_output(): boolean {
    return Boolean(this.stdout || this.stderr);
  }

  /**
   * Create a fingerprint for loop detection.
   *
   * Plain English: We hash the tool name + arguments to create a short
   * "fingerprint". If two calls have the same fingerprint, they're
   * doing the exact same thing. This is how we detect loops.
   *
   * We use SHA-256 truncated to 16 chars — fast, consistent, and
   * collision-resistant enough for our purposes.
   */
  fingerprint(): string {
    const content = `${this.tool_name}:${JSON.stringify(this.tool_input, Object.keys(this.tool_input).sort())}`;
    return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
  }
}

// ---------------------------------------------------------------------------
// LspDiagnostic — code-level error from Language Server Protocol
// ---------------------------------------------------------------------------

/**
 * A code-level diagnostic from a Language Server (LSP).
 *
 * Plain English: When you edit a file in VS Code and see red squiggly
 * lines, those are LSP diagnostics. They tell you things like:
 * - "Undefined variable 'foo' on line 42"
 * - "Type error: expected str, got int"
 * - "Missing import: 'os'"
 *
 * We only capture ERROR-severity diagnostics (not warnings or hints)
 * to avoid noise. This follows Codex CLI's pattern.
 *
 * Attributes:
 *   file_path: Which file has the error.
 *   line: Line number (0-based).
 *   message: The error message.
 *   severity: Always "error" (we filter out warnings).
 *   source: Which language server reported this (e.g., "pyright").
 */
export class LspDiagnostic {
  readonly file_path: string;
  readonly line: number;
  readonly message: string;
  readonly severity: string;
  readonly source: string;

  constructor(options: Partial<LspDiagnostic> = {}) {
    this.file_path = options.file_path ?? '';
    this.line = options.line ?? 0;
    this.message = options.message ?? '';
    this.severity = options.severity ?? 'error';
    this.source = options.source ?? '';
  }
}

// ---------------------------------------------------------------------------
// LoopDetector — fingerprint-based doom-loop detection
// ---------------------------------------------------------------------------

/**
 * Detects when the agent repeats the same tool calls.
 *
 * Plain English: Imagine someone trying the same door handle over and
 * over. After 3 tries, you'd say "it's locked, try a different door."
 * That's what this does — it fingerprints each tool call and tracks
 * them in a sliding window. If the same fingerprint appears 3+ times,
 * we flag it as a loop.
 *
 * This follows the pattern from "Building AI Coding Agents for the
 * Terminal" (arxiv 2603.05344): MD5 hash of (tool_name, arguments)
 * in a sliding window of 20 calls, threshold of 3.
 *
 * We use SHA-256 instead of MD5 (same idea, stronger hash).
 *
 * Attributes:
 *   window_size: How many recent calls to track (default: 20).
 *   threshold: How many repeats before flagging (default: 3).
 *   _recent: Sliding window of recent fingerprints.
 *   _loop_count: How many loops have been detected.
 */
export class LoopDetector {
  window_size: number;
  threshold: number;
  private _recent: string[];
  private _loop_count: number;

  /**
   * Initialize the loop detector.
   *
   * Args:
   *   window_size: Number of recent calls to remember.
   *   threshold: Number of identical calls to trigger a loop warning.
   */
  constructor(window_size: number = 20, threshold: number = 3) {
    this.window_size = window_size;
    this.threshold = threshold;
    this._recent = [];
    this._loop_count = 0;
  }

  /**
   * Check if this execution is part of a loop.
   *
   * Args:
   *   result: The execution result to check.
   *
   * Returns:
   *   A LoopWarning if a loop is detected, None otherwise.
   */
  check(result: ExecutionResult): LoopWarning | null {
    const fingerprint = result.fingerprint();
    this._recent.push(fingerprint);
    if (this._recent.length > this.window_size) {
      this._recent.shift();
    }

    // Count how many times this fingerprint appears in the window
    const count = this._recent.filter((f) => f === fingerprint).length;

    if (count >= this.threshold) {
      this._loop_count++;
      return new LoopWarning({
        tool_name: result.tool_name,
        tool_input: result.tool_input,
        repeat_count: count,
        total_loops: this._loop_count,
      });
    }

    return null;
  }

  /** Clear the sliding window (e.g., on new task). */
  reset(): void {
    this._recent = [];
    this._loop_count = 0;
  }
}

/**
 * A warning that the agent is stuck in a loop.
 *
 * Plain English: "You've tried the same thing 5 times. Try something different."
 *
 * Attributes:
 *   tool_name: Which tool is being repeated.
 *   tool_input: What arguments are being repeated.
 *   repeat_count: How many times this call has been made.
 *   total_loops: How many loops have been detected overall.
 */
export class LoopWarning {
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly repeat_count: number;
  readonly total_loops: number;

  constructor(options: Partial<LoopWarning> = {}) {
    this.tool_name = options.tool_name ?? '';
    this.tool_input = options.tool_input ? { ...options.tool_input } : {};
    this.repeat_count = options.repeat_count ?? 0;
    this.total_loops = options.total_loops ?? 0;
  }
}

// ---------------------------------------------------------------------------
// DiagnosticContext — tracks what data we have vs what we're missing
// ---------------------------------------------------------------------------

/**
 * Tracks what diagnostic data is available and what's missing.
 *
 * Plain English: This is like a checklist for the LLM. It says:
 * - "We have stdout" ✓
 * - "We have stderr" ✓
 * - "We have exit code" ✓
 * - "We have LSP diagnostics" ✗ (missing)
 * - "We have loop warnings" ✓
 *
 * The LLM uses this to know what it CAN reason about and what
 * questions it CANNOT answer. If critical data is missing, the
 * LLM should ask for it rather than guessing.
 *
 * Attributes:
 *   has_stdout: Whether we captured stdout.
 *   has_stderr: Whether we captured stderr.
 *   has_exit_code: Whether we captured exit code.
 *   has_duration: Whether we captured duration.
 *   has_lsp_diagnostics: Whether we have LSP diagnostics.
 *   has_loop_warning: Whether a loop was detected.
 *   missing: List of data we DON'T have.
 */
export class DiagnosticContext {
  has_stdout: boolean;
  has_stderr: boolean;
  has_exit_code: boolean;
  has_duration: boolean;
  has_lsp_diagnostics: boolean;
  has_loop_warning: boolean;
  missing: string[];

  constructor(options: Partial<DiagnosticContext> = {}) {
    this.has_stdout = options.has_stdout ?? false;
    this.has_stderr = options.has_stderr ?? false;
    this.has_exit_code = options.has_exit_code ?? true; // Always captured
    this.has_duration = options.has_duration ?? true; // Always captured
    this.has_lsp_diagnostics = options.has_lsp_diagnostics ?? false;
    this.has_loop_warning = options.has_loop_warning ?? false;
    this.missing = options.missing ? [...options.missing] : [];
  }

  /** Serialize for LLM consumption. */
  to_dict(): Record<string, unknown> {
    return {
      available: {
        stdout: this.has_stdout,
        stderr: this.has_stderr,
        exit_code: this.has_exit_code,
        duration: this.has_duration,
        lsp_diagnostics: this.has_lsp_diagnostics,
        loop_warning: this.has_loop_warning,
      },
      missing: this.missing,
    };
  }
}

// ---------------------------------------------------------------------------
// format_for_llm — the main entry point
// ---------------------------------------------------------------------------

/**
 * Format execution result as structured JSON for the LLM.
 *
 * Plain English: This is the "report card" we send to the LLM. It includes
 * everything the LLM needs to diagnose what happened:
 * - The command output (stdout or stderr)
 * - Whether it succeeded (exit_code)
 * - How long it took (duration)
 * - Any code-level errors (LSP diagnostics)
 * - Any loop warnings
 * - What data we have vs what we're missing
 *
 * We format as JSON because:
 * 1. It's structured (easy for the LLM to parse)
 * 2. It's self-describing (fields are labeled)
 * 3. It's compact (doesn't waste context window)
 *
 * This follows Codex CLI's pattern: function_call_output with
 * JSON {output, metadata}.
 *
 * Args:
 *   result: The execution result to format.
 *   lsp_diagnostics: Optional LSP diagnostics (code-level errors).
 *   loop_warning: Optional loop warning.
 *   max_output_chars: Maximum characters for output (prevents context overflow).
 *   max_diagnostics: Maximum LSP diagnostics to include (cap at 20).
 *
 * Returns:
 *   A JSON string ready to send to the LLM.
 */
export function format_for_llm(
  result: ExecutionResult,
  lsp_diagnostics: LspDiagnostic[] | null = null,
  loop_warning: LoopWarning | null = null,
  max_output_chars: number = 10000,
  max_diagnostics: number = 20
): string {
  // Build the output object
  const output: Record<string, unknown> = {};

  // 1. Command output (prefer stdout, fallback to stderr)
  let output_text = result.output_text;
  if (output_text.length > max_output_chars) {
    output_text = output_text.slice(0, max_output_chars) + '\n... (truncated)';
  }
  output['output'] = output_text;

  // 2. Metadata (always included)
  output['metadata'] = {
    exit_code: result.exit_code,
    duration_seconds: Math.round(result.duration_seconds * 10) / 10,
    tool: result.tool_name,
  };

  // 3. LSP diagnostics (error-severity only, capped)
  const diagnostics = lsp_diagnostics ?? [];
  if (diagnostics.length > 0) {
    output['diagnostics'] = diagnostics.slice(0, max_diagnostics).map((d) => ({
      file: d.file_path,
      line: d.line,
      message: d.message,
      severity: d.severity,
      source: d.source,
    }));
  }

  // 4. Loop warning
  if (loop_warning) {
    output['loop_warning'] = {
      tool: loop_warning.tool_name,
      repeats: loop_warning.repeat_count,
      message: `This tool has been called ${loop_warning.repeat_count} times with the same arguments. Try a different approach.`,
    };
  }

  // 5. Diagnostic context (what we have vs what we're missing)
  const context = _build_context(result, diagnostics, loop_warning);
  output['context'] = context.to_dict();

  return JSON.stringify(output, null, 2);
}

function _build_context(
  result: ExecutionResult,
  lsp_diagnostics: LspDiagnostic[],
  loop_warning: LoopWarning | null
): DiagnosticContext {
  /**
   * Build a DiagnosticContext tracking what data is available.
   *
   * Args:
   *   result: The execution result.
   *   lsp_diagnostics: Optional LSP diagnostics.
   *   loop_warning: Optional loop warning.
   *
   * Returns:
   *   A DiagnosticContext with availability flags and missing data list.
   */
  const missing: string[] = [];

  const has_stdout = Boolean(result.stdout);
  const has_stderr = Boolean(result.stderr);

  if (!has_stdout && !has_stderr) {
    missing.push('output (both stdout and stderr are empty)');
  } else if (!has_stdout) {
    missing.push('stdout (only stderr captured)');
  } else if (!has_stderr) {
    missing.push('stderr (only stdout captured)');
  }

  const has_lsp = lsp_diagnostics.length > 0;
  if (!has_lsp) {
    missing.push('lsp_diagnostics (no language server running or no errors)');
  }

  return new DiagnosticContext({
    has_stdout,
    has_stderr,
    has_exit_code: true,
    has_duration: result.duration_seconds > 0,
    has_lsp_diagnostics: has_lsp,
    has_loop_warning: loop_warning !== null,
    missing,
  });
}

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

/**
 * Create a successful execution result.
 *
 * Plain English: Shorthand for "the command worked."
 *
 * Args:
 *   stdout: What the command printed.
 *   tool_name: Which tool was called.
 *   tool_input: What arguments were passed.
 *   duration: How long it took.
 *
 * Returns:
 *   An ExecutionResult with exit_code=0.
 */
export function success(
  stdout: string = '',
  tool_name: string = '',
  tool_input: Record<string, unknown> | null = null,
  duration: number = 0.0
): ExecutionResult {
  return new ExecutionResult({
    stdout,
    exit_code: 0,
    duration_seconds: duration,
    tool_name,
    tool_input: tool_input ?? {},
  });
}

/**
 * Create a failed execution result.
 *
 * Plain English: Shorthand for "the command failed."
 *
 * Args:
 *   stderr: The error output.
 *   stdout: Any normal output (may be partial).
 *   exit_code: The exit code (default 1 = general failure).
 *   tool_name: Which tool was called.
 *   tool_input: What arguments were passed.
 *   duration: How long it took.
 *
 * Returns:
 *   An ExecutionResult with non-zero exit_code.
 */
export function failure(
  stderr: string = '',
  stdout: string = '',
  exit_code: number = 1,
  tool_name: string = '',
  tool_input: Record<string, unknown> | null = null,
  duration: number = 0.0
): ExecutionResult {
  return new ExecutionResult({
    stdout,
    stderr,
    exit_code,
    duration_seconds: duration,
    tool_name,
    tool_input: tool_input ?? {},
  });
}
