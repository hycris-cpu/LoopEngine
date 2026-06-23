"""Bundles are pre-composed capability sets — "starter packs" for common use cases.

Plain English: If plugins are LEGO kits, bundles are the pre-built models
on the box cover. Instead of picking individual pieces, you grab a bundle:
- make_coding(): Everything you need for a coding agent
- make_reliability(): Safety nets and loop detection
- make_evaluation(): Judges and metrics
- make_self_improve(): Evolution capabilities

You compose bundles with the | operator:
  config = (make_coding() | make_reliability()).build()
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from loopengine.primitives.events import Event
from loopengine.primitives.processors import MultiHookProcessor

from .builder import HarnessBuilder


# ---------------------------------------------------------------------------
# Stub (placeholder) processors — real implementations come later
# ---------------------------------------------------------------------------


class _StubProcessor(MultiHookProcessor):
    """A placeholder processor that passes all events through unchanged.

    Plain English: This is a "coming soon" sign. The bundle functions need
    processors to register, but the real implementations live in the
    processors/ directory (built later). These stubs ensure the configs
    are structurally valid without any behavioral logic.
    """

    def __init__(self, name: str, hook: str = "step_end") -> None:
        """Initialize with a descriptive name.

        Args:
            name: Human-readable name (e.g., "coding.planner").
            hook: The hook point this processor is meant for.
        """
        super().__init__(name=name)
        self._hook = hook


class _StubTool:
    """A placeholder tool that satisfies the Tool Protocol.

    Used by bundles to provide structural completeness.
    Real tool implementations live in the tools/ directory.
    """

    def __init__(self, name: str, description: str = "") -> None:
        self._name = name
        self._description = description or f"Stub tool: {name}"

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def input_schema(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, input: dict[str, Any], ctx: Any) -> Any:
        """No-op execution — stubs never run in production."""
        raise NotImplementedError("StubTool is a placeholder; use a real implementation.")


# ---------------------------------------------------------------------------
# make_coding — starter pack for coding agents
# ---------------------------------------------------------------------------


def make_coding(working_dir: str = ".") -> HarnessBuilder:
    """Create a builder pre-configured for coding tasks.

    Plain English: This is the "coding agent starter pack." It sets up:
    - A planner processor (to decompose coding tasks)
    - A file editor tool (to modify code)
    - A code runner tool (to execute and test code)
    - Flags for code-aware features
    - A working directory slot

    Args:
        working_dir: The directory where code lives (default: current dir).

    Returns:
        A HarnessBuilder with coding capabilities pre-loaded.
    """
    builder = HarnessBuilder()

    # Processors
    builder = builder.add(
        _StubProcessor("coding.planner", "before_model"),
        hook="before_model",
        order=-10,
    )
    builder = builder.add(
        _StubProcessor("coding.patcher", "after_tool"),
        hook="after_tool",
        order=0,
    )

    # Tools
    builder = builder.tool(_StubTool("file_editor", "Edit source files in the working directory"))
    builder = builder.tool(_StubTool("code_runner", "Execute code and capture output"))
    builder = builder.tool(_StubTool("test_runner", "Run test suites and report results"))

    # Flags
    builder = builder.flag("coding.patch_apply", enabled=True)
    builder = builder.flag("coding.auto_test", enabled=True)

    # Slots
    builder = builder.slot(working_dir=working_dir)

    return builder


# ---------------------------------------------------------------------------
# make_reliability — safety nets and loop detection
# ---------------------------------------------------------------------------


def make_reliability() -> HarnessBuilder:
    """Create a builder with loop detection and safety guards.

    Plain English: This is the "safety net bundle." It adds:
    - A loop detector (to catch the agent repeating itself)
    - A budget guard (to prevent runaway token usage)
    - A timeout enforcer (to prevent hung steps)
    - Safety-related flags

    Returns:
        A HarnessBuilder with reliability capabilities pre-loaded.
    """
    builder = HarnessBuilder()

    # Processors
    builder = builder.add(
        _StubProcessor("reliability.loop_detector", "step_end"),
        hook="step_end",
        order=10,
    )
    builder = builder.add(
        _StubProcessor("reliability.budget_guard", "step_start"),
        hook="step_start",
        order=-10,
    )

    # Flags
    builder = builder.flag("reliability.loop_detection", enabled=True)
    builder = builder.flag("reliability.guard_enabled", enabled=True)
    builder = builder.flag("reliability.max_retries", enabled=True)

    return builder


# ---------------------------------------------------------------------------
# make_evaluation — judges and metrics
# ---------------------------------------------------------------------------


def make_evaluation() -> HarnessBuilder:
    """Create a builder with evaluation processors.

    Plain English: This is the "judge bundle." It adds:
    - A step evaluator (to score each step)
    - A task evaluator (to score the final result)
    - Evaluation flags

    Returns:
        A HarnessBuilder with evaluation capabilities pre-loaded.
    """
    builder = HarnessBuilder()

    # Processors
    builder = builder.add(
        _StubProcessor("evaluation.step_judge", "step_end"),
        hook="step_end",
        order=5,
    )
    builder = builder.add(
        _StubProcessor("evaluation.task_judge", "task_end"),
        hook="task_end",
        order=0,
    )

    # Flags
    builder = builder.flag("eval.step_scoring", enabled=True)
    builder = builder.flag("eval.task_scoring", enabled=True)

    return builder


# ---------------------------------------------------------------------------
# make_self_improve — evolution capabilities
# ---------------------------------------------------------------------------


def make_self_improve() -> HarnessBuilder:
    """Create a builder with self-improvement / evolution capabilities.

    Plain English: This is the "evolution bundle." It adds:
    - A strategy selector (to pick improvement strategies)
    - A code modifier (to apply self-improvements)
    - Evolution flags

    Returns:
        A HarnessBuilder with evolution capabilities pre-loaded.
    """
    builder = HarnessBuilder()

    # Processors
    builder = builder.add(
        _StubProcessor("evolution.strategy_selector", "task_start"),
        hook="task_start",
        order=0,
    )
    builder = builder.add(
        _StubProcessor("evolution.code_modifier", "task_end"),
        hook="task_end",
        order=10,
    )

    # Flags
    builder = builder.flag("evolution.enabled", enabled=True)
    builder = builder.flag("evolution.auto_promote", enabled=False)

    return builder
