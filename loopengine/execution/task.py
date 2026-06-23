"""A Task defines WHAT the agent should accomplish.

Plain English: A Task is like a homework assignment. It has:
- prompt: The question or problem to solve
- max_steps: How many attempts you get
- budget: How many resources (tokens, money) you can spend
- is_done(): A way to check if you're finished
- evaluate(): A way to grade your work

SimpleTask is the basic implementation. You give it a prompt and
optionally an evaluation function, and it handles the rest.

BatchTask wraps multiple tasks for benchmark runs — like running
a full exam instead of a single question.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Protocol, runtime_checkable

from loopengine.primitives.events import EvalResult
from loopengine.primitives.state import Budget, State
from loopengine.primitives.trajectory import Trajectory


# ---------------------------------------------------------------------------
# Task Protocol — the interface all tasks must satisfy
# ---------------------------------------------------------------------------

@runtime_checkable
class Task(Protocol):
    """Protocol defining what a task must provide.

    A Task is the "assignment" that the agent works on. It tells the agent:
    - What to do (prompt)
    - How long it has (max_steps, budget)
    - When it's done (is_done)
    - How well it did (evaluate)

    Think of Task as a teacher handing out a worksheet:
    - prompt: the instructions at the top
    - max_steps: how many questions you can attempt
    - budget: how much paper/pencil you can use
    - is_done(): "Have you answered all the questions?"
    - evaluate(): "Let me grade your work"
    """

    @property
    def prompt(self) -> str:
        """The instructions or problem statement for this task."""
        ...

    @property
    def max_steps(self) -> int:
        """Maximum number of reasoning steps allowed."""
        ...

    @property
    def budget(self) -> Budget:
        """Resource limits (tokens, cost) for this task."""
        ...

    def is_done(self, state: State) -> bool:
        """Check if the task is complete given the current state.

        Args:
            state: The current agent state.

        Returns:
            True if the task is complete, False otherwise.
        """
        ...

    async def evaluate(self, trajectory: Trajectory) -> EvalResult:
        """Grade the agent's work on this task.

        Args:
            trajectory: The full execution history.

        Returns:
            An EvalResult with score, pass/fail, and explanation.
        """
        ...


# ---------------------------------------------------------------------------
# Type aliases for callback functions
# ---------------------------------------------------------------------------

# A function that checks if a task is done given the current state.
DoneCondition = Callable[[State], bool]

# An async function that evaluates a trajectory against a task.
EvalFunction = Callable[[Trajectory, "Task"], Any]  # returns Awaitable[EvalResult]


# ---------------------------------------------------------------------------
# SimpleTask — the basic concrete implementation
# ---------------------------------------------------------------------------

@dataclass
class SimpleTask:
    """A concrete task implementation with configurable behavior.

    Plain English: SimpleTask is the "fill in the blanks" version of a task.
    You provide:
    - prompt: What to do (required)
    - max_steps: How many tries (default: 50)
    - budget: Resource limits (default: generous)
    - done_condition: Custom function to check completion (optional)
    - eval_fn: Custom function to grade work (optional)

    If you don't provide done_condition, the task is never "done" —
    the agent runs until max_steps or budget is exhausted.

    If you don't provide eval_fn, the evaluation returns a score of 0.0
    (use this for tasks where you only care about completion, not quality).

    Attributes:
        prompt: The task description or problem statement.
        max_steps: Maximum reasoning steps allowed.
        budget: Resource limits for this task.
        done_condition: Optional custom completion checker.
        eval_fn: Optional custom evaluation function.
    """

    prompt: str = ""
    max_steps: int = 50
    budget: Budget = field(default_factory=Budget)
    done_condition: DoneCondition | None = None
    eval_fn: EvalFunction | None = None

    def is_done(self, state: State) -> bool:
        """Check if the task is complete.

        Delegates to the custom done_condition if provided.
        Otherwise, always returns False (task runs until budget/steps exhausted).

        Plain English: "Am I finished with this assignment?"
        - If the teacher gave specific completion criteria, use those.
        - Otherwise, keep working until time runs out.

        Args:
            state: The current agent state.

        Returns:
            True if the task is complete, False otherwise.
        """
        if self.done_condition is not None:
            return self.done_condition(state)
        return False

    async def evaluate(self, trajectory: Trajectory) -> EvalResult:
        """Grade the agent's work on this task.

        Delegates to the custom eval_fn if provided.
        Otherwise, returns a default EvalResult with score 0.0.

        Plain English: "How well did the student do?"
        - If there's a grading rubric (eval_fn), use it.
        - Otherwise, give a default score (0.0 = no grade).

        Args:
            trajectory: The full execution history.

        Returns:
            An EvalResult with score, pass/fail, and explanation.
        """
        if self.eval_fn is not None:
            result = await self.eval_fn(trajectory, self)
            if isinstance(result, EvalResult):
                return result
            return result
        return EvalResult(passed=False, score=0.0, reason="No evaluation function provided")


# ---------------------------------------------------------------------------
# BatchTask — wraps multiple tasks for benchmark runs
# ---------------------------------------------------------------------------

@dataclass
class BatchTask:
    """A container that wraps multiple tasks for benchmark execution.

    Plain English: If a SimpleTask is one exam question, a BatchTask
    is the entire exam. It holds a list of tasks that should all be
    run as part of a benchmark.

    BatchTask itself is iterable — you can loop over its tasks to
    run them one at a time, or hand the whole batch to a benchmark
    runner that handles parallelism.

    BatchTask also provides prompt, max_steps, and budget by delegating
    to the first task in the list (useful for inspection).

    Attributes:
        tasks: The list of tasks in this batch.
    """

    tasks: list[Task] = field(default_factory=list)

    @property
    def prompt(self) -> str:
        """The prompt of the first task (for quick inspection).

        Returns:
            The first task's prompt, or empty string if batch is empty.
        """
        return self.tasks[0].prompt if self.tasks else ""

    @property
    def max_steps(self) -> int:
        """The max_steps of the first task (for quick inspection).

        Returns:
            The first task's max_steps, or 0 if batch is empty.
        """
        return self.tasks[0].max_steps if self.tasks else 0

    @property
    def budget(self) -> Budget:
        """The budget of the first task (for quick inspection).

        Returns:
            The first task's budget, or a default Budget if batch is empty.
        """
        return self.tasks[0].budget if self.tasks else Budget()

    def __len__(self) -> int:
        """Return the number of tasks in the batch."""
        return len(self.tasks)

    def __iter__(self):
        """Iterate over tasks in order."""
        return iter(self.tasks)

    def __getitem__(self, index: int) -> Task:
        """Get a task by index (supports negative indexing)."""
        return self.tasks[index]
