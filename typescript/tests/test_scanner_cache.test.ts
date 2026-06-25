import { describe, test, expect } from "bun:test";
import {
  hashFile,
  hashString,
  getOcrCachePath,
  getVlmCachePath,
  loadFromCache,
  saveToCache,
} from "../src/scanner/cache";

// ---------------------------------------------------------------------------
// hashFile / hashString — deterministic hashing
// ---------------------------------------------------------------------------

describe("hashFile", () => {
  test("produces a stable hex hash for the same content", async () => {
    const content = new TextEncoder().encode("test pdf content");
    const hash1 = await hashFile(content);
    const hash2 = await hashFile(content);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{16}$/); // 16 hex chars
  });

  test("produces different hashes for different content", async () => {
    const content1 = new TextEncoder().encode("pdf version 1");
    const content2 = new TextEncoder().encode("pdf version 2");
    const hash1 = await hashFile(content1);
    const hash2 = await hashFile(content2);
    expect(hash1).not.toBe(hash2);
  });
});

describe("hashString", () => {
  test("produces a stable hex hash for the same string", async () => {
    const hash1 = await hashString("test prompt");
    const hash2 = await hashString("test prompt");
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{16}$/);
  });

  test("produces different hashes for different strings", async () => {
    const hash1 = await hashString("prompt v1");
    const hash2 = await hashString("prompt v2");
    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// Cache path generation
// ---------------------------------------------------------------------------

describe("getOcrCachePath", () => {
  test("includes the file hash in the path", async () => {
    const content = new TextEncoder().encode("test pdf");
    const fileHash = await hashFile(content);
    const path = getOcrCachePath(fileHash, 0);
    expect(path).toContain(fileHash);
    expect(path).toContain("page_0");
    expect(path).toMatch(/\.json$/);
  });
});

describe("getVlmCachePath", () => {
  test("includes both file hash and prompt hash", async () => {
    const fileHash = "abc123def456";
    const promptHash = await hashString("test prompt");
    const path = getVlmCachePath(fileHash, promptHash, 0);
    expect(path).toContain(fileHash);
    expect(path).toContain(promptHash);
    expect(path).toContain("page_0");
    expect(path).toMatch(/\.json$/);
  });
});

// ---------------------------------------------------------------------------
// loadFromCache / saveToCache — disk persistence
// ---------------------------------------------------------------------------

describe("Cache round-trip", () => {
  test("saves and loads OCR results to/from cache", async () => {
    const cacheDir = `/tmp/loopengine_test_cache_${Date.now()}`;
    const data = {
      page_number: 0,
      text: "test ocr text",
      blocks: [],
      dimensions: [595, 842],
      confidence: 0.95,
    };
    const cachePath = `${cacheDir}/test_ocr.json`;
    await saveToCache(cachePath, data);
    const loaded = await loadFromCache(cachePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.page_number).toBe(0);
    expect(loaded!.text).toBe("test ocr text");
  });

  test("returns null for non-existent cache file", async () => {
    const loaded = await loadFromCache("/tmp/nonexistent_cache_file.json");
    expect(loaded).toBeNull();
  });
});
