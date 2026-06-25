/**
 * Bank Statement Scanner — Caching Layer
 *
 * Provides disk-based caching for OCR and VLM results to avoid redundant
 * expensive operations during the evolution loop.
 *
 * Cache strategy:
 *   - OCR cache: keyed by (pdf_file_hash, page_number). OCR output doesn't
 *     change when fingerprints or prompts change, so it's the most stable cache.
 *   - VLM cache: keyed by (pdf_file_hash, prompt_hash, page_number). VLM
 *     output only needs re-running when the prompt changes.
 *
 * The cache lives under a configurable root directory (default: ./cache/).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Hashing — deterministic, collision-resistant identifiers
// ---------------------------------------------------------------------------

/**
 * Compute a truncated SHA-256 hash of file content (for cache keys).
 * Returns 16 hex characters (64 bits) — sufficient for cache key uniqueness.
 */
export async function hashFile(content: Uint8Array): Promise<string> {
  const hash = createHash("sha256").update(content).digest("hex");
  return hash.slice(0, 16);
}

/**
 * Compute a truncated SHA-256 hash of a string (for prompt cache keys).
 */
export async function hashString(text: string): Promise<string> {
  const hash = createHash("sha256").update(text).digest("hex");
  return hash.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Cache path generation
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_ROOT = "./cache";

/**
 * Generate the cache file path for an OCR result.
 *
 * Format: {cache_root}/ocr/{file_hash}/page_{page_num}.json
 */
export function getOcrCachePath(
  fileHash: string,
  pageNum: number,
  cacheRoot = DEFAULT_CACHE_ROOT,
): string {
  return join(cacheRoot, "ocr", fileHash, `page_${pageNum}.json`);
}

/**
 * Generate the cache file path for a VLM result.
 *
 * Format: {cache_root}/vlm/{file_hash}/{prompt_hash}/page_{page_num}.json
 */
export function getVlmCachePath(
  fileHash: string,
  promptHash: string,
  pageNum: number,
  cacheRoot = DEFAULT_CACHE_ROOT,
): string {
  return join(cacheRoot, "vlm", fileHash, promptHash, `page_${pageNum}.json`);
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

/**
 * Save data to a cache file. Creates parent directories as needed.
 */
export async function saveToCache(
  cachePath: string,
  data: unknown,
): Promise<void> {
  const dir = dirname(cachePath);
  await mkdir(dir, { recursive: true });
  await writeFile(cachePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Load data from a cache file. Returns null if the file doesn't exist
 * or can't be parsed.
 */
export async function loadFromCache<T = unknown>(
  cachePath: string,
): Promise<T | null> {
  try {
    const content = await readFile(cachePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Batch cache operations
// ---------------------------------------------------------------------------

/**
 * Check if all OCR pages for a file are cached.
 */
export async function isOcrCached(
  fileHash: string,
  pageCount: number,
  cacheRoot = DEFAULT_CACHE_ROOT,
): Promise<boolean> {
  for (let i = 0; i < pageCount; i++) {
    const path = getOcrCachePath(fileHash, i, cacheRoot);
    const data = await loadFromCache(path);
    if (data === null) return false;
  }
  return true;
}

/**
 * Check if all VLM pages for a file+prompt combination are cached.
 */
export async function isVlmCached(
  fileHash: string,
  promptHash: string,
  pageCount: number,
  cacheRoot = DEFAULT_CACHE_ROOT,
): Promise<boolean> {
  for (let i = 0; i < pageCount; i++) {
    const path = getVlmCachePath(fileHash, promptHash, i, cacheRoot);
    const data = await loadFromCache(path);
    if (data === null) return false;
  }
  return true;
}

/**
 * Load all cached OCR pages for a file.
 */
export async function loadOcrCache(
  fileHash: string,
  pageCount: number,
  cacheRoot = DEFAULT_CACHE_ROOT,
): Promise<unknown[] | null> {
  const results: unknown[] = [];
  for (let i = 0; i < pageCount; i++) {
    const path = getOcrCachePath(fileHash, i, cacheRoot);
    const data = await loadFromCache(path);
    if (data === null) return null;
    results.push(data);
  }
  return results;
}

/**
 * Load all cached VLM pages for a file+prompt combination.
 */
export async function loadVlmCache(
  fileHash: string,
  promptHash: string,
  pageCount: number,
  cacheRoot = DEFAULT_CACHE_ROOT,
): Promise<unknown[] | null> {
  const results: unknown[] = [];
  for (let i = 0; i < pageCount; i++) {
    const path = getVlmCachePath(fileHash, promptHash, i, cacheRoot);
    const data = await loadFromCache(path);
    if (data === null) return null;
    results.push(data);
  }
  return results;
}
