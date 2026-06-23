"""Tests for the Codex-style diagnostics module.

Tests verify:
1. ExecutionResult captures raw output correctly
2. LoopDetector fingerprints and detects loops
3. format_for_llm produces structured JSON the LLM can reason about
4. DiagnosticContext tracks what data we have vs what we're missing
"""

from __future__ import annotations

import json
import pytest

from loopengine.evolution.diagnostics import (
    DiagnosticContext,
    ExecutionResult,
    LspDiagnostic,
    LoopDetector,
    LoopWarning,
    failure,
    format_for_llm,
    success,
)


# ---------------------------------------------------------------------------
# ExecutionResult
# ---------------------------------------------------------------------------


class TestExecutionResult:
    """Test raw execution capture."""

    def test_creation(self):
        """Given execution data, When creating ExecutionResult, Then all fields stored."""
        r = ExecutionResult(
            stdout="hello",
            stderr="",
            exit_code=0,
            duration_seconds=1.5,
            tool_name="shell",
            tool_input={"command": "echo hello"},
        )
        assert r.stdout == "hello"
        assert r.stderr == ""
        assert r.exit_code == 0
        assert r.duration_seconds == 1.5
        assert r.tool_name == "shell"

    def test_frozen(self):
        """ExecutionResult is immutable."""
        r = ExecutionResult()
        with pytest.raises(AttributeError):
            r.stdout = "changed"

    def test_succeeded_true(self):
        """exit_code 0 means success."""
        r = ExecutionResult(exit_code=0)
        assert r.succeeded is True

    def test_succeeded_false(self):
        """Non-zero exit code means failure."""
        r = ExecutionResult(exit_code=1)
        assert r.succeeded is False

    def test_output_text_prefers_stdout(self):
        """output_text returns stdout when available."""
        r = ExecutionResult(stdout="output", stderr="error")
        assert r.output_text == "output"

    def test_output_text_fallback_to_stderr(self):
        """output_text falls back to stderr when stdout is empty."""
        r = ExecutionResult(stdout="", stderr="error message")
        assert r.output_text == "error message"

    def test_has_output_true(self):
        """has_output is True when there's stdout or stderr."""
        r = ExecutionResult(stdout="something")
        assert r.has_output is True

    def test_has_output_false(self):
        """has_output is False when both are empty."""
        r = ExecutionResult()
        assert r.has_output is False

    def test_fingerprint_deterministic(self):
        """Same tool + input = same fingerprint."""
        r1 = ExecutionResult(tool_name="shell", tool_input={"cmd": "ls"})
        r2 = ExecutionResult(tool_name="shell", tool_input={"cmd": "ls"})
        assert r1.fingerprint() == r2.fingerprint()

    def test_fingerprint_different_inputs(self):
        """Different input = different fingerprint."""
        r1 = ExecutionResult(tool_name="shell", tool_input={"cmd": "ls"})
        r2 = ExecutionResult(tool_name="shell", tool_input={"cmd": "pwd"})
        assert r1.fingerprint() != r2.fingerprint()

    def test_fingerprint_different_tools(self):
        """Different tool = different fingerprint."""
        r1 = ExecutionResult(tool_name="shell", tool_input={"cmd": "ls"})
        r2 = ExecutionResult(tool_name="read", tool_input={"path": "ls"})
        assert r1.fingerprint() != r2.fingerprint()


# ---------------------------------------------------------------------------
# LspDiagnostic
# ---------------------------------------------------------------------------


class TestLspDiagnostic:
    """Test LSP diagnostic capture."""

    def test_creation(self):
        d = LspDiagnostic(
            file_path="main.py",
            line=42,
            message="Undefined variable 'foo'",
            severity="error",
            source="pyright",
        )
        assert d.file_path == "main.py"
        assert d.line == 42
        assert d.severity == "error"

    def test_frozen(self):
        d = LspDiagnostic()
        with pytest.raises(AttributeError):
            d.message = "changed"


# ---------------------------------------------------------------------------
# LoopDetector
# ---------------------------------------------------------------------------


class TestLoopDetector:
    """Test fingerprint-based loop detection."""

    def test_no_loop_on_different_calls(self):
        """Different tool calls should not trigger loop detection."""
        detector = LoopDetector(window_size=5, threshold=3)
        r1 = ExecutionResult(tool_name="shell", tool_input={"cmd": "ls"})
        r2 = ExecutionResult(tool_name="shell", tool_input={"cmd": "pwd"})

        assert detector.check(r1) is None
        assert detector.check(r2) is None

    def test_loop_detected_at_threshold(self):
        """Same call 3 times should trigger loop warning."""
        detector = LoopDetector(window_size=10, threshold=3)
        r = ExecutionResult(tool_name="shell", tool_input={"cmd": "ls"})

        assert detector.check(r) is None  # 1st
        assert detector.check(r) is None  # 2nd
        warning = detector.check(r)       # 3rd — trigger!
        assert warning is not None
        assert warning.repeat_count >= 3
        assert warning.tool_name == "shell"

    def test_loop_warning_fields(self):
        """LoopWarning should contain useful diagnostic info."""
        detector = LoopDetector(threshold=2)
        r = ExecutionResult(
            tool_name="search",
            tool_input={"query": "fibonacci"},
        )

        detector.check(r)
        warning = detector.check(r)

        assert warning is not None
        assert warning.tool_name == "search"
        assert warning.tool_input == {"query": "fibonacci"}
        assert warning.total_loops == 1

    def test_reset_clears_window(self):
        """Reset should clear the sliding window."""
        detector = LoopDetector(threshold=3)
        r = ExecutionResult(tool_name="shell", tool_input={"cmd": "ls"})

        detector.check(r)
        detector.check(r)
        detector.reset()

        # Should not trigger after reset
        assert detector.check(r) is None

    def test_window_size_limits_memory(self):
        """Old entries should be evicted when window is full."""
        detector = LoopDetector(window_size=3, threshold=3)

        # Fill window with different calls
        for i in range(5):
            r = ExecutionResult(tool_name="shell", tool_input={"cmd": f"cmd_{i}"})
            detector.check(r)

        # Now repeat one call — should NOT trigger because old entries evicted
        r = ExecutionResult(tool_name="shell", tool_input={"cmd": "cmd_0"})
        assert detector.check(r) is None  # Only 1 occurrence in window


# ---------------------------------------------------------------------------
# LoopWarning
# ---------------------------------------------------------------------------


class TestLoopWarning:
    def test_creation(self):
        w = LoopWarning(tool_name="shell", repeat_count=3, total_loops=1)
        assert w.tool_name == "shell"
        assert w.repeat_count == 3

    def test_frozen(self):
        w = LoopWarning()
        with pytest.raises(AttributeError):
            w.repeat_count = 5


# ---------------------------------------------------------------------------
# DiagnosticContext
# ---------------------------------------------------------------------------


class TestDiagnosticContext:
    """Test tracking of available vs missing data via format_for_llm."""

    def test_all_available(self):
        """When all data is present, missing should be empty."""
        result = ExecutionResult(stdout="ok", stderr="also ok")
        lsp = [LspDiagnostic(message="an error")]
        output = json.loads(format_for_llm(result, lsp_diagnostics=lsp))

        assert output["context"]["available"]["stdout"] is True
        assert output["context"]["available"]["stderr"] is True
        assert output["context"]["available"]["lsp_diagnostics"] is True
        assert output["context"]["missing"] == []

    def test_missing_stdout(self):
        """When stdout is empty, it should be noted in context."""
        result = ExecutionResult(stdout="", stderr="error msg", exit_code=1)
        output = json.loads(format_for_llm(result))

        assert output["context"]["available"]["stdout"] is False
        assert any("stdout" in m for m in output["context"]["missing"])

    def test_missing_lsp(self):
        """When no LSP diagnostics, it should be noted."""
        result = ExecutionResult(stdout="ok")
        output = json.loads(format_for_llm(result))

        assert output["context"]["available"]["lsp_diagnostics"] is False
        assert any("lsp" in m for m in output["context"]["missing"])


# ---------------------------------------------------------------------------
# format_for_llm
# ---------------------------------------------------------------------------


class TestFormatForLlm:
    """Test the main formatting function."""

    def test_basic_success(self):
        """Given a successful execution, When formatting, Then JSON has output and metadata."""
        result = success(stdout="Hello, World!", tool_name="shell")
        output = json.loads(format_for_llm(result))

        assert output["output"] == "Hello, World!"
        assert output["metadata"]["exit_code"] == 0
        assert output["metadata"]["tool"] == "shell"

    def test_basic_failure(self):
        """Given a failed execution, When formatting, Then stderr is in output."""
        result = failure(
            stderr="Error: file not found",
            exit_code=1,
            tool_name="read_file",
        )
        output = json.loads(format_for_llm(result))

        assert "Error: file not found" in output["output"]
        assert output["metadata"]["exit_code"] == 1

    def test_with_lsp_diagnostics(self):
        """Given LSP diagnostics, When formatting, They appear in output."""
        result = success(tool_name="edit_file")
        diagnostics = [
            LspDiagnostic(file_path="main.py", line=10, message="Undefined name 'x'"),
            LspDiagnostic(file_path="main.py", line=20, message="Type error"),
        ]
        output = json.loads(format_for_llm(result, lsp_diagnostics=diagnostics))

        assert "diagnostics" in output
        assert len(output["diagnostics"]) == 2
        assert output["diagnostics"][0]["file"] == "main.py"
        assert output["diagnostics"][0]["line"] == 10

    def test_with_loop_warning(self):
        """Given a loop warning, When formatting, It appears in output."""
        result = ExecutionResult(tool_name="shell", tool_input={"cmd": "ls"})
        warning = LoopWarning(
            tool_name="shell",
            tool_input={"cmd": "ls"},
            repeat_count=5,
            total_loops=1,
        )
        output = json.loads(format_for_llm(result, loop_warning=warning))

        assert "loop_warning" in output
        assert output["loop_warning"]["repeats"] == 5
        assert "different approach" in output["loop_warning"]["message"]

    def test_context_tracking(self):
        """The output should include context about what data is available."""
        result = ExecutionResult(stdout="output", exit_code=0)
        output = json.loads(format_for_llm(result))

        assert "context" in output
        assert "available" in output["context"]
        assert output["context"]["available"]["stdout"] is True
        assert output["context"]["available"]["lsp_diagnostics"] is False

    def test_context_missing_data(self):
        """When data is missing, it should be listed in context."""
        result = ExecutionResult(stderr="error only", exit_code=1)
        output = json.loads(format_for_llm(result))

        assert len(output["context"]["missing"]) > 0

    def test_truncation(self):
        """Long output should be truncated."""
        long_output = "x" * 20000
        result = ExecutionResult(stdout=long_output)
        output = json.loads(format_for_llm(result, max_output_chars=1000))

        assert len(output["output"]) < 1100  # 1000 + truncation message
        assert "truncated" in output["output"]

    def test_lsp_diagnostics_capped(self):
        """LSP diagnostics should be capped at max_diagnostics."""
        result = success()
        diagnostics = [LspDiagnostic(message=f"error {i}") for i in range(50)]
        output = json.loads(format_for_llm(result, lsp_diagnostics=diagnostics, max_diagnostics=20))

        assert len(output["diagnostics"]) == 20


# ---------------------------------------------------------------------------
# Convenience functions
# ---------------------------------------------------------------------------


class TestConvenienceFunctions:
    """Test success() and failure() helpers."""

    def test_success(self):
        r = success(stdout="ok", tool_name="shell", duration=0.5)
        assert r.succeeded is True
        assert r.stdout == "ok"
        assert r.duration_seconds == 0.5

    def test_failure(self):
        r = failure(stderr="err", exit_code=1, tool_name="shell")
        assert r.succeeded is False
        assert r.stderr == "err"
        assert r.exit_code == 1

    def test_success_default_tool_input(self):
        r = success()
        assert r.tool_input == {}

    def test_failure_default_tool_input(self):
        r = failure()
        assert r.tool_input == {}


# ---------------------------------------------------------------------------
# Integration: full diagnostic flow
# ---------------------------------------------------------------------------


class TestIntegration:
    """Test the complete diagnostic flow."""

    def test_full_flow_success(self):
        """Successful execution → clean JSON output."""
        result = success(
            stdout="4 files found",
            tool_name="shell",
            tool_input={"command": "find . -name '*.py'"},
            duration=0.3,
        )
        output = json.loads(format_for_llm(result))

        assert output["output"] == "4 files found"
        assert output["metadata"]["exit_code"] == 0
        assert output["metadata"]["duration_seconds"] == 0.3
        assert "diagnostics" not in output
        assert "loop_warning" not in output

    def test_full_flow_failure_with_lsp(self):
        """Failed edit with LSP diagnostics → comprehensive JSON output."""
        result = failure(
            stderr="SyntaxError: invalid syntax",
            tool_name="edit_file",
            tool_input={"path": "main.py"},
        )
        diagnostics = [
            LspDiagnostic(file_path="main.py", line=15, message="Expected ':'"),
        ]
        output = json.loads(format_for_llm(result, lsp_diagnostics=diagnostics))

        assert output["metadata"]["exit_code"] == 1
        assert len(output["diagnostics"]) == 1
        assert "Expected" in output["diagnostics"][0]["message"]

    def test_full_flow_loop_detection(self):
        """Repeated tool calls → loop warning in output."""
        detector = LoopDetector(threshold=3)
        results = []

        for _ in range(4):
            result = ExecutionResult(
                tool_name="search",
                tool_input={"query": "fibonacci python"},
            )
            warning = detector.check(result)
            results.append((result, warning))

        # 3rd and 4th should have warnings
        assert results[2][1] is not None
        assert results[3][1] is not None

        # Format the 4th call with its warning
        output = json.loads(format_for_llm(
            results[3][0],
            loop_warning=results[3][1],
        ))

        assert "loop_warning" in output
        assert output["loop_warning"]["repeats"] >= 3
