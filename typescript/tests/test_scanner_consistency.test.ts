import { describe, test, expect } from "bun:test";
import {
  compareResults,
  computeFieldSimilarity,
} from "../src/scanner/consistency";
import type {
  StatementResult,
  ExtractedField,
  ExtractedAccountInfo,
  ExtractedTransaction,
  StatementPeriod,
  ExtractedSummary,
  ConsistencyReport,
  ProcessingMetadata,
} from "../src/scanner/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function field<T>(
  value: T,
  source: "ocr" | "vlm" | "fingerprint" | "consensus" = "ocr",
  confidence = 0.9,
): ExtractedField<T> {
  return { value, source, confidence };
}

function makeResult(overrides: Partial<StatementResult> = {}): StatementResult {
  const account: ExtractedAccountInfo = {
    account_holder: field("John Doe"),
    bsb: field("062-000"),
    account_number: field("12345678"),
    bank_name: field("CBA"),
    branch: field("Sydney"),
  };

  const transactions: ExtractedTransaction[] = [
    {
      date: field("2024-01-15"),
      description: field("SALARY"),
      debit: field(null),
      credit: field(5000.0),
      balance: field(5000.0),
      reference: field("PAY001"),
    },
    {
      date: field("2024-01-16"),
      description: field("RENT"),
      debit: field(2000.0),
      credit: field(null),
      balance: field(3000.0),
      reference: field(""),
    },
  ];

  const period: StatementPeriod = {
    start_date: field("2024-01-01"),
    end_date: field("2024-01-31"),
    statement_date: field("2024-02-01"),
  };

  const summary: ExtractedSummary = {
    opening_balance: field(0.0),
    closing_balance: field(3000.0),
    total_credits: field(5000.0),
    total_debits: field(2000.0),
  };

  const metadata: ProcessingMetadata = {
    processing_time_ms: 1000,
    page_count: 1,
    ocr_engine: "paddleocr",
    vlm_model: "gpt-4o",
    processed_at: "2024-01-01T00:00:00Z",
    warnings: [],
  };

  return {
    source_file: "test.pdf",
    is_bank_statement: true,
    bank_id: "cba",
    fingerprint_version: 1,
    account,
    transactions,
    period,
    summary,
    consistency: {
      agreement_score: 0,
      field_comparisons: [],
      agreements: 0,
      disagreements: 0,
      missing_in_ocr: [],
      missing_in_vlm: [],
      is_consistent: false,
    },
    metadata,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// compareResults — OCR vs VLM cross-validation (LOCKED)
// ---------------------------------------------------------------------------

describe("compareResults", () => {
  test("reports perfect agreement when OCR and VLM match", () => {
    const ocrResult = makeResult();
    const vlmResult = makeResult();
    const report = compareResults(ocrResult, vlmResult);
    expect(report.agreement_score).toBe(1.0);
    expect(report.is_consistent).toBe(true);
    expect(report.disagreements).toBe(0);
  });

  test("detects disagreements in account info", () => {
    const ocrResult = makeResult();
    const vlmResult = makeResult({
      account: {
        ...ocrResult.account,
        account_holder: field("Jane Smith"), // different!
      },
    });
    const report = compareResults(ocrResult, vlmResult);
    expect(report.agreement_score).toBeLessThan(1.0);
    expect(report.disagreements).toBeGreaterThan(0);
  });

  test("detects disagreements in transaction amounts", () => {
    const ocrResult = makeResult();
    const vlmResult = makeResult({
      transactions: [
        {
          ...ocrResult.transactions[0],
          credit: field(5500.0), // different!
        },
        ...ocrResult.transactions.slice(1),
      ],
    });
    const report = compareResults(ocrResult, vlmResult);
    expect(report.agreement_score).toBeLessThan(1.0);
    expect(report.disagreements).toBeGreaterThan(0);
  });

  test("detects disagreements in summary balances", () => {
    const ocrResult = makeResult();
    const vlmResult = makeResult({
      summary: {
        ...ocrResult.summary,
        closing_balance: field(3500.0), // different!
      },
    });
    const report = compareResults(ocrResult, vlmResult);
    expect(report.agreement_score).toBeLessThan(1.0);
  });

  test("tracks fields missing in OCR but present in VLM", () => {
    const ocrResult = makeResult({
      account: {
        ...makeResult().account,
        bsb: field(""), // empty in OCR
      },
    });
    const vlmResult = makeResult();
    const report = compareResults(ocrResult, vlmResult);
    expect(report.missing_in_ocr.length).toBeGreaterThan(0);
  });

  test("tracks fields missing in VLM but present in OCR", () => {
    const ocrResult = makeResult();
    const vlmResult = makeResult({
      account: {
        ...makeResult().account,
        bsb: field(""), // empty in VLM
      },
    });
    const report = compareResults(ocrResult, vlmResult);
    expect(report.missing_in_vlm.length).toBeGreaterThan(0);
  });

  test("is_consistent requires agreement_score >= threshold", () => {
    // Create results with significant disagreement
    const ocrResult = makeResult();
    const vlmResult = makeResult({
      account: {
        account_holder: field("Different Name"),
        bsb: field("999-999"),
        account_number: field("00000000"),
        bank_name: field("Other Bank"),
        branch: field("Other City"),
      },
      summary: {
        opening_balance: field(100.0),
        closing_balance: field(9999.0),
        total_credits: field(9999.0),
        total_debits: field(100.0),
      },
    });
    const report = compareResults(ocrResult, vlmResult, 0.7);
    expect(report.is_consistent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeFieldSimilarity — string/number comparison
// ---------------------------------------------------------------------------

describe("computeFieldSimilarity", () => {
  test("returns 1.0 for identical strings", () => {
    expect(computeFieldSimilarity("hello", "hello")).toBe(1.0);
  });

  test("returns 1.0 for identical numbers", () => {
    expect(computeFieldSimilarity(5000.0, 5000.0)).toBe(1.0);
  });

  test("returns 0.0 for completely different strings", () => {
    expect(computeFieldSimilarity("abc", "xyz")).toBe(0.0);
  });

  test("partial match for similar strings", () => {
    const sim = computeFieldSimilarity("SALARY PAYMENT", "SALARY");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1.0);
  });

  test("handles null values — both null → 1.0", () => {
    expect(computeFieldSimilarity(null, null)).toBe(1.0);
  });

  test("handles null vs non-null → 0.0", () => {
    expect(computeFieldSimilarity(null, 100.0)).toBe(0.0);
    expect(computeFieldSimilarity(100.0, null)).toBe(0.0);
  });

  test("numeric similarity decreases with larger relative difference", () => {
    const close = computeFieldSimilarity(5000.0, 5050.0);
    const far = computeFieldSimilarity(5000.0, 6000.0);
    expect(close).toBeGreaterThan(far);
  });

  test("empty strings are treated as missing (similar to null)", () => {
    expect(computeFieldSimilarity("", "")).toBe(1.0);
    expect(computeFieldSimilarity("", "hello")).toBe(0.0);
    expect(computeFieldSimilarity("hello", "")).toBe(0.0);
  });
});
