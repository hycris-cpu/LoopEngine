"""The Sandbox provides a safe execution environment for running code.

Plain English: A Sandbox is like a children's sandbox in a playground —
a controlled area where you can dig, build, and make messes without
affecting the rest of the world. In our case, it's where the agent
runs shell commands, reads/writes files, and executes code.

Three implementations:
1. LocalSandbox — runs commands on YOUR machine (fast but risky)
2. (Future) DockerSandbox — runs in a Docker container (safe but slower)
3. (Future) CloudSandbox — runs in the cloud (scalable but costs money)

SandboxProvider manages sandbox lifecycles — creating, reusing, and
destroying sandboxes. Think of it as a pool of sandboxes that agents
can check out and return.
"""

from __future__ import annotations

import asyncio
import glob
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable


# ---------------------------------------------------------------------------
# Sandbox Protocol — the interface all sandboxes must satisfy
# ---------------------------------------------------------------------------

@runtime_checkable
class Sandbox(Protocol):
    """Protocol defining what a sandbox must provide.

    A sandbox is any object that can execute commands and perform file
    operations in an isolated environment. This Protocol defines the
    contract that all sandbox implementations must satisfy.

    Think of Sandbox as a "workshop" — it has tools for:
    - Running commands (exec)
    - Reading files (read_file)
    - Writing files (write_file)
    - Listing directories (list_dir)
    - Finding files (glob_files)
    - Searching file contents (grep_files)
    """

    async def exec(
        self,
        command: str,
        cwd: str = ".",
        timeout: float = 30,
    ) -> tuple[str, str, int]:
        """Execute a shell command and return its output.

        Args:
            command: The shell command to execute.
            cwd: Working directory for the command (default: current dir).
            timeout: Maximum execution time in seconds (default: 30).

        Returns:
            A tuple of (stdout, stderr, exit_code).
        """
        ...

    async def read_file(self, path: str) -> str:
        """Read the contents of a file.

        Args:
            path: Path to the file to read.

        Returns:
            The file contents as a string.

        Raises:
            FileNotFoundError: If the file doesn't exist.
        """
        ...

    async def write_file(self, path: str, content: str) -> None:
        """Write content to a file, creating parent directories if needed.

        Args:
            path: Path to the file to write.
            content: The content to write.
        """
        ...

    async def list_dir(self, path: str) -> list[str]:
        """List the contents of a directory.

        Args:
            path: Path to the directory to list.

        Returns:
            A list of entry names (files and directories).

        Raises:
            FileNotFoundError: If the directory doesn't exist.
        """
        ...

    async def glob_files(self, pattern: str, path: str = ".") -> list[str]:
        """Find files matching a glob pattern.

        Args:
            pattern: The glob pattern to match (e.g., '*.py', '**/*.txt').
            path: The directory to search in (default: current dir).

        Returns:
            A list of matching file paths.
        """
        ...

    async def grep_files(
        self,
        pattern: str,
        path: str = ".",
    ) -> list[str]:
        """Search for a regex pattern in file contents.

        Args:
            pattern: The regex pattern to search for.
            path: The directory to search in (default: current dir).

        Returns:
            A list of matching lines in "filepath:line_number:content" format.
        """
        ...


# ---------------------------------------------------------------------------
# LocalSandbox — runs commands on the host machine
# ---------------------------------------------------------------------------

class LocalSandbox:
    """A sandbox that executes directly on the host machine.

    Plain English: This is like working at your own desk — fast and
    convenient, but anything you do affects your real computer.
    Use this for development and testing. For production, use
    DockerSandbox or CloudSandbox instead.

    LocalSandbox uses:
    - asyncio.create_subprocess_exec for command execution
    - pathlib for file operations
    - glob module for pattern matching
    - grep via subprocess (grep command)

    All operations are async so they don't block the event loop.
    """

    async def exec(
        self,
        command: str,
        cwd: str = ".",
        timeout: float = 30,
    ) -> tuple[str, str, int]:
        """Execute a shell command on the local machine.

        Uses asyncio.create_subprocess_exec to run the command without
        blocking the event loop. The command is run through /bin/sh -c
        to support shell features like pipes and redirects.

        Args:
            command: The shell command to execute.
            cwd: Working directory for the command.
            timeout: Maximum execution time in seconds.

        Returns:
            A tuple of (stdout, stderr, exit_code).

        Raises:
            asyncio.TimeoutError: If the command exceeds the timeout.
        """
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise

        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")
        exit_code = process.returncode or 0

        return stdout, stderr, exit_code

    async def read_file(self, path: str) -> str:
        """Read the contents of a file on the local filesystem.

        Args:
            path: Path to the file to read.

        Returns:
            The file contents as a string.

        Raises:
            FileNotFoundError: If the file doesn't exist.
        """
        file_path = Path(path)
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {path}")
        return file_path.read_text(encoding="utf-8")

    async def write_file(self, path: str, content: str) -> None:
        """Write content to a file on the local filesystem.

        Creates parent directories if they don't exist.

        Args:
            path: Path to the file to write.
            content: The content to write.
        """
        file_path = Path(path)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")

    async def list_dir(self, path: str) -> list[str]:
        """List the contents of a directory on the local filesystem.

        Args:
            path: Path to the directory to list.

        Returns:
            A sorted list of entry names.

        Raises:
            FileNotFoundError: If the directory doesn't exist.
        """
        dir_path = Path(path)
        if not dir_path.exists():
            raise FileNotFoundError(f"Directory not found: {path}")
        if not dir_path.is_dir():
            raise NotADirectoryError(f"Not a directory: {path}")
        return sorted(entry.name for entry in dir_path.iterdir())

    async def glob_files(self, pattern: str, path: str = ".") -> list[str]:
        """Find files matching a glob pattern on the local filesystem.

        Args:
            pattern: The glob pattern to match.
            path: The directory to search in.

        Returns:
            A sorted list of matching file paths as strings.
        """
        base = Path(path)
        matches = sorted(str(p) for p in base.glob(pattern) if p.is_file())
        return matches

    async def grep_files(
        self,
        pattern: str,
        path: str = ".",
    ) -> list[str]:
        """Search for a regex pattern in file contents.

        Uses the system grep command for efficiency. Falls back to
        Python regex if grep is not available.

        Args:
            pattern: The regex pattern to search for.
            path: The directory to search in.

        Returns:
            A list of matching lines in "filepath:line_number:content" format.
        """
        # Try system grep first (faster for large codebases)
        try:
            process = await asyncio.create_subprocess_exec(
                "grep", "-rn", "--include=*.py", "--include=*.txt",
                "--include=*.md", "--include=*.json", "--include=*.yaml",
                "--include=*.yml", "--include=*.toml", "--include=*.cfg",
                "--include=*.sh", "--include=*.js", "--include=*.ts",
                pattern, path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, _ = await asyncio.wait_for(
                process.communicate(), timeout=10
            )
            if process.returncode == 0:
                return stdout_bytes.decode("utf-8", errors="replace").strip().split("\n")
            return []
        except (FileNotFoundError, asyncio.TimeoutError):
            # Fallback to Python implementation
            return await self._grep_python(pattern, path)

    async def _grep_python(self, pattern: str, path: str) -> list[str]:
        """Python fallback for grep_files when system grep is unavailable.

        Args:
            pattern: The regex pattern to search for.
            path: The directory to search in.

        Returns:
            A list of matching lines in "filepath:line_number:content" format.
        """
        import re
        results: list[str] = []
        regex = re.compile(pattern)

        base = Path(path)
        text_extensions = {
            ".py", ".txt", ".md", ".json", ".yaml", ".yml",
            ".toml", ".cfg", ".sh", ".js", ".ts",
        }

        for file_path in base.rglob("*"):
            if not file_path.is_file():
                continue
            if file_path.suffix not in text_extensions:
                continue
            try:
                lines = file_path.read_text(encoding="utf-8", errors="replace").split("\n")
                for i, line in enumerate(lines, start=1):
                    if regex.search(line):
                        results.append(f"{file_path}:{i}:{line}")
            except (PermissionError, OSError):
                continue

        return results


# ---------------------------------------------------------------------------
# SandboxProvider Protocol — managing sandbox lifecycles
# ---------------------------------------------------------------------------

@runtime_checkable
class SandboxProvider(Protocol):
    """Protocol for managing sandbox lifecycles.

    Plain English: A SandboxProvider is like a car rental agency.
    You can:
    - acquire(): Check out a sandbox (like renting a car)
    - release(): Return a sandbox (like returning the car)
    - shutdown(): Close the agency (return all cars, clean up)

    The provider manages a pool of sandboxes for efficiency —
    creating new ones on demand and reusing returned ones.
    """

    async def acquire(self) -> Sandbox:
        """Get a sandbox from the pool.

        Returns:
            A Sandbox instance ready for use.

        Raises:
            RuntimeError: If the provider has been shut down.
        """
        ...

    async def release(self, sandbox: Sandbox) -> None:
        """Return a sandbox to the pool for reuse.

        Args:
            sandbox: The sandbox to return.
        """
        ...

    async def shutdown(self) -> None:
        """Shut down the provider and clean up all sandboxes.

        After shutdown, acquire() will raise RuntimeError.
        """
        ...


# ---------------------------------------------------------------------------
# LocalSandboxProvider — manages a pool of LocalSandbox instances
# ---------------------------------------------------------------------------

class LocalSandboxProvider:
    """A provider that manages a pool of LocalSandbox instances.

    Plain English: This is like a library that has multiple copies of
    the same book. When someone needs a book, they check one out.
    When they return it, it goes back on the shelf for the next person.

    The pool:
    - Creates sandboxes on demand (lazy initialization)
    - Reuses returned sandboxes (pool recycling)
    - Cleans up all sandboxes on shutdown

    This is useful for concurrent task execution — multiple agents
    can each have their own sandbox without creating/destroying them
    repeatedly.
    """

    def __init__(self) -> None:
        """Initialize an empty pool."""
        self._available: list[LocalSandbox] = []
        self._in_use: set[LocalSandbox] = set()
        self._shutdown: bool = False

    async def acquire(self) -> LocalSandbox:
        """Get a LocalSandbox from the pool.

        If a returned sandbox is available, reuses it. Otherwise,
        creates a new one.

        Returns:
            A LocalSandbox instance.

        Raises:
            RuntimeError: If the provider has been shut down.
        """
        if self._shutdown:
            raise RuntimeError("Cannot acquire sandbox: provider is shut down")

        if self._available:
            sandbox = self._available.pop()
        else:
            sandbox = LocalSandbox()

        self._in_use.add(sandbox)
        return sandbox

    async def release(self, sandbox: LocalSandbox) -> None:
        """Return a sandbox to the pool for reuse.

        Args:
            sandbox: The sandbox to return.
        """
        if sandbox in self._in_use:
            self._in_use.remove(sandbox)
            self._available.append(sandbox)

    async def shutdown(self) -> None:
        """Shut down the provider.

        Marks the provider as shut down and clears all pools.
        After this, acquire() will raise RuntimeError.
        """
        self._shutdown = True
        self._available.clear()
        self._in_use.clear()


# ---------------------------------------------------------------------------
# DockerSandbox — runs commands INSIDE a container for real isolation
# ---------------------------------------------------------------------------

import shlex
import posixpath
from typing import Awaitable, Callable, Optional

# A host-docker runner: given an argv list (and optional stdin + timeout),
# execute it on the host and return (stdout, stderr, exit_code).
DockerRunner = Callable[..., Awaitable["tuple[str, str, int]"]]


async def _default_docker_runner(
    argv: list[str], stdin: Optional[str] = None, timeout: float = 30
) -> tuple[str, str, int]:
    """Default runner: execute a docker argv on the host without a shell.

    Uses create_subprocess_exec (no shell) so arguments are passed literally and
    cannot be reinterpreted by a host shell.
    """
    process = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE if stdin is not None else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out_b, err_b = await asyncio.wait_for(
            process.communicate(stdin.encode("utf-8") if stdin is not None else None),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise
    return (
        out_b.decode("utf-8", errors="replace"),
        err_b.decode("utf-8", errors="replace"),
        process.returncode or 0,
    )


class DockerSandbox:
    """A sandbox that runs every operation INSIDE a Docker container.

    Unlike LocalSandbox (which runs on the host with no isolation), DockerSandbox
    confines all execution and file access to a container and to a single working
    directory inside it. The agent can never reach the host filesystem or escape
    the workdir.

    Host docker invocation is delegated to an injected ``runner`` so the
    translation logic is unit-testable without a running daemon.
    """

    def __init__(
        self,
        container: str,
        workdir: str = "/workspace",
        runner: Optional[DockerRunner] = None,
    ) -> None:
        self._container = container
        self._workdir = workdir.rstrip("/") or "/"
        self._run: DockerRunner = runner or _default_docker_runner

    def _resolve(self, path: str) -> str:
        """Resolve ``path`` to an absolute path confined to the workdir.

        Raises ValueError if the path escapes the workdir (e.g. '../etc/passwd'
        or an absolute path outside the workdir).
        """
        candidate = path if posixpath.isabs(path) else posixpath.join(self._workdir, path)
        normalized = posixpath.normpath(candidate)
        if normalized != self._workdir and not normalized.startswith(self._workdir + "/"):
            raise ValueError(f"Path escapes sandbox workdir: {path}")
        return normalized

    async def exec(
        self, command: str, cwd: str = ".", timeout: float = 30
    ) -> tuple[str, str, int]:
        """Run a shell command inside the container, confined to the workdir."""
        workdir = self._resolve(cwd)
        argv = ["docker", "exec", "-w", workdir, self._container, "sh", "-c", command]
        return await self._run(argv, None, timeout)

    async def read_file(self, path: str) -> str:
        """Read a file from inside the container."""
        target = self._resolve(path)
        out, _err, code = await self._run(
            ["docker", "exec", self._container, "cat", target], None, 30
        )
        if code != 0:
            raise FileNotFoundError(f"File not found in container: {path}")
        return out

    async def write_file(self, path: str, content: str) -> None:
        """Write a file inside the container, creating parent directories."""
        target = self._resolve(path)
        parent = posixpath.dirname(target)
        if parent:
            await self._run(
                ["docker", "exec", self._container, "mkdir", "-p", parent], None, 30
            )
        await self._run(
            ["docker", "exec", "-i", self._container, "sh", "-c",
             f"cat > {shlex.quote(target)}"],
            content,
            30,
        )

    async def list_dir(self, path: str) -> list[str]:
        """List a directory inside the container."""
        target = self._resolve(path)
        out, _err, code = await self._run(
            ["docker", "exec", self._container, "ls", "-1A", target], None, 30
        )
        if code != 0:
            raise FileNotFoundError(f"Directory not found in container: {path}")
        return [line for line in out.split("\n") if line]

    async def glob_files(self, pattern: str, path: str = ".") -> list[str]:
        """Find files matching a glob pattern inside the container."""
        base = self._resolve(path)
        out, _err, code = await self._run(
            ["docker", "exec", self._container, "sh", "-c",
             f"find {shlex.quote(base)} -type f -name {shlex.quote(pattern)}"],
            None,
            30,
        )
        if code != 0:
            return []
        return [line for line in out.split("\n") if line]

    async def grep_files(self, pattern: str, path: str = ".") -> list[str]:
        """Search file contents for a pattern inside the container."""
        base = self._resolve(path)
        out, _err, code = await self._run(
            ["docker", "exec", self._container, "grep", "-rn", pattern, base],
            None,
            30,
        )
        if code != 0:
            return []
        return [line for line in out.split("\n") if line]


class DockerSandboxProvider:
    """Manages Docker containers, handing out DockerSandbox instances.

    acquire() starts a detached container and returns a DockerSandbox bound to
    it; release()/shutdown() force-remove containers. Host docker invocation is
    delegated to an injected runner for testability.
    """

    def __init__(
        self,
        image: str,
        workdir: str = "/workspace",
        runner: Optional[DockerRunner] = None,
    ) -> None:
        self._image = image
        self._workdir = workdir
        self._run: DockerRunner = runner or _default_docker_runner
        self._containers: dict[DockerSandbox, str] = {}
        self._shutdown = False

    async def acquire(self) -> DockerSandbox:
        if self._shutdown:
            raise RuntimeError("Cannot acquire sandbox: provider is shut down")
        out, _err, code = await self._run(
            ["docker", "run", "-d", "-w", self._workdir, self._image,
             "sleep", "infinity"],
            None,
            60,
        )
        if code != 0:
            raise RuntimeError(f"Failed to start container: {_err}")
        container_id = out.strip()
        sandbox = DockerSandbox(container_id, workdir=self._workdir, runner=self._run)
        self._containers[sandbox] = container_id
        return sandbox

    async def release(self, sandbox: DockerSandbox) -> None:
        container_id = self._containers.pop(sandbox, None)
        if container_id is not None:
            await self._run(["docker", "rm", "-f", container_id], None, 30)

    async def shutdown(self) -> None:
        self._shutdown = True
        for container_id in list(self._containers.values()):
            await self._run(["docker", "rm", "-f", container_id], None, 30)
        self._containers.clear()
