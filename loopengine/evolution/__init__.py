"""The Evolution Layer — self-improvement for LoopEngine agents.

Plain English: This is the layer that makes the agent SMARTER over time.
It's like giving the agent the ability to learn from its mistakes and
improve itself — not by learning from data (that's ML training), but by
literally modifying its own code, prompts, and configuration.

The evolution cycle:
1. Run benchmark (measure performance)
2. Analyze trajectory (find patterns in what went wrong)
3. Generate CodeMods (propose specific changes)
4. Test in sandbox (verify changes help)
5. Promote or reject (quality gate)
6. Apply changes (update real code)
7. Repeat

Main classes:
- CodeMod: A proposed self-modification
- CodeModSet: A collection of related modifications
- Insight: A pattern found in trajectory analysis
- EvolutionStrategy: Interface for improvement strategies
- PromptEvolver: Strategy that improves system prompts
- ConfigEvolver: Strategy that tweaks configuration
- CompositeEvolutionStrategy: Runs multiple strategies together
- PromotionDecision: The gate's verdict on a modification
- PromotionGate: Quality control checkpoint
- EvolutionReport: Summary of an evolution run
- LoopEngine: THE orchestrator — runs the full improvement cycle
"""

from loopengine.evolution.code_mod import (
    CodeMod,
    CodeModSet,
    parse_unified_diff,
)

from loopengine.evolution.analysis import (
    Insight,
    analyze_trajectory,
    summarize_trajectory,
)

from loopengine.evolution.strategies import (
    EvolutionStrategy,
    PromptEvolver,
    ConfigEvolver,
    CompositeEvolutionStrategy,
)
from loopengine.evolution.promotion import (
    PromotionDecision,
    PromotionGate,
)
from loopengine.evolution.loop_engine import (
    EvolutionReport,
    LoopEngine,
)
from loopengine.evolution.checkpoint import (
    CheckpointStore,
    EvolutionCheckpoint,
)
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

__all__ = [
    # code_mod
    "CodeMod",
    "CodeModSet",
    "parse_unified_diff",
    # analysis
    "Insight",
    "analyze_trajectory",
    "summarize_trajectory",
    # strategies
    "EvolutionStrategy",
    "PromptEvolver",
    "ConfigEvolver",
    "CompositeEvolutionStrategy",
    # promotion
    "PromotionDecision",
    "PromotionGate",
    # loop_engine
    "EvolutionReport",
    "LoopEngine",
    # checkpoint
    "CheckpointStore",
    "EvolutionCheckpoint",
    # diagnostics (Codex-style)
    "ExecutionResult",
    "LspDiagnostic",
    "LoopDetector",
    "LoopWarning",
    "DiagnosticContext",
    "format_for_llm",
    "success",
    "failure",
]
