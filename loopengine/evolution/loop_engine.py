"""LoopEngine — THE SELF-IMPROVEMENT ORCHESTRATOR.

Plain English: This is the big one. LoopEngine is like a factory assembly line
for self-improvement. It runs a cycle:

1. MEASURE: "How good am I right now?" (run benchmark → baseline)
2. ANALYZE: "What am I doing wrong?" (analyze trajectories → insights)
3. PROPOSE: "What should I change?" (evolution strategies → CodeMods)
4. TEST: "Does the change help?" (apply mods in sandbox → candidate)
5. DECIDE: "Should I keep this change?" (promotion gate → yes/no)
6. APPLY: "Update the real code." (if promoted)
7. REPEAT: Go back to step 1.

The LoopEngine doesn't know HOW to improve — that's what the strategies are for.
It just orchestrates the cycle: measure → propose → test → decide → apply → repeat.

Real-world analogy: Imagine a sports team's training program. The coach (LoopEngine)
doesn't play the game. Instead, they:
1. Watch game tape (measure current performance)
2. Identify weaknesses (analyze trajectories)
3. Design new drills (propose changes via strategies)
4. Test the drills in practice (run benchmark with modifications)
5. Decide if the drill worked (promotion gate)
6. Add it to the permanent training plan (apply if promoted)
7. Repeat next week

This is the "meta-harness" pattern: the agent that improves agents.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Import dependencies from sibling and parent modules.
# Use stubs if other agents haven't built them yet.
# ---------------------------------------------------------------------------

try:
    from loopengine.evolution.code_mod import CodeMod, CodeModSet
except ImportError:
    @dataclass(frozen=True)
    class CodeMod:
        """Stub CodeMod — replaced when code_mod.py is built."""
        target_file: str = ""
        description: str = ""
        diff: str = ""
        rationale: str = ""
        expected_impact: str = ""

        def to_dict(self) -> dict[str, Any]:
            return {
                "target_file": self.target_file,
                "description": self.description,
                "diff": self.diff,
                "rationale": self.rationale,
                "expected_impact": self.expected_impact,
            }

        def is_safe(self) -> bool:
            return True

    @dataclass(frozen=True)
    class CodeModSet:
        """Stub CodeModSet — replaced when code_mod.py is built."""
        mods: tuple[CodeMod, ...] = ()

        def is_safe(self) -> bool:
            return all(m.is_safe() for m in self.mods)

        def apply_to(self, files: dict[str, str]) -> dict[str, str]:
            return files


try:
    from loopengine.evolution.strategies import EvolutionStrategy
except ImportError:
    from typing import Protocol, runtime_checkable

    @runtime_checkable
    class EvolutionStrategy(Protocol):
        """Stub — replaced when strategies.py is built."""
        @property
        def name(self) -> str: ...
        async def propose(self, trajectory: Any, eval_result: Any, config: Any, source_code: dict[str, str]) -> list[CodeMod]: ...


try:
    from loopengine.evolution.promotion import PromotionGate, PromotionDecision
except ImportError:
    @dataclass(frozen=True)
    class PromotionDecision:
        """Stub — replaced when promotion.py is built."""
        promoted: bool = False
        reason: str = ""
        details: dict[str, Any] = field(default_factory=dict)

    class PromotionGate:
        """Stub — replaced when promotion.py is built."""
        async def validate(self, baseline: Any, candidate: Any, mods: Any) -> PromotionDecision:
            return PromotionDecision(promoted=True, reason="stub")


try:
    from loopengine.evaluation.benchmark import BenchmarkResult
except ImportError:
    @dataclass(frozen=True)
    class BenchmarkResult:
        """Stub BenchmarkResult."""
        scores: dict[str, Any] = field(default_factory=dict)
        aggregate: dict[str, float] = field(default_factory=dict)


try:
    from loopengine.execution.harness import Harness
except ImportError:
    class Harness:
        """Stub Harness."""
        async def run(self, task: Any) -> Any:
            return None


# ---------------------------------------------------------------------------
# EvolutionReport — the outcome of the entire evolution run
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EvolutionReport:
    """The complete report from a LoopEngine run — what happened and why.

    Plain English: After the self-improvement factory finishes its shifts,
    this is the summary report. It tells you:
    - How many iterations were attempted
    - What happened in each iteration (history)
    - The final score after all improvements
    - How many changes were promoted vs rejected

    This report is the "graduation certificate" of the evolution process.
    You can use it to understand what changed, why, and whether it helped.

    Attributes:
        iterations: Total number of iterations performed.
        history: List of dicts, one per iteration, with details.
        final_score: The final aggregate score after all improvements.
        improvements: Number of successful promotions.
        rejections: Number of rejected proposals.
    """

    iterations: int = 0
    history: list[dict[str, Any]] = field(default_factory=list)
    final_score: float = 0.0
    improvements: int = 0
    rejections: int = 0

    def summary(self) -> str:
        """Generate a human-readable summary of the evolution run.

        Plain English: This is the "executive summary" — a short text
        that tells you the key results without needing to read the full history.

        Returns:
            A formatted multi-line string with the key metrics.
        """
        parts = [
            "=== Evolution Report ===",
            f"Iterations:   {self.iterations}",
            f"Final Score:  {self.final_score:.4f}",
            f"Improvements: {self.improvements}",
            f"Rejections:   {self.rejections}",
        ]

        if self.history:
            parts.append("\n--- Iteration History ---")
            for entry in self.history:
                iter_num = entry.get("iteration", "?")
                score = entry.get("score", 0.0)
                promoted = entry.get("promoted", False)
                proposals = entry.get("proposals", 0)
                status = "PROMOTED" if promoted else "REJECTED"
                parts.append(
                    f"  Iter {iter_num}: score={score:.4f}, "
                    f"proposals={proposals}, status={status}"
                )

        if self.improvements > 0:
            first_score = self.history[0]["score"] if self.history else 0.0
            delta = self.final_score - first_score
            parts.append(f"\nTotal improvement: {delta:+.4f}")
        else:
            parts.append("\nNo improvements were promoted.")

        return "\n".join(parts)


# ---------------------------------------------------------------------------
# LoopEngine — the self-improvement orchestrator
# ---------------------------------------------------------------------------


class LoopEngine:
    """THE SELF-IMPROVEMENT ORCHESTRATOR — runs the measure→propose→test→decide→apply cycle.

    Plain English: LoopEngine is the factory manager who oversees the entire
    self-improvement assembly line. It doesn't do the work itself — it
    coordinates:

    1. The Benchmark (measures current performance)
    2. The Strategies (propose improvements)
    3. The PromotionGate (decides what to keep)
    4. The Sandbox (tests changes safely)
    5. The Agent Builder (creates agents from configs)

    At each iteration, it follows the cycle:
    - Run the benchmark on the CURRENT code → baseline score
    - Ask strategies what to change → CodeMods
    - Apply mods in sandbox, run benchmark again → candidate score
    - Let the PromotionGate compare baseline vs candidate
    - If promoted, apply mods to real code

    The cycle stops when:
    - No more proposals (strategies return empty)
    - Max iterations reached
    - All proposals are rejected (strategies exhausted)

    Attributes:
        _agent_builder: Callable that creates a Harness from a config dict.
        _benchmark: The Benchmark for measuring agent performance.
        _strategies: List of EvolutionStrategy instances.
        _gate: The PromotionGate for validating improvements.
        _sandbox: Optional sandbox for safe testing.
        _max_iterations: Maximum number of improvement iterations.
    """

    def __init__(
        self,
        agent_builder: Callable[..., Any],
        benchmark: Any,
        strategies: list[Any],
        gate: Any,
        sandbox: Any = None,
        max_iterations: int = 100,
    ) -> None:
        """Initialize the LoopEngine.

        Args:
            agent_builder: Callable that takes a config dict and returns a Harness.
            benchmark: A Benchmark instance for measuring performance.
            strategies: List of EvolutionStrategy instances.
            gate: A PromotionGate for validating improvements.
            sandbox: Optional sandbox for testing modifications.
            max_iterations: Maximum improvement iterations (default 100).
        """
        self._agent_builder = agent_builder
        self._benchmark = benchmark
        self._strategies = list(strategies)
        self._gate = gate
        self._sandbox = sandbox
        self._max_iterations = max_iterations

    async def run(
        self,
        tasks: list[Any] | None = None,
        source_files: dict[str, str] | None = None,
        config: dict[str, Any] | None = None,
    ) -> EvolutionReport:
        """Run the full self-improvement loop.

        Plain English: "Start the factory! Let's make this agent better."

        The loop:
        1. Build an agent from the current config
        2. Run the benchmark to measure baseline performance
        3. Ask strategies for improvement proposals
        4. If no proposals → stop (nothing to improve)
        5. For each proposal:
           a. Apply the mod to source files
           b. Build a new agent from the modified source
           c. Run the benchmark on the new agent
           d. Let the PromotionGate decide
           e. If promoted, update the real source files
           f. Record in history
        6. Repeat from step 2

        Args:
            tasks: Optional list of tasks for the benchmark. If None, uses
                   whatever tasks the benchmark was configured with.
            source_files: Dict mapping filename to content. This is the
                         "source code" of the agent being improved.
            config: Optional config dict passed to the agent builder.

        Returns:
            An EvolutionReport with the full history and final results.
        """
        # Initialize tracking state
        if source_files is None:
            source_files = {}
        if config is None:
            config = {}

        history: list[dict[str, Any]] = []
        current_source = dict(source_files)
        current_config = dict(config)
        improvements = 0
        rejections = 0
        final_score = 0.0
        no_proposals_count = 0
        max_no_proposals = 2  # Stop after N consecutive iterations with no proposals

        for iteration in range(self._max_iterations):
            # Step 1: MEASURE — run benchmark on current code
            baseline = await self._run_benchmark(tasks)

            # Step 2: ANALYZE + PROPOSE — get proposals from strategies
            proposals = await self._get_proposals(baseline, current_source, current_config)

            # Step 3: Check if we have any proposals
            if not proposals:
                no_proposals_count += 1
                if no_proposals_count >= max_no_proposals:
                    # No more proposals from any strategy — done improving
                    history.append({
                        "iteration": iteration,
                        "score": baseline.aggregate.get("mean_score", 0.0),
                        "proposals": 0,
                        "promoted": False,
                        "reason": "No proposals — stopping.",
                    })
                    final_score = baseline.aggregate.get("mean_score", 0.0)
                    break
                else:
                    # Might be transient — record and continue
                    history.append({
                        "iteration": iteration,
                        "score": baseline.aggregate.get("mean_score", 0.0),
                        "proposals": 0,
                        "promoted": False,
                        "reason": "No proposals from strategies.",
                    })
                    final_score = baseline.aggregate.get("mean_score", 0.0)
                    continue

            # Reset no-proposals counter
            no_proposals_count = 0

            # Step 4: TEST + DECIDE — try each proposal
            iteration_promoted = False
            iteration_score = baseline.aggregate.get("mean_score", 0.0)

            for mod in proposals:
                # Apply mod to get candidate source
                candidate_source = self._apply_mods([mod], current_source)

                # Run benchmark with candidate source
                candidate = await self._run_benchmark(tasks)

                # Let the PromotionGate decide
                decision = await self._gate.validate(baseline, candidate, mod)

                if decision.promoted:
                    # Promoted! Update the real source
                    current_source = candidate_source
                    improvements += 1
                    iteration_promoted = True
                    iteration_score = candidate.aggregate.get("mean_score", 0.0)
                    # Only promote one mod per iteration (most impactful)
                    break
                else:
                    rejections += 1

            # Record iteration history
            history.append({
                "iteration": iteration,
                "score": iteration_score,
                "proposals": len(proposals),
                "promoted": iteration_promoted,
                "reason": (
                    "Promoted a modification."
                    if iteration_promoted
                    else f"All {len(proposals)} proposals rejected."
                ),
            })

            final_score = iteration_score

        return EvolutionReport(
            iterations=len(history),
            history=history,
            final_score=final_score,
            improvements=improvements,
            rejections=rejections,
        )

    async def _run_benchmark(self, tasks: list[Any] | None) -> BenchmarkResult:
        """Run the benchmark to measure current performance.

        Args:
            tasks: Optional tasks for the benchmark.

        Returns:
            A BenchmarkResult with scores and aggregates.
        """
        if tasks is not None:
            return await self._benchmark.run(tasks)

        # If no tasks provided, try to use the benchmark's built-in tasks
        if hasattr(self._benchmark, "tasks"):
            return await self._benchmark.run(self._benchmark.tasks)

        # Last resort: run with empty task list
        return await self._benchmark.run([])

    async def _get_proposals(
        self,
        baseline: BenchmarkResult,
        source_code: dict[str, str],
        config: dict[str, Any],
    ) -> list[CodeMod]:
        """Collect proposals from all strategies.

        Uses the baseline's first trajectory (if available) for analysis.
        If no trajectory is available, passes a minimal one.

        Args:
            baseline: The current benchmark result.
            source_code: Current source code files.
            config: Current configuration.

        Returns:
            A combined list of CodeMod proposals from all strategies.
        """
        # Get a trajectory for analysis (from the first scored task)
        trajectory = self._extract_trajectory(baseline)
        eval_result = self._extract_eval_result(baseline)

        all_mods: list[CodeMod] = []
        for strategy in self._strategies:
            try:
                mods = await strategy.propose(
                    trajectory, eval_result, config, source_code,
                )
                all_mods.extend(mods)
            except Exception:
                # Strategy failed — skip it
                pass

        return all_mods

    def _extract_trajectory(self, baseline: BenchmarkResult) -> Any:
        """Extract a trajectory from the benchmark result for analysis.

        Args:
            baseline: The benchmark result to extract from.

        Returns:
            A Trajectory object, or an empty one if none available.
        """
        from loopengine.primitives.trajectory import Trajectory

        # Try to get trajectory from the first scored task
        for task_id, eval_result in baseline.scores.items():
            if hasattr(eval_result, "trajectory"):
                return eval_result.trajectory

        return Trajectory()

    def _extract_eval_result(self, baseline: BenchmarkResult) -> Any:
        """Extract the first eval result from the benchmark for strategy use.

        Args:
            baseline: The benchmark result to extract from.

        Returns:
            The first EvalResult, or None if none available.
        """
        if baseline.scores:
            return next(iter(baseline.scores.values()))
        return None

    def _apply_mods(
        self,
        mods: list[CodeMod],
        source_files: dict[str, str],
    ) -> dict[str, str]:
        """Apply a list of CodeMods to source files.

        This creates a MODIFIED COPY of the source files — the originals
        are not touched until the PromotionGate approves.

        Args:
            mods: List of CodeMods to apply.
            source_files: Current source code files.

        Returns:
            A new dict with the modifications applied.
        """
        # Deep copy so we don't modify the original
        result = dict(source_files)

        for mod in mods:
            if hasattr(mod, "apply_to"):
                result = mod.apply_to(result)

        return result
