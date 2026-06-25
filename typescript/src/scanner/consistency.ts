/**
 * Bank Statement Scanner — Consistency Checker (LOCKED)
 *
 * Cross-validates OCR and VLM extraction results field-by-field. This module
 * is deliberately kept OUT of the evolvable source_files set — it is the
 * secondary scoring signal (weight 0.2) and must not be gameable.
 *
 * Design principles:
 *   - Consistency is a TIE-BREAKER, never the primary objective.
 *   - Optimizing purely for agreement invites the loop to make both methods
 *     wrong-but-consistent. Balance arithmetic (weight 0.5) is the anchor.
 *   - Field-level comparison uses string similarity for text and relative
 *     difference for numbers.
 */

import type {
    StatementResult,
    ExtractedField,
    FieldComparison,
    ConsistencyReport,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Numeric fields require near-exact match; string fields are more lenient.
const NUMERIC_SIMILARITY_THRESHOLD = 0.95;
const STRING_SIMILARITY_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// FieldCompareResult — internal result for a single field comparison
// ---------------------------------------------------------------------------

interface FieldCompareResult {
    comparison: FieldComparison;
    agreed: boolean;
    missingInOcr: boolean;
    missingInVlm: boolean;
}

// ---------------------------------------------------------------------------
// compareResults — produce a full ConsistencyReport
// ---------------------------------------------------------------------------

/**
 * Compare OCR and VLM extraction results and produce a consistency report.
 *
 * Walks through every field in the StatementResult, comparing the OCR-sourced
 * value with the VLM-sourced value. Fields where one method produced a value
 * and the other didn't are tracked separately.
 *
 * @param ocrResult - The extraction result from the OCR pipeline
 * @param vlmResult - The extraction result from the VLM pipeline
 * @param threshold - Minimum agreement_score to consider the results consistent
 *                    (default: 0.7)
 */
export function compareResults(
    ocrResult: StatementResult,
    vlmResult: StatementResult,
    threshold = 0.7,
): ConsistencyReport {
    const comparisons: FieldComparison[] = [];
    let agreements = 0;
    let disagreements = 0;
    const missingInOcr: string[] = [];
    const missingInVlm: string[] = [];

    // Compare account info fields
    const accountFields = [
        "account_holder",
        "bsb",
        "account_number",
        "bank_name",
        "branch",
    ] as const;

    for (const fieldName of accountFields) {
        const ocrField = ocrResult.account[fieldName] as ExtractedField;
        const vlmField = vlmResult.account[fieldName] as ExtractedField;
        const result = compareFieldDeep(fieldName, ocrField, vlmField);
        comparisons.push(result.comparison);
        if (result.missingInOcr) missingInOcr.push(fieldName);
        if (result.missingInVlm) missingInVlm.push(fieldName);
        if (result.agreed) agreements++;
        else disagreements++;
    }

    // Compare summary fields
    const summaryFields = [
        "opening_balance",
        "closing_balance",
        "total_credits",
        "total_debits",
    ] as const;

    for (const fieldName of summaryFields) {
        const ocrField = ocrResult.summary[fieldName] as ExtractedField<
            number | null
        >;
        const vlmField = vlmResult.summary[fieldName] as ExtractedField<
            number | null
        >;
        const result = compareFieldDeep(fieldName, ocrField, vlmField);
        comparisons.push(result.comparison);
        if (result.missingInOcr) missingInOcr.push(fieldName);
        if (result.missingInVlm) missingInVlm.push(fieldName);
        if (result.agreed) agreements++;
        else disagreements++;
    }

    // Compare period fields
    const periodFields = ["start_date", "end_date", "statement_date"] as const;

    for (const fieldName of periodFields) {
        const ocrField = ocrResult.period[fieldName] as ExtractedField;
        const vlmField = vlmResult.period[fieldName] as ExtractedField;
        const result = compareFieldDeep(fieldName, ocrField, vlmField);
        comparisons.push(result.comparison);
        if (result.missingInOcr) missingInOcr.push(fieldName);
        if (result.missingInVlm) missingInVlm.push(fieldName);
        if (result.agreed) agreements++;
        else disagreements++;
    }

    // Compare transactions (by position — same index = same transaction)
    const maxTx = Math.max(
        ocrResult.transactions.length,
        vlmResult.transactions.length,
    );

    for (let i = 0; i < maxTx; i++) {
        const ocrTx = ocrResult.transactions[i];
        const vlmTx = vlmResult.transactions[i];

        if (!ocrTx) {
            missingInOcr.push(`transaction_${i}`);
            disagreements++;
            continue;
        }
        if (!vlmTx) {
            missingInVlm.push(`transaction_${i}`);
            disagreements++;
            continue;
        }

        const txFields = [
            "date",
            "description",
            "debit",
            "credit",
            "balance",
        ] as const;
        for (const fieldName of txFields) {
            const ocrField = ocrTx[fieldName];
            const vlmField = vlmTx[fieldName];
            const prefix = `tx${i}.${fieldName}`;
            const result = compareFieldDeep(prefix, ocrField, vlmField);
            comparisons.push(result.comparison);
            if (result.missingInOcr) missingInOcr.push(prefix);
            if (result.missingInVlm) missingInVlm.push(prefix);
            if (result.agreed) agreements++;
            else disagreements++;
        }
    }

    const totalFields = agreements + disagreements;
    const agreementScore = totalFields > 0 ? agreements / totalFields : 0;

    return {
        agreement_score: agreementScore,
        field_comparisons: comparisons,
        agreements,
        disagreements,
        missing_in_ocr: missingInOcr,
        missing_in_vlm: missingInVlm,
        is_consistent: agreementScore >= threshold,
    };
}

// ---------------------------------------------------------------------------
// compareFieldDeep — compare a single field between OCR and VLM
// ---------------------------------------------------------------------------

function compareFieldDeep(
    fieldName: string,
    ocrField: ExtractedField<unknown>,
    vlmField: ExtractedField<unknown>,
): FieldCompareResult {
    const ocrValue = ocrField.value;
    const vlmValue = vlmField.value;

    const ocrMissing = isMissing(ocrValue);
    const vlmMissing = isMissing(vlmValue);

    const ocrStr = String(ocrValue ?? "");
    const vlmStr = String(vlmValue ?? "");

    const similarity = computeFieldSimilarity(ocrValue, vlmValue);
    // Use stricter threshold for numeric values (near-exact match required)
    const threshold =
        typeof ocrValue === "number" || typeof vlmValue === "number"
            ? NUMERIC_SIMILARITY_THRESHOLD
            : STRING_SIMILARITY_THRESHOLD;
    const matches = similarity >= threshold;

    return {
        comparison: {
            field_name: fieldName,
            ocr_value: ocrStr,
            vlm_value: vlmStr,
            matches,
            similarity,
        },
        agreed: matches,
        missingInOcr: ocrMissing && !vlmMissing,
        missingInVlm: vlmMissing && !ocrMissing,
    };
}

function isMissing(value: unknown): boolean {
    return value === null || value === undefined || value === "";
}

// ---------------------------------------------------------------------------
// computeFieldSimilarity — the core comparison function
// ---------------------------------------------------------------------------

/**
 * Compute similarity between two field values (0.0 to 1.0).
 *
 * - Both null/empty → 1.0 (both agree it's missing)
 * - One null, one not → 0.0 (disagreement on existence)
 * - Both numbers → 1.0 - |a - b| / max(|a|, |b|, 1)
 * - Both strings → Jaccard similarity on word tokens
 */
export function computeFieldSimilarity(a: unknown, b: unknown): number {
    const aMissing = isMissing(a);
    const bMissing = isMissing(b);

    // Both missing → agree
    if (aMissing && bMissing) return 1.0;

    // One missing, one not → disagree
    if (aMissing || bMissing) return 0.0;

    // Both numbers
    if (typeof a === "number" && typeof b === "number") {
        if (a === b) return 1.0;
        const maxAbs = Math.max(Math.abs(a), Math.abs(b), 1);
        return Math.max(0, 1.0 - Math.abs(a - b) / maxAbs);
    }

    // Both strings
    const aStr = String(a);
    const bStr = String(b);

    if (aStr === bStr) return 1.0;

    // Jaccard similarity on word tokens
    const aTokens = new Set(aStr.toLowerCase().split(/\s+/).filter(Boolean));
    const bTokens = new Set(bStr.toLowerCase().split(/\s+/).filter(Boolean));

    if (aTokens.size === 0 && bTokens.size === 0) return 1.0;
    if (aTokens.size === 0 || bTokens.size === 0) return 0.0;

    let intersection = 0;
    for (const token of aTokens) {
        if (bTokens.has(token)) intersection++;
    }

    const union = aTokens.size + bTokens.size - intersection;
    return union > 0 ? intersection / union : 0.0;
}
