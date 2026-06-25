/**
 * Bank Statement Scanner — Phase 6 End-to-End Evolution Test
 *
 * This test exercises the FULL evolution stack with mocked OCR (no real
 * PaddleOCR / VLM / model calls):
 *
 *   LoopEngine → ScannerHarness → parser → ScannerJudge → scoring
 *                     ↑                                      │
 *                     └──── strategies propose CodeMods ─────┘
 *
 * Scenario: we seed a fingerprint that is BROKEN (it has no identifiers, so
 * matchFingerprint() returns null and the scanner produces an empty result
 * scoring ~0.15). The FingerprintEvolver detects the missing identifier and
 * proposes a CodeMod that adds the bank name as a header identifier. Once
 * promoted, the fingerprint matches, the parser extracts a balanced ledger,
 * and the score jumps to 1.0.
 *
 * The test asserts:
 *   1. The score strictly improves across the run.
 *   2. The evolved fingerprint JSON differs from the seed (the loop actually
 *      changed the artifact).
 *   3. The scoring/parser/consistency code is NEVER placed in source_files
 *      (anti reward-hacking guarantee).
 *   4. The judge scores the REAL extraction (not ground truth or a stub).
 */

import { describe, test, expect } from "bun:test";
import { LoopEngine } from "../src/evolution/loop_engine";
import { PromotionGate } from "../src/evolution/promotion";
import {
    ScannerHarness,
    ScannerBenchmark,
    ScannerJudge,
} from "../src/scanner/evolution_integration";
import {
    FingerprintEvolver,
    ScannerPromptEvolver,
    ScannerConfigEvolver,
} from "../src/scanner/strategies";
import type {
    OcrPageResult,
    OcrTextBlock,
    BankFingerprint,
    FingerprintLibrary,
    ScannerConfig,
} from "../src/scanner/types";
import type { ScannerTask } from "../src/scanner/evolution_integration";
import { DEFAULT_SCANNER_CONFIG } from "../src/scanner/types";
import { Trajectory } from "../src/primitives/trajectory";

// ---------------------------------------------------------------------------
// Mocked OCR fixtures — a balanced statement (no real OCR engine involved)
// ---------------------------------------------------------------------------

function makeBlock(text: string, x = 0, y = 0, w = 100, h = 15): OcrTextBlock {
    return { text, bbox: [x, y, w, h], confidence: 0.95 };
}

function makePage(blocks: OcrTextBlock[], page = 0): OcrPageResult {
    return {
        page_number: page,
        text: blocks.map((b) => b.text).join("\n"),
        blocks,
        dimensions: [595, 842],
        confidence: 0.95,
    };
}

/**
 * A balanced statement: opening 1000 + credits 5000 - debits 2000 = closing 4000.
 * The balance arithmetic check (scoring weight 0.5) passes only when the
 * fingerprint matches and the parser extracts these values.
 */
const STATEMENT_PAGES: OcrPageResult[] = [
    makePage([
        makeBlock("Commonwealth Bank", 50, 30, 200, 20),
        makeBlock("John Doe", 50, 80, 120, 15),
        makeBlock("BSB: 062-000", 50, 100, 120, 15),
        makeBlock("Acct: 12345678", 200, 100, 150, 15),
        // Transactions (body region)
        makeBlock("15/01/2024", 50, 300, 80, 15),
        makeBlock("SALARY", 150, 300, 100, 15),
        makeBlock("5000.00", 500, 300, 80, 15),
        makeBlock("16/01/2024", 50, 330, 80, 15),
        makeBlock("RENT", 150, 330, 100, 15),
        makeBlock("2000.00", 420, 330, 80, 15),
        // Summary (footer region)
        makeBlock("Opening 1000.00", 50, 760, 200, 15),
        makeBlock("Credits 5000.00", 50, 775, 200, 15),
        makeBlock("Debits 2000.00", 50, 790, 200, 15),
        makeBlock("Closing 4000.00", 50, 805, 200, 15),
    ]),
];

/**
 * A fingerprint that is structurally complete EXCEPT it has no identifiers.
 * matchFingerprint() therefore returns null and the scanner cannot process
 * the statement. This is the defect the evolution loop must repair.
 */
function makeBrokenFingerprint(): BankFingerprint {
    return {
        bank_id: "cba",
        bank_name: "Commonwealth Bank",
        identifiers: [], // <-- the defect
        layout: {
            page: { width: 595, height: 842, margins: [50, 50, 50, 50] },
            account_info: {
                y_range: [0.0, 0.15],
                fields: [],
                start_pattern: "",
                end_pattern: "",
            },
            transactions: {
                columns: [
                    { name: "date", x_range: [0.0, 0.18], alignment: "left" },
                    {
                        name: "description",
                        x_range: [0.2, 0.5],
                        alignment: "left",
                    },
                    { name: "debit", x_range: [0.55, 0.7], alignment: "right" },
                    {
                        name: "credit",
                        x_range: [0.72, 0.85],
                        alignment: "right",
                    },
                    {
                        name: "balance",
                        x_range: [0.87, 1.0],
                        alignment: "right",
                    },
                ],
                header_pattern: "",
                footer_pattern: "",
                multiline_transactions: false,
                balance_position: "separate_column",
            },
            summary: {
                y_range: [0.85, 1.0],
                fields: [],
                start_pattern: "",
                end_pattern: "",
            },
            date_format: "DD/MM/YYYY",
            currency_prefix: "$",
            debit_style: "separate_column",
            column_delimiter: "whitespace",
        },
        confidence: 0.8,
        sample_count: 5,
        last_updated: "2024-01-01T00:00:00Z",
        version: 1,
    };
}

// ---------------------------------------------------------------------------
// Helpers mirroring the runner's source <-> object translation (JSON only)
// ---------------------------------------------------------------------------

function loadFingerprintsFromSource(
    source: Record<string, string>,
): FingerprintLibrary {
    const fingerprints: Record<string, BankFingerprint> = {};
    for (const [key, value] of Object.entries(source)) {
        if (key.startsWith("fingerprints/") && key.endsWith(".json")) {
            const fp = JSON.parse(value) as BankFingerprint;
            fingerprints[fp.bank_id] = fp;
        }
    }
    return {
        fingerprints,
        total_processed: Object.keys(fingerprints).length,
        last_updated: "",
    };
}

function loadConfigFromSource(source: Record<string, string>): ScannerConfig {
    const content = source["scanner_config.json"];
    return content
        ? { ...DEFAULT_SCANNER_CONFIG, ...JSON.parse(content) }
        : DEFAULT_SCANNER_CONFIG;
}

// ---------------------------------------------------------------------------
// E2E test
// ---------------------------------------------------------------------------

describe("Scanner evolution E2E", () => {
    test("loop repairs a broken fingerprint and improves the score", async () => {
        const ocr = new Map<string, OcrPageResult[]>();
        ocr.set("statement.pdf", STATEMENT_PAGES);

        const tasks: ScannerTask[] = [{ id: "statement.pdf", ocr_pages: [] }];

        // Track every source_files dict the agent_builder ever receives so we
        // can assert the locked code is never smuggled into the evolvable set.
        const observedSourceKeys = new Set<string>();

        const agentBuilder = (hc: Record<string, unknown>) => {
            const source = hc.source_files as Record<string, string>;
            for (const key of Object.keys(source)) observedSourceKeys.add(key);
            return new ScannerHarness({
                ocr_pages: ocr,
                fingerprint_library: loadFingerprintsFromSource(source),
                config: loadConfigFromSource(source),
            });
        };

        const benchmark = new ScannerBenchmark(0.01);
        const strategies = [
            new FingerprintEvolver(),
            new ScannerPromptEvolver(),
            new ScannerConfigEvolver(),
        ];
        const gate = new PromotionGate(0.01, 0.02, true);

        const engine = new LoopEngine(
            agentBuilder as unknown as ConstructorParameters<
                typeof LoopEngine
            >[0],
            benchmark,
            strategies,
            gate,
            undefined,
            5, // max_iterations
            3, // patience
        );

        // Seed source: ONLY JSON artifacts (broken fingerprint + default config).
        // Note trailing newline — the strategies' whole-file diffs require it.
        const seedFingerprintJson =
            JSON.stringify(makeBrokenFingerprint(), null, 2) + "\n";
        const sourceFiles: Record<string, string> = {
            "fingerprints/cba.json": seedFingerprintJson,
            "scanner_config.json":
                JSON.stringify(DEFAULT_SCANNER_CONFIG, null, 2) + "\n",
        };

        const report = await engine.run(tasks, sourceFiles, {}, false);

        // 1. The loop promoted at least one improvement and reached a high score.
        expect(report.improvements).toBeGreaterThanOrEqual(1);
        expect(report.final_score).toBeGreaterThan(0.9);

        // 2. The baseline (broken) score must be far below the final score —
        //    confirms a real, measurable improvement, not a no-op.
        const baselineLibrary: FingerprintLibrary =
            loadFingerprintsFromSource(sourceFiles);
        const baselineHarness = new ScannerHarness({
            ocr_pages: ocr,
            fingerprint_library: baselineLibrary,
            config: DEFAULT_SCANNER_CONFIG,
        });
        const baselineRun = await baselineHarness.run_batch(tasks);
        const judge = new ScannerJudge(0.01);
        const baselineEval = await judge.evaluate(
            baselineRun[0].trajectory as Trajectory,
            tasks[0],
        );
        expect(baselineEval.score).toBeLessThan(0.3);
        expect(report.final_score - baselineEval.score).toBeGreaterThan(0.5);

        // 3. Anti reward-hacking: the evolvable source set must contain ONLY
        //    JSON artifacts — never the locked scoring/parser/consistency code.
        for (const key of observedSourceKeys) {
            const isFingerprint =
                key.startsWith("fingerprints/") && key.endsWith(".json");
            const isConfig = key === "scanner_config.json";
            expect(isFingerprint || isConfig).toBe(true);
        }
        // Locked modules must be absent.
        for (const locked of [
            "scoring.ts",
            "consistency.ts",
            "parser.ts",
            "evolution_integration.ts",
        ]) {
            for (const key of observedSourceKeys) {
                expect(key.includes(locked)).toBe(false);
            }
        }
    });

    test("judge scores the real extraction carried through the trajectory", async () => {
        // The harness must propagate the parsed StatementResult into the
        // trajectory so the judge scores actual output, not ground truth.
        const ocr = new Map<string, OcrPageResult[]>();
        const fixed = makeBrokenFingerprint();
        fixed.identifiers = [
            {
                pattern: "Commonwealth Bank",
                location: "header",
                is_regex: false,
            },
        ];
        ocr.set("statement.pdf", STATEMENT_PAGES);

        const harness = new ScannerHarness({
            ocr_pages: ocr,
            fingerprint_library: {
                fingerprints: { cba: fixed },
                total_processed: 1,
                last_updated: "",
            },
            config: DEFAULT_SCANNER_CONFIG,
        });

        const tasks: ScannerTask[] = [{ id: "statement.pdf", ocr_pages: [] }];
        const runResults = await harness.run_batch(tasks);

        // The trajectory metadata carries the serialized, REAL extraction.
        const meta = (runResults[0].trajectory as Trajectory).metadata;
        expect(typeof meta.statement_result).toBe("string");
        const parsed = JSON.parse(meta.statement_result as string);
        expect(parsed.bank_id).toBe("cba");
        expect(parsed.transactions.length).toBe(2);

        // The judge, given NO ground_truth, must still score the real result.
        const judge = new ScannerJudge(0.01);
        const evalResult = await judge.evaluate(
            runResults[0].trajectory as Trajectory,
            tasks[0],
        );
        expect(evalResult.score).toBeGreaterThan(0.9);
        expect(evalResult.passed).toBe(true);
    });
});
