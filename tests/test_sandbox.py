"""Tests for the Sandbox module — safe execution environments for agents.

TDD approach: Write ONE test → implement → verify pass → repeat (vertical slices)
BDD style: Each test has a Given/When/Then docstring.
DDD style: Tests verify domain behavior through public interfaces only.

The Sandbox provides a controlled environment where agents can:
- Execute shell commands (exec)
- Read and write files
- List directories and search for files

Three implementations:
1. LocalSandbox — runs on the host machine (fast, used for development)
2. DockerSandbox — runs in a Docker container (safe, for production)
3. CloudSandbox — runs in the cloud (scalable, for heavy workloads)
"""

from __future__ import annotations

import os
import pytest
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from loopengine.execution.sandbox import (
    Sandbox,
    LocalSandbox,
    SandboxProvider,
    LocalSandboxProvider,
)


# ============================================================================
# Test 1: Sandbox Protocol — the interface contract
# ============================================================================

class TestSandboxProtocol:
    """Tests for the Sandbox Protocol definition."""

    def test_sandbox_protocol_exists(self):
        """Given the sandbox module, When imported, Then Sandbox protocol is available."""
        assert Sandbox is not None

    def test_local_sandbox_satisfies_protocol(self):
        """Given a LocalSandbox instance, When checked against Sandbox protocol,
        Then it satisfies the protocol."""
        sandbox = LocalSandbox()
        assert isinstance(sandbox, Sandbox)

    def test_sandbox_protocol_has_exec(self):
        """Given the Sandbox protocol, When inspected, Then it has exec method."""
        # Protocol methods are available via annotations
        import inspect
        hints = typing.get_type_hints(Sandbox.exec, include_extras=True)
        assert hints is not None


# ============================================================================
# Test 2: LocalSandbox.exec — run shell commands
# ============================================================================

class TestLocalSandboxExec:
    """Tests for LocalSandbox.exec — running shell commands."""

    @pytest.mark.asyncio
    async def test_exec_echo_command(self, work_dir):
        """Given a LocalSandbox, When I run 'echo hello',
        Then stdout is 'hello', stderr is empty, exit code is 0."""
        sandbox = LocalSandbox()
        stdout, stderr, exit_code = await sandbox.exec(
            command="echo hello",
            cwd=str(work_dir),
        )
        assert stdout.strip() == "hello"
        assert stderr == ""
        assert exit_code == 0

    @pytest.mark.asyncio
    async def test_exec_command_with_stderr(self, work_dir):
        """Given a LocalSandbox, When I run a command that writes to stderr,
        Then stderr contains the output and exit code is non-zero."""
        sandbox = LocalSandbox()
        stdout, stderr, exit_code = await sandbox.exec(
            command="echo error >&2 && exit 1",
            cwd=str(work_dir),
        )
        assert "error" in stderr
        assert exit_code == 1

    @pytest.mark.asyncio
    async def test_exec_command_returns_tuple(self, work_dir):
        """Given a LocalSandbox, When I exec a command,
        Then result is a tuple of (stdout, stderr, exit_code)."""
        sandbox = LocalSandbox()
        result = await sandbox.exec("echo test", cwd=str(work_dir))
        assert isinstance(result, tuple)
        assert len(result) == 3
        assert isinstance(result[0], str)  # stdout
        assert isinstance(result[1], str)  # stderr
        assert isinstance(result[2], int)  # exit_code

    @pytest.mark.asyncio
    async def test_exec_with_default_cwd(self):
        """Given a LocalSandbox, When I exec without specifying cwd,
        Then it runs in the current directory."""
        sandbox = LocalSandbox()
        stdout, stderr, exit_code = await sandbox.exec("pwd")
        assert exit_code == 0
        assert stdout.strip()  # Should have some path

    @pytest.mark.asyncio
    async def test_exec_with_timeout(self, work_dir):
        """Given a LocalSandbox, When I exec a slow command with short timeout,
        Then it times out (exit code indicates timeout or exception)."""
        sandbox = LocalSandbox()
        # sleep 10 should timeout with 1 second timeout
        with pytest.raises(asyncio.TimeoutError):
            await sandbox.exec("sleep 10", cwd=str(work_dir), timeout=0.1)


# ============================================================================
# Test 3: LocalSandbox.read_file / write_file — file operations
# ============================================================================

class TestLocalSandboxFileOps:
    """Tests for LocalSandbox file reading and writing."""

    @pytest.mark.asyncio
    async def test_write_and_read_file(self, work_dir):
        """Given a LocalSandbox, When I write a file and then read it,
        Then the content matches."""
        sandbox = LocalSandbox()
        file_path = str(work_dir / "test.txt")

        await sandbox.write_file(file_path, "Hello, World!")
        content = await sandbox.read_file(file_path)

        assert content == "Hello, World!"

    @pytest.mark.asyncio
    async def test_write_file_creates_parent_dirs(self, work_dir):
        """Given a LocalSandbox, When I write to a nested path,
        Then parent directories are created."""
        sandbox = LocalSandbox()
        file_path = str(work_dir / "subdir" / "nested" / "file.txt")

        await sandbox.write_file(file_path, "nested content")
        content = await sandbox.read_file(file_path)

        assert content == "nested content"

    @pytest.mark.asyncio
    async def test_read_nonexistent_file_raises(self, work_dir):
        """Given a LocalSandbox, When I read a file that doesn't exist,
        Then it raises FileNotFoundError."""
        sandbox = LocalSandbox()
        with pytest.raises(FileNotFoundError):
            await sandbox.read_file(str(work_dir / "nonexistent.txt"))

    @pytest.mark.asyncio
    async def test_write_file_overwrites_existing(self, work_dir):
        """Given a LocalSandbox, When I write to an existing file,
        Then the content is overwritten."""
        sandbox = LocalSandbox()
        file_path = str(work_dir / "overwrite.txt")

        await sandbox.write_file(file_path, "original")
        await sandbox.write_file(file_path, "updated")
        content = await sandbox.read_file(file_path)

        assert content == "updated"

    @pytest.mark.asyncio
    async def test_read_file_multiline(self, work_dir):
        """Given a LocalSandbox, When I write multiline content,
        Then read_file preserves all lines."""
        sandbox = LocalSandbox()
        file_path = str(work_dir / "multiline.txt")
        multiline = "line1\nline2\nline3"

        await sandbox.write_file(file_path, multiline)
        content = await sandbox.read_file(file_path)

        assert content == multiline


# ============================================================================
# Test 4: LocalSandbox.list_dir — directory listing
# ============================================================================

class TestLocalSandboxListDir:
    """Tests for LocalSandbox.list_dir — listing directory contents."""

    @pytest.mark.asyncio
    async def test_list_dir_returns_entries(self, work_dir):
        """Given a directory with files, When I list_dir,
        Then I get the file names."""
        sandbox = LocalSandbox()
        # Create some files
        (work_dir / "file1.txt").write_text("a")
        (work_dir / "file2.txt").write_text("b")

        entries = await sandbox.list_dir(str(work_dir))

        assert "file1.txt" in entries
        assert "file2.txt" in entries

    @pytest.mark.asyncio
    async def test_list_dir_includes_directories(self, work_dir):
        """Given a directory with subdirectories, When I list_dir,
        Then subdirectory names are included."""
        sandbox = LocalSandbox()
        (work_dir / "subdir").mkdir()

        entries = await sandbox.list_dir(str(work_dir))

        assert "subdir" in entries

    @pytest.mark.asyncio
    async def test_list_dir_empty_directory(self, work_dir):
        """Given an empty directory, When I list_dir,
        Then I get an empty list."""
        sandbox = LocalSandbox()
        empty_dir = work_dir / "empty"
        empty_dir.mkdir()

        entries = await sandbox.list_dir(str(empty_dir))

        assert entries == []

    @pytest.mark.asyncio
    async def test_list_dir_nonexistent_raises(self, work_dir):
        """Given a nonexistent directory, When I list_dir,
        Then it raises FileNotFoundError."""
        sandbox = LocalSandbox()
        with pytest.raises(FileNotFoundError):
            await sandbox.list_dir(str(work_dir / "nonexistent"))


# ============================================================================
# Test 5: LocalSandbox.glob_files — pattern matching
# ============================================================================

class TestLocalSandboxGlobFiles:
    """Tests for LocalSandbox.glob_files — finding files by pattern."""

    @pytest.mark.asyncio
    async def test_glob_finds_matching_files(self, work_dir):
        """Given a directory with .py files, When I glob '*.py',
        Then I get the matching file paths."""
        sandbox = LocalSandbox()
        (work_dir / "main.py").write_text("print('hi')")
        (work_dir / "utils.py").write_text("def helper(): pass")
        (work_dir / "readme.txt").write_text("docs")

        results = await sandbox.glob_files("*.py", str(work_dir))

        assert len(results) == 2
        assert any("main.py" in r for r in results)
        assert any("utils.py" in r for r in results)

    @pytest.mark.asyncio
    async def test_glob_returns_empty_for_no_match(self, work_dir):
        """Given a directory with no matching files, When I glob '*.xyz',
        Then I get an empty list."""
        sandbox = LocalSandbox()
        (work_dir / "file.txt").write_text("text")

        results = await sandbox.glob_files("*.xyz", str(work_dir))

        assert results == []

    @pytest.mark.asyncio
    async def test_glob_recursive_pattern(self, work_dir):
        """Given nested directories with .py files, When I glob '**/*.py',
        Then I get files from all subdirectories."""
        sandbox = LocalSandbox()
        subdir = work_dir / "sub"
        subdir.mkdir()
        (work_dir / "top.py").write_text("top")
        (subdir / "nested.py").write_text("nested")

        results = await sandbox.glob_files("**/*.py", str(work_dir))

        assert len(results) == 2
        assert any("top.py" in r for r in results)
        assert any("nested.py" in r for r in results)


# ============================================================================
# Test 6: LocalSandbox.grep_files — searching file contents
# ============================================================================

class TestLocalSandboxGrepFiles:
    """Tests for LocalSandbox.grep_files — searching for patterns in files."""

    @pytest.mark.asyncio
    async def test_grep_finds_matching_lines(self, work_dir):
        """Given files with content, When I grep for a pattern,
        Then I get the matching lines with file paths."""
        sandbox = LocalSandbox()
        (work_dir / "a.py").write_text("def hello():\n    return 'world'")
        (work_dir / "b.py").write_text("def goodbye():\n    return 'moon'")

        results = await sandbox.grep_files("hello", str(work_dir))

        assert len(results) >= 1
        assert any("hello" in r for r in results)

    @pytest.mark.asyncio
    async def test_grep_returns_empty_for_no_match(self, work_dir):
        """Given files, When I grep for a pattern that doesn't exist,
        Then I get an empty list."""
        sandbox = LocalSandbox()
        (work_dir / "a.py").write_text("print('hi')")

        results = await sandbox.grep_files("xyz_nonexistent", str(work_dir))

        assert results == []

    @pytest.mark.asyncio
    async def test_grep_with_regex_pattern(self, work_dir):
        """Given files, When I grep with a regex pattern,
        Then matching lines are returned."""
        sandbox = LocalSandbox()
        (work_dir / "code.py").write_text("import os\nimport sys\nfrom pathlib import Path")

        results = await sandbox.grep_files(r"^import", str(work_dir))

        assert len(results) >= 2


# ============================================================================
# Test 7: SandboxProvider Protocol and LocalSandboxProvider
# ============================================================================

class TestSandboxProvider:
    """Tests for SandboxProvider — managing sandbox lifecycles."""

    def test_sandbox_provider_protocol_exists(self):
        """Given the sandbox module, When imported, Then SandboxProvider protocol is available."""
        assert SandboxProvider is not None

    def test_local_sandbox_provider_satisfies_protocol(self):
        """Given a LocalSandboxProvider, When checked against SandboxProvider,
        Then it satisfies the protocol."""
        provider = LocalSandboxProvider()
        assert isinstance(provider, SandboxProvider)

    @pytest.mark.asyncio
    async def test_acquire_returns_sandbox(self):
        """Given a LocalSandboxProvider, When I acquire a sandbox,
        Then I get a Sandbox instance."""
        provider = LocalSandboxProvider()
        sandbox = await provider.acquire()
        assert isinstance(sandbox, Sandbox)

    @pytest.mark.asyncio
    async def test_acquire_returns_unique_instances(self):
        """Given a LocalSandboxProvider, When I acquire twice,
        Then I get different sandbox instances."""
        provider = LocalSandboxProvider()
        s1 = await provider.acquire()
        s2 = await provider.acquire()
        assert s1 is not s2

    @pytest.mark.asyncio
    async def test_release_returns_sandbox_to_pool(self):
        """Given a LocalSandboxProvider, When I acquire then release,
        Then the sandbox can be acquired again (pool recycling)."""
        provider = LocalSandboxProvider()
        s1 = await provider.acquire()
        await provider.release(s1)
        s2 = await provider.acquire()
        # In a pool, the released sandbox should be reused
        assert s1 is s2

    @pytest.mark.asyncio
    async def test_shutdown_cleans_up(self):
        """Given a LocalSandboxProvider, When I shutdown,
        Then all sandboxes are cleaned up."""
        provider = LocalSandboxProvider()
        await provider.acquire()
        await provider.acquire()
        # Should not raise
        await provider.shutdown()

    @pytest.mark.asyncio
    async def test_acquire_after_shutdown_raises(self):
        """Given a LocalSandboxProvider that's been shut down,
        When I try to acquire, Then it raises RuntimeError."""
        provider = LocalSandboxProvider()
        await provider.shutdown()
        with pytest.raises(RuntimeError):
            await provider.acquire()


# ============================================================================
# Test 8: LocalSandbox — functional test with real commands
# ============================================================================

class TestLocalSandboxIntegration:
    """Integration tests for LocalSandbox — full workflow scenarios."""

    @pytest.mark.asyncio
    async def test_full_workflow_exec_write_read(self, work_dir):
        """Given a LocalSandbox, When I write a Python file and execute it,
        Then I get the expected output."""
        sandbox = LocalSandbox()
        script_path = str(work_dir / "script.py")

        await sandbox.write_file(script_path, "print(2 + 2)")
        stdout, stderr, exit_code = await sandbox.exec(
            f"python3 {script_path}",
            cwd=str(work_dir),
        )

        assert exit_code == 0
        assert stdout.strip() == "4"

    @pytest.mark.asyncio
    async def test_list_dir_after_write(self, work_dir):
        """Given a LocalSandbox, When I write files and list the directory,
        Then the written files appear in the listing."""
        sandbox = LocalSandbox()

        await sandbox.write_file(str(work_dir / "a.txt"), "content_a")
        await sandbox.write_file(str(work_dir / "b.txt"), "content_b")

        entries = await sandbox.list_dir(str(work_dir))

        assert "a.txt" in entries
        assert "b.txt" in entries


# Need to import asyncio for TimeoutError in test
import asyncio
import typing
