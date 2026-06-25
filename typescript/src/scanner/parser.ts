/**
 * Bank Statement Scanner — OCR Text Parser
 *
 * Converts raw OCR text blocks into structured ExtractedField arrays using
 * a bank's fingerprint layout rules. This module is the "reading brain" that
 * turns pixel-level text into domain objects.
 *
 * The parser is LOCKED — it reads fingerprint JSON but is never in source_files.
 * Only the fingerprint JSON evolves; the parsing logic stays fixed.
 */

import type {
    BankFingerprint,
    OcrPageResult,
    OcrTextBlock,
    ScannerConfig,
    ExtractedField,
    ExtractedAccountInfo,
    ExtractedTransaction,
    StatementPeriod,
    ExtractedSummary,
    ColumnDef,
} from "./types";

// ---------------------------------------------------------------------------
// buildField — convenience constructor for ExtractedField
// ---------------------------------------------------------------------------

/**
 * Create an ExtractedField with sensible defaults.
 *
 * @param value - The extracted value
 * @param source - Where this value came from (default: "ocr")
 * @param confidence - Confidence score 0-1 (default: 0.8)
 * @param bbox - Optional bounding box [x, y, w, h] in normalized coords
 * @param page - Optional page number (0-indexed)
 */
export function buildField<T>(
    value: T,
    source: ExtractedField["source"] = "ocr",
    confidence = 0.8,
    bbox?: [number, number, number, number],
    page?: number,
): ExtractedField<T> {
    const field: ExtractedField<T> = { value, source, confidence };
    if (bbox) field.bbox = bbox;
    if (page !== undefined) field.page = page;
    return field;
}

// ---------------------------------------------------------------------------
// parseDate — normalize date strings to ISO format
// ---------------------------------------------------------------------------

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

/**
 * Parse a date string according to the specified format and return ISO format.
 *
 * Supported formats:
 *   - DD/MM/YYYY → 2024-01-15
 *   - DD-MM-YYYY → 2024-01-15
 *   - DD MMM YYYY → 2024-01-15
 *   - YYYY-MM-DD → 2024-01-15 (passthrough)
 *
 * Returns the original string if parsing fails.
 */
export function parseDate(value: string, format: string): string {
    if (!value || value.trim() === "") return value;

    const trimmed = value.trim();

    // YYYY-MM-DD — already ISO
    if (format === "YYYY-MM-DD" || /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return trimmed;
    }

    // DD/MM/YYYY or DD-MM-YYYY
    if (format === "DD/MM/YYYY" || format === "DD-MM-YYYY") {
        const match = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (match) {
            const [, day, month, year] = match;
            return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
        }
    }

    // DD MMM YYYY
    if (format === "DD MMM YYYY") {
        const match = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
        if (match) {
            const [, day, monthStr, year] = match;
            const month = MONTHS[monthStr.slice(0, 3).toLowerCase()];
            if (month !== undefined) {
                return `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
            }
        }
    }

    // Fallback: try all formats
    const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) return trimmed;

    const dmyMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmyMatch) {
        const [, day, month, year] = dmyMatch;
        return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }

    const dmonthMatch = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
    if (dmonthMatch) {
        const [, day, monthStr, year] = dmonthMatch;
        const month = MONTHS[monthStr.slice(0, 3).toLowerCase()];
        if (month !== undefined) {
            return `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
        }
    }

    return value; // Return original if nothing matches
}

// ---------------------------------------------------------------------------
// parseAmount — normalize currency strings to numbers
// ---------------------------------------------------------------------------

/**
 * Parse a currency amount string to a number.
 *
 * Handles: $1,234.56, -200.00, 5000.00, etc.
 * Returns null for non-numeric or empty strings.
 */
export function parseAmount(value: string): number | null {
    if (!value || value.trim() === "") return null;

    // Remove currency symbols, commas, and whitespace
    const cleaned = value
        .replace(/[$€£¥]/g, "")
        .replace(/,/g, "")
        .replace(/\s/g, "")
        .replace(/[()]/g, (m) => (m === "(" ? "-" : "")); // (200.00) → -200.00

    // Handle CR/DR suffixes (some banks use these)
    const drMatch = cleaned.match(/^(-?\d+\.?\d*)\s*DR$/i);
    if (drMatch) return -Math.abs(parseFloat(drMatch[1]));

    const crMatch = cleaned.match(/^(-?\d+\.?\d*)\s*CR$/i);
    if (crMatch) return Math.abs(parseFloat(crMatch[1]));

    const num = parseFloat(cleaned);
    if (Number.isNaN(num) || !Number.isFinite(num)) return null;

    return num;
}

// ---------------------------------------------------------------------------
// parseOcrText — main extraction function
// ---------------------------------------------------------------------------

interface ParsedResult {
    is_bank_statement: boolean;
    account: ExtractedAccountInfo;
    transactions: ExtractedTransaction[];
    period: StatementPeriod;
    summary: ExtractedSummary;
}

/**
 * Parse OCR text blocks into structured data using a bank fingerprint.
 *
 * The fingerprint provides layout rules (column positions, section boundaries,
 * date format, etc.) that guide the extraction. The config provides additional
 * hints (date formats to try, confidence thresholds, etc.).
 */
export function parseOcrText(
    pages: OcrPageResult[],
    fingerprint: BankFingerprint,
    config: ScannerConfig,
): ParsedResult {
    const layout = fingerprint.layout;

    // Classify blocks by page region
    const headerBlocks: OcrTextBlock[] = [];
    const bodyBlocks: OcrTextBlock[] = [];
    const footerBlocks: OcrTextBlock[] = [];

    for (const page of pages) {
        const pageHeight = page.dimensions[1];
        const pageWidth = page.dimensions[0];

        for (const block of page.blocks) {
            const yNorm = block.bbox[1] / pageHeight;
            const xNorm = block.bbox[0] / pageWidth;

            // Classify by y-position using fingerprint section ranges
            if (yNorm < layout.account_info.y_range[1]) {
                headerBlocks.push(block);
            } else if (yNorm >= layout.summary.y_range[0]) {
                footerBlocks.push(block);
            } else {
                bodyBlocks.push(block);
            }
        }
    }

    // Extract each section
    const allBlocks = pages.flatMap((p) => p.blocks);
    const account = extractAccountInfo(allBlocks, headerBlocks, layout, config);
    const transactions = extractTransactions(bodyBlocks, layout, config, pages);
    const summary = extractSummary(footerBlocks, layout, config);
    const period = extractPeriod(headerBlocks, footerBlocks, layout, config);

    return {
        is_bank_statement: true,
        account,
        transactions,
        period,
        summary,
    };
}

// ---------------------------------------------------------------------------
// Section extractors
// ---------------------------------------------------------------------------

function extractAccountInfo(
    allBlocks: OcrTextBlock[],
    headerBlocks: OcrTextBlock[],
    layout: BankFingerprint["layout"],
    config: ScannerConfig,
): ExtractedAccountInfo {
    // Use ALL blocks for label-based extraction (labels can appear anywhere),
    // but prefer header blocks for direct name extraction.
    const allText = allBlocks.map((b) => b.text).join(" ");
    const headerText = headerBlocks.map((b) => b.text).join(" ");

    // Try to find account holder from header blocks (often just a name without label)
    let accountHolder =
        extractLabelledValue(allText, ["Name", "Account Holder", "Holder"]) ||
        "";
    if (!accountHolder && headerBlocks.length > 0) {
        // Look for a block that looks like a person's name (2-3 words, no digits, not a label)
        for (const block of headerBlocks) {
            const text = block.text.trim();
            if (text.length < 3 || text.length > 40) continue;
            if (/\d/.test(text)) continue; // skip blocks with digits
            if (
                /^(BSB|Acct|Account|Bank|Branch|Statement|Date|Page|Commonwealth|Westpac|NAB|ANZ)/i.test(
                    text,
                )
            )
                continue;
            if (/[:]/.test(text)) continue; // skip label:value blocks
            // Looks like a name — use it
            accountHolder = text;
            break;
        }
    }

    return {
        account_holder: buildField(accountHolder),
        bsb: buildField(extractBsb(allText) || ""),
        account_number: buildField(extractAccountNumber(allText) || ""),
        bank_name: buildField(
            extractLabelledValue(allText, ["Bank", "Institution"]) || "",
        ),
        branch: buildField(extractLabelledValue(allText, ["Branch"]) || ""),
    };
}

function extractTransactions(
    blocks: OcrTextBlock[],
    layout: BankFingerprint["layout"],
    config: ScannerConfig,
    pages: OcrPageResult[],
): ExtractedTransaction[] {
    if (blocks.length === 0) return [];

    const columns = layout.transactions.columns;
    const transactions: ExtractedTransaction[] = [];

    // Group blocks by y-position (same row = same transaction)
    const rows = groupByRow(blocks, pages);

    for (const row of rows) {
        // Assign each block in the row to a column based on x-position
        const assigned = assignToColumns(row, columns, pages);

        // Only create a transaction if we have at least a date
        const dateText = assigned.get("date")?.text ?? "";
        if (!dateText || !/\d/.test(dateText)) continue;

        const dateValue = parseDate(dateText, layout.date_format);
        const descText = assigned.get("description")?.text ?? "";
        const debitText = assigned.get("debit")?.text ?? "";
        const creditText = assigned.get("credit")?.text ?? "";
        const balanceText = assigned.get("balance")?.text ?? "";

        // Skip if this looks like a header row
        if (/^date/i.test(dateText)) continue;

        const debit = parseAmount(debitText);
        const credit = parseAmount(creditText);
        const balance = parseAmount(balanceText);

        transactions.push({
            date: buildField(
                dateValue,
                "ocr",
                assigned.has("date") ? 0.85 : 0.3,
            ),
            description: buildField(
                descText,
                "ocr",
                assigned.has("description") ? 0.8 : 0.3,
            ),
            debit: buildField(debit, "ocr", debit !== null ? 0.85 : 0.3),
            credit: buildField(credit, "ocr", credit !== null ? 0.85 : 0.3),
            balance: buildField(balance, "ocr", balance !== null ? 0.85 : 0.3),
            reference: buildField("", "ocr", 0.3),
        });
    }

    return transactions;
}

function extractSummary(
    blocks: OcrTextBlock[],
    layout: BankFingerprint["layout"],
    config: ScannerConfig,
): ExtractedSummary {
    const text = blocks.map((b) => b.text).join(" ");

    return {
        opening_balance: buildField(
            extractAmount(text, ["Opening", "Brought Forward"]) ?? null,
        ),
        closing_balance: buildField(
            extractAmount(text, ["Closing", "Carried Forward", "Balance"]) ??
                null,
        ),
        total_credits: buildField(
            extractAmount(text, ["Total Credit", "Credits"]) ?? null,
        ),
        total_debits: buildField(
            extractAmount(text, ["Total Debit", "Debits"]) ?? null,
        ),
    };
}

function extractPeriod(
    headerBlocks: OcrTextBlock[],
    footerBlocks: OcrTextBlock[],
    layout: BankFingerprint["layout"],
    config: ScannerConfig,
): StatementPeriod {
    const allText = [...headerBlocks, ...footerBlocks]
        .map((b) => b.text)
        .join(" ");

    return {
        start_date: buildField(
            extractDateFromText(allText, layout.date_format, [
                "From",
                "Period Start",
                "Statement Period",
            ]) || "",
        ),
        end_date: buildField(
            extractDateFromText(allText, layout.date_format, [
                "To",
                "Period End",
            ]) || "",
        ),
        statement_date: buildField(
            extractDateFromText(allText, layout.date_format, [
                "Statement Date",
                "Date",
            ]) || "",
        ),
    };
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a value that follows a label (e.g., "BSB: 062-000" → "062-000").
 */
function extractLabelledValue(text: string, labels: string[]): string | null {
    for (const label of labels) {
        const pattern = new RegExp(`${label}[:\\s]+([\\w\\s\\-]+)`, "i");
        const match = text.match(pattern);
        if (match) {
            return match[1].trim();
        }
    }
    return null;
}

/**
 * Extract a BSB (Bank-State-Branch) number from text.
 * Australian BSB format: XXX-XXX
 */
function extractBsb(text: string): string | null {
    const match = text.match(/BSB[:\s]+(\d{3}[-\s]?\d{3})/i);
    if (match) {
        return match[1].replace(/\s/, "-");
    }
    // Also try matching standalone BSB pattern
    const standalone = text.match(/\b(\d{3}-\d{3})\b/);
    return standalone ? standalone[1] : null;
}

/**
 * Extract an account number from text.
 */
function extractAccountNumber(text: string): string | null {
    const match = text.match(/(?:Acct|Account|Account\s+No)[:\s]+(\d{4,10})/i);
    return match ? match[1] : null;
}

/**
 * Extract an amount that follows a label.
 */
function extractAmount(text: string, labels: string[]): number | null {
    for (const label of labels) {
        const pattern = new RegExp(`${label}[:\\s]+([\\$\\d,\\.\\-]+)`, "i");
        const match = text.match(pattern);
        if (match) {
            return parseAmount(match[1]);
        }
    }
    return null;
}

/**
 * Extract a date that follows a label.
 */
function extractDateFromText(
    text: string,
    dateFormat: string,
    labels: string[],
): string | null {
    for (const label of labels) {
        const pattern = new RegExp(`${label}[:\\s]+([\\d/\\-\\w]+)`, "i");
        const match = text.match(pattern);
        if (match) {
            const parsed = parseDate(match[1], dateFormat);
            if (parsed !== match[1]) return parsed; // Successfully parsed
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Row grouping and column assignment
// ---------------------------------------------------------------------------

/**
 * Group text blocks into rows based on y-position proximity.
 * Blocks within 10 pixels vertically are considered the same row.
 */
function groupByRow(
    blocks: OcrTextBlock[],
    pages: OcrPageResult[],
): OcrTextBlock[][] {
    if (blocks.length === 0) return [];

    // Sort by y-position
    const sorted = [...blocks].sort((a, b) => a.bbox[1] - b.bbox[1]);

    const rows: OcrTextBlock[][] = [];
    let currentRow: OcrTextBlock[] = [sorted[0]];
    let currentY = sorted[0].bbox[1];

    const Y_TOLERANCE = 10; // pixels

    for (let i = 1; i < sorted.length; i++) {
        const block = sorted[i];
        if (Math.abs(block.bbox[1] - currentY) <= Y_TOLERANCE) {
            currentRow.push(block);
        } else {
            // Sort current row by x-position
            currentRow.sort((a, b) => a.bbox[0] - b.bbox[0]);
            rows.push(currentRow);
            currentRow = [block];
            currentY = block.bbox[1];
        }
    }

    // Don't forget the last row
    if (currentRow.length > 0) {
        currentRow.sort((a, b) => a.bbox[0] - b.bbox[0]);
        rows.push(currentRow);
    }

    return rows;
}

/**
 * Assign text blocks in a row to columns based on x-position overlap
 * with the fingerprint's column definitions.
 */
function assignToColumns(
    row: OcrTextBlock[],
    columns: ColumnDef[],
    pages: OcrPageResult[],
): Map<string, OcrTextBlock> {
    const assigned = new Map<string, OcrTextBlock>();
    const pageWidth = pages.length > 0 ? pages[0].dimensions[0] : 595;

    for (const block of row) {
        // bbox is [x, y, width, height], so center_x = x + width/2
        const xCenter = (block.bbox[0] + block.bbox[2] / 2) / pageWidth;

        // Find the column whose x_range contains this block's center
        let bestColumn: string | null = null;
        let bestOverlap = 0;

        for (const col of columns) {
            const [xMin, xMax] = col.x_range;
            if (xCenter >= xMin && xCenter <= xMax) {
                const overlap = xMax - xMin;
                if (overlap > bestOverlap) {
                    bestOverlap = overlap;
                    bestColumn = col.name;
                }
            }
        }

        // If no column matched by center, try by proximity
        if (!bestColumn) {
            let minDist = Infinity;
            for (const col of columns) {
                const colCenter = (col.x_range[0] + col.x_range[1]) / 2;
                const dist = Math.abs(xCenter - colCenter);
                if (dist < minDist) {
                    minDist = dist;
                    bestColumn = col.name;
                }
            }
        }

        if (bestColumn) {
            assigned.set(bestColumn, block);
        }
    }

    return assigned;
}
