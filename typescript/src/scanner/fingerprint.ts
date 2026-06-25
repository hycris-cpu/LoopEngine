/**
 * Bank Statement Scanner — Fingerprint Engine
 *
 * The fingerprint engine is the scanner's "pattern recognition brain". It:
 *   1. MATCHES incoming statements against known bank fingerprints
 *   2. CREATES new fingerprints for previously unseen banks
 *   3. REFINES existing fingerprints with new observations
 *   4. PERSISTS the fingerprint library to/from JSON
 *
 * Fingerprints are pure JSON — they live in `fingerprints/*.json` and are the
 * primary evolvable artifact that LoopEngine modifies. The scanner code that
 * reads fingerprints is LOCKED; only the JSON data evolves.
 *
 * Design principles:
 *   - Matching uses a scoring system: each identifier that matches contributes
 *     1 point. Location constraints are enforced (header/footer/anywhere).
 *   - The best match is the one with the most identifier hits; confidence is
 *     the tiebreaker.
 *   - New fingerprints start with low confidence (0.3) and generic layout rules.
 *   - Refinement bumps version, increases sample_count, and gradually raises
 *     confidence toward 1.0.
 */

import type {
    BankFingerprint,
    BankIdentifier,
    OcrPageResult,
    OcrTextBlock,
    FingerprintLibrary,
    ColumnDef,
    LayoutRules,
    PageLayout,
    SectionLayout,
    TransactionTableLayout,
} from "./types";

// ---------------------------------------------------------------------------
// Location helpers — map y-position to page region
// ---------------------------------------------------------------------------

/** Header region: top 20% of the page. */
const HEADER_Y_FRACTION = 0.2;
/** Footer region: bottom 15% of the page. */
const FOOTER_Y_FRACTION = 0.85;

type PageRegion = "header" | "footer" | "body";

/**
 * Determine which region of the page a text block falls in, based on its
 * normalized y-coordinate (0 = top, 1 = bottom).
 */
function blockRegion(block: OcrTextBlock, pageHeight: number): PageRegion {
    // Normalize y to 0-1 range (top of page = 0)
    const yNorm = block.bbox[1] / pageHeight;
    if (yNorm < HEADER_Y_FRACTION) return "header";
    if (yNorm >= FOOTER_Y_FRACTION) return "footer";
    return "body";
}

/**
 * Check whether a block's region is compatible with an identifier's location
 * constraint. "anywhere" matches any region.
 */
function regionMatches(
    blockRegion: PageRegion,
    identifierLocation: BankIdentifier["location"],
): boolean {
    if (identifierLocation === "anywhere") return true;
    return blockRegion === identifierLocation;
}

// ---------------------------------------------------------------------------
// matchFingerprint — identify which bank a statement belongs to
// ---------------------------------------------------------------------------

interface MatchScore {
    fingerprint: BankFingerprint;
    hits: number;
}

/**
 * Match OCR pages against the fingerprint library and return the best match.
 *
 * Scoring: each identifier that matches (text + location) contributes 1 hit.
 * The fingerprint with the most hits wins. Ties are broken by confidence.
 *
 * Returns null if no fingerprint has any hits.
 */
export function matchFingerprint(
    pages: OcrPageResult[],
    library: FingerprintLibrary,
): BankFingerprint | null {
    const candidates: MatchScore[] = [];

    for (const fp of Object.values(library.fingerprints)) {
        let hits = 0;

        for (const identifier of fp.identifiers) {
            if (identifierMatches(identifier, pages)) {
                hits++;
            }
        }

        if (hits > 0) {
            candidates.push({ fingerprint: fp, hits });
        }
    }

    if (candidates.length === 0) return null;

    // Sort by hits descending, then confidence descending
    candidates.sort((a, b) => {
        if (b.hits !== a.hits) return b.hits - a.hits;
        return b.fingerprint.confidence - a.fingerprint.confidence;
    });

    return candidates[0].fingerprint;
}

/**
 * Check whether a single identifier matches any text block in the pages,
 * respecting location constraints.
 */
function identifierMatches(
    identifier: BankIdentifier,
    pages: OcrPageResult[],
): boolean {
    for (const page of pages) {
        for (const block of page.blocks) {
            // Check location constraint
            if (
                !regionMatches(
                    blockRegion(block, page.dimensions[1]),
                    identifier.location,
                )
            ) {
                continue;
            }

            // Check text match
            if (identifier.is_regex) {
                try {
                    const regex = new RegExp(identifier.pattern);
                    if (regex.test(block.text)) return true;
                } catch {
                    // Invalid regex — skip this identifier
                    continue;
                }
            } else {
                if (block.text.includes(identifier.pattern)) return true;
            }
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// createFingerprint — bootstrap a new fingerprint from OCR observations
// ---------------------------------------------------------------------------

/** Default layout for a brand-new fingerprint (generic Australian bank). */
const DEFAULT_LAYOUT: LayoutRules = {
    page: { width: 595, height: 842, margins: [50, 50, 50, 50] },
    account_info: {
        y_range: [0.0, 0.15],
        fields: ["account_holder", "bsb", "account_number", "bank_name"],
        start_pattern: "Account",
        end_pattern: "Date",
    },
    transactions: {
        columns: [
            { name: "date", x_range: [0.0, 0.2], alignment: "left" },
            { name: "description", x_range: [0.2, 0.55], alignment: "left" },
            { name: "debit", x_range: [0.55, 0.7], alignment: "right" },
            { name: "credit", x_range: [0.7, 0.85], alignment: "right" },
            { name: "balance", x_range: [0.85, 1.0], alignment: "right" },
        ],
        header_pattern: "Date.*Description",
        footer_pattern: "Closing|Balance",
        multiline_transactions: false,
        balance_position: "separate_column",
    },
    summary: {
        y_range: [0.88, 1.0],
        fields: [
            "opening_balance",
            "closing_balance",
            "total_credits",
            "total_debits",
        ],
        start_pattern: "Opening",
        end_pattern: "Closing",
    },
    date_format: "DD/MM/YYYY",
    currency_prefix: "$",
    debit_style: "separate_column",
    column_delimiter: "whitespace",
};

/**
 * Create a new fingerprint for a previously unseen bank.
 *
 * Extracts identifiers from header text blocks and uses default layout rules.
 * The fingerprint starts with low confidence (0.3) — it must be refined through
 * successful extractions before it can be trusted.
 */
export function createFingerprint(
    bankId: string,
    bankName: string,
    pages: OcrPageResult[],
): BankFingerprint {
    const identifiers = extractIdentifiers(bankName, pages);

    return {
        bank_id: bankId,
        bank_name: bankName,
        identifiers,
        layout: { ...DEFAULT_LAYOUT },
        confidence: 0.3,
        sample_count: 1,
        last_updated: new Date().toISOString(),
        version: 1,
    };
}

/**
 * Extract BankIdentifiers from the OCR pages.
 *
 * Strategy:
 *   - The bank name itself is always an identifier (location: "header" if
 *     found in the header region, otherwise "anywhere").
 *   - Additional identifiers are extracted from short, distinctive text blocks
 *     in the header region (likely logos/branding).
 */
function extractIdentifiers(
    bankName: string,
    pages: OcrPageResult[],
): BankIdentifier[] {
    const identifiers: BankIdentifier[] = [];

    // The bank name is always the primary identifier
    const nameLocation = findTextLocation(bankName, pages);
    identifiers.push({
        pattern: bankName,
        location: nameLocation === "header" ? "header" : "anywhere",
        is_regex: false,
    });

    // Look for additional distinctive header text (short blocks that look like
    // brand names or product names — typically < 30 chars, in the header region)
    for (const page of pages) {
        for (const block of page.blocks) {
            const region = blockRegion(block, page.dimensions[1]);
            if (region !== "header") continue;
            const text = block.text.trim();
            // Skip if it's the bank name itself, too long, or looks like data
            if (text === bankName) continue;
            if (text.length > 30 || text.length < 3) continue;
            if (/\d{4,}/.test(text)) continue; // skip things with long numbers
            if (/^\d/.test(text)) continue; // skip things starting with digits

            // Check it's not already captured
            if (identifiers.some((id) => id.pattern === text)) continue;

            identifiers.push({
                pattern: text,
                location: "header",
                is_regex: false,
            });
        }
    }

    return identifiers;
}

/**
 * Find where a text string appears in the pages (first occurrence).
 */
function findTextLocation(
    text: string,
    pages: OcrPageResult[],
): PageRegion | "anywhere" {
    for (const page of pages) {
        for (const block of page.blocks) {
            if (block.text.includes(text)) {
                return blockRegion(block, page.dimensions[1]);
            }
        }
    }
    return "anywhere";
}

// ---------------------------------------------------------------------------
// refineFingerprint — improve an existing fingerprint with new observations
// ---------------------------------------------------------------------------

/**
 * Confidence growth rate: each new sample increases confidence by this fraction
 * of the remaining headroom (1.0 - current_confidence). This gives diminishing
 * returns — early samples matter more than later ones.
 */
const CONFIDENCE_GROWTH_RATE = 0.15;

/**
 * Refine a fingerprint with observations from a new statement.
 *
 * This is the core learning mechanism: each successful extraction provides
 * evidence that the fingerprint is correct, so confidence increases. The
 * layout rules can also be adjusted based on observed text positions.
 *
 * The refined fingerprint is a NEW object (immutable update).
 */
export function refineFingerprint(
    fingerprint: BankFingerprint,
    pages: OcrPageResult[],
): BankFingerprint {
    const newSampleCount = fingerprint.sample_count + 1;

    // Confidence grows with diminishing returns
    const headroom = 1.0 - fingerprint.confidence;
    const newConfidence = Math.min(
        1.0,
        fingerprint.confidence + headroom * CONFIDENCE_GROWTH_RATE,
    );

    // Adjust layout based on observed positions
    const refinedLayout = adjustLayout(fingerprint.layout, pages);

    return {
        ...fingerprint,
        sample_count: newSampleCount,
        confidence: newConfidence,
        layout: refinedLayout,
        last_updated: new Date().toISOString(),
        version: fingerprint.version + 1,
    };
}

/**
 * Adjust layout rules based on observed text block positions.
 *
 * This is a conservative adjustment: we only nudge column x_range values
 * slightly toward the observed positions. Large jumps are prevented to avoid
 * a single outlier statement from distorting the fingerprint.
 *
 * The adjustment weight is inversely proportional to sample_count — early
 * samples have more influence, later ones less (stabilization).
 */
function adjustLayout(
    layout: LayoutRules,
    pages: OcrPageResult[],
): LayoutRules {
    // Collect observed x-positions for potential column content
    const observations = collectColumnObservations(pages);

    if (observations.length === 0) return layout;

    // Compute the adjustment weight: starts at 0.3 for the first sample,
    // decays toward 0.05 as sample_count grows
    const totalSamples = observations.length;
    const weight = Math.max(0.05, 0.3 / (1 + totalSamples * 0.1));

    // Adjust column x_range values
    const adjustedColumns = layout.transactions.columns.map((col) => {
        const colObs = observations.filter(
            (o) => o.possibleColumn === col.name,
        );
        if (colObs.length === 0) return col;

        // Average the observed x-center positions
        const avgX =
            colObs.reduce((sum, o) => sum + o.xCenter, 0) / colObs.length;

        // Nudge the column boundaries toward the observed center
        const currentCenter = (col.x_range[0] + col.x_range[1]) / 2;
        const nudge = (avgX - currentCenter) * weight;

        return {
            ...col,
            x_range: [
                Math.max(0, col.x_range[0] + nudge * 0.5),
                Math.min(1, col.x_range[1] + nudge * 0.5),
            ] as [number, number],
        };
    });

    return {
        ...layout,
        transactions: {
            ...layout.transactions,
            columns: adjustedColumns,
        },
    };
}

interface ColumnObservation {
    possibleColumn: string;
    xCenter: number; // normalized 0-1
}

/**
 * Heuristic: classify text blocks as potential column content based on their
 * position and content. This is intentionally simple — the evolution loop
 * will refine the fingerprint's column positions over time.
 */
function collectColumnObservations(
    pages: OcrPageResult[],
): ColumnObservation[] {
    const observations: ColumnObservation[] = [];

    for (const page of pages) {
        const pageWidth = page.dimensions[0];
        if (pageWidth === 0) continue;

        for (const block of page.blocks) {
            const xCenter =
                (block.bbox[0] + block.bbox[0] + block.bbox[2]) / 2 / pageWidth;
            const text = block.text.trim();

            // Date-like: starts with digits, short
            if (/^\d{1,2}[\/\-\.]/.test(text) && text.length <= 12) {
                observations.push({ possibleColumn: "date", xCenter });
                continue;
            }

            // Amount-like: contains digits with decimal point, possibly with $ or -
            if (/[\$]?\d+\.\d{2}/.test(text) && text.length <= 15) {
                // Distinguish credit/debit/balance by position heuristics
                if (xCenter > 0.8) {
                    observations.push({ possibleColumn: "balance", xCenter });
                } else if (xCenter > 0.65) {
                    observations.push({ possibleColumn: "credit", xCenter });
                } else if (xCenter > 0.5) {
                    observations.push({ possibleColumn: "debit", xCenter });
                }
                continue;
            }

            // Description-like: longer text, middle of the line
            if (text.length > 5 && xCenter > 0.1 && xCenter < 0.6) {
                observations.push({ possibleColumn: "description", xCenter });
            }
        }
    }

    return observations;
}

// ---------------------------------------------------------------------------
// Persistence — load/save fingerprint library as JSON
// ---------------------------------------------------------------------------

/**
 * Serialize a FingerprintLibrary to a JSON string.
 */
export function saveFingerprintLibrary(library: FingerprintLibrary): string {
    return JSON.stringify(library, null, 2);
}

/**
 * Deserialize a FingerprintLibrary from a JSON string.
 *
 * Returns an empty library if the JSON is invalid or missing required fields.
 */
export function loadFingerprintLibrary(json: string): FingerprintLibrary {
    try {
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== "object") {
            return emptyLibrary();
        }

        // Validate structure
        const fingerprints: Record<string, BankFingerprint> = {};
        if (parsed.fingerprints && typeof parsed.fingerprints === "object") {
            for (const [key, value] of Object.entries(
                parsed.fingerprints as Record<string, unknown>,
            )) {
                if (isValidFingerprint(value)) {
                    fingerprints[key] = value as BankFingerprint;
                }
            }
        }

        return {
            fingerprints,
            total_processed:
                typeof parsed.total_processed === "number"
                    ? parsed.total_processed
                    : Object.keys(fingerprints).length,
            last_updated:
                typeof parsed.last_updated === "string"
                    ? parsed.last_updated
                    : new Date().toISOString(),
        };
    } catch {
        return emptyLibrary();
    }
}

function emptyLibrary(): FingerprintLibrary {
    return {
        fingerprints: {},
        total_processed: 0,
        last_updated: "",
    };
}

/**
 * Basic runtime validation that a parsed object looks like a BankFingerprint.
 */
function isValidFingerprint(obj: unknown): boolean {
    if (!obj || typeof obj !== "object") return false;
    const fp = obj as Record<string, unknown>;
    return (
        typeof fp.bank_id === "string" &&
        typeof fp.bank_name === "string" &&
        Array.isArray(fp.identifiers) &&
        fp.layout !== null &&
        typeof fp.layout === "object"
    );
}
