import { describe, test, expect } from "bun:test";
import {
    matchFingerprint,
    createFingerprint,
    refineFingerprint,
    loadFingerprintLibrary,
    saveFingerprintLibrary,
} from "../src/scanner/fingerprint";
import type {
    BankFingerprint,
    BankIdentifier,
    OcrTextBlock,
    OcrPageResult,
    FingerprintLibrary,
} from "../src/scanner/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOcrPage(blocks: Partial<OcrTextBlock>[], page = 0): OcrPageResult {
    return {
        page_number: page,
        text: blocks.map((b) => b.text ?? "").join("\n"),
        blocks: blocks.map((b) => ({
            text: b.text ?? "",
            bbox: b.bbox ?? [0, 0, 100, 20],
            confidence: b.confidence ?? 0.95,
        })),
        dimensions: [595, 842], // A4 in points
        confidence: 0.95,
    };
}

const CBA_IDENTIFIERS: BankIdentifier[] = [
    {
        pattern: "Commonwealth Bank",
        location: "header",
        is_regex: false,
    },
    {
        pattern: "NetBank",
        location: "anywhere",
        is_regex: false,
    },
    {
        pattern: "CBA",
        location: "anywhere",
        is_regex: false,
    },
];

const WESTPAC_IDENTIFIERS: BankIdentifier[] = [
    {
        pattern: "Westpac",
        location: "header",
        is_regex: false,
    },
    {
        pattern: "Westpac Banking",
        location: "anywhere",
        is_regex: false,
    },
];

const CBA_FINGERPRINT: BankFingerprint = {
    bank_id: "cba",
    bank_name: "Commonwealth Bank of Australia",
    identifiers: CBA_IDENTIFIERS,
    layout: {
        page: { width: 595, height: 842, margins: [50, 50, 50, 50] },
        account_info: {
            y_range: [0.0, 0.15],
            fields: ["account_holder", "bsb", "account_number"],
            start_pattern: "Account Details",
            end_pattern: "Transaction",
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
            header_pattern: "Date.*Description.*Debit.*Credit.*Balance",
            footer_pattern: "Closing Balance",
            multiline_transactions: true,
            balance_position: "separate_column",
        },
        summary: {
            y_range: [0.9, 1.0],
            fields: ["opening_balance", "closing_balance"],
            start_pattern: "Opening Balance",
            end_pattern: "Closing Balance",
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

const WESTPAC_FINGERPRINT: BankFingerprint = {
    bank_id: "westpac",
    bank_name: "Westpac Banking Corporation",
    identifiers: WESTPAC_IDENTIFIERS,
    layout: {
        page: { width: 595, height: 842, margins: [40, 40, 40, 40] },
        account_info: {
            y_range: [0.0, 0.12],
            fields: ["account_holder", "account_number"],
            start_pattern: "Account",
            end_pattern: "Date",
        },
        transactions: {
            columns: [
                { name: "date", x_range: [0.0, 0.2], alignment: "left" },
                { name: "description", x_range: [0.2, 0.5], alignment: "left" },
                { name: "debit", x_range: [0.5, 0.65], alignment: "right" },
                { name: "credit", x_range: [0.65, 0.8], alignment: "right" },
                { name: "balance", x_range: [0.8, 1.0], alignment: "right" },
            ],
            header_pattern: "Date.*Details.*Debit.*Credit.*Balance",
            footer_pattern: "Balance",
            multiline_transactions: false,
            balance_position: "separate_column",
        },
        summary: {
            y_range: [0.88, 1.0],
            fields: ["opening_balance", "closing_balance"],
            start_pattern: "Opening",
            end_pattern: "Closing",
        },
        date_format: "DD MMM YYYY",
        currency_prefix: "$",
        debit_style: "separate_column",
        column_delimiter: "whitespace",
    },
    confidence: 0.6,
    sample_count: 2,
    last_updated: "2024-01-01T00:00:00Z",
    version: 1,
};

const SAMPLE_LIBRARY: FingerprintLibrary = {
    fingerprints: {
        cba: CBA_FINGERPRINT,
        westpac: WESTPAC_FINGERPRINT,
    },
    total_processed: 7,
    last_updated: "2024-01-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// matchFingerprint — identify which bank a statement belongs to
// ---------------------------------------------------------------------------

describe("matchFingerprint", () => {
    test("matches a CBA statement by header identifier", () => {
        const pages = [
            makeOcrPage([
                { text: "Commonwealth Bank", bbox: [50, 30, 200, 20] },
                { text: "Account Details", bbox: [50, 100, 150, 15] },
            ]),
        ];
        const result = matchFingerprint(pages, SAMPLE_LIBRARY);
        expect(result).not.toBeNull();
        expect(result!.bank_id).toBe("cba");
    });

    test("matches a Westpac statement by header identifier", () => {
        const pages = [
            makeOcrPage([
                { text: "Westpac", bbox: [50, 30, 120, 20] },
                { text: "Account: 1234 5678", bbox: [50, 100, 200, 15] },
            ]),
        ];
        const result = matchFingerprint(pages, SAMPLE_LIBRARY);
        expect(result).not.toBeNull();
        expect(result!.bank_id).toBe("westpac");
    });

    test("matches using 'anywhere' location identifiers", () => {
        const pages = [
            makeOcrPage([
                { text: "Statement of Account", bbox: [50, 30, 200, 20] },
                { text: "Powered by NetBank", bbox: [300, 800, 150, 12] },
            ]),
        ];
        const result = matchFingerprint(pages, SAMPLE_LIBRARY);
        expect(result).not.toBeNull();
        expect(result!.bank_id).toBe("cba");
    });

    test("returns null when no fingerprint matches", () => {
        const pages = [
            makeOcrPage([
                { text: "ANZ Bank", bbox: [50, 30, 100, 20] },
                { text: "Account Statement", bbox: [50, 100, 150, 15] },
            ]),
        ];
        const result = matchFingerprint(pages, SAMPLE_LIBRARY);
        expect(result).toBeNull();
    });

    test("returns the best match when multiple fingerprints partially match", () => {
        // A page that mentions both "CBA" and "Westpac" — CBA should win because
        // it has more identifier hits (3 identifiers vs 2 for Westpac)
        const pages = [
            makeOcrPage([
                { text: "CBA", bbox: [50, 30, 50, 20] },
                { text: "Westpac", bbox: [200, 30, 100, 20] },
            ]),
        ];
        const result = matchFingerprint(pages, SAMPLE_LIBRARY);
        expect(result).not.toBeNull();
        // CBA has 3 identifiers, one of which ("CBA") matches.
        // Westpac has 2 identifiers, one of which ("Westpac") matches.
        // Both have 1 match, but CBA has higher confidence (0.8 vs 0.6) as tiebreaker.
        expect(result!.bank_id).toBe("cba");
    });

    test("returns null for an empty library", () => {
        const emptyLibrary: FingerprintLibrary = {
            fingerprints: {},
            total_processed: 0,
            last_updated: "",
        };
        const pages = [
            makeOcrPage([
                { text: "Commonwealth Bank", bbox: [50, 30, 200, 20] },
            ]),
        ];
        const result = matchFingerprint(pages, emptyLibrary);
        expect(result).toBeNull();
    });

    test("matches regex identifiers", () => {
        const regexLibrary: FingerprintLibrary = {
            fingerprints: {
                nab: {
                    bank_id: "nab",
                    bank_name: "National Australia Bank",
                    identifiers: [
                        {
                            pattern: "National\\s+Australia\\s+Bank",
                            location: "anywhere",
                            is_regex: true,
                        },
                    ],
                    layout: CBA_FINGERPRINT.layout,
                    confidence: 0.5,
                    sample_count: 1,
                    last_updated: "2024-01-01T00:00:00Z",
                    version: 1,
                },
            },
            total_processed: 1,
            last_updated: "2024-01-01T00:00:00Z",
        };
        const pages = [
            makeOcrPage([
                { text: "National Australia Bank", bbox: [50, 30, 250, 20] },
            ]),
        ];
        const result = matchFingerprint(pages, regexLibrary);
        expect(result).not.toBeNull();
        expect(result!.bank_id).toBe("nab");
    });

    test("respects location constraint — header-only identifier does not match in footer", () => {
        // CBA's "Commonwealth Bank" identifier is location: "header"
        // Place it in the footer area (y > 0.8 of page height)
        const pages = [
            makeOcrPage([
                { text: "Commonwealth Bank", bbox: [50, 750, 200, 20] }, // y=750 in 842pt page ≈ 0.89
            ]),
        ];
        const result = matchFingerprint(pages, SAMPLE_LIBRARY);
        // Should NOT match because the identifier is in the footer, not the header
        // But "CBA" is "anywhere" so it won't match either since it's not present
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// createFingerprint — bootstrap a new fingerprint from OCR observations
// ---------------------------------------------------------------------------

describe("createFingerprint", () => {
    test("creates a fingerprint with a generated bank_id", () => {
        const pages = [
            makeOcrPage([
                { text: "ANZ Bank", bbox: [50, 30, 100, 20] },
                { text: "Account: 012345 6789012", bbox: [50, 100, 200, 15] },
                {
                    text: "01/03/2024  SALARY  5000.00  5000.00",
                    bbox: [50, 200, 500, 15],
                },
            ]),
        ];
        const fp = createFingerprint("anz", "ANZ Bank", pages);
        expect(fp.bank_id).toBe("anz");
        expect(fp.bank_name).toBe("ANZ Bank");
        expect(fp.identifiers.length).toBeGreaterThan(0);
        expect(fp.version).toBe(1);
        expect(fp.sample_count).toBe(1);
        expect(fp.confidence).toBeLessThan(0.5); // brand new, low confidence
    });

    test("extracts identifiers from header text blocks", () => {
        const pages = [
            makeOcrPage([{ text: "ING Bank", bbox: [50, 30, 100, 20] }]),
        ];
        const fp = createFingerprint("ing", "ING Bank", pages);
        expect(fp.identifiers.some((id) => id.pattern === "ING Bank")).toBe(
            true,
        );
        expect(fp.identifiers.some((id) => id.location === "header")).toBe(
            true,
        );
    });

    test("sets default layout rules for a new fingerprint", () => {
        const pages = [makeOcrPage([])];
        const fp = createFingerprint("test", "Test Bank", pages);
        expect(fp.layout).toBeDefined();
        expect(fp.layout.page.width).toBeGreaterThan(0);
        expect(fp.layout.transactions.columns.length).toBeGreaterThan(0);
        expect(fp.layout.date_format).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// refineFingerprint — improve an existing fingerprint with new observations
// ---------------------------------------------------------------------------

describe("refineFingerprint", () => {
    test("bumps version and sample_count on refinement", () => {
        const refined = refineFingerprint(CBA_FINGERPRINT, [
            makeOcrPage([
                { text: "Commonwealth Bank", bbox: [50, 30, 200, 20] },
                {
                    text: "15/01/2024  COFFEE  4.50  4995.50",
                    bbox: [50, 200, 400, 15],
                },
            ]),
        ]);
        expect(refined.version).toBe(CBA_FINGERPRINT.version + 1);
        expect(refined.sample_count).toBe(CBA_FINGERPRINT.sample_count + 1);
    });

    test("increases confidence with more samples", () => {
        const refined = refineFingerprint(CBA_FINGERPRINT, [
            makeOcrPage([
                { text: "Commonwealth Bank", bbox: [50, 30, 200, 20] },
            ]),
        ]);
        expect(refined.confidence).toBeGreaterThan(CBA_FINGERPRINT.confidence);
    });

    test("confidence never exceeds 1.0", () => {
        let fp = { ...CBA_FINGERPRINT, confidence: 0.99, sample_count: 100 };
        const refined = refineFingerprint(fp, [
            makeOcrPage([
                { text: "Commonwealth Bank", bbox: [50, 30, 200, 20] },
            ]),
        ]);
        expect(refined.confidence).toBeLessThanOrEqual(1.0);
    });

    test("preserves bank_id and bank_name", () => {
        const refined = refineFingerprint(CBA_FINGERPRINT, [
            makeOcrPage([
                { text: "Commonwealth Bank", bbox: [50, 30, 200, 20] },
            ]),
        ]);
        expect(refined.bank_id).toBe(CBA_FINGERPRINT.bank_id);
        expect(refined.bank_name).toBe(CBA_FINGERPRINT.bank_name);
    });

    test("updates last_updated timestamp", () => {
        const refined = refineFingerprint(CBA_FINGERPRINT, [
            makeOcrPage([
                { text: "Commonwealth Bank", bbox: [50, 30, 200, 20] },
            ]),
        ]);
        expect(refined.last_updated).not.toBe(CBA_FINGERPRINT.last_updated);
    });

    test("can adjust column x_range hints based on observed positions", () => {
        // Provide OCR blocks that suggest different column positions
        const pages = [
            makeOcrPage([
                { text: "15/01/2024", bbox: [50, 200, 80, 15] }, // date at x≈0.08
                { text: "SALARY", bbox: [150, 200, 100, 15] }, // description at x≈0.25
                { text: "5000.00", bbox: [450, 200, 80, 15] }, // credit at x≈0.76
                { text: "5000.00", bbox: [520, 200, 80, 15] }, // balance at x≈0.87
            ]),
        ];
        const refined = refineFingerprint(CBA_FINGERPRINT, pages);
        // The refined fingerprint should have adjusted column positions
        // (even if only slightly — the key is that it doesn't crash and
        // the layout is still valid)
        expect(refined.layout.transactions.columns.length).toBe(
            CBA_FINGERPRINT.layout.transactions.columns.length,
        );
    });
});

// ---------------------------------------------------------------------------
// loadFingerprintLibrary / saveFingerprintLibrary — persistence
// ---------------------------------------------------------------------------

describe("FingerprintLibrary persistence", () => {
    test("round-trips a library through JSON serialization", () => {
        const json = saveFingerprintLibrary(SAMPLE_LIBRARY);
        const restored = loadFingerprintLibrary(json);
        expect(Object.keys(restored.fingerprints)).toEqual(
            Object.keys(SAMPLE_LIBRARY.fingerprints),
        );
        expect(restored.fingerprints.cba.bank_id).toBe("cba");
        expect(restored.fingerprints.westpac.bank_id).toBe("westpac");
        expect(restored.total_processed).toBe(SAMPLE_LIBRARY.total_processed);
    });

    test("loads an empty library from empty JSON", () => {
        const empty: FingerprintLibrary = {
            fingerprints: {},
            total_processed: 0,
            last_updated: "",
        };
        const json = saveFingerprintLibrary(empty);
        const restored = loadFingerprintLibrary(json);
        expect(Object.keys(restored.fingerprints).length).toBe(0);
    });

    test("preserves all fingerprint fields through round-trip", () => {
        const json = saveFingerprintLibrary(SAMPLE_LIBRARY);
        const restored = loadFingerprintLibrary(json);
        const original = SAMPLE_LIBRARY.fingerprints.cba;
        const result = restored.fingerprints.cba;

        expect(result.bank_id).toBe(original.bank_id);
        expect(result.bank_name).toBe(original.bank_name);
        expect(result.identifiers).toEqual(original.identifiers);
        expect(result.confidence).toBe(original.confidence);
        expect(result.sample_count).toBe(original.sample_count);
        expect(result.version).toBe(original.version);
        expect(result.layout.date_format).toBe(original.layout.date_format);
        expect(result.layout.transactions.columns.length).toBe(
            original.layout.transactions.columns.length,
        );
    });
});
