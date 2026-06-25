# AGENTS.md — LoopEngine Repository Knowledge

## Project Overview
LoopEngine is a self-improving AI agent framework with dual-language implementation (Python + TypeScript).

## Architecture
5-layer architecture, each layer builds on the one below:
1. **Primitives** (events, state, tools, processors, trajectory)
2. **Composition** (builder, plugins, bundles, flags)
3. **Execution** (run_loop, harness, sandbox, task)
4. **Evaluation** (judges, metrics, benchmarks, grader)
5. **Evolution** (loop_engine, strategies, promotion, code_mod, diagnostics, checkpoint)

## Build & Test Commands
- Python tests: `pytest tests/ -v`
- TypeScript tests: `cd typescript && bun test`
- Install Python: `pip install -e ".[dev,full]"`
- Install TS: `cd typescript && bun install`

## Key Design Patterns
- Protocol/Interface-based DI (Tool, Judge, Strategy, Plugin are Protocols)
- Immutable Value Objects (frozen dataclasses for Events, Snapshots, Decisions)
- Builder pattern (HarnessBuilder returns NEW instances on each mutation)
- Pipeline pattern (ProcessorChain chains processors sequentially)
- Strategy pattern (EvolutionStrategy is pluggable)
- Gate/Specification pattern (PromotionGate validates before applying)

## Bugs Fixed (2024-06)
- **FeatureFlag.__post_init__**: Was incorrectly overriding `value=False` when `default=True`. Fixed with None sentinel.
- **tool_schemas format**: Was passing raw JSON Schema instead of OpenAI format. Fixed by using `ToolSchema.to_openai_dict()`.
- **Dangerous stub CodeMod**: `try/except ImportError` stubs in promotion.py and strategies.py had `is_safe()=True`. Fixed by importing directly (bug C3).
- **Missing top-level exports**: GradeResult, IsolatedGrader, CheckpointStore, diagnostics items were not exported from top-level `__init__.py`.

## Python ↔ TypeScript Parity
- Both have identical module structure (one-to-one file mapping)
- TS uses `interface` instead of `Protocol`, `readonly` instead of `frozen=True`
- TS uses `.merge(other)` instead of `__or__` (`|` operator)
- TS has extra `errors.ts` with `ValueError`/`KeyError` classes
- Both test suites cover the same scenarios (550 Python, 497 TypeScript)
- See `typescript/PORTING.md` for mapping rules
- See `typescript/tests/KNOWN_DIFFERENCES.md` for test differences

## Code Style Notes
- Extensive "Plain English" docstrings explaining concepts
- BDD-style Given/When/Then test docstrings
- No `any` in TypeScript unless Python used `Any`
- All events are frozen/readonly — history is immutable
- State is mutable but can be snapshotted/restored
- Dual-track messages: `raw_messages` (ground truth) vs `messages` (model view)
