import { describe, test, expect } from "bun:test";
import {
  scoreStatement,
  checkBalanceArithmetic,
  checkFormatValidity,
} from "../src/scanner/scoring";
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
// Fixture helpers
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

  // opening 0 + credits 5000 - debits 2000 = closing 3000  ✓ balanced
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

  const consistency: ConsistencyReport = {
    agreement_score: 0.95,
    field_comparisons: [],
    agreements: 10,
    disagreements: 1,
    missing_in_ocr: [],
    missing_in_vlm: [],
    is_consistent: true,
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
    consistency,
    metadata,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scoreStatement — overall weighted score
// ---------------------------------------------------------------------------

describe("scoreStatement", () => {
  test("scores a perfectly balanced, well-formatted statement near 1.0", () => {
    const score = scoreStatement(makeResult());
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  test("penalizes balance arithmetic failure heavily (weight 0.5)", () => {
    const result = makeResult({
      summary: {
        opening_balance: field(0.0),
        closing_balance: field(9999.0), // should be 3000
        total_credits: field(5000.0),
        total_debits: field(2000.0),
      },
    });
    // Losing the 0.5 balance weight should drop the score well below 0.7.
    expect(scoreStatement(result)).toBeLessThan(0.7);
  });

  test("penalizes invalid BSB format (part of format weight 0.3)", () => {
    const result = makeResult({
      account: {
        ...makeResult().account,
        bsb: field("invalid-bsb"),
      },
    });
    expect(scoreStatement(result)).toBeLessThan(0.95);
  });

  test("penalizes a bank statement with no transactions", () => {
    expect(scoreStatement(makeResult({ transactions: [] }))).toBeLessThan(0.8);
  });

  test("penalizes low OCR/VLM consistency (weight 0.2)", () => {
    const result = makeResult({
      consistency: {
        agreement_score: 0.3,
        field_comparisons: [],
        agreements: 3,
        disagreements: 7,
        missing_in_ocr: ["bsb"],
        missing_in_vlm: [],
        is_consistent: false,
      },
    });
    expect(scoreStatement(result)).toBeLessThan(0.95);
  });

  test("scores a completely empty extraction very low", () => {
    const empty = makeResult({
      is_bank_statement: true,
      account: {
        account_holder: field(""),
        bsb: field(""),
        account_number: field(""),
        bank_name: field(""),
        branch: field(""),
      },
      transactions: [],
      summary: {
        opening_balance: field(null),
        closing_balance: field(null),
        total_credits: field(null),
        total_debits: field(null),
      },
      consistency: {
        agreement_score: 0,
        field_comparisons: [],
        agreements: 0,
        disagreements: 0,
        missing_in_ocr: [],
        missing_in_vlm: [],
        is_consistent: false,
      },
    });
    expect(scoreStatement(empty)).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// checkBalanceArithmetic — the self-validating math anchor
// ---------------------------------------------------------------------------

describe("checkBalanceArithmetic", () => {
  test("passes when opening + credits - debits == closing", () => {
    const check = checkBalanceArithmetic(makeResult(), 0.01);
    expect(check.passed).toBe(true);
    expect(Math.abs(check.delta)).toBeLessThan(0.01);
  });

  test("fails when the ledger does not balance", () => {
    const result = makeResult({
      summary: {
        opening_balance: field(1000.0),
        closing_balance: field(5000.0), // 1000 + 5000 - 2000 = 4000 != 5000
        total_credits: field(5000.0),
        total_debits: field(2000.0),
      },
    });
    const check = checkBalanceArithmetic(result, 0.01);
    expect(check.passed).toBe(false);
    expect(Math.abs(check.delta)).toBeGreaterThan(0.5);
  });

  test("fails when a key balance is null (cannot verify)", () => {
    const result = makeResult({
      summary: {
        opening_balance: field(null),
        closing_balance: field(3000.0),
        total_credits: field(5000.0),
        total_debits: field(2000.0),
      },
    });
    expect(checkBalanceArithmetic(result, 0.01).passed).toBe(false);
  });

  test("respects the supplied tolerance", () => {
    const result = makeResult({
      summary: {
        opening_balance: field(0.0),
        closing_balance: field(3000.05), // off by 0.05
        total_credits: field(5000.0),
        total_debits: field(2000.0),
      },
    });
    expect(checkBalanceArithmetic(result, 0.1).passed).toBe(true);
    expect(checkBalanceArithmetic(result, 0.01).passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkFormatValidity — structural validity checks
// ---------------------------------------------------------------------------

describe("checkFormatValidity", () => {
  test("accepts a valid XXX-XXX BSB", () => {
    expect(checkFormatValidity(makeResult()).bsb_valid).toBe(true);
  });

  test("rejects a malformed BSB", () => {
    const result = makeResult({
      account: { ...makeResult().account, bsb: field("12345") },
    });
    expect(checkFormatValidity(result).bsb_valid).toBe(false);
  });

  test("rejects an empty BSB", () => {
    const result = makeResult({
      account: { ...makeResult().account, bsb: field("") },
    });
    expect(checkFormatValidity(result).bsb_valid).toBe(false);
  });

  test("accepts valid ISO transaction dates", () => {
    expect(checkFormatValidity(makeResult()).dates_valid).toBe(true);
  });

  test("rejects unparseable transaction dates", () => {
    const result = makeResult({
      transactions: [
        {
          date: field("not-a-date"),
          description: field("TEST"),
          debit: field(null),
          credit: field(100.0),
          balance: field(100.0),
          reference: field(""),
        },
      ],
    });
    expect(checkFormatValidity(result).dates_valid).toBe(false);
  });

  test("accepts numeric amounts", () => {
    expect(checkFormatValidity(makeResult()).amounts_valid).toBe(true);
  });

  test("flags presence of transactions on a bank statement", () => {
    expect(checkFormatValidity(makeResult()).has_transactions).toBe(true);
    expect(checkFormatValidity(makeResult({ transactions: [] })).has_transactions).toBe(false);
  });
});
