"""
Shared test fixtures and mock implementations for the entire LoopEngine test suite.

Think of this file as a "test kitchen" — it preps all the ingredients (fixtures)
that every test file needs, so each test can focus on its specific recipe (behavior)
without worrying about setup details.
"""

import asyncio
import uuid
import time
import pytest
from unittest.mock import AsyncMock, MagicMock
from typing import Any

# We import from the actual package once modules exist.
# Agents implementing each module will make these imports work.
# For now, we use try/except so the conftest loads even before all modules exist.


# ---------------------------------------------------------------------------
# FIXTURE: Unique run_id and step_id generators
# ---------------------------------------------------------------------------

@pytest.fixture
def run_id() -> str:
    """Generate a unique run ID for test isolation.
    Each test gets its own run_id so events from different tests never collide."""
    return str(uuid.uuid4())


@pytest.fixture
def step_id() -> int:
    """Start step counter at 0 for each test."""
    return 0


@pytest.fixture
def now() -> float:
    """Provide a consistent timestamp for deterministic tests."""
    return time.time()


# ---------------------------------------------------------------------------
# FIXTURE: Mock Model Provider
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_model_provider():
    """
    A fake LLM provider that returns canned responses.

    Real-world analogy: This is like a stand-in actor in a rehearsal.
    The real actor (Claude, GPT, etc.) isn't available for unit tests,
    so we use this double that responds with predictable lines.
    """
    provider = AsyncMock()
    provider.complete = AsyncMock(return_value=None)  # Agents set return values
    provider.count_tokens = MagicMock(return_value=100)
    return provider


# ---------------------------------------------------------------------------
# FIXTURE: Mock Sandbox
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_sandbox():
    """
    A fake sandbox (execution environment) for testing.

    Real-world analogy: Instead of running code on a real computer (slow, risky),
    we use this "pretend computer" that gives back the answers we pre-program.
    """
    sandbox = AsyncMock()
    sandbox.exec = AsyncMock(return_value=("", "", 0))  # (stdout, stderr, exit_code)
    sandbox.read_file = AsyncMock(return_value="")
    sandbox.write_file = AsyncMock()
    sandbox.list_dir = AsyncMock(return_value=[])
    sandbox.glob_files = AsyncMock(return_value=[])
    sandbox.grep_files = AsyncMock(return_value=[])
    return sandbox


# ---------------------------------------------------------------------------
# FIXTURE: Temp working directory
# ---------------------------------------------------------------------------

@pytest.fixture
def work_dir(tmp_path):
    """
    A temporary directory that gets cleaned up after the test.
    Use this instead of touching the real filesystem.
    """
    return tmp_path


# ---------------------------------------------------------------------------
# HELPERS: Async test utilities
# ---------------------------------------------------------------------------

async def collect_async(gen):
    """
    Collect all items from an async generator into a list.

    Why we need this: Processors yield events one at a time via `async yield`.
    In tests, we want to grab ALL yielded events to inspect them.
    This helper does that collecting for us.
    """
    return [item async for item in gen]
