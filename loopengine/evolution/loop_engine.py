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

import os
import tempfile
from dataclasses import dataclass, field
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Import dependencies directly from sibling and parent modules.
#
# These were once wrapped in try/except ImportError with stub fallbacks (a
# parallel-development scaffold). The stubs were dangerous: the PromotionGate
# stub promoted unconditionally and the CodeMod stub reported is_safe()=True, so
# a real import failure would *silently* disable every safety check. We now
# import directly — a broken import fails loud instead of degrading to
# approve-everything (bug C3).
# ---------------------------------------------------------------------------

from loopengine.evolution.code_mod import CodeMod, CodeModSet
from loopengine.evolution.strategies import EvolutionStrategy
from loopengine.evolution.promotion import PromotionDecision, PromotionGate
from loopengine.evolution.checkpoint import CheckpointStore, EvolutionCheckpoint
from loopengine.evaluation.benchmark import BenchmarkResult
from loopengine.execution.harness import Harness


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
        patience: int | None = None,
        workspace_root: str | None = None,
        checkpoint_path: str | None = None,
    ) -> None:
        """Initialize the LoopEngine.

        Args:
            agent_builder: Callable that takes a config dict and returns a Harness.
            benchmark: A Benchmark instance for measuring performance.
            strategies: List of EvolutionStrategy instances.
            gate: A PromotionGate for validating improvements.
            sandbox: Optional sandbox for testing modifications.
            max_iterations: Maximum improvement iterations (default 100).
            patience: Stop after this many consecutive iterations that promote
                nothing. ``None`` (default) disables the early stop. Prevents the
                loop from burning the full ``max_iterations`` making no progress
                (bug M3).
            workspace_root: Directory under which candidate source is materialized
                to disk. Defaults to a fresh temp directory (bug C4).
        """
        self._agent_builder = agent_builder
        self._benchmark = benchmark
        self._strategies = list(strategies)
        self._gate = gate
        self._sandbox = sandbox
        self._max_iterations = max_iterations
        self._patience = patience
        self._workspace_root = workspace_root
        self._workspace_seq = 0
        self._store = CheckpointStore(checkpoint_path) if checkpoint_path else None

    async def run(
        self,
        tasks: list[Any] | None = None,
        source_files: dict[str, str] | None = None,
        config: dict[str, Any] | None = None,
        resume: bool = False,
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
        no_promotion_count = 0
        max_no_proposals = 2  # Stop after N consecutive iterations with no proposals
        start_iteration = 0

        # Feature C: resume from a prior checkpoint instead of restarting. The
        # restored state (history, evolved source/config, counters) is carried
        # forward and the loop continues from the iteration AFTER the last one.
        if resume and self._store is not None and self._store.exists():
            cp = self._store.load()
            if cp is not None:
                history = list(cp.history)
                current_source = dict(cp.current_source) or current_source
                current_config = dict(cp.current_config) or current_config
                improvements = cp.improvements
                rejections = cp.rejections
                final_score = cp.final_score
                start_iteration = cp.iteration + 1

        for iteration in range(start_iteration, self._max_iterations):
            # Step 1: MEASURE — build baseline harness and run benchmark on current code
            baseline = await self._run_benchmark(tasks, current_config, current_source)

            # Step 2: ANALYZE + PROPOSE — get proposals from strategies
            proposals = await self._get_proposals(
                baseline, current_source, current_config
            )

            # Step 3: Check if we have any proposals
            if not proposals:
                no_proposals_count += 1
                if no_proposals_count >= max_no_proposals:
                    # No more proposals from any strategy — done improving
                    history.append(
                        {
                            "iteration": iteration,
                            "score": baseline.aggregate.get("mean_score", 0.0),
                            "proposals": 0,
                            "promoted": False,
                            "reason": "No proposals — stopping.",
                        }
                    )
                    final_score = baseline.aggregate.get("mean_score", 0.0)
                    self._save_checkpoint(
                        iteration, history, current_source, current_config,
                        improvements, rejections, final_score,
                    )
                    break
                else:
                    # Might be transient — record and continue
                    history.append(
                        {
                            "iteration": iteration,
                            "score": baseline.aggregate.get("mean_score", 0.0),
                            "proposals": 0,
                            "promoted": False,
                            "reason": "No proposals from strategies.",
                        }
                    )
                    final_score = baseline.aggregate.get("mean_score", 0.0)
                    self._save_checkpoint(
                        iteration, history, current_source, current_config,
                        improvements, rejections, final_score,
                    )
                    continue

            # Reset no-proposals counter
            no_proposals_count = 0

            # Step 4: TEST + DECIDE.
            # Safety is checked BEFORE a candidate is ever built or run, so unsafe
            # code never executes during benchmarking (bug C2). Mods whose diff
            # does not actually apply are skipped instead of wasting a benchmark
            # (bug M1). Every promotable candidate is benchmarked and the single
            # BEST one is promoted — not merely the first that passes (bug M2).
            iteration_promoted = False
            iteration_score = baseline.aggregate.get("mean_score", 0.0)
            promotable: list[tuple[Any, dict[str, Any], dict[str, Any], Any]] = []

            for mod in proposals:
                # C2: reject unsafe mods up front — never build or run them.
                if not self._is_safe(mod):
                    rejections += 1
                    continue

                # M1: apply the mod and skip it if its diff did not land.
                candidate_source, applied = self._apply_mod_checked(
                    mod, current_source
                )
                if not applied:
                    rejections += 1
                    continue

                candidate_config = self._build_candidate_config(
                    current_config, candidate_source
                )
                candidate = await self._run_benchmark(
                    tasks, candidate_config, candidate_source
                )
                decision = await self._gate.validate(baseline, candidate, mod)

                if decision.promoted:
                    promotable.append(
                        (mod, candidate_source, candidate_config, candidate)
                    )
                else:
                    rejections += 1

            if promotable:
                # M2: promote the highest-scoring promotable candidate.
                best = max(
                    promotable,
                    key=lambda c: c[3].aggregate.get("mean_score", 0.0),
                )
                _mod, best_source, best_config, best_result = best
                current_source = best_source
                current_config = best_config
                improvements += 1
                iteration_promoted = True
                iteration_score = best_result.aggregate.get("mean_score", 0.0)

            # Record iteration history
            history.append(
                {
                    "iteration": iteration,
                    "score": iteration_score,
                    "proposals": len(proposals),
                    "promoted": iteration_promoted,
                    "reason": (
                        "Promoted the best of "
                        f"{len(promotable)} viable modification(s)."
                        if iteration_promoted
                        else f"No promotable modification among {len(proposals)}."
                    ),
                }
            )

            final_score = iteration_score
            self._save_checkpoint(
                iteration, history, current_source, current_config,
                improvements, rejections, final_score,
            )

            # M3: stop early after `patience` consecutive non-promoting iterations.
            if iteration_promoted:
                no_promotion_count = 0
            else:
                no_promotion_count += 1
                if self._patience is not None and no_promotion_count >= self._patience:
                    break

        return EvolutionReport(
            iterations=len(history),
            history=history,
            final_score=final_score,
            improvements=improvements,
            rejections=rejections,
        )

    async def _run_benchmark(
        self,
        tasks: list[Any] | None,
        config: dict[str, Any],
        source_files: dict[str, str],
    ) -> BenchmarkResult:
        """Build a harness, run tasks through it, and evaluate with the benchmark.

        This wires the agent_builder into the evolution loop: the harness is
        rebuilt from the supplied config + source_files so that each benchmark
        run tests the *current* (or *candidate*) agent, not a stale snapshot.

        Steps:
        1. Build a harness config from config + source_files + sandbox
        2. Call agent_builder to create a Harness
        3. Run all tasks through the harness (run_batch)
        4. Evaluate the resulting RunResults with the benchmark
        5. Attach trajectories to the result so strategies can analyze them

        Args:
            tasks: Optional tasks for the benchmark. If None, falls back to
                   the benchmark's built-in tasks, or an empty list.
            config: Config dict for the agent builder.
            source_files: Current source code files used by the agent builder.

        Returns:
            A BenchmarkResult with scores and aggregates.
        """
        # Resolve the task list
        if tasks is not None:
            task_list = tasks
        elif hasattr(self._benchmark, "tasks"):
            task_list = self._benchmark.tasks
        else:
            task_list = []

        # Build harness config: merge user config with source files and sandbox
        harness_config: dict[str, Any] = dict(config)
        harness_config["source_files"] = dict(source_files)
        harness_config["sandbox"] = self._sandbox

        # C4: materialize the source on disk so a builder can actually import and
        # run the evolved code, then hand the builder the workspace path. Without
        # this the candidate is behaviourally identical to the baseline and
        # nothing could ever be promoted.
        if source_files:
            try:
                harness_config["workspace"] = self._materialize(
                    source_files, self._ensure_workspace_root()
                )
            except OSError:
                # Never let a filesystem hiccup abort the evolution run.
                pass

        # Build a harness from the current config + source files
        harness = self._agent_builder(harness_config)

        # Run tasks through the harness to produce RunResults
        run_results = await harness.run_batch(task_list)

        # Evaluate the run results with the benchmark, passing the original
        # tasks so the judge can access task.prompt, task.max_steps, etc.
        result = await self._benchmark.run(run_results, tasks=task_list)

        # Preserve trajectories for strategy analysis
        trajectories = [getattr(r, "trajectory", None) for r in run_results]
        object.__setattr__(result, "trajectories", trajectories)

        return result

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
                    trajectory,
                    eval_result,
                    config,
                    source_code,
                )
                all_mods.extend(mods)
            except Exception:
                # Strategy failed — skip it
                pass

        return all_mods

    def _build_candidate_config(
        self,
        base_config: dict[str, Any],
        source_files: dict[str, str],
    ) -> dict[str, Any]:
        """Build a candidate config that includes modified source files.

        This guarantees that the candidate harness receives a different config
        than the baseline, even if the agent builder does not directly consume
        source_files.

        Args:
            base_config: The current configuration.
            source_files: The candidate source code files.

        Returns:
            A new config dict for the candidate harness.
        """
        candidate = dict(base_config)
        candidate["source_files"] = dict(source_files)
        return candidate

    def _extract_trajectory(self, baseline: BenchmarkResult) -> Any:
        """Extract a trajectory from the benchmark result for analysis.

        _run_benchmark attaches real trajectories from the harness run to
        the BenchmarkResult via the ``trajectories`` attribute. Strategies
        need these to analyze what the agent actually did.

        Args:
            baseline: The benchmark result to extract from.

        Returns:
            A Trajectory object, or an empty one if none available.
        """
        from loopengine.primitives.trajectory import Trajectory

        # Prefer real trajectories from the harness run
        trajectories = getattr(baseline, "trajectories", None)
        if trajectories:
            return trajectories[0]

        # Fallback: try to get trajectory from the first scored task
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

    def _save_checkpoint(
        self,
        iteration: int,
        history: list[dict[str, Any]],
        current_source: dict[str, str],
        current_config: dict[str, Any],
        improvements: int,
        rejections: int,
        final_score: float,
    ) -> None:
        """Persist a resumable checkpoint after an iteration (Feature C)."""
        if self._store is None:
            return
        self._store.save(
            EvolutionCheckpoint(
                iteration=iteration,
                history=history,
                current_source=current_source,
                current_config=current_config,
                improvements=improvements,
                rejections=rejections,
                final_score=final_score,
            )
        )

    def _is_safe(self, mod: Any) -> bool:
        """Return whether a proposed mod passes its own safety check.

        Mods without an ``is_safe`` method are treated as safe (the gate and
        sandbox provide defense in depth).
        """
        checker = getattr(mod, "is_safe", None)
        return checker() if callable(checker) else True

    def _apply_mod_checked(
        self, mod: Any, source_files: dict[str, str]
    ) -> tuple[dict[str, str], bool]:
        """Apply one mod, reporting whether it actually landed (bug M1).

        Prefers ``apply_with_status`` when available; otherwise falls back to the
        best-effort ``apply_to`` and assumes it applied.
        """
        status = getattr(mod, "apply_with_status", None)
        if callable(status):
            return status(source_files)
        return self._apply_mods([mod], source_files), True

    def _ensure_workspace_root(self) -> str:
        """Lazily create (once per engine) the root for materialized workspaces."""
        if self._workspace_root is None:
            self._workspace_root = tempfile.mkdtemp(prefix="loopengine_ws_")
        return self._workspace_root

    def _materialize(self, source_files: dict[str, str], root: str) -> str:
        """Write a source map to a fresh workspace directory under ``root``.

        Each call gets its own numbered subdirectory so candidate and baseline
        workspaces never clobber one another. Returns the workspace path so the
        agent builder can import the evolved code from disk (bug C4).
        """
        self._workspace_seq += 1
        workspace = os.path.join(root, f"ws_{self._workspace_seq}")
        for rel_path, content in source_files.items():
            dest = os.path.join(workspace, rel_path)
            os.makedirs(os.path.dirname(dest) or workspace, exist_ok=True)
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(content)
        os.makedirs(workspace, exist_ok=True)
        return workspace

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
