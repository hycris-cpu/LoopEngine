/**
 * Shared test fixtures and helper factories for the LoopEngine test suite.
 *
 * Mirrors tests/conftest.py from the Python implementation.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Generate a unique run_id for test isolation. */
export function makeRunId(): string {
  return randomUUID();
}

/** Create a temporary directory that is unique per call. */
export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'loopengine-test-'));
}

/** Collect all items from an async iterable into an array. */
export async function collectAsync<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

/** Approximate floating-point comparison (like pytest.approx). */
export function approx(actual: number, expected: number, tolerance = 0.001): boolean {
  return Math.abs(actual - expected) < tolerance;
}
