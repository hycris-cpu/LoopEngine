# LoopEngine TypeScript Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a runnable, strict TypeScript/Bun port of the Python LoopEngine library in `./typescript`, including all source modules and tests, with no behavior changes.

**Architecture:** The Python package structure is preserved as ES-module barrels under `typescript/src/`. Each Python module is translated file-by-file (in parallel via subagents) following a shared `PORTING.md` style guide. After translation, an integration pass installs dependencies, type-checks with `tsc --noEmit`, and runs the Bun test suite until it passes.

**Tech Stack:** Bun runtime + built-in test runner, TypeScript 5.5+ with `strict: true`, Zod for runtime schemas, Pino for logging.

---

## File structure

### Source files to create

```
typescript/src/
├── index.ts
├── primitives/
│   ├── index.ts
│   ├── events.ts
│   ├── tools.ts
│   ├── state.ts
│   ├── trajectory.ts
│   └── processors.ts
├── composition/
│   ├── index.ts
│   ├── config.ts
│   ├── flags.ts
│   ├── builder.ts
│   ├── plugins.ts
│   └── bundles.ts
├── execution/
│   ├── index.ts
│   ├── runloop.ts
│   ├── harness.ts
│   ├── task.ts
│   └── sandbox.ts
├── evaluation/
│   ├── index.ts
│   ├── judges.ts
│   ├── metrics.ts
│   └── benchmark.ts
├── evolution/
│   ├── index.ts
│   ├── code_mod.ts
│   ├── analysis.ts
│   ├── strategies.ts
│   ├── promotion.ts
│   ├── loop_engine.ts
│   └── diagnostics.ts
├── tools/
│   └── index.ts          # empty barrel for future tools
└── processors/
    ├── index.ts          # empty barrel
    ├── evaluation/
    │   └── index.ts      # empty barrel
    ├── memory/
    │   └── index.ts      # empty barrel
    ├── control/
    │   └── index.ts      # empty barrel
    └── context/
        └── index.ts      # empty barrel
```

### Test files to create

Mirror every file in `tests/*.py` as `typescript/tests/*.test.ts`:

- `typescript/tests/test_events.test.ts`
- `typescript/tests/test_tools.test.ts`
- `typescript/tests/test_state.test.ts`
- `typescript/tests/test_trajectory.test.ts`
- `typescript/tests/test_processors.test.ts`
- `typescript/tests/test_config.test.ts`
- `typescript/tests/test_flags.test.ts`
- `typescript/tests/test_builder.test.ts`
- `typescript/tests/test_plugins.test.ts`
- `typescript/tests/test_bundles.test.ts`
- `typescript/tests/test_runloop.test.ts`
- `typescript/tests/test_harness.test.ts`
- `typescript/tests/test_task.test.ts`
- `typescript/tests/test_sandbox.test.ts`
- `typescript/tests/test_judges.test.ts`
- `typescript/tests/test_metrics.test.ts`
- `typescript/tests/test_benchmark.test.ts`
- `typescript/tests/test_code_mod.test.ts`
- `typescript/tests/test_analysis.test.ts`
- `typescript/tests/test_strategies.test.ts`
- `typescript/tests/test_promotion.test.ts`
- `typescript/tests/test_loop_engine.test.ts`
- `typescript/tests/test_diagnostics.test.ts`
- `typescript/tests/test_integration.test.ts`

---

## Shared subagent prompt templates

These prompts are reused by the parallel translation tasks. Each task fills in the concrete source and target paths.

### Source-module translator prompt

```
You are translating a single Python module from the LoopEngine project to idiomatic TypeScript for the Bun runtime.

Source Python file: {{source_file}}
Target TypeScript file: {{target_file}}
Project root: /home/hycris/loopengine
TypeScript output root: /home/hycris/loopengine/typescript

Read the source file, then write the target TypeScript file. Follow these rules exactly:

1. Read /home/hycris/loopengine/typescript/PORTING.md and follow every mapping rule.
2. Preserve all JSDoc/docstring comments as JSDoc.
3. Translate Python imports to relative ES-module imports with NO file extension, e.g.
   from loopengine.primitives.events import Event  ->  import { Event } from '../primitives/events'
4. For subpackage barrels, re-export public members from sibling files using `export { ... } from './file'`.
5. Use TypeScript string enums for Python `str, enum.Enum` classes.
6. Replace `@dataclass(frozen=True)` with classes whose fields are `readonly` and assigned only in the constructor.
7. Replace Python protocols with TypeScript interfaces; use `instanceof` only when the concrete class is known.
8. Replace `structlog` calls with a Pino child logger imported from a shared logger utility if one exists; otherwise use `console` and add a short JSDoc note that a logger helper can be introduced later.
9. Replace any Pydantic models with Zod schemas and inferred types.
10. Do NOT change behavior, names of public exports, or add features.
11. After writing the file, run `cd /home/hycris/loopengine/typescript && bun run build` and fix any TypeScript errors introduced by your file.

Return a short summary: file written, key types exported, and any build errors you fixed.
```

### Test-file translator prompt

```
You are translating a single Python pytest file to a Bun test file.

Source Python test file: {{source_file}}
Target TypeScript test file: {{target_file}}
Project root: /home/hycris/loopengine
TypeScript output root: /home/hycris/loopengine/typescript

Read the source test file and the corresponding source module(s) it tests, then write the target test file. Rules:

1. Use Bun's test runner: import { describe, test, expect, beforeEach, mock } from 'bun:test'.
2. Replace pytest fixtures with helper factory functions or `beforeEach` blocks.
3. Replace `AsyncMock` / `MagicMock` with `mock()` from bun:test or small inline async stubs.
4. Replace `tmp_path` with `tmpDirSync()` from `node:fs`.
5. Preserve the intent of every test; do not drop assertions.
6. Import implementation under test from the matching `../src/...` path.
7. After writing the file, run `cd /home/hycris/loopengine/typescript && bun test {{target_file_relative}}` and fix failures caused by translation mistakes.

Return a short summary: file written, number of tests translated, and any failures you fixed.
```

---

## Task 1: Bootstrap the TypeScript package

**Files:**
- Create: `typescript/package.json`
- Create: `typescript/tsconfig.json`
- Create: `typescript/PORTING.md`
- Create: `typescript/README.md`

- [ ] **Step 1: Create `typescript/package.json`**

```json
{
  "name": "loopengine-ts",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "pino": "^9.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.5.0"
  },
  "peerDependencies": {
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Create `typescript/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["bun"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create `typescript/PORTING.md`**

```markdown
# LoopEngine TypeScript Port Style Guide

## General rules
- Preserve behavior and public API names.
- Preserve JSDoc comments.
- Use strict TypeScript; no `any` unless the original Python used `Any` and no better type exists.

## Imports
- Use relative ES-module imports with NO file extension.
- Example: `import { Event } from '../primitives/events'`.

## Python → TypeScript mappings
| Python | TypeScript |
|---|---|
| Subpackage `__init__.py` | `index.ts` barrel with named re-exports |
| `@dataclass` | `class` with public properties; mutable defaults created fresh in constructor |
| `@dataclass(frozen=True)` | `class` with `readonly` properties, assigned only in constructor |
| `__post_init__` | Constructor body after field assignments |
| `str, enum.Enum` | TypeScript string enum |
| `typing.Protocol` | `interface` |
| `dict[str, Any]` | `Record<string, unknown>` |
| `tuple[T, ...]` | `readonly T[]` |
| `**kwargs: Any` | Options object with an explicit type or rest params |
| `__or__` merge | Explicit `.merge(other)` method |
| Pydantic models | Zod schema + inferred type |
| `structlog` | `pino` logger (use a shared `getLogger()` helper if available) |
| Exceptions | Custom `Error` subclasses |
| `pytest` fixtures | `beforeEach` + factory helpers |
| `unittest.mock.AsyncMock` | `mock()` from `bun:test` or inline async stubs |
| `tmp_path` | `tmpDirSync()` from `node:fs` |

## Tests
- Use `import { describe, test, expect, beforeEach, mock } from 'bun:test'`.
- Keep test names and assertions identical in intent.
```

- [ ] **Step 4: Create `typescript/README.md`**

```markdown
# LoopEngine (TypeScript)

A TypeScript/Bun port of the Python LoopEngine library.

## Development

Install dependencies:

```bash
cd typescript
bun install
```

Type-check:

```bash
bun run build
```

Run tests:

```bash
bun test
```
```

- [ ] **Step 5: Install dependencies**

Run:
```bash
cd /home/hycris/loopengine/typescript && bun install
```

Expected: `bun install` completes and creates `node_modules`.

- [ ] **Step 6: Commit**

```bash
git add typescript/package.json typescript/tsconfig.json typescript/PORTING.md typescript/README.md
git commit -m "chore(typescript): bootstrap Bun/TypeScript package"
```

---

## Task 2: Translate primitives source modules

**Files:**
- Create: `typescript/src/primitives/events.ts`
- Create: `typescript/src/primitives/tools.ts`
- Create: `typescript/src/primitives/state.ts`
- Create: `typescript/src/primitives/trajectory.ts`
- Create: `typescript/src/primitives/processors.ts`
- Create: `typescript/src/primitives/index.ts`

These modules are foundational and have no internal dependencies other than each other.

- [ ] **Step 1: Dispatch parallel subagents for each source file**

Use the "Source-module translator prompt" with these concrete mappings:

| source | target |
|---|---|
| `loopengine/primitives/events.py` | `typescript/src/primitives/events.ts` |
| `loopengine/primitives/tools.py` | `typescript/src/primitives/tools.ts` |
| `loopengine/primitives/state.py` | `typescript/src/primitives/state.ts` |
| `loopengine/primitives/trajectory.py` | `typescript/src/primitives/trajectory.ts` |
| `loopengine/primitives/processors.py` | `typescript/src/primitives/processors.ts` |

- [ ] **Step 2: Create `typescript/src/primitives/index.ts` barrel**

Re-export public members from the five files above to match `loopengine/primitives/__init__.py`.

```typescript
export {
  Event,
  Message,
  MessageType,
  ToolCall,
  ToolCallMetadata,
  ToolResult,
  EvalResult,
} from './events';

export {
  HOOK_POINTS,
  Processor,
  MultiHookProcessor,
  ProcessorChain,
  event_to_hook,
  pipe,
  pipe_all,
} from './processors';
```

(Adjust exports if the original `__init__.py` names differ after translation.)

- [ ] **Step 3: Verify the layer compiles**

Run:
```bash
cd /home/hycris/loopengine/typescript && bun run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add typescript/src/primitives

git commit -m "feat(typescript): port primitives layer"
```

---

## Task 3: Translate composition source modules

**Files:**
- Create: `typescript/src/composition/config.ts`
- Create: `typescript/src/composition/flags.ts`
- Create: `typescript/src/composition/builder.ts`
- Create: `typescript/src/composition/plugins.ts`
- Create: `typescript/src/composition/bundles.ts`
- Create: `typescript/src/composition/index.ts`

- [ ] **Step 1: Dispatch parallel subagents for each source file**

Use the "Source-module translator prompt" with these mappings:

| source | target |
|---|---|
| `loopengine/composition/config.py` | `typescript/src/composition/config.ts` |
| `loopengine/composition/flags.py` | `typescript/src/composition/flags.ts` |
| `loopengine/composition/builder.py` | `typescript/src/composition/builder.ts` |
| `loopengine/composition/plugins.py` | `typescript/src/composition/plugins.ts` |
| `loopengine/composition/bundles.py` | `typescript/src/composition/bundles.ts` |

- [ ] **Step 2: Create `typescript/src/composition/index.ts` barrel**

Re-export public members matching `loopengine/composition/__init__.py`.

- [ ] **Step 3: Verify the layer compiles**

Run:
```bash
cd /home/hycris/loopengine/typescript && bun run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add typescript/src/composition

git commit -m "feat(typescript): port composition layer"
```

---

## Task 4: Translate execution source modules

**Files:**
- Create: `typescript/src/execution/runloop.ts`
- Create: `typescript/src/execution/harness.ts`
- Create: `typescript/src/execution/task.ts`
- Create: `typescript/src/execution/sandbox.ts`
- Create: `typescript/src/execution/index.ts`

- [ ] **Step 1: Dispatch parallel subagents for each source file**

| source | target |
|---|---|
| `loopengine/execution/runloop.py` | `typescript/src/execution/runloop.ts` |
| `loopengine/execution/harness.py` | `typescript/src/execution/harness.ts` |
| `loopengine/execution/task.py` | `typescript/src/execution/task.ts` |
| `loopengine/execution/sandbox.py` | `typescript/src/execution/sandbox.ts` |

- [ ] **Step 2: Create `typescript/src/execution/index.ts` barrel**

Re-export public members matching `loopengine/execution/__init__.py`.

- [ ] **Step 3: Verify the layer compiles**

Run:
```bash
cd /home/hycris/loopengine/typescript && bun run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add typescript/src/execution

git commit -m "feat(typescript): port execution layer"
```

---

## Task 5: Translate evaluation source modules

**Files:**
- Create: `typescript/src/evaluation/judges.ts`
- Create: `typescript/src/evaluation/metrics.ts`
- Create: `typescript/src/evaluation/benchmark.ts`
- Create: `typescript/src/evaluation/index.ts`

- [ ] **Step 1: Dispatch parallel subagents for each source file**

| source | target |
|---|---|
| `loopengine/evaluation/judges.py` | `typescript/src/evaluation/judges.ts` |
| `loopengine/evaluation/metrics.py` | `typescript/src/evaluation/metrics.ts` |
| `loopengine/evaluation/benchmark.py` | `typescript/src/evaluation/benchmark.ts` |

- [ ] **Step 2: Create `typescript/src/evaluation/index.ts` barrel**

Re-export public members matching `loopengine/evaluation/__init__.py`.

- [ ] **Step 3: Verify the layer compiles**

Run:
```bash
cd /home/hycris/loopengine/typescript && bun run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add typescript/src/evaluation

git commit -m "feat(typescript): port evaluation layer"
```

---

## Task 6: Translate evolution source modules

**Files:**
- Create: `typescript/src/evolution/code_mod.ts`
- Create: `typescript/src/evolution/analysis.ts`
- Create: `typescript/src/evolution/strategies.ts`
- Create: `typescript/src/evolution/promotion.ts`
- Create: `typescript/src/evolution/loop_engine.ts`
- Create: `typescript/src/evolution/diagnostics.ts`
- Create: `typescript/src/evolution/index.ts`

- [ ] **Step 1: Dispatch parallel subagents for each source file**

| source | target |
|---|---|
| `loopengine/evolution/code_mod.py` | `typescript/src/evolution/code_mod.ts` |
| `loopengine/evolution/analysis.py` | `typescript/src/evolution/analysis.ts` |
| `loopengine/evolution/strategies.py` | `typescript/src/evolution/strategies.ts` |
| `loopengine/evolution/promotion.py` | `typescript/src/evolution/promotion.ts` |
| `loopengine/evolution/loop_engine.py` | `typescript/src/evolution/loop_engine.ts` |
| `loopengine/evolution/diagnostics.py` | `typescript/src/evolution/diagnostics.ts` |

- [ ] **Step 2: Create `typescript/src/evolution/index.ts` barrel**

Re-export public members matching `loopengine/evolution/__init__.py`.

- [ ] **Step 3: Verify the layer compiles**

Run:
```bash
cd /home/hycris/loopengine/typescript && bun run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add typescript/src/evolution

git commit -m "feat(typescript): port evolution layer"
```

---

## Task 7: Create empty barrels and top-level public API

**Files:**
- Create: `typescript/src/tools/index.ts`
- Create: `typescript/src/processors/index.ts`
- Create: `typescript/src/processors/evaluation/index.ts`
- Create: `typescript/src/processors/memory/index.ts`
- Create: `typescript/src/processors/control/index.ts`
- Create: `typescript/src/processors/context/index.ts`
- Create: `typescript/src/index.ts`

- [ ] **Step 1: Create empty barrels**

Each empty barrel file should contain only a JSDoc comment explaining it is reserved for future use:

```typescript
/**
 * Empty barrel reserved for future processor plugins.
 */
export {};
```

- [ ] **Step 2: Create `typescript/src/index.ts`**

Re-export all public members from the five layers, matching `loopengine/__init__.py` and the design spec.

```typescript
// Layer 1: Primitives
export {
  Event, Message, MessageType, ToolCall, ToolCallMetadata, ToolResult, EvalResult,
  HOOK_POINTS, Processor, MultiHookProcessor, ProcessorChain, pipe, pipe_all,
} from './primitives';

// Layer 2: Composition
export {
  FeatureFlag, FlagRegistry, flag, HarnessConfig, ProcessorEntry, HarnessBuilder,
  Plugin, SimplePlugin, PluginLoader, make_coding, make_reliability, make_evaluation, make_self_improve,
} from './composition';

// Layer 3: Execution
export { RunResult, ModelProvider, run_loop, Harness } from './execution';
export { Sandbox, LocalSandbox, SandboxProvider, LocalSandboxProvider } from './execution/sandbox';
export { Task, SimpleTask, BatchTask } from './execution/task';

// Layer 4: Evaluation
export {
  Judge, TestSuiteJudge, LLMJudge, MetricJudge, CompositeJudge,
  Metric, PassRateMetric, EfficiencyMetric, CustomMetric,
  Benchmark, BenchmarkResult, Comparison, compare,
} from './evaluation';

// Layer 5: Evolution
export {
  CodeMod, CodeModSet, parse_unified_diff,
  Insight, analyze_trajectory, summarize_trajectory,
  EvolutionStrategy, PromptEvolver, ConfigEvolver, CompositeEvolutionStrategy,
  PromotionDecision, PromotionGate,
  EvolutionReport, LoopEngine,
} from './evolution';
```

(Adjust exports to match the actual translated API names.)

- [ ] **Step 3: Verify the full source tree compiles**

Run:
```bash
cd /home/hycris/loopengine/typescript && bun run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add typescript/src/index.ts typescript/src/tools/index.ts typescript/src/processors

git commit -m "feat(typescript): add top-level barrel and empty plugin barrels"
```

---

## Task 8: Translate tests

**Files:** all `typescript/tests/*.test.ts` listed in the File Structure section.

- [ ] **Step 1: Dispatch parallel subagents for each test file**

Use the "Test-file translator prompt" with these mappings (one subagent per file):

| source | target |
|---|---|
| `tests/test_events.py` | `typescript/tests/test_events.test.ts` |
| `tests/test_tools.py` | `typescript/tests/test_tools.test.ts` |
| `tests/test_state.py` | `typescript/tests/test_state.test.ts` |
| `tests/test_trajectory.py` | `typescript/tests/test_trajectory.test.ts` |
| `tests/test_processors.py` | `typescript/tests/test_processors.test.ts` |
| `tests/test_config.py` | `typescript/tests/test_config.test.ts` |
| `tests/test_flags.py` | `typescript/tests/test_flags.test.ts` |
| `tests/test_builder.py` | `typescript/tests/test_builder.test.ts` |
| `tests/test_plugins.py` | `typescript/tests/test_plugins.test.ts` |
| `tests/test_bundles.py` | `typescript/tests/test_bundles.test.ts` |
| `tests/test_runloop.py` | `typescript/tests/test_runloop.test.ts` |
| `tests/test_harness.py` | `typescript/tests/test_harness.test.ts` |
| `tests/test_task.py` | `typescript/tests/test_task.test.ts` |
| `tests/test_sandbox.py` | `typescript/tests/test_sandbox.test.ts` |
| `tests/test_judges.py` | `typescript/tests/test_judges.test.ts` |
| `tests/test_metrics.py` | `typescript/tests/test_metrics.test.ts` |
| `tests/test_benchmark.py` | `typescript/tests/test_benchmark.test.ts` |
| `tests/test_code_mod.py` | `typescript/tests/test_code_mod.test.ts` |
| `tests/test_analysis.py` | `typescript/tests/test_analysis.test.ts` |
| `tests/test_strategies.py` | `typescript/tests/test_strategies.test.ts` |
| `tests/test_promotion.py` | `typescript/tests/test_promotion.test.ts` |
| `tests/test_loop_engine.py` | `typescript/tests/test_loop_engine.test.ts` |
| `tests/test_diagnostics.py` | `typescript/tests/test_diagnostics.test.ts` |
| `tests/test_integration.py` | `typescript/tests/test_integration.test.ts` |

- [ ] **Step 2: Verify all tests compile**

Run:
```bash
cd /home/hycris/loopengine/typescript && bun run build
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add typescript/tests

git commit -m "test(typescript): port Python test suite"
```

---

## Task 9: Integration pass

**Goal:** Make the entire package type-check and the test suite pass.

- [ ] **Step 1: Run full build**

```bash
cd /home/hycris/loopengine/typescript && bun run build
```

Expected: zero errors.

- [ ] **Step 2: Run full test suite**

```bash
cd /home/hycris/loopengine/typescript && bun test
```

Expected: all tests pass. If failures are due to legitimate environment differences, document them in `typescript/PORTING.md` under a "Known differences" section.

- [ ] **Step 3: Fix cross-cutting issues**

Common fixes to apply:
- Add missing re-exports in barrel files.
- Align names if a Python class was renamed during translation.
- Replace any remaining Python idioms (e.g., `dict.get`, `list.copy`) with TypeScript equivalents.
- Ensure `readonly` arrays are used consistently.
- Add a shared Pino logger helper at `typescript/src/logger.ts` if multiple modules need structured logging and it does not exist yet.

- [ ] **Step 4: Final verification**

```bash
cd /home/hycris/loopengine/typescript
bun run build
bun test
```

Expected: both commands succeed.

- [ ] **Step 5: Commit**

```bash
git add typescript

git commit -m "chore(typescript): integration pass — build and tests pass"
```

---

## Spec coverage check

- **Standalone runnable package with tests** → Task 1 bootstraps the package; Task 8 translates tests; Task 9 verifies.
- **Bun + strict TypeScript** → `tsconfig.json` and `package.json` in Task 1; verification in Task 9.
- **Zod for schemas, Pino for logging** → Dependencies in Task 1; subagent prompts require their use.
- **Idiomatic TypeScript while preserving behavior** → `PORTING.md` rules and subagent prompts enforce this.
- **Module-by-module parallel translation** → Tasks 2–6 and 8 use parallel subagent dispatch.
- **No new features / unchanged public API** → Subagent prompts explicitly forbid this; Task 7 matches `loopengine/__init__.py`.
