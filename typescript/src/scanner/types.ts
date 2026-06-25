/**
 * Bank Statement Scanner — Domain Types
 *
 * Core types for the bank statement scanning domain. These types model the
 * business concepts: bank fingerprints, extracted fields, statement results,
 * and consistency checks.
 *
 * Design principles:
 * - Interfaces for data structures (no behavior needed)
 * - All amount fields are `number | null` (null = not found)
 * - ExtractedField wraps every value with provenance and confidence
 * - ScannerConfig is the evolvable JSON that LoopEngine modifies
 */

// ---------------------------------------------------------------------------
// Bank Fingerprint — a bank's unique layout signature
// ---------------------------------------------------------------------------

/** Pattern that identifies a specific bank's statements. */
export interface BankIdentifier {
    /** Text pattern to match (regex source or literal string). */
    pattern: string;
    /** Where on the page to look for this pattern. */
    location: "header" | "footer" | "body" | "anywhere";
    /** Whether `pattern` is a regex (vs a literal substring match). */
    is_regex: boolean;
}

/** A column within a transaction table. */
export interface ColumnDef {
    /** Column name (e.g., "date", "description", "debit", "credit", "balance"). */
    name: string;
    /** X-coordinate range, normalized 0-1 from the left edge. */
    x_range: [number, number];
    /** Text alignment within this column. */
    alignment: "left" | "right" | "center";
}

/** Layout rules for a labelled section of the statement. */
export interface SectionLayout {
    /** Y-coordinate range where this section typically appears (0-1 normalized). */
    y_range: [number, number];
    /** Field names expected in this section. */
    fields: string[];
    /** Pattern marking the start of this section. */
    start_pattern: string;
    /** Pattern marking the end of this section. */
    end_pattern: string;
}

/** Layout rules for the transaction table specifically. */
export interface TransactionTableLayout {
    /** Column definitions with position hints. */
    columns: ColumnDef[];
    /** Pattern marking the start of the transaction table. */
    header_pattern: string;
    /** Pattern marking the end of the transaction table. */
    footer_pattern: string;
    /** Whether a single transaction can span multiple text lines. */
    multiline_transactions: boolean;
    /** How running balances are presented. */
    balance_position: "after_each_transaction" | "separate_column" | "none";
}

/** Page dimensions and margins (PDF point coordinate system). */
export interface PageLayout {
    width: number;
    height: number;
    /** Margins in points: [top, right, bottom, left]. */
    margins: [number, number, number, number];
}

/** Full layout rules describing how a bank formats its statement. */
export interface LayoutRules {
    page: PageLayout;
    account_info: SectionLayout;
    transactions: TransactionTableLayout;
    summary: SectionLayout;
    /** Date format used by this bank (e.g., "DD/MM/YYYY", "DD MMM YYYY"). */
    date_format: string;
    /** Currency symbol/prefix used (e.g., "$"). */
    currency_prefix: string;
    /** How debits are presented. */
    debit_style: "negative" | "separate_column";
    /** Column delimiter for text-based extraction. */
    column_delimiter: "whitespace" | "tab" | "pipe" | "fixed_width";
}

/**
 * A bank's unique layout fingerprint — the "DNA" of its statement format.
 *
 * Fingerprints evolve: as the scanner sees more statements from a bank, the
 * evolution loop refines the layout rules and bumps the version.
 */
export interface BankFingerprint {
    bank_id: string;
    bank_name: string;
    identifiers: BankIdentifier[];
    layout: LayoutRules;
    /** Confidence (0-1) based on how many statements validated this fingerprint. */
    confidence: number;
    /** Number of statements used to build/validate this fingerprint. */
    sample_count: number;
    /** ISO timestamp of the last update. */
    last_updated: string;
    /** Version counter, bumped each time the fingerprint is refined. */
    version: number;
}

// ---------------------------------------------------------------------------
// Extracted Field — a single value with provenance
// ---------------------------------------------------------------------------

/** A single field extracted from a statement, tagged with where it came from. */
export interface ExtractedField<T = string> {
    /** Normalized field value. */
    value: T;
    /** Which extraction method produced this value. */
    source: "ocr" | "vlm" | "fingerprint" | "consensus";
    /** Confidence score (0-1). */
    confidence: number;
    /** Bounding box [x, y, width, height] in normalized coords (0-1). */
    bbox?: [number, number, number, number];
    /** Page number (0-indexed). */
    page?: number;
    /** Raw text before normalization. */
    raw_text?: string;
}

// ---------------------------------------------------------------------------
// Statement Result — full extraction output
// ---------------------------------------------------------------------------

export interface ExtractedAccountInfo {
    account_holder: ExtractedField<string>;
    bsb: ExtractedField<string>;
    account_number: ExtractedField<string>;
    bank_name: ExtractedField<string>;
    branch: ExtractedField<string>;
}

export interface ExtractedTransaction {
    date: ExtractedField<string>;
    description: ExtractedField<string>;
    debit: ExtractedField<number | null>;
    credit: ExtractedField<number | null>;
    balance: ExtractedField<number | null>;
    reference: ExtractedField<string>;
}

export interface StatementPeriod {
    start_date: ExtractedField<string>;
    end_date: ExtractedField<string>;
    statement_date: ExtractedField<string>;
}

export interface ExtractedSummary {
    opening_balance: ExtractedField<number | null>;
    closing_balance: ExtractedField<number | null>;
    total_credits: ExtractedField<number | null>;
    total_debits: ExtractedField<number | null>;
}

export interface ProcessingMetadata {
    processing_time_ms: number;
    page_count: number;
    ocr_engine: string;
    vlm_model: string | null;
    processed_at: string;
    warnings: string[];
}

/** A single field's comparison between the OCR and VLM extraction methods. */
export interface FieldComparison {
    field_name: string;
    ocr_value: string;
    vlm_value: string;
    matches: boolean;
    similarity: number;
}

/**
 * Cross-validation report between OCR and VLM extraction.
 *
 * This is a secondary signal in scoring (weight 0.2). It is deliberately NOT
 * the primary objective — optimizing purely for agreement invites the loop to
 * make both methods wrong-but-consistent. Balance arithmetic is the anchor.
 */
export interface ConsistencyReport {
    agreement_score: number;
    field_comparisons: FieldComparison[];
    agreements: number;
    disagreements: number;
    missing_in_ocr: string[];
    missing_in_vlm: string[];
    is_consistent: boolean;
}

/** The complete extraction result for one bank statement PDF. */
export interface StatementResult {
    source_file: string;
    is_bank_statement: boolean;
    bank_id: string | null;
    fingerprint_version: number | null;
    account: ExtractedAccountInfo;
    transactions: ExtractedTransaction[];
    period: StatementPeriod;
    summary: ExtractedSummary;
    consistency: ConsistencyReport;
    metadata: ProcessingMetadata;
}

// ---------------------------------------------------------------------------
// OCR / VLM Intermediate Results
// ---------------------------------------------------------------------------

export interface OcrTextBlock {
    text: string;
    /** [x, y, width, height] in pixels. */
    bbox: [number, number, number, number];
    confidence: number;
}

export interface OcrPageResult {
    page_number: number;
    text: string;
    blocks: OcrTextBlock[];
    /** [width, height] in pixels. */
    dimensions: [number, number];
    confidence: number;
}

export interface VlmPageResult {
    page_number: number;
    extracted_json: Record<string, unknown>;
    raw_response: string;
    confidence: number;
}

// ---------------------------------------------------------------------------
// Scanner Config — the evolvable JSON (lives in scanner_config.json)
// ---------------------------------------------------------------------------

/**
 * Scanner configuration. This is the JSON the evolution loop is allowed to
 * modify (prompts + thresholds). The scoring/consistency code is NOT here —
 * it stays as locked TypeScript so the loop can't game its own grader.
 */
export interface ScannerConfig {
    /** VLM system prompt for extraction. */
    vlm_system_prompt: string;
    /** VLM user prompt template; `{page}` and `{total}` are interpolated. */
    vlm_user_prompt: string;
    /** Minimum confidence to accept an extracted field. */
    confidence_threshold: number;
    /** Tolerance for the balance arithmetic check (absolute dollars). */
    balance_tolerance: number;
    /** Minimum agreement score for a result to count as consistent. */
    consistency_threshold: number;
    /** Hint column widths for fixed-width parsing (0-1 normalized). */
    column_width_hints: Record<string, [number, number]>;
    /** Date formats to try when parsing transaction dates. */
    date_formats: string[];
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
    vlm_system_prompt: `You are an expert bank statement data extractor for Australian banks.
Extract all structured data visible on each page.
If the document is NOT a bank statement, set is_bank_statement=false.
Respond with ONLY valid JSON.`,
    vlm_user_prompt: `Page {page} of {total}. Extract all bank statement data. JSON only.`,
    confidence_threshold: 0.5,
    balance_tolerance: 0.01,
    consistency_threshold: 0.7,
    column_width_hints: {
        date: [0.0, 0.2],
        description: [0.2, 0.55],
        debit: [0.55, 0.7],
        credit: [0.7, 0.85],
        balance: [0.85, 1.0],
    },
    date_formats: ["DD/MM/YYYY", "DD MMM YYYY", "YYYY-MM-DD"],
};

// ---------------------------------------------------------------------------
// Fingerprint Library — the evolving knowledge base
// ---------------------------------------------------------------------------

/** Stores and manages all known bank fingerprints, keyed by bank_id. */
export interface FingerprintLibrary {
    fingerprints: Record<string, BankFingerprint>;
    total_processed: number;
    last_updated: string;
}
