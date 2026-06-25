# LoopEngine TypeScript Port Design

## Goal

Create a standalone, runnable TypeScript/Bun package in `./typescript` that is a behavior-preserving translation of the existing Python LoopEngine library. The source tree contains 28 Python modules and 25 test files (~18,000 lines total). The translated package must:

- Compile with TypeScript `strict: true`.
- Run its translated test suite with Bun's built-in test runner.
- Preserve the existing public API names and behavior.
- Introduce no new features.

## Decisions from brainstorming

- **Output form**: standalone runnable package with tests.
- **Runtime / test toolchain**: Bun with built-in test runner.
- **Python library mapping**:
  - Pydantic / JSON schemas → Zod for runtime validation and inferred TypeScript types.
  - `structlog` → Pino for structured logging.
- **Translation style**: idiomatic TypeScript while preserving behavior.
- **Type strictness**: `strict: true`.
- **Porting strategy**: module-by-module parallel translation, followed by an integration pass.

## Project layout

```
./typescript/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts              # public API barrel (mirrors loopengine/__init__.py)
    ├── primitives/
    │   ├── events.ts
    │   ├── tools.ts
    │   ├── state.ts
    │   ├── trajectory.ts
    │   └── processors.ts
    ├── composition/
    │   ├── config.ts
    │   ├── flags.ts
    │   ├── builder.ts
    │   ├── plugins.ts
    │   └── bundles.ts
    ├── execution/
    │   ├── runloop.ts
    │   ├── harness.ts
    │   ├── task.ts
    │   └── sandbox.ts
    ├── evaluation/
    │   ├── judges.ts
    │   ├── metrics.ts
    │   └── benchmark.ts
    ├── evolution/
    │   ├── code_mod.ts
    │   ├── strategies.ts
    │   ├── loop_engine.ts
    │   ├── promotion.ts
    │   ├── analysis.ts
    │   └── diagnostics.ts
    ├── tools/
    └── processors/
        ├── evaluation/
        ├── memory/
        ├── control/
        └── context/
└── tests/
    └── (mirror of tests/*.py as *.test.ts)
```

## Key translation rules

| Python idiom | TypeScript idiom |
|---|---|
| Subpackage (`loopengine/primitives/__init__.py`) | Folder with `index.ts` barrel exports |
| `from __future__ import annotations` | Not needed; TypeScript handles forward references |
| `@dataclass` / `@dataclass(frozen=True)` | Class with `readonly` fields; mutable defaults created fresh in constructor |
| `__post_init__` | Constructor body after field assignments |
| `object.__setattr__` for frozen fields | Assign `readonly` fields only inside the constructor |
| `str` enum (e.g. `MessageType`) | TypeScript string enum |
| `typing.Protocol` / `@runtime_checkable` | TypeScript `interface`; use `instanceof` for concrete classes where runtime dispatch is required |
| `dict[str, Any]` | `Record<string, unknown>` |
| `tuple[T, ...]` | `readonly T[]` |
| `**kwargs: Any` | Options object or rest parameters with an explicit type |
| `__or__` merge operator | Explicit `.merge(other)` method |
| Pydantic models | Zod schemas + inferred types |
| `structlog` | `pino` logger |
| `pytest` fixtures | Bun `beforeEach` + helper factory functions |
| `unittest.mock.AsyncMock` | Bun mocks or small async stub functions |
| `tmp_path` | `tmpDirSync` from `node:fs` / Bun file APIs |
| Exceptions | Custom `Error` subclasses |
| Docstrings | JSDoc comments |

## Decomposition and implementation flow

1. **Bootstrap** — create `package.json`, `tsconfig.json`, and a short `PORTING.md` style guide. The style guide records the mapping rules above, import conventions, and how to handle common patterns so parallel translators stay consistent.
2. **Parallel module translation** — one subagent per Python source file, producing the matching TypeScript module under `./typescript/src/...`. Subagents may reference modules that are translated in parallel; import paths must follow the target layout.
3. **Parallel test translation** — one subagent per Python test file, producing `*.test.ts` under `./typescript/tests/...`.
4. **Integration pass** — run `bun install`, `bun run build` (TypeScript check), and `bun test`. Fix cross-module type mismatches, missing exports, logging setup, and test-helper differences.

## Validation criteria

- `bun install` completes without errors.
- `bun run build` (equivalent to `tsc --noEmit`) passes with `strict: true` and no type errors.
- `bun test` runs the translated suite. Failures caused by legitimate environment differences are documented, but the default expectation is behavioral parity with the Python tests.

## Scope

### In scope

- Translating every source file in `loopengine/` to TypeScript under `./typescript/src/`.
- Translating every test file in `tests/` to TypeScript under `./typescript/tests/`.
- Creating Bun package configuration (`package.json`, `tsconfig.json`).
- Producing a short README for the TypeScript package.

### Out of scope

- Adding new features or changing public API names.
- Modifying the original Python source.
- Publishing the package to npm.
- Changing LoopEngine's behavior to be more "TypeScript-like" beyond idiomatic syntax.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Inconsistent type definitions across parallel translators | Provide a `PORTING.md` style guide; integration pass reconciles mismatches. |
| Python dynamic features (`isinstance`, `getattr`, duck typing) | Map to interfaces + `instanceof` on concrete classes; document cases that need runtime reflection. |
| Test fixture differences between `pytest` and Bun | Translate fixtures to explicit helper factories and `beforeEach` blocks. |
| Mutable-default footguns in dataclasses | Create fresh default arrays/objects inside constructors. |
| Zod schemas drift from original Pydantic behavior | Keep schemas minimal and behavior-equivalent; validate with existing tests. |
