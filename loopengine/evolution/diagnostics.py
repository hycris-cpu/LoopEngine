"""Execution Feedback — Codex-style diagnostic capture and formatting.

Plain English: When the agent runs a command or uses a tool, we need to
tell the LLM what happened. This module captures EVERYTHING (stdout, stderr,
exit codes, LSP errors) and formats it as structured JSON for the LLM.

The key insight from GitHub Codex CLI: DON'T try to diagnose the problem
yourself. Just capture the raw output, format it well, and let the LLM
figure out what went wrong. The LLM is better at diagnosis than heuristics.

What we DO:
1. Capture raw execution output (stdout, stderr, exit_code, duration)
2. Capture LSP diagnostics (code-level errors after file edits)
3. Detect loops via fingerprinting (same tool + same args = loop)
4. Track what data we have vs what we're missing
5. Format everything as structured JSON for the LLM

What we DON'T do:
- Pre-classify failures (the LLM does this better)
- Run heuristic probes (may mislead the LLM)
- Try to determine "sufficiency" (the LLM knows when it needs more info)

Architecture:
    ExecutionResult → format_for_llm() → JSON string → LLM
    LspDiagnostic  ──────────────────────↗
    LoopDetector   ──────────────────────↗

Inspired by:
- GitHub Codex CLI: raw-exec.ts, handle-exec-command.ts, agent-loop.ts
- "Building AI Coding Agents for the Terminal" (arxiv 2603.05344)
"""

from __future__ import annotations

import hashlib
import json
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# ExecutionResult — raw capture of a tool/command execution
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExecutionResult:
    """Raw execution output — everything the LLM needs to diagnose issues.

    Plain English: This is like taking a photo of the terminal after running
    a command. We capture:
    - stdout: What the command printed (normal output)
    - stderr: What the command complained about (error output)
    - exit_code: Whether it succeeded (0) or failed (non-zero)
    - duration_seconds: How long it took (helps detect timeouts)
    - tool_name: Which tool was called (for loop detection)
    - tool_input: What arguments were passed (for loop detection)

    We capture EVERYTHING because we don't know what the LLM will need.
    Filtering happens later, not here.

    Attributes:
        stdout: Standard output from the command.
        stderr: Standard error from the command.
        exit_code: Exit code (0 = success, non-zero = failure).
        duration_seconds: How long the command took.
        tool_name: Which tool was called (e.g., "shell", "read_file").
        tool_input: What arguments were passed to the tool.
        timestamp: When this execution happened (Unix timestamp).
    """

    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0
    duration_seconds: float = 0.0
    tool_name: str = ""
    tool_input: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)

    @property
    def succeeded(self) -> bool:
        """Did the command succeed? (exit_code == 0)"""
        return self.exit_code == 0

    @property
    def output_text(self) -> str:
        """The best output to show the LLM — prefer stdout, fallback to stderr.

        This follows Codex CLI's pattern: if there's stdout, use it.
        If stdout is empty but there's stderr, use that (the error IS the output).
        """
        return self.stdout or self.stderr

    @property
    def has_output(self) -> bool:
        """Is there any output at all?"""
        return bool(self.stdout or self.stderr)

    def fingerprint(self) -> str:
        """Create a fingerprint for loop detection.

        Plain English: We hash the tool name + arguments to create a short
        "fingerprint". If two calls have the same fingerprint, they're
        doing the exact same thing. This is how we detect loops.

        We use SHA-256 truncated to 16 chars — fast, consistent, and
        collision-resistant enough for our purposes.
        """
        content = f"{self.tool_name}:{json.dumps(self.tool_input, sort_keys=True)}"
        return hashlib.sha256(content.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# LspDiagnostic — code-level error from Language Server Protocol
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LspDiagnostic:
    """A code-level diagnostic from a Language Server (LSP).

    Plain English: When you edit a file in VS Code and see red squiggly
    lines, those are LSP diagnostics. They tell you things like:
    - "Undefined variable 'foo' on line 42"
    - "Type error: expected str, got int"
    - "Missing import: 'os'"

    We only capture ERROR-severity diagnostics (not warnings or hints)
    to avoid noise. This follows Codex CLI's pattern.

    Attributes:
        file_path: Which file has the error.
        line: Line number (0-based).
        message: The error message.
        severity: Always "error" (we filter out warnings).
        source: Which language server reported this (e.g., "pyright").
    """

    file_path: str = ""
    line: int = 0
    message: str = ""
    severity: str = "error"
    source: str = ""


# ---------------------------------------------------------------------------
# LoopDetector — fingerprint-based doom-loop detection
# ---------------------------------------------------------------------------


class LoopDetector:
    """Detects when the agent repeats the same tool calls.

    Plain English: Imagine someone trying the same door handle over and
    over. After 3 tries, you'd say "it's locked, try a different door."
    That's what this does — it fingerprints each tool call and tracks
    them in a sliding window. If the same fingerprint appears 3+ times,
    we flag it as a loop.

    This follows the pattern from "Building AI Coding Agents for the
    Terminal" (arxiv 2603.05344): MD5 hash of (tool_name, arguments)
    in a sliding window of 20 calls, threshold of 3.

    We use SHA-256 instead of MD5 (same idea, stronger hash).

    Attributes:
        window_size: How many recent calls to track (default: 20).
        threshold: How many repeats before flagging (default: 3).
        _recent: Sliding window of recent fingerprints.
        _loop_count: How many loops have been detected.
    """

    def __init__(self, window_size: int = 20, threshold: int = 3):
        """Initialize the loop detector.

        Args:
            window_size: Number of recent calls to remember.
            threshold: Number of identical calls to trigger a loop warning.
        """
        self.window_size = window_size
        self.threshold = threshold
        self._recent: deque[str] = deque(maxlen=window_size)
        self._loop_count = 0

    def check(self, result: ExecutionResult) -> LoopWarning | None:
        """Check if this execution is part of a loop.

        Args:
            result: The execution result to check.

        Returns:
            A LoopWarning if a loop is detected, None otherwise.
        """
        fingerprint = result.fingerprint()
        self._recent.append(fingerprint)

        # Count how many times this fingerprint appears in the window
        count = sum(1 for f in self._recent if f == fingerprint)

        if count >= self.threshold:
            self._loop_count += 1
            return LoopWarning(
                tool_name=result.tool_name,
                tool_input=result.tool_input,
                repeat_count=count,
                total_loops=self._loop_count,
            )

        return None

    def reset(self) -> None:
        """Clear the sliding window (e.g., on new task)."""
        self._recent.clear()
        self._loop_count = 0


@dataclass(frozen=True)
class LoopWarning:
    """A warning that the agent is stuck in a loop.

    Plain English: "You've tried the same thing 5 times. Try something different."

    Attributes:
        tool_name: Which tool is being repeated.
        tool_input: What arguments are being repeated.
        repeat_count: How many times this call has been made.
        total_loops: How many loops have been detected overall.
    """

    tool_name: str = ""
    tool_input: dict[str, Any] = field(default_factory=dict)
    repeat_count: int = 0
    total_loops: int = 0


# ---------------------------------------------------------------------------
# DiagnosticContext — tracks what data we have vs what we're missing
# ---------------------------------------------------------------------------


@dataclass
class DiagnosticContext:
    """Tracks what diagnostic data is available and what's missing.

    Plain English: This is like a checklist for the LLM. It says:
    - "We have stdout" ✓
    - "We have stderr" ✓
    - "We have exit code" ✓
    - "We have LSP diagnostics" ✗ (missing)
    - "We have loop warnings" ✓

    The LLM uses this to know what it CAN reason about and what
    questions it CANNOT answer. If critical data is missing, the
    LLM should ask for it rather than guessing.

    Attributes:
        has_stdout: Whether we captured stdout.
        has_stderr: Whether we captured stderr.
        has_exit_code: Whether we captured exit code.
        has_duration: Whether we captured duration.
        has_lsp_diagnostics: Whether we have LSP diagnostics.
        has_loop_warning: Whether a loop was detected.
        missing: List of data we DON'T have.
    """

    has_stdout: bool = False
    has_stderr: bool = False
    has_exit_code: bool = True  # Always captured
    has_duration: bool = True   # Always captured
    has_lsp_diagnostics: bool = False
    has_loop_warning: bool = False
    missing: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Serialize for LLM consumption."""
        return {
            "available": {
                "stdout": self.has_stdout,
                "stderr": self.has_stderr,
                "exit_code": self.has_exit_code,
                "duration": self.has_duration,
                "lsp_diagnostics": self.has_lsp_diagnostics,
                "loop_warning": self.has_loop_warning,
            },
            "missing": self.missing,
        }


# ---------------------------------------------------------------------------
# format_for_llm — the main entry point
# ---------------------------------------------------------------------------


def format_for_llm(
    result: ExecutionResult,
    lsp_diagnostics: list[LspDiagnostic] | None = None,
    loop_warning: LoopWarning | None = None,
    max_output_chars: int = 10000,
    max_diagnostics: int = 20,
) -> str:
    """Format execution result as structured JSON for the LLM.

    Plain English: This is the "report card" we send to the LLM. It includes
    everything the LLM needs to diagnose what happened:
    - The command output (stdout or stderr)
    - Whether it succeeded (exit_code)
    - How long it took (duration)
    - Any code-level errors (LSP diagnostics)
    - Any loop warnings
    - What data we have vs what we're missing

    We format as JSON because:
    1. It's structured (easy for the LLM to parse)
    2. It's self-describing (fields are labeled)
    3. It's compact (doesn't waste context window)

    This follows Codex CLI's pattern: function_call_output with
    JSON {output, metadata}.

    Args:
        result: The execution result to format.
        lsp_diagnostics: Optional LSP diagnostics (code-level errors).
        loop_warning: Optional loop warning.
        max_output_chars: Maximum characters for output (prevents context overflow).
        max_diagnostics: Maximum LSP diagnostics to include (cap at 20).

    Returns:
        A JSON string ready to send to the LLM.
    """
    # Build the output object
    output: dict[str, Any] = {}

    # 1. Command output (prefer stdout, fallback to stderr)
    output_text = result.output_text
    if len(output_text) > max_output_chars:
        output_text = output_text[:max_output_chars] + "\n... (truncated)"
    output["output"] = output_text

    # 2. Metadata (always included)
    output["metadata"] = {
        "exit_code": result.exit_code,
        "duration_seconds": round(result.duration_seconds, 1),
        "tool": result.tool_name,
    }

    # 3. LSP diagnostics (error-severity only, capped)
    if lsp_diagnostics:
        diagnostics = lsp_diagnostics[:max_diagnostics]
        output["diagnostics"] = [
            {
                "file": d.file_path,
                "line": d.line,
                "message": d.message,
                "severity": d.severity,
                "source": d.source,
            }
            for d in diagnostics
        ]

    # 4. Loop warning
    if loop_warning:
        output["loop_warning"] = {
            "tool": loop_warning.tool_name,
            "repeats": loop_warning.repeat_count,
            "message": (
                f"This tool has been called {loop_warning.repeat_count} times "
                f"with the same arguments. Try a different approach."
            ),
        }

    # 5. Diagnostic context (what we have vs what we're missing)
    context = _build_context(result, lsp_diagnostics, loop_warning)
    output["context"] = context.to_dict()

    return json.dumps(output, indent=2)


def _build_context(
    result: ExecutionResult,
    lsp_diagnostics: list[LspDiagnostic] | None,
    loop_warning: LoopWarning | None,
) -> DiagnosticContext:
    """Build a DiagnosticContext tracking what data is available.

    Args:
        result: The execution result.
        lsp_diagnostics: Optional LSP diagnostics.
        loop_warning: Optional loop warning.

    Returns:
        A DiagnosticContext with availability flags and missing data list.
    """
    missing: list[str] = []

    has_stdout = bool(result.stdout)
    has_stderr = bool(result.stderr)

    if not has_stdout and not has_stderr:
        missing.append("output (both stdout and stderr are empty)")
    elif not has_stdout:
        missing.append("stdout (only stderr captured)")
    elif not has_stderr:
        missing.append("stderr (only stdout captured)")

    has_lsp = bool(lsp_diagnostics)
    if not has_lsp:
        missing.append("lsp_diagnostics (no language server running or no errors)")

    return DiagnosticContext(
        has_stdout=has_stdout,
        has_stderr=has_stderr,
        has_exit_code=True,
        has_duration=result.duration_seconds > 0,
        has_lsp_diagnostics=has_lsp,
        has_loop_warning=loop_warning is not None,
        missing=missing,
    )


# ---------------------------------------------------------------------------
# Convenience functions
# ---------------------------------------------------------------------------


def success(
    stdout: str = "",
    tool_name: str = "",
    tool_input: dict[str, Any] | None = None,
    duration: float = 0.0,
) -> ExecutionResult:
    """Create a successful execution result.

    Plain English: Shorthand for "the command worked."

    Args:
        stdout: What the command printed.
        tool_name: Which tool was called.
        tool_input: What arguments were passed.
        duration: How long it took.

    Returns:
        An ExecutionResult with exit_code=0.
    """
    return ExecutionResult(
        stdout=stdout,
        exit_code=0,
        duration_seconds=duration,
        tool_name=tool_name,
        tool_input=tool_input or {},
    )


def failure(
    stderr: str = "",
    stdout: str = "",
    exit_code: int = 1,
    tool_name: str = "",
    tool_input: dict[str, Any] | None = None,
    duration: float = 0.0,
) -> ExecutionResult:
    """Create a failed execution result.

    Plain English: Shorthand for "the command failed."

    Args:
        stderr: The error output.
        stdout: Any normal output (may be partial).
        exit_code: The exit code (default 1 = general failure).
        tool_name: Which tool was called.
        tool_input: What arguments were passed.
        duration: How long it took.

    Returns:
        An ExecutionResult with non-zero exit_code.
    """
    return ExecutionResult(
        stdout=stdout,
        stderr=stderr,
        exit_code=exit_code,
        duration_seconds=duration,
        tool_name=tool_name,
        tool_input=tool_input or {},
    )
