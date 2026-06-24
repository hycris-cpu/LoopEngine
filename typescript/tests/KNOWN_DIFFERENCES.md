# Known Differences: Python → TypeScript Test Port

## Structural Differences

1. **Test framework**: Python uses `pytest` with class-based tests; TypeScript uses `bun:test` with `describe`/`test` blocks.

2. **Immutability enforcement**: Python dataclasses with `frozen=True` raise `FrozenInstanceError` on mutation. TypeScript `readonly` properties only enforce at compile time — runtime JS does not throw. Tests verify field values rather than mutation behavior.

3. **Protocol checks**: Python uses `isinstance(obj, Protocol)` for runtime protocol checking. TypeScript protocols are compile-time only; tests verify duck-typing by checking that required methods/properties exist.

4. **Equality comparison**: Python dataclasses auto-generate `__eq__`. TypeScript classes do not; tests compare individual fields rather than using `==`.

5. **Enum values**: Python `MessageType.SYSTEM == "system"` works directly. TypeScript enums require comparing against the enum member (`MessageType.SYSTEM`) since strict equality with raw strings requires explicit casting.

6. **`pytest.approx`**: No exact Bun equivalent; tests use `toBeCloseTo()` from Bun's test runner.

7. **`pytest.raises`**: Replaced with `expect(() => ...).toThrow()` for sync errors and `expect(async () => ...).rejects.toThrow()` for async errors.

8. **`tmp_path` fixture**: Replaced with `mkdtempSync(os.tmpdir())` helper in `fixtures.ts`.

9. **`@pytest.fixture`**: Replaced with helper factory functions imported from `fixtures.ts`.

10. **`AsyncMock`/`MagicMock`**: Replaced with plain objects implementing required interfaces, or inline async functions.

## Behavior Differences

11. **Tool execution error messages**: Python's error message format `"Tool execution exploded!"` maps to TypeScript's string interpolation `Tool execution error: Error: Tool execution exploded!`. Tests use substring matching to accommodate this.

12. **Run loop `run_id`**: Python uses `run_id="run_..."` format; TypeScript generates `run_` prefixed UUIDs. Tests verify the field exists rather than checking format.

## Files Not Translated

None — all 24 test files were translated.
