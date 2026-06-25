"""Evolution Strategies — the "brains" of self-improvement.

Plain English: An EvolutionStrategy is like a coach watching game tape.
After watching the agent play (analyzing its trajectory), the coach
suggests specific improvements. Different coaches specialize in different things:

- PromptEvolver: "Your instructions are confusing. Let me rewrite them."
- ToolEvolver: "You need a new tool, or your existing tools need tweaking."
- ProcessorEvolver: "Your behavioral checkpoints need adjustment."
- ConfigEvolver: "Your settings are suboptimal."

Each strategy implements the same interface:
  propose(trajectory, eval_result, config, source_code) -> list[CodeMod]

The strategies don't APPLY changes — they only PROPOSE them.
The PromotionGate decides whether to actually apply them.

Real-world analogy: This is like having a team of consultants. Each one
specializes in a different area (marketing, operations, finance). They all
look at the same data (your trajectory) and each suggests changes in their
area of expertise. The PromotionGate is the CEO who decides which
suggestions to actually implement.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

# ---------------------------------------------------------------------------
# Import dependencies directly from sibling modules.
#
# These were once wrapped in try/except ImportError with stub fallbacks.
# The stubs were dangerous: the CodeMod stub reported is_safe()=True
# unconditionally, so a real import failure would *silently* disable
# every safety check. We now import directly — a broken import fails
# loud instead of degrading to approve-everything (bug C3).
# ---------------------------------------------------------------------------

from loopengine.evolution.code_mod import CodeMod, CodeModSet

try:
    from loopengine.evolution.analysis import Insight, analyze_trajectory
except ImportError:
    # analysis.py is a pure computation module — if it can't load, we can
    # still function without trajectory insights. Define minimal safe stubs
    # that return empty results (not dangerous "approve everything" stubs).
    from dataclasses import dataclass, field
    from typing import Any

    @dataclass(frozen=True)
    class Insight:
        """Stub Insight when analysis.py is unavailable — returns empty data."""
        category: str = ""
        description: str = ""
        severity: str = "low"
        evidence: str = ""
        suggested_fix: str = ""

    def analyze_trajectory(trajectory: Any) -> list[Insight]:
        """Stub — no insights available when analysis module is missing."""
        return []

try:
    from loopengine.execution.runloop import ModelProvider
except ImportError:
    from typing import Protocol as _Protocol, runtime_checkable

    @runtime_checkable
    class ModelProvider(_Protocol):  # type: ignore[no-redef]
        """Stub ModelProvider when runloop.py is unavailable."""
        async def complete(self, messages: list[Any], tools: list[Any] | None = None) -> Any: ...
        def count_tokens(self, messages: list[Any]) -> int: ...


# ---------------------------------------------------------------------------
# EvolutionStrategy — the Protocol that all strategies implement
# ---------------------------------------------------------------------------


@runtime_checkable
class EvolutionStrategy(Protocol):
    """The interface that every evolution strategy must implement.

    Plain English: Think of this as a job description for a "coach."
    Every coach must have a name and must be able to propose improvements
    when shown how the agent performed.

    The strategy receives:
    - trajectory: The agent's "diary" of what it did step by step
    - eval_result: How well it scored (like a test grade)
    - config: The current settings/setup
    - source_code: Dict of filename → content for the agent's own code

    And returns a list of CodeMods — proposed changes. The strategy
    doesn't apply these changes; it just suggests them.
    """

    @property
    def name(self) -> str:
        """A human-readable name for this strategy (e.g., 'prompt_evolver')."""
        ...

    async def propose(
        self,
        trajectory: Any,
        eval_result: Any,
        config: Any,
        source_code: dict[str, str],
    ) -> list[CodeMod]:
        """Analyze the trajectory and propose self-modifications.

        Args:
            trajectory: The agent's execution trajectory.
            eval_result: The evaluation result for this run.
            config: The current agent configuration.
            source_code: Dict mapping filename to file content.

        Returns:
            A list of CodeMod proposals. Empty list means no changes suggested.
        """
        ...


# ---------------------------------------------------------------------------
# PromptEvolver — proposes system prompt improvements
# ---------------------------------------------------------------------------


class PromptEvolver:
    """Analyzes trajectory and proposes system prompt improvements.

    Plain English: Imagine a writing coach reading your agent's "instruction
    manual" (system prompt) and saying: "This part is confusing, that part
    is missing, and this other part contradicts itself." The PromptEvolver
    looks at how the agent actually behaved (trajectory) vs. how it should
    have behaved (eval_result), and suggests rewrites to the instructions.

    It uses a language model to generate the improved prompts — because
    who better to write instructions for an AI than another AI?

    Attributes:
        _model: The language model provider used to generate prompt rewrites.
    """

    def __init__(self, model: Any) -> None:
        """Initialize the PromptEvolver.

        Args:
            model: A ModelProvider instance used to generate improved prompts.
                   In production, this is a real LLM. In tests, use a mock.
        """
        self._model = model

    @property
    def name(self) -> str:
        """This strategy's name — 'prompt_evolver'."""
        return "prompt_evolver"

    async def propose(
        self,
        trajectory: Any,
        eval_result: Any,
        config: Any,
        source_code: dict[str, str],
    ) -> list[CodeMod]:
        """Propose system prompt improvements based on trajectory analysis.

        Steps:
        1. Analyze the trajectory for signs of confusion, repetition, or errors
        2. Build a context describing what went wrong
        3. Ask the model to suggest improved instructions
        4. Return CodeMods targeting the system prompt file

        Args:
            trajectory: The agent's execution trajectory.
            eval_result: The evaluation result for this run.
            config: The current agent configuration.
            source_code: Dict mapping filename to file content.

        Returns:
            A list of CodeMod proposals targeting prompt files.
        """
        # Step 1: Analyze trajectory for insights
        insights = analyze_trajectory(trajectory)

        if not insights and self._has_good_score(eval_result):
            # No issues found and score is good — no changes needed
            return []

        # Step 2: Build context for the model
        context = self._build_context(trajectory, eval_result, insights, source_code)

        # Step 3: Ask the model for improved prompts
        from loopengine.primitives.events import Message

        messages = [
            Message(role="system", content=self._system_instruction()),
            Message(role="user", content=context),
        ]

        response = await self._model.complete(messages=messages, tools=None)

        # Step 4: Parse the response into CodeMods
        mods = self._parse_response(response, source_code)

        return mods

    def _has_good_score(self, eval_result: Any) -> bool:
        """Check if the evaluation score is already good enough.

        Args:
            eval_result: The evaluation result to check.

        Returns:
            True if score >= 0.8 (indicating good performance).
        """
        if eval_result is None:
            return False
        score = getattr(eval_result, "score", 0.0)
        return score >= 0.8

    def _build_context(
        self,
        trajectory: Any,
        eval_result: Any,
        insights: list[Insight],
        source_code: dict[str, str],
    ) -> str:
        """Build the context string for the model prompt.

        This summarizes what happened and what went wrong, so the model
        can suggest targeted improvements.

        Args:
            trajectory: The agent's execution trajectory.
            eval_result: The evaluation result.
            insights: Insights from trajectory analysis.
            source_code: Current source code files.

        Returns:
            A formatted context string for the model.
        """
        parts = ["## Trajectory Analysis\n"]

        # Add trajectory summary
        step_count = len(trajectory.steps) if hasattr(trajectory, "steps") else 0
        total_reward = getattr(trajectory, "total_reward", 0.0)
        parts.append(f"Steps taken: {step_count}")
        parts.append(f"Total reward: {total_reward:.3f}")

        # Add eval result
        if eval_result is not None:
            score = getattr(eval_result, "score", 0.0)
            passed = getattr(eval_result, "passed", False)
            reason = getattr(eval_result, "reason", "")
            parts.append(f"Score: {score:.3f} (passed={passed})")
            if reason:
                parts.append(f"Reason: {reason}")

        # Add insights
        if insights:
            parts.append("\n## Insights\n")
            for insight in insights:
                parts.append(
                    f"- [{insight.severity}] {insight.category}: {insight.description}"
                )
                if insight.suggested_fix:
                    parts.append(f"  Suggested fix: {insight.suggested_fix}")

        # Add current system prompt (if present in source)
        for fname, content in source_code.items():
            if "prompt" in fname.lower() or "system" in fname.lower():
                parts.append(f"\n## Current {fname}\n```\n{content[:2000]}\n```")

        return "\n".join(parts)

    def _system_instruction(self) -> str:
        """The system instruction for the prompt improvement model.

        Returns:
            A system prompt telling the model what to do.
        """
        return (
            "You are a prompt engineering expert. Analyze the agent's performance "
            "data and suggest improved system prompts. Return your suggestions as "
            "a JSON object with fields: target_file, description, diff, rationale, "
            "expected_impact. The diff should be a unified diff format."
        )

    def _parse_response(
        self,
        response: Any,
        source_code: dict[str, str],
    ) -> list[CodeMod]:
        """Parse the model's response into CodeMod proposals.

        The model should return JSON with fields matching CodeMod.
        If parsing fails, return an empty list (don't crash the evolution loop).

        Args:
            response: The model's response Message.
            source_code: Current source code (for fallback targeting).

        Returns:
            A list of parsed CodeMod objects.
        """
        import json

        content = ""
        if hasattr(response, "content"):
            content = response.content
        elif isinstance(response, str):
            content = response

        if not content:
            return []

        # Try to parse as JSON
        try:
            data = json.loads(content)
            # Handle both single object and list
            if isinstance(data, dict):
                data = [data]
            if isinstance(data, list):
                mods = []
                for item in data:
                    if isinstance(item, dict):
                        mods.append(CodeMod(
                            target_file=item.get("target_file", ""),
                            description=item.get("description", ""),
                            diff=item.get("diff", ""),
                            rationale=item.get("rationale", ""),
                            expected_impact=item.get("expected_impact", ""),
                        ))
                return mods
        except (json.JSONDecodeError, TypeError):
            pass

        # Fallback: create a single CodeMod from the raw text
        target = next(iter(source_code.keys()), "system_prompt.py")
        return [CodeMod(
            target_file=target,
            description="Prompt improvement suggested by evolver",
            diff=content[:500],
            rationale="Generated by prompt evolver based on trajectory analysis",
            expected_impact="Improved agent behavior",
        )]


# ---------------------------------------------------------------------------
# ConfigEvolver — proposes config changes
# ---------------------------------------------------------------------------


class ConfigEvolver:
    """Proposes configuration changes based on trajectory analysis.

    Plain English: This is like a settings optimizer. It looks at how the
    agent performed and suggests tweaking the knobs and dials:
    - "Turn on the retry flag — the agent failed too often."
    - "Increase the budget — it ran out of steps."
    - "Disable that plugin — it was causing confusion."

    Unlike PromptEvolver, ConfigEvolver doesn't need a language model.
    It uses simple heuristics based on the trajectory metrics.

    Attributes:
        _score_threshold: Below this score, propose config changes.
        _step_threshold: Above this step count, flag as "too many steps".
    """

    def __init__(
        self,
        score_threshold: float = 0.7,
        step_threshold: int = 50,
    ) -> None:
        """Initialize the ConfigEvolver.

        Args:
            score_threshold: Score below which config changes are proposed.
            step_threshold: Step count above which efficiency flags are proposed.
        """
        self._score_threshold = score_threshold
        self._step_threshold = step_threshold

    @property
    def name(self) -> str:
        """This strategy's name — 'config_evolver'."""
        return "config_evolver"

    async def propose(
        self,
        trajectory: Any,
        eval_result: Any,
        config: Any,
        source_code: dict[str, str],
    ) -> list[CodeMod]:
        """Propose config changes based on trajectory metrics.

        Heuristics:
        - Low score → suggest increasing max_steps or budget
        - Too many steps → suggest enabling retry flags
        - High tool error rate → suggest adding error-handling processors

        Args:
            trajectory: The agent's execution trajectory.
            eval_result: The evaluation result for this run.
            config: The current agent configuration.
            source_code: Dict mapping filename to file content.

        Returns:
            A list of CodeMod proposals targeting config files.
        """
        mods: list[CodeMod] = []

        score = getattr(eval_result, "score", 0.0) if eval_result else 0.0
        step_count = len(trajectory.steps) if hasattr(trajectory, "steps") else 0

        # Target a config file that actually exists in the source map. A
        # hard-coded "config.py" is usually absent, so the mod could never apply
        # (bug M4).
        target = self._pick_target(source_code)

        # Heuristic 1: Low score → suggest budget increase
        if score < self._score_threshold:
            mods.append(CodeMod(
                target_file=target,
                description="Increase budget due to low score",
                diff=self._budget_diff(trajectory),
                rationale=(
                    f"Score {score:.3f} is below threshold {self._score_threshold}. "
                    "The agent may need more resources to complete tasks effectively."
                ),
                expected_impact="Higher score with increased budget",
            ))

        # Heuristic 2: Too many steps → suggest efficiency improvements
        if step_count > self._step_threshold:
            mods.append(CodeMod(
                target_file=target,
                description="Enable efficiency flags due to excessive steps",
                diff=self._efficiency_diff(),
                rationale=(
                    f"Agent took {step_count} steps (threshold: {self._step_threshold}). "
                    "Enabling retry limits and early-stop flags may help."
                ),
                expected_impact="Fewer steps per task, faster completion",
            ))

        # Heuristic 3: Check for tool errors in trajectory
        tool_errors = self._count_tool_errors(trajectory)
        if tool_errors > 2:
            mods.append(CodeMod(
                target_file=target,
                description="Add error recovery due to tool failures",
                diff=self._error_recovery_diff(),
                rationale=(
                    f"Detected {tool_errors} tool errors in trajectory. "
                    "Adding error recovery processors may improve reliability."
                ),
                expected_impact="Fewer failures from tool errors",
            ))

        return mods

    def _pick_target(self, source_code: dict[str, str]) -> str:
        """Choose a config file to target from the actual source map.

        Prefers a file whose name looks config-related; otherwise falls back to
        any available file, and finally to a bare ``config.py`` when the source
        map is empty (bug M4).
        """
        if source_code:
            for name in source_code:
                lowered = name.lower()
                if "config" in lowered or "settings" in lowered:
                    return name
            return next(iter(source_code))
        return "config.py"

    def _budget_diff(self, trajectory: Any) -> str:
        """Generate a diff that increases the budget.

        Returns:
            A unified diff string suggesting budget increase.
        """
        return (
            "--- a/config.py\n"
            "+++ b/config.py\n"
            "@@ -1,3 +1,3 @@\n"
            " budget = Budget(\n"
            "-    max_tokens=10000,\n"
            "+    max_tokens=20000,\n"
            " )\n"
        )

    def _efficiency_diff(self) -> str:
        """Generate a diff that enables efficiency flags.

        Returns:
            A unified diff string suggesting efficiency improvements.
        """
        return (
            "--- a/config.py\n"
            "+++ b/config.py\n"
            "@@ -1,3 +1,4 @@\n"
            " flags = {\n"
            '     "retry_on_error": True,\n'
            '+    "early_stop_on_loop": True,\n'
            '     "max_tool_retries": 3,\n'
            " }\n"
        )

    def _error_recovery_diff(self) -> str:
        """Generate a diff that adds error recovery.

        Returns:
            A unified diff string suggesting error recovery.
        """
        return (
            "--- a/config.py\n"
            "+++ b/config.py\n"
            "@@ -1,3 +1,4 @@\n"
            " processors = [\n"
            "+    ErrorRecoveryProcessor(),\n"
            "     ContextProcessor(),\n"
            " ]\n"
        )

    def _count_tool_errors(self, trajectory: Any) -> int:
        """Count the number of tool errors in a trajectory.

        Looks at trajectory steps' observations for ToolResults with errors.

        Args:
            trajectory: The trajectory to analyze.

        Returns:
            Number of tool error observations found.
        """
        errors = 0
        if not hasattr(trajectory, "steps"):
            return 0
        for step in trajectory.steps:
            for obs in getattr(step, "observations", ()):
                # Check for ToolResult with error
                if hasattr(obs, "error") and obs.error is not None:
                    errors += 1
                # Also check is_error property
                elif hasattr(obs, "is_error") and obs.is_error:
                    errors += 1
        return errors


# ---------------------------------------------------------------------------
# CompositeEvolutionStrategy — runs multiple strategies, collects all proposals
# ---------------------------------------------------------------------------


class CompositeEvolutionStrategy:
    """Runs multiple evolution strategies and aggregates all their proposals.

    Plain English: This is like a board of advisors. Each advisor (strategy)
    looks at the same data and proposes changes in their area of expertise.
    The composite collects ALL proposals from ALL advisors into one big list.

    The strategies are independent — they don't know about each other.
    The PromotionGate later decides which proposals to actually apply.

    Attributes:
        _strategies: The list of strategies to run.
    """

    def __init__(self, strategies: list[Any]) -> None:
        """Initialize the composite strategy.

        Args:
            strategies: List of EvolutionStrategy instances to aggregate.
        """
        self._strategies = list(strategies)

    @property
    def name(self) -> str:
        """This strategy's name — 'composite'."""
        return "composite"

    @property
    def strategies(self) -> list[Any]:
        """The list of sub-strategies (read-only view)."""
        return list(self._strategies)

    async def propose(
        self,
        trajectory: Any,
        eval_result: Any,
        config: Any,
        source_code: dict[str, str],
    ) -> list[CodeMod]:
        """Run all sub-strategies and collect all proposals.

        Each strategy runs independently. If one strategy fails, the
        others still run — we don't let one bad apple spoil the bunch.

        Args:
            trajectory: The agent's execution trajectory.
            eval_result: The evaluation result for this run.
            config: The current agent configuration.
            source_code: Dict mapping filename to file content.

        Returns:
            A combined list of CodeMod proposals from all strategies.
        """
        all_mods: list[CodeMod] = []

        for strategy in self._strategies:
            try:
                mods = await strategy.propose(
                    trajectory, eval_result, config, source_code,
                )
                all_mods.extend(mods)
            except Exception:
                # Strategy failed — skip it but don't crash the whole loop
                # In production, this would be logged
                pass

        return all_mods
