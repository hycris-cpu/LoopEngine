import { describe, test, expect } from "bun:test";
import {
    ScannerHarness,
    ScannerJudge,
    ScannerBenchmark,
} from "../src/scanner/evolution_integration";
import {
    FingerprintEvolver,
    ScannerPromptEvolver,
    ScannerConfigEvolver,
} from "../src/scanner/strategies";
import type {
    ScannerTask,
    StatementResult,
    OcrPageResult,
    FingerprintLibrary,
    ScannerConfig,
    BankFingerprint,
} from "../src/scanner/types";
import { DEFAULT_SCANNER_CONFIG } from "../src/scanner/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CBA_FINGERPRINT: BankFingerprint = {
    bank_id: "cba",
    bank_name: "Commonwealth Bank",
    identifiers: [
        { pattern: "Commonwealth Bank", location: "header", is_regex: false },
    ],
    layout: {
        page: { width: 595, height: 842, margins: [50, 50, 50, 50] },
        account_info: {
            y_range: [0.0, 0.15],
            fields: ["account_holder", "bsb", "account_number"],
            start_pattern: "Account",
            end_pattern: "Date",
        },
        transactions: {
            columns: [
                { name: "date", x_range: [0.0, 0.2], alignment: "left" },
                {
                    name: "description",
                    x_range: [0.2, 0.55],
                    alignment: "left",
                },
                { name: "debit", x_range: [0.55, 0.7], alignment: "right" },
                { name: "credit", x_range: [0.7, 0.85], alignment: "right" },
                { name: "balance", x_range: [0.85, 1.0], alignment: "right" },
            ],
            header_pattern: "Date",
            footer_pattern: "Closing",
            multiline_transactions: true,
            balance_position: "separate_column",
        },
        summary: {
            y_range: [0.85, 1.0],
            fields: ["opening_balance", "closing_balance"],
            start_pattern: "Opening",
            end_pattern: "Closing",
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

const SAMPLE_LIBRARY: FingerprintLibrary = {
    fingerprints: { cba: CBA_FINGERPRINT },
    total_processed: 1,
    last_updated: "2024-01-01T00:00:00Z",
};

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

// ---------------------------------------------------------------------------
// ScannerHarness
// ---------------------------------------------------------------------------

describe("ScannerHarness", () => {
    test("processes a task with matching fingerprint", async () => {
        const ocrPages = new Map<string, OcrPageResult[]>();
        ocrPages.set("test.pdf", [
            makePage([
                makeBlock("Commonwealth Bank", 50, 30, 200, 20),
                makeBlock("John Doe", 50, 80, 120, 15),
                makeBlock("BSB: 062-000", 50, 100, 120, 15),
                makeBlock("Acct: 12345678", 200, 100, 150, 15),
                makeBlock("15/01/2024", 50, 200, 80, 15),
                makeBlock("SALARY", 150, 200, 100, 15),
                makeBlock("5000.00", 420, 200, 80, 15),
                makeBlock("5000.00", 500, 200, 80, 15),
            ]),
        ]);

        const harness = new ScannerHarness({
            ocr_pages: ocrPages,
            fingerprint_library: SAMPLE_LIBRARY,
            config: DEFAULT_SCANNER_CONFIG,
        });

        const tasks: ScannerTask[] = [{ id: "test.pdf", ocr_pages: [] }];

        const results = await harness.run_batch(tasks);
        expect(results.length).toBe(1);
        expect(results[0].trajectory.task_id).toBe("test.pdf");
    });

    test("handles task with no matching fingerprint", async () => {
        const ocrPages = new Map<string, OcrPageResult[]>();
        ocrPages.set("unknown.pdf", [
            makePage([makeBlock("Some Bank", 50, 30, 100, 20)]),
        ]);

        const harness = new ScannerHarness({
            ocr_pages: ocrPages,
            fingerprint_library: SAMPLE_LIBRARY,
            config: DEFAULT_SCANNER_CONFIG,
        });

        const tasks: ScannerTask[] = [{ id: "unknown.pdf", ocr_pages: [] }];

        const results = await harness.run_batch(tasks);
        expect(results.length).toBe(1);
        expect(results[0].trajectory.task_id).toBe("unknown.pdf");
    });

    test("handles empty task list", async () => {
        const harness = new ScannerHarness({
            ocr_pages: new Map(),
            fingerprint_library: SAMPLE_LIBRARY,
            config: DEFAULT_SCANNER_CONFIG,
        });

        const results = await harness.run_batch([]);
        expect(results.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// ScannerJudge
// ---------------------------------------------------------------------------

describe("ScannerJudge", () => {
    test("scores a well-formed result high", async () => {
        const judge = new ScannerJudge();

        const groundTruth: StatementResult = {
            source_file: "test.pdf",
            is_bank_statement: true,
            bank_id: "cba",
            fingerprint_version: 1,
            account: {
                account_holder: {
                    value: "John Doe",
                    source: "ocr",
                    confidence: 0.9,
                },
                bsb: { value: "062-000", source: "ocr", confidence: 0.9 },
                account_number: {
                    value: "12345678",
                    source: "ocr",
                    confidence: 0.9,
                },
                bank_name: { value: "CBA", source: "ocr", confidence: 0.9 },
                branch: { value: "Sydney", source: "ocr", confidence: 0.9 },
            },
            transactions: [
                {
                    date: {
                        value: "2024-01-15",
                        source: "ocr",
                        confidence: 0.9,
                    },
                    description: {
                        value: "SALARY",
                        source: "ocr",
                        confidence: 0.9,
                    },
                    debit: { value: null, source: "ocr", confidence: 0.9 },
                    credit: { value: 5000.0, source: "ocr", confidence: 0.9 },
                    balance: { value: 5000.0, source: "ocr", confidence: 0.9 },
                    reference: {
                        value: "PAY001",
                        source: "ocr",
                        confidence: 0.9,
                    },
                },
                {
                    date: {
                        value: "2024-01-16",
                        source: "ocr",
                        confidence: 0.9,
                    },
                    description: {
                        value: "RENT",
                        source: "ocr",
                        confidence: 0.9,
                    },
                    debit: { value: 2000.0, source: "ocr", confidence: 0.9 },
                    credit: { value: null, source: "ocr", confidence: 0.9 },
                    balance: { value: 3000.0, source: "ocr", confidence: 0.9 },
                    reference: { value: "", source: "ocr", confidence: 0.9 },
                },
            ],
            period: {
                start_date: {
                    value: "2024-01-01",
                    source: "ocr",
                    confidence: 0.9,
                },
                end_date: {
                    value: "2024-01-31",
                    source: "ocr",
                    confidence: 0.9,
                },
                statement_date: {
                    value: "2024-02-01",
                    source: "ocr",
                    confidence: 0.9,
                },
            },
            summary: {
                opening_balance: { value: 0.0, source: "ocr", confidence: 0.9 },
                closing_balance: {
                    value: 3000.0,
                    source: "ocr",
                    confidence: 0.9,
                },
                total_credits: {
                    value: 5000.0,
                    source: "ocr",
                    confidence: 0.9,
                },
                total_debits: { value: 2000.0, source: "ocr", confidence: 0.9 },
            },
            consistency: {
                agreement_score: 0.95,
                field_comparisons: [],
                agreements: 10,
                disagreements: 1,
                missing_in_ocr: [],
                missing_in_vlm: [],
                is_consistent: true,
            },
            metadata: {
                processing_time_ms: 1000,
                page_count: 1,
                ocr_engine: "paddleocr",
                vlm_model: "gpt-4o",
                processed_at: "2024-01-01T00:00:00Z",
                warnings: [],
            },
        };

        const trajectory = new (
            await import("../src/primitives/trajectory")
        ).Trajectory({
            task_id: "test.pdf",
            metadata: { bank_id: "cba" },
        });

        const task: ScannerTask = {
            id: "test.pdf",
            ocr_pages: [],
            ground_truth: groundTruth,
        };

        const result = await judge.evaluate(trajectory, task);
        expect(result.score).toBeGreaterThan(0.9);
        expect(result.passed).toBe(true);
    });

    test("scores an empty result low", async () => {
        const judge = new ScannerJudge();

        const trajectory = new (
            await import("../src/primitives/trajectory")
        ).Trajectory({
            task_id: "empty.pdf",
            metadata: {},
        });

        const task: ScannerTask = {
            id: "empty.pdf",
            ocr_pages: [],
        };

        const result = await judge.evaluate(trajectory, task);
        expect(result.score).toBeLessThan(0.5);
        expect(result.passed).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// ScannerBenchmark
// ---------------------------------------------------------------------------

describe("ScannerBenchmark", () => {
    test("creates benchmark with scanner judge", () => {
        const benchmark = new ScannerBenchmark();
        expect(benchmark.judge.name).toBe("scanner_judge");
    });
});

// ---------------------------------------------------------------------------
// FingerprintEvolver
// ---------------------------------------------------------------------------

describe("FingerprintEvolver", () => {
    test("proposes adjustments for fingerprint with no identifiers", () => {
        const evolver = new FingerprintEvolver();

        const sourceCode: Record<string, string> = {
            "fingerprints/test.json": JSON.stringify({
                bank_id: "test",
                bank_name: "Test Bank",
                identifiers: [],
                layout: {
                    page: {
                        width: 595,
                        height: 842,
                        margins: [50, 50, 50, 50],
                    },
                    account_info: {
                        y_range: [0.0, 0.15],
                        fields: [],
                        start_pattern: "",
                        end_pattern: "",
                    },
                    transactions: {
                        columns: [
                            {
                                name: "date",
                                x_range: [0.0, 0.2],
                                alignment: "left",
                            },
                            {
                                name: "description",
                                x_range: [0.2, 0.55],
                                alignment: "left",
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
                sample_count: 1,
                last_updated: "2024-01-01T00:00:00Z",
                version: 1,
            }),
        };

        const mods = evolver.propose({}, {}, {}, sourceCode);
        expect(mods.length).toBeGreaterThan(0);
        expect(mods[0].rationale).toContain("identifiers");
    });

    test("proposes adjustments for fingerprint with high confidence but few samples", () => {
        const evolver = new FingerprintEvolver();

        const sourceCode: Record<string, string> = {
            "fingerprints/test.json": JSON.stringify({
                bank_id: "test",
                bank_name: "Test Bank",
                identifiers: [
                    {
                        pattern: "Test Bank",
                        location: "header",
                        is_regex: false,
                    },
                ],
                layout: {
                    page: {
                        width: 595,
                        height: 842,
                        margins: [50, 50, 50, 50],
                    },
                    account_info: {
                        y_range: [0.0, 0.15],
                        fields: [],
                        start_pattern: "",
                        end_pattern: "",
                    },
                    transactions: {
                        columns: [
                            {
                                name: "date",
                                x_range: [0.0, 0.2],
                                alignment: "left",
                            },
                            {
                                name: "description",
                                x_range: [0.2, 0.55],
                                alignment: "left",
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
                confidence: 0.9,
                sample_count: 1,
                last_updated: "2024-01-01T00:00:00Z",
                version: 1,
            }),
        };

        const mods = evolver.propose({}, {}, {}, sourceCode);
        expect(mods.length).toBeGreaterThan(0);
        expect(mods[0].rationale).toContain("too high");
    });

    test("returns no mods for well-configured fingerprint", () => {
        const evolver = new FingerprintEvolver();

        const sourceCode: Record<string, string> = {
            "fingerprints/cba.json": JSON.stringify({
                bank_id: "cba",
                bank_name: "Commonwealth Bank",
                identifiers: [
                    {
                        pattern: "Commonwealth Bank",
                        location: "header",
                        is_regex: false,
                    },
                ],
                layout: {
                    page: {
                        width: 595,
                        height: 842,
                        margins: [50, 50, 50, 50],
                    },
                    account_info: {
                        y_range: [0.0, 0.15],
                        fields: [],
                        start_pattern: "",
                        end_pattern: "",
                    },
                    transactions: {
                        columns: [
                            {
                                name: "date",
                                x_range: [0.0, 0.15],
                                alignment: "left",
                            },
                            {
                                name: "description",
                                x_range: [0.2, 0.55],
                                alignment: "left",
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
                confidence: 0.5,
                sample_count: 5,
                last_updated: "2024-01-01T00:00:00Z",
                version: 1,
            }),
        };

        const mods = evolver.propose({}, {}, {}, sourceCode);
        // Should not propose any mods for a well-configured fingerprint
        expect(mods.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// ScannerPromptEvolver
// ---------------------------------------------------------------------------

describe("ScannerPromptEvolver", () => {
    test("proposes improvements for prompts missing JSON requirement", () => {
        const evolver = new ScannerPromptEvolver();

        const sourceCode: Record<string, string> = {
            "scanner_config.json": JSON.stringify({
                ...DEFAULT_SCANNER_CONFIG,
                vlm_system_prompt: "Extract data from bank statements.",
            }),
        };

        const mods = evolver.propose({}, {}, {}, sourceCode);
        expect(mods.length).toBeGreaterThan(0);
        expect(mods[0].rationale).toContain("JSON");
    });

    test("proposes improvements for prompts missing page context", () => {
        const evolver = new ScannerPromptEvolver();

        const sourceCode: Record<string, string> = {
            "scanner_config.json": JSON.stringify({
                ...DEFAULT_SCANNER_CONFIG,
                vlm_user_prompt: "Extract all data. Respond with JSON.",
            }),
        };

        const mods = evolver.propose({}, {}, {}, sourceCode);
        expect(mods.length).toBeGreaterThan(0);
        expect(mods[0].rationale).toContain("page context");
    });

    test("returns no mods for well-configured prompts", () => {
        const evolver = new ScannerPromptEvolver();

        const sourceCode: Record<string, string> = {
            "scanner_config.json": JSON.stringify(DEFAULT_SCANNER_CONFIG),
        };

        const mods = evolver.propose({}, {}, {}, sourceCode);
        // The default config should already have good prompts
        expect(mods.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// ScannerConfigEvolver
// ---------------------------------------------------------------------------

describe("ScannerConfigEvolver", () => {
    test("proposes threshold adjustments for overly strict config", () => {
        const evolver = new ScannerConfigEvolver();

        const sourceCode: Record<string, string> = {
            "scanner_config.json": JSON.stringify({
                ...DEFAULT_SCANNER_CONFIG,
                confidence_threshold: 0.9,
                balance_tolerance: 0.001,
                consistency_threshold: 0.95,
            }),
        };

        const mods = evolver.propose({}, {}, {}, sourceCode);
        expect(mods.length).toBeGreaterThan(0);
        expect(mods[0].rationale).toContain("threshold");
    });

    test("returns no mods for well-calibrated config", () => {
        const evolver = new ScannerConfigEvolver();

        const sourceCode: Record<string, string> = {
            "scanner_config.json": JSON.stringify(DEFAULT_SCANNER_CONFIG),
        };

        const mods = evolver.propose({}, {}, {}, sourceCode);
        // The default config should be well-calibrated
        expect(mods.length).toBe(0);
    });
});
