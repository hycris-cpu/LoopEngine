"""The Harness ties everything together — it's the "agent" you actually use.

Plain English: If the RunLoop is the engine, the Harness is the complete car.
It combines:
- A model (the driver)
- A config (the blueprint)
- A sandbox (the road)

You create a Harness, then call it with a task to get a result.
It's the top-level API that users interact with.

Usage:
    # Create from a builder
    builder = make_coding() | make_reliability()
    harness = Harness.from_builder(builder, model=my_model)

    # Run a single task
    result = await harness.run(task)

    # Run a batch of tasks
    results = await harness.run_batch(tasks, parallelism=4)
"""

from __future__ import annotations

import asyncio
from typing import Any

from loopengine.execution.runloop import RunResult, ModelProvider, run_loop

# ---------------------------------------------------------------------------
# Try to import Task and Sandbox from the execution layer.
# If they don't exist yet, define minimal stubs.
# ---------------------------------------------------------------------------

try:
    from loopengine.execution.task import Task
except ImportError:
    from typing import Protocol as _Protocol
    from loopengine.primitives.state import Budget, State

    class Task(_Protocol):  # type: ignore[no-redef]
        """Stub Task protocol — replaced when task.py is built."""

        @property
        def prompt(self) -> str: ...

        @property
        def max_steps(self) -> int: ...

        @property
        def budget(self) -> Budget: ...

        def is_done(self, state: State) -> bool: ...


try:
    from loopengine.execution.sandbox import Sandbox
except ImportError:
    pass  # Sandbox is optional


# ---------------------------------------------------------------------------
# Harness — the main user-facing class
# ---------------------------------------------------------------------------


class Harness:
    """The complete agent — top-level API for running tasks.

    Plain English: A Harness is like a self-driving car. You give it:
    - A model (the driver's brain)
    - A config (the car's setup — sensors, safety systems, etc.)
    - Optionally a sandbox (the road environment)

    Then you call harness.run(task) and it drives the task to completion,
    returning a RunResult with everything that happened.

    The Harness is the ONLY class most users need. It hides the complexity
    of the RunLoop, processors, and state management behind a clean API.

    Attributes:
        model: The language model provider.
        config: The HarnessConfig with processors and tools.
        sandbox: Optional sandboxed execution environment.
    """

    def __init__(
        self,
        model: ModelProvider,
        config: Any = None,
        sandbox: Any = None,
    ) -> None:
        """Initialize a Harness.

        Args:
            model: The language model provider (OpenAI, Anthropic, etc.).
            config: A HarnessConfig with processors, tools, flags, and slots.
            sandbox: Optional sandboxed execution environment.
        """
        self.model = model
        self.config = config
        self.sandbox = sandbox

    async def run(self, task: Task, run_id: str | None = None) -> RunResult:
        """Execute a single task and return the result.

        Plain English: "Hey agent, here's your assignment. Go!"
        The Harness delegates to run_loop, which handles all the
        step-by-step complexity.

        Args:
            task: The task to execute.
            run_id: Optional unique identifier for this run.

        Returns:
            A RunResult with the trajectory, evaluation, and statistics.
        """
        return await run_loop(
            task=task,
            model=self.model,
            config=self.config,
            sandbox=self.sandbox,
            run_id=run_id,
        )

    async def run_batch(
        self,
        tasks: list[Task],
        parallelism: int = 1,
    ) -> list[RunResult]:
        """Run multiple tasks, optionally in parallel.

        Plain English: "Hey agent, here's a stack of assignments.
        Work through them, maybe with some friends helping."
        parallelism=1 means one at a time (sequential).
        parallelism=4 means up to 4 tasks running at once.

        Args:
            tasks: The list of tasks to execute.
            parallelism: Maximum number of concurrent tasks (default: 1).

        Returns:
            A list of RunResults, one per task, in the same order as input.
        """
        if parallelism <= 1:
            # Sequential execution
            results: list[RunResult] = []
            for task in tasks:
                result = await self.run(task)
                results.append(result)
            return results

        # Parallel execution with semaphore-based concurrency control
        semaphore = asyncio.Semaphore(parallelism)

        async def _run_with_semaphore(task: Task) -> RunResult:
            async with semaphore:
                return await self.run(task)

        return await asyncio.gather(
            *[_run_with_semaphore(task) for task in tasks]
        )

    @classmethod
    def from_builder(
        cls,
        builder: Any,
        model: ModelProvider,
        sandbox: Any = None,
    ) -> Harness:
        """Create a Harness from a HarnessBuilder (convenience factory).

        Plain English: Instead of manually assembling a config, you can
        use a builder (which has a nice fluent API) and convert it to
        a Harness in one step.

        Args:
            builder: A HarnessBuilder instance.
            model: The language model provider.
            sandbox: Optional sandboxed execution environment.

        Returns:
            A new Harness configured from the builder's blueprint.
        """
        config = builder.build()
        return cls(model=model, config=config, sandbox=sandbox)

    def __repr__(self) -> str:
        """Human-readable representation for debugging."""
        model_name = type(self.model).__name__
        has_config = self.config is not None
        has_sandbox = self.sandbox is not None
        return (
            f"Harness(model={model_name}, "
            f"config={'yes' if has_config else 'no'}, "
            f"sandbox={'yes' if has_sandbox else 'no'})"
        )
