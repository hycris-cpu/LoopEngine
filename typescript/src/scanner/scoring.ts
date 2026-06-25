/**
 * Bank Statement Scanner — Scoring (LOCKED evaluation logic)
 *
 * This module is the scanner's grader. It is deliberately kept OUT of the
 * evolvable `source_files` set so the evolution loop cannot modify the rules
 * it is judged by (anti reward-hacking).
 *
 * The score is a weighted blend, ordered by how hard each signal is to game:
 *   - Balance arithmetic (0.5): opening + credits - debits ≈ closing. Math is
 *     objective — you cannot fake a balanced ledger with wrong numbers.
 *   - Format validity (0.3): BSB shape, parseable dates, numeric amounts,
 *     at least one transaction. Structural, hard to fake.
 *   - OCR/VLM consistency (0.2): a tie-breaker, never the main objective.
 *
 * All functions here are pure: no I/O, no model calls, no mutation.
 */

import type { StatementResult } from "./types";

// Weights for the three scoring signals. Sum to 1.0.
const WEIGHT_BALANCE = 0.5;
const WEIGHT_FORMAT = 0.3;
const WEIGHT_CONSISTENCY = 0.2;

// Australian BSB: six digits formatted as XXX-XXX.
const BSB_PATTERN = /^\d{3}-\d{3}$/;

// ---------------------------------------------------------------------------
// Balance arithmetic — the self-validating anchor
// ---------------------------------------------------------------------------

export interface BalanceCheck {
    /** Whether the ledger balances within tolerance. */
    passed: boolean;
    /** Signed difference: (opening + credits - debits) - closing. */
    delta: number;
    /** False when a required balance value was missing (could not verify). */
    verifiable: boolean;
}

/**
 * Verify that opening + total_credits - total_debits ≈ closing.
 *
 * Returns `passed: false` when any of the four balances is null, because an
 * unverifiable ledger must not be rewarded as if it balanced.
 */
export function checkBalanceArithmetic(
    result: StatementResult,
    tolerance: number,
): BalanceCheck {
    const opening = result.summary.opening_balance.value;
    const closing = result.summary.closing_balance.value;
    const credits = result.summary.total_credits.value;
    const debits = result.summary.total_debits.value;

    // A bank statement with no transactions cannot be meaningfully validated.
    // Treat it as unverifiable — the balance arithmetic is trivially satisfied
    // but the extraction is clearly incomplete.
    if (result.transactions.length === 0) {
        return {
            passed: false,
            delta: Number.POSITIVE_INFINITY,
            verifiable: false,
        };
    }

    if (
        opening === null ||
        closing === null ||
        credits === null ||
        debits === null
    ) {
        return {
            passed: false,
            delta: Number.POSITIVE_INFINITY,
            verifiable: false,
        };
    }

    const expectedClosing = opening + credits - debits;
    const delta = expectedClosing - closing;

    return {
        passed: Math.abs(delta) <= tolerance,
        delta,
        verifiable: true,
    };
}

// ---------------------------------------------------------------------------
// Format validity — structural checks
// ---------------------------------------------------------------------------

export interface FormatCheck {
    bsb_valid: boolean;
    dates_valid: boolean;
    amounts_valid: boolean;
    has_transactions: boolean;
}

/** Check structural validity of the extracted fields. */
export function checkFormatValidity(result: StatementResult): FormatCheck {
    const bsb = result.account.bsb.value;
    const bsb_valid = typeof bsb === "string" && BSB_PATTERN.test(bsb);

    // Dates are valid when every transaction date parses to a real calendar date.
    // An empty transaction list yields `true` here; "has_transactions" handles
    // the missing-rows case separately.
    const dates_valid = result.transactions.every((t) =>
        isParseableDate(t.date.value),
    );

    // Amounts are valid when present numeric fields are finite numbers.
    const amounts_valid = result.transactions.every((t) =>
        [t.debit.value, t.credit.value, t.balance.value].every(
            (v) => v === null || (typeof v === "number" && Number.isFinite(v)),
        ),
    );

    const has_transactions = result.transactions.length > 0;

    return { bsb_valid, dates_valid, amounts_valid, has_transactions };
}

/**
 * Determine whether a string parses as a real calendar date.
 *
 * Accepts ISO (YYYY-MM-DD) and the common Australian forms (DD/MM/YYYY,
 * DD MMM YYYY). Returns false for empty strings and nonsense values.
 */
function isParseableDate(value: string): boolean {
    if (!value || value.trim() === "") return false;

    // ISO: YYYY-MM-DD
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
        return isValidYmd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    }

    // DD/MM/YYYY or DD-MM-YYYY
    const dmy = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (dmy) {
        return isValidYmd(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
    }

    // DD MMM YYYY (e.g., 15 Jan 2024)
    const dmonth = value.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
    if (dmonth) {
        const month = MONTHS[dmonth[2].slice(0, 3).toLowerCase()];
        if (month === undefined) return false;
        return isValidYmd(Number(dmonth[3]), month, Number(dmonth[1]));
    }

    return false;
}

const MONTHS: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
};

function isValidYmd(year: number, month: number, day: number): boolean {
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    const d = new Date(year, month - 1, day);
    return (
        d.getFullYear() === year &&
        d.getMonth() === month - 1 &&
        d.getDate() === day
    );
}

// ---------------------------------------------------------------------------
// Consistency — secondary tie-breaker signal
// ---------------------------------------------------------------------------

/** Extract the consistency contribution (currently the raw agreement score). */
export function computeConsistency(result: StatementResult): number {
    return clamp01(result.consistency.agreement_score);
}

// ---------------------------------------------------------------------------
// Overall weighted score
// ---------------------------------------------------------------------------

/**
 * Compute the overall quality score (0-1) for an extraction result.
 *
 * Only meaningful for documents that ARE bank statements. The caller is
 * responsible for the separate "is this a bank statement?" classification
 * decision; here we measure extraction quality.
 */
export function scoreStatement(
    result: StatementResult,
    balanceTolerance = 0.01,
): number {
    const balance = checkBalanceArithmetic(result, balanceTolerance);
    const format = checkFormatValidity(result);
    const consistency = computeConsistency(result);

    const balanceScore = balance.passed ? 1.0 : 0.0;

    // Format score: four equally weighted structural checks.
    const formatChecks = [
        format.bsb_valid,
        format.dates_valid,
        format.amounts_valid,
        format.has_transactions,
    ];
    const formatScore =
        formatChecks.filter(Boolean).length / formatChecks.length;

    const total =
        WEIGHT_BALANCE * balanceScore +
        WEIGHT_FORMAT * formatScore +
        WEIGHT_CONSISTENCY * consistency;

    return clamp01(total);
}

function clamp01(n: number): number {
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(1, n));
}
