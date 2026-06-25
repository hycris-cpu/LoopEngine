import { describe, test, expect } from "bun:test";
import {
    parseOcrText,
    parseDate,
    parseAmount,
    buildField,
} from "../src/scanner/parser";
import type {
    OcrPageResult,
    OcrTextBlock,
    BankFingerprint,
    ScannerConfig,
} from "../src/scanner/types";
import { DEFAULT_SCANNER_CONFIG } from "../src/scanner/types";

// ---------------------------------------------------------------------------
// Fixtures
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

// ---------------------------------------------------------------------------
// parseOcrText — extract structured data from OCR text blocks
// ---------------------------------------------------------------------------

describe("parseOcrText", () => {
    test("extracts account info from header blocks", () => {
        const pages = [
            makePage([
                makeBlock("Commonwealth Bank", 50, 30, 200, 20),
                makeBlock("John Doe", 50, 80, 120, 15),
                makeBlock("BSB: 062-000", 50, 100, 120, 15),
                makeBlock("Acct: 12345678", 200, 100, 150, 15),
            ]),
        ];
        const result = parseOcrText(
            pages,
            CBA_FINGERPRINT,
            DEFAULT_SCANNER_CONFIG,
        );
        expect(result.account.account_holder.value).toBe("John Doe");
        expect(result.account.bsb.value).toBe("062-000");
        expect(result.account.account_number.value).toBe("12345678");
    });

    test("extracts transactions from body blocks", () => {
        const pages = [
            makePage([
                makeBlock("15/01/2024", 50, 200, 80, 15),
                makeBlock("SALARY", 150, 200, 100, 15),
                makeBlock("", 350, 200, 80, 15),
                makeBlock("5000.00", 420, 200, 80, 15),
                makeBlock("5000.00", 500, 200, 80, 15),
                makeBlock("16/01/2024", 50, 220, 80, 15),
                makeBlock("RENT", 150, 220, 100, 15),
                makeBlock("2000.00", 350, 220, 80, 15),
                makeBlock("", 420, 220, 80, 15),
                makeBlock("3000.00", 500, 220, 80, 15),
            ]),
        ];
        const result = parseOcrText(
            pages,
            CBA_FINGERPRINT,
            DEFAULT_SCANNER_CONFIG,
        );
        expect(result.transactions.length).toBeGreaterThanOrEqual(2);
    });

    test("returns empty transactions when no body blocks present", () => {
        const pages = [
            makePage([makeBlock("Commonwealth Bank", 50, 30, 200, 20)]),
        ];
        const result = parseOcrText(
            pages,
            CBA_FINGERPRINT,
            DEFAULT_SCANNER_CONFIG,
        );
        expect(result.transactions).toEqual([]);
    });

    test("handles pages with no matching fingerprint gracefully", () => {
        const pages = [makePage([])];
        const result = parseOcrText(
            pages,
            CBA_FINGERPRINT,
            DEFAULT_SCANNER_CONFIG,
        );
        expect(result).toBeDefined();
        expect(result.is_bank_statement).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// parseDate — normalize date strings
// ---------------------------------------------------------------------------

describe("parseDate", () => {
    test("parses DD/MM/YYYY to ISO format", () => {
        expect(parseDate("15/01/2024", "DD/MM/YYYY")).toBe("2024-01-15");
    });

    test("parses DD MMM YYYY to ISO format", () => {
        expect(parseDate("15 Jan 2024", "DD MMM YYYY")).toBe("2024-01-15");
    });

    test("parses YYYY-MM-DD as-is", () => {
        expect(parseDate("2024-01-15", "YYYY-MM-DD")).toBe("2024-01-15");
    });

    test("returns original string when format doesn't match", () => {
        expect(parseDate("not-a-date", "DD/MM/YYYY")).toBe("not-a-date");
    });

    test("handles date formats from config's date_formats list", () => {
        expect(parseDate("15/01/2024", "DD/MM/YYYY")).toBe("2024-01-15");
        expect(parseDate("15 Jan 2024", "DD MMM YYYY")).toBe("2024-01-15");
    });
});

// ---------------------------------------------------------------------------
// parseAmount — normalize currency strings
// ---------------------------------------------------------------------------

describe("parseAmount", () => {
    test("parses a plain number", () => {
        expect(parseAmount("5000.00")).toBe(5000.0);
    });

    test("parses with currency prefix", () => {
        expect(parseAmount("$5000.00")).toBe(5000.0);
    });

    test("parses negative amounts", () => {
        expect(parseAmount("-200.00")).toBe(-200.0);
    });

    test("parses amounts with commas", () => {
        expect(parseAmount("1,234.56")).toBe(1234.56);
    });

    test("returns null for non-numeric strings", () => {
        expect(parseAmount("N/A")).toBeNull();
    });

    test("returns null for empty strings", () => {
        expect(parseAmount("")).toBeNull();
    });

    test("returns null for whitespace-only strings", () => {
        expect(parseAmount("   ")).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// buildField — create ExtractedField with defaults
// ---------------------------------------------------------------------------

describe("buildField", () => {
    test("creates a field with source=ocr and default confidence", () => {
        const field = buildField("test value");
        expect(field.value).toBe("test value");
        expect(field.source).toBe("ocr");
        expect(field.confidence).toBe(0.8);
    });

    test("creates a field with custom source and confidence", () => {
        const field = buildField(42, "vlm", 0.95);
        expect(field.value).toBe(42);
        expect(field.source).toBe("vlm");
        expect(field.confidence).toBe(0.95);
    });

    test("includes bbox and page when provided", () => {
        const field = buildField("hello", "ocr", 0.9, [0.1, 0.2, 0.3, 0.4], 2);
        expect(field.bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
        expect(field.page).toBe(2);
    });
});
