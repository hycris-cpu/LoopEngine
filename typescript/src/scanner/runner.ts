/**
 * Bank Statement Scanner — Runner (Entry Point)
 *
 * This module wires the scanner into LoopEngine's evolution loop. It:
 *   1. Loads fingerprint library and scanner config from disk
 *   2. Creates the scanner harness, benchmark, and strategies
 *   3. Configures LoopEngine with the scanner components
 *   4. Runs the evolution loop
 *   5. Saves the evolved fingerprints and config back to disk
 *
 * Usage:
 *   const report = await runScannerEvolution({
 *     pdf_paths: ["path/to/statement.pdf", ...],
 *     fingerprints_dir: "./fingerprints",
 *     config_path: "./scanner_config.json",
 *     max_iterations: 10,
 *   });
 */

import { LoopEngine } from "../evolution/loop_engine";
import { PromotionGate } from "../evolution/promotion";
import { CheckpointStore } from "../evolution/checkpoint";
import type { EvolutionStrategy } from "../evolution/strategies";
import { ScannerHarness, ScannerBenchmark } from "./evolution_integration";
import {
    FingerprintEvolver,
    ScannerPromptEvolver,
    ScannerConfigEvolver,
} from "./strategies";
import type {
    OcrPageResult,
    FingerprintLibrary,
    ScannerConfig,
    StatementResult,
} from "./types";
import { DEFAULT_SCANNER_CONFIG } from "./types";
import { loadFingerprintLibrary, saveFingerprintLibrary } from "./fingerprint";
import { hashFile } from "./cache";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the scanner evolution run.
 */
export interface ScannerRunnerConfig {
    /** Paths to PDF files to use for evaluation. */
    pdf_paths: string[];

    /** Directory containing fingerprint JSON files. */
    fingerprints_dir: string;

    /** Path to scanner_config.json. */
    config_path: string;

    /** Maximum number of evolution iterations (default: 10). */
    max_iterations?: number;

    /** Patience — stop after N iterations without improvement (default: 3). */
    patience?: number;

    /** Path to checkpoint file for resume capability. */
    checkpoint_path?: string;

    /** Whether to resume from a previous checkpoint. */
    resume?: boolean;

    /** Balance tolerance for scoring (default: 0.01). */
    balance_tolerance?: number;

    /** Cache directory for OCR/VLM results. */
    cache_dir?: string;
}

// ---------------------------------------------------------------------------
// runScannerEvolution — the main entry point
// ---------------------------------------------------------------------------

/**
 * Run the scanner evolution loop.
 *
 * This function:
 *   1. Loads fingerprints and config from disk
 *   2. Pre-computes OCR results for all PDFs (with caching)
 *   3. Creates the scanner harness, benchmark, and strategies
 *   4. Configures and runs LoopEngine
 *   5. Saves the evolved fingerprints and config back to disk
 *
 * @param config - The runner configuration
 * @returns An EvolutionReport with the results of the evolution run
 */
export async function runScannerEvolution(
    config: ScannerRunnerConfig,
): Promise<{
    report: unknown;
    evolved_fingerprints: FingerprintLibrary;
    evolved_config: ScannerConfig;
}> {
    // Step 1: Load fingerprints and config
    const fingerprints = await loadFingerprints(config.fingerprints_dir);
    const scannerConfig = await loadScannerConfig(config.config_path);

    // Step 2: Pre-compute OCR results (with caching)
    const ocrResults = await precomputeOcr(config.pdf_paths, config.cache_dir);

    // Step 3: Create evaluation tasks
    const tasks = createEvalTasks(config.pdf_paths, ocrResults);

    // Step 4: Create harness, benchmark, and strategies
    const harness = new ScannerHarness({
        ocr_pages: ocrResults,
        fingerprint_library: fingerprints,
        config: scannerConfig,
    });

    const benchmark = new ScannerBenchmark(config.balance_tolerance ?? 0.01);

    const strategies: EvolutionStrategy[] = [
        new FingerprintEvolver(),
        new ScannerPromptEvolver(),
        new ScannerConfigEvolver(),
    ];

    // Step 5: Create agent_builder function. The LoopEngine only ever calls
    // `run_batch` on the object it returns, so the ScannerHarness (a duck-typed
    // harness) satisfies the contract. We cast through `unknown` because the
    // declared parameter type is the full Harness class.
    const agent_builder = (harnessConfig: Record<string, unknown>) => {
        // Load fingerprints and config from the harnessConfig
        const sourceFiles = harnessConfig.source_files as Record<
            string,
            string
        >;
        const evolvedFingerprints = loadFingerprintsFromSource(
            sourceFiles,
            config.fingerprints_dir,
        );
        const evolvedConfig = loadConfigFromSource(sourceFiles);

        return new ScannerHarness({
            ocr_pages: ocrResults,
            fingerprint_library: evolvedFingerprints,
            config: evolvedConfig,
        });
    };

    // Step 6: Configure LoopEngine
    const gate = new PromotionGate(
        0.01, // min_improvement
        0.02, // no_regression
        true, // require_safety
    );

    const engine = new LoopEngine(
        agent_builder as unknown as ConstructorParameters<typeof LoopEngine>[0],
        benchmark,
        strategies,
        gate,
        undefined, // sandbox
        config.max_iterations ?? 10,
        config.patience ?? 3,
        undefined, // workspace_root
        config.checkpoint_path ?? null,
    );

    // Step 7: Build source_files dict (fingerprint JSON + config)
    const sourceFiles = buildSourceFiles(
        fingerprints,
        scannerConfig,
        config.fingerprints_dir,
    );

    // Step 8: Run the evolution loop
    const report = await engine.run(
        tasks,
        sourceFiles,
        {}, // config (not used for scanner)
        config.resume ?? false,
    );

    // Step 9: Recover the evolved source. The EvolutionReport does not expose
    // the final source files directly, but the LoopEngine persists them to the
    // checkpoint store after every iteration. When a checkpoint path is
    // configured we read the evolved source back from there; otherwise we fall
    // back to the original source (no evolution was persisted).
    let finalSource = sourceFiles;
    if (config.checkpoint_path) {
        const store = new CheckpointStore(config.checkpoint_path);
        const checkpoint = store.load();
        if (checkpoint && Object.keys(checkpoint.current_source).length > 0) {
            finalSource = checkpoint.current_source;
        }
    }

    const evolvedFingerprints = loadFingerprintsFromSource(
        finalSource,
        config.fingerprints_dir,
    );
    const evolvedConfig = loadConfigFromSource(finalSource);

    await saveFingerprints(evolvedFingerprints, config.fingerprints_dir);
    await saveScannerConfig(evolvedConfig, config.config_path);

    return {
        report,
        evolved_fingerprints: evolvedFingerprints,
        evolved_config: evolvedConfig,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load fingerprints from a directory of JSON files.
 */
async function loadFingerprints(dir: string): Promise<FingerprintLibrary> {
    try {
        const { readdir, readFile } = await import("node:fs/promises");
        const files = await readdir(dir);
        const jsonFiles = files.filter((f) => f.endsWith(".json"));

        const fingerprints: Record<string, unknown> = {};
        for (const file of jsonFiles) {
            const content = await readFile(join(dir, file), "utf-8");
            try {
                const fp = JSON.parse(content);
                if (fp && typeof fp === "object" && fp.bank_id) {
                    fingerprints[fp.bank_id] = fp;
                }
            } catch {
                // Skip invalid JSON
            }
        }

        return {
            fingerprints: fingerprints as FingerprintLibrary["fingerprints"],
            total_processed: Object.keys(fingerprints).length,
            last_updated: new Date().toISOString(),
        };
    } catch {
        return {
            fingerprints: {},
            total_processed: 0,
            last_updated: new Date().toISOString(),
        };
    }
}

/**
 * Load scanner config from a JSON file.
 */
async function loadScannerConfig(path: string): Promise<ScannerConfig> {
    try {
        const content = await readFile(path, "utf-8");
        return { ...DEFAULT_SCANNER_CONFIG, ...JSON.parse(content) };
    } catch {
        return DEFAULT_SCANNER_CONFIG;
    }
}

/**
 * Pre-compute OCR results for all PDFs.
 *
 * This is a placeholder — in production, this would call PaddleOCR.
 * For now, it returns empty results that the scanner can handle.
 */
async function precomputeOcr(
    pdfPaths: string[],
    cacheDir?: string,
): Promise<Map<string, OcrPageResult[]>> {
    const results = new Map<string, OcrPageResult[]>();

    for (const pdfPath of pdfPaths) {
        // In production, this would:
        // 1. Check if OCR results are cached
        // 2. If not, call PaddleOCR via Python subprocess
        // 3. Cache the results
        // 4. Return the cached results

        // For now, return empty results
        results.set(pdfPath, []);
    }

    return results;
}

/**
 * Create evaluation tasks from PDF paths and OCR results.
 */
function createEvalTasks(
    pdfPaths: string[],
    ocrResults: Map<string, OcrPageResult[]>,
): Array<{ id: string; ocr_pages: OcrPageResult[] }> {
    return pdfPaths.map((path) => ({
        id: path,
        ocr_pages: ocrResults.get(path) ?? [],
    }));
}

/**
 * Build source_files dict from fingerprints and config.
 */
function buildSourceFiles(
    fingerprints: FingerprintLibrary,
    config: ScannerConfig,
    fingerprintsDir: string,
): Record<string, string> {
    const sourceFiles: Record<string, string> = {};

    // Add fingerprint files. A trailing newline is required so the evolution
    // strategies' whole-file unified diffs apply cleanly (see strategies.ts).
    for (const [bankId, fp] of Object.entries(fingerprints.fingerprints)) {
        sourceFiles[`fingerprints/${bankId}.json`] =
            JSON.stringify(fp, null, 2) + "\n";
    }

    // Add config file (same trailing-newline invariant).
    sourceFiles["scanner_config.json"] = JSON.stringify(config, null, 2) + "\n";

    return sourceFiles;
}

/**
 * Load fingerprints from source_files dict.
 */
function loadFingerprintsFromSource(
    sourceFiles: Record<string, string>,
    fingerprintsDir: string,
): FingerprintLibrary {
    const fingerprints: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(sourceFiles)) {
        if (key.startsWith("fingerprints/") && key.endsWith(".json")) {
            try {
                const fp = JSON.parse(value);
                if (fp && typeof fp === "object" && fp.bank_id) {
                    fingerprints[fp.bank_id] = fp;
                }
            } catch {
                // Skip invalid JSON
            }
        }
    }

    return {
        fingerprints: fingerprints as FingerprintLibrary["fingerprints"],
        total_processed: Object.keys(fingerprints).length,
        last_updated: new Date().toISOString(),
    };
}

/**
 * Load config from source_files dict.
 */
function loadConfigFromSource(
    sourceFiles: Record<string, string>,
): ScannerConfig {
    const configContent = sourceFiles["scanner_config.json"];
    if (configContent) {
        try {
            return { ...DEFAULT_SCANNER_CONFIG, ...JSON.parse(configContent) };
        } catch {
            // Fall through to default
        }
    }
    return DEFAULT_SCANNER_CONFIG;
}

/**
 * Save fingerprints to a directory of JSON files.
 */
async function saveFingerprints(
    library: FingerprintLibrary,
    dir: string,
): Promise<void> {
    await mkdir(dir, { recursive: true });

    for (const [bankId, fp] of Object.entries(library.fingerprints)) {
        const filePath = join(dir, `${bankId}.json`);
        await writeFile(filePath, JSON.stringify(fp, null, 2), "utf-8");
    }
}

/**
 * Save scanner config to a JSON file.
 */
async function saveScannerConfig(
    config: ScannerConfig,
    path: string,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
}
