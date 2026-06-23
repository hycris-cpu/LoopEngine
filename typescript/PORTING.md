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
| `@dataclass(frozen=True)` | `class` with `readonly` properties, assigned only in the constructor |
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
