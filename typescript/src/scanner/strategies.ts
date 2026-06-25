/**
 * Bank Statement Scanner — Evolution Strategies
 *
 * These strategies analyze extraction failures and propose CodeMods that
 * modify ONLY JSON files (fingerprints + scanner_config). They never
 * modify TypeScript source code.
 *
 * The strategies implement LoopEngine's EvolutionStrategy interface and
 * produce CodeMod objects that the promotion gate validates before applying.
 *
 * Diff format note:
 *   CodeMod.apply_with_status() applies a unified diff by locating the removed
 *   "old_text" block verbatim in the file and replacing it. The parser always
 *   appends a trailing newline to each hunk, so we build WHOLE-FILE diffs and
 *   require the source content to end in a newline. buildWholeFileDiff() and
 *   the runner's buildSourceFiles() both maintain that invariant.
 */

import type { EvolutionStrategy } from "../evolution/strategies";
import { CodeMod } from "../evolution/code_mod";
import type { BankFingerprint, ScannerConfig } from "./types";

// ---------------------------------------------------------------------------
// Diff helper — produce an applicable whole-file unified diff
// ---------------------------------------------------------------------------

/**
 * Build a whole-file unified diff that CodeMod.apply_with_status() can apply.
 *
 * Both inputs MUST end with a trailing newline. The returned diff removes the
 * entire old content and inserts the entire new content as a single hunk.
 */
function buildWholeFileDiff(original: string, updated: string): string {
    const oldBody = original.endsWith("\n") ? original.slice(0, -1) : original;
    const newBody = updated.endsWith("\n") ? updated.slice(0, -1) : updated;
    const minus = oldBody
        .split("\n")
        .map((line) => "-" + line)
        .join("\n");
    const plus = newBody
        .split("\n")
        .map((line) => "+" + line)
        .join("\n");
    return `@@ -1 +1 @@\n${minus}\n${plus}\n`;
}

/** Serialize a JSON object with a stable 2-space indent and trailing newline. */
function serialize(obj: unknown): string {
    return JSON.stringify(obj, null, 2) + "\n";
}

/** Deep clone via JSON round-trip (objects here are always JSON-safe). */
function clone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T;
}

// ---------------------------------------------------------------------------
// FingerprintEvolver — proposes layout adjustments to fingerprint JSON
// ---------------------------------------------------------------------------

/**
 * Analyzes extraction failures and proposes adjustments to fingerprint
 * layout rules. When a fingerprint fails to extract data correctly,
 * this strategy examines the layout and suggests column position
 * adjustments, date format changes, and other layout refinements.
 *
 * Only modifies fingerprint JSON files — never TypeScript source.
 */
export class FingerprintEvolver implements EvolutionStrategy {
    readonly name = "fingerprint_evolver";

    propose(
        trajectory: unknown,
        eval_result: unknown,
        config: unknown,
        source_code: Record<string, string>,
    ): CodeMod[] {
        const mods: CodeMod[] = [];

        const fingerprintFiles = Object.entries(source_code).filter(
            ([key]) => key.startsWith("fingerprints/") && key.endsWith(".json"),
        );

        for (const [filePath, content] of fingerprintFiles) {
            let fingerprint: BankFingerprint;
            try {
                fingerprint = JSON.parse(content) as BankFingerprint;
            } catch {
                continue; // Skip invalid JSON files
            }

            const { modified, reasons } =
                this._analyze_fingerprint(fingerprint);
            if (reasons.length === 0) continue;

            const updated = serialize(modified);
            const original = content.endsWith("\n") ? content : content + "\n";

            mods.push(
                new CodeMod({
                    target_file: filePath,
                    description: `Refine ${fingerprint.bank_id} fingerprint layout`,
                    diff: buildWholeFileDiff(original, updated),
                    rationale: reasons.join("; "),
                    expected_impact:
                        "Improved extraction accuracy for this bank's statements",
                }),
            );
        }

        return mods;
    }

    /**
     * Analyze a fingerprint, produce a modified copy, and report reasons.
     */
    private _analyze_fingerprint(fingerprint: BankFingerprint): {
        modified: BankFingerprint;
        reasons: string[];
    } {
        const modified = clone(fingerprint);
        const reasons: string[] = [];

        // Missing date format — default to a common Australian format.
        if (!modified.layout.date_format) {
            modified.layout.date_format = "DD/MM/YYYY";
            reasons.push(
                "Date format was missing; defaulting to common Australian format",
            );
        }

        // Columns too close together — widen the gap.
        const columns = modified.layout.transactions.columns;
        for (let i = 0; i < columns.length - 1; i++) {
            const current = columns[i];
            const next = columns[i + 1];
            const gap = next.x_range[0] - current.x_range[1];
            if (gap < 0.02) {
                current.x_range = [
                    current.x_range[0],
                    Math.min(1, current.x_range[1] + 0.02),
                ];
                reasons.push(
                    `Column "${current.name}" is too close to "${next.name}"; widening gap`,
                );
            }
        }

        // No identifiers — add the bank name as a header identifier.
        if (modified.identifiers.length === 0) {
            modified.identifiers.push({
                pattern: modified.bank_name,
                location: "header",
                is_regex: false,
            });
            reasons.push(
                "No identifiers found; adding bank name as header identifier",
            );
        }

        // Over-confident for too few samples — clamp confidence.
        if (modified.confidence > 0.8 && modified.sample_count < 3) {
            const old = modified.confidence;
            modified.confidence = Math.min(0.5, modified.confidence);
            reasons.push(
                `Confidence ${old} is too high for only ${modified.sample_count} samples`,
            );
        }

        return { modified, reasons };
    }
}

// ---------------------------------------------------------------------------
// ScannerPromptEvolver — proposes prompt improvements
// ---------------------------------------------------------------------------

/**
 * Analyzes VLM extraction failures and proposes improvements to the
 * scanner config's VLM prompts. When the VLM consistently fails on
 * certain types of fields, this strategy suggests prompt refinements.
 *
 * Only modifies scanner_config.json — never TypeScript source.
 */
export class ScannerPromptEvolver implements EvolutionStrategy {
    readonly name = "scanner_prompt_evolver";

    propose(
        trajectory: unknown,
        eval_result: unknown,
        config: unknown,
        source_code: Record<string, string>,
    ): CodeMod[] {
        const mods: CodeMod[] = [];

        const configPath = "scanner_config.json";
        const configContent = source_code[configPath];
        if (!configContent) return mods;

        let scannerConfig: ScannerConfig;
        try {
            scannerConfig = JSON.parse(configContent) as ScannerConfig;
        } catch {
            return mods; // Skip invalid config
        }

        const { modified, reasons } = this._analyze_prompts(scannerConfig);
        if (reasons.length === 0) return mods;

        const updated = serialize(modified);
        const original = configContent.endsWith("\n")
            ? configContent
            : configContent + "\n";

        mods.push(
            new CodeMod({
                target_file: configPath,
                description: "Improve VLM prompts for better extraction",
                diff: buildWholeFileDiff(original, updated),
                rationale: reasons.join("; "),
                expected_impact: "Higher extraction accuracy from VLM",
            }),
        );

        return mods;
    }

    /**
     * Analyze VLM prompts, produce a modified config, and report reasons.
     */
    private _analyze_prompts(config: ScannerConfig): {
        modified: ScannerConfig;
        reasons: string[];
    } {
        const modified = clone(config);
        const reasons: string[] = [];

        // System prompt must explicitly require JSON output.
        if (!modified.vlm_system_prompt.toLowerCase().includes("json")) {
            modified.vlm_system_prompt +=
                "\nYou MUST respond with valid JSON only.";
            reasons.push("System prompt should explicitly require JSON output");
        }

        // User prompt should include page context for multi-page documents.
        if (!modified.vlm_user_prompt.includes("{page}")) {
            modified.vlm_user_prompt =
                "Page {page} of {total}. " + modified.vlm_user_prompt;
            reasons.push(
                "User prompt should include page context for multi-page documents",
            );
        }

        // Establish Australian bank context in at least one prompt.
        const mentionsAustralian =
            modified.vlm_system_prompt.toLowerCase().includes("australian") ||
            modified.vlm_user_prompt.toLowerCase().includes("australian");
        if (!mentionsAustralian) {
            modified.vlm_user_prompt +=
                " This is an Australian bank statement.";
            reasons.push(
                "Prompt should specify Australian bank format for better accuracy",
            );
        }

        return { modified, reasons };
    }
}

// ---------------------------------------------------------------------------
// ScannerConfigEvolver — proposes threshold adjustments
// ---------------------------------------------------------------------------

/**
 * Analyzes extraction performance and proposes adjustments to scanner
 * config thresholds (confidence_threshold, balance_tolerance, etc.).
 *
 * Only modifies scanner_config.json — never TypeScript source.
 */
export class ScannerConfigEvolver implements EvolutionStrategy {
    readonly name = "scanner_config_evolver";

    propose(
        trajectory: unknown,
        eval_result: unknown,
        config: unknown,
        source_code: Record<string, string>,
    ): CodeMod[] {
        const mods: CodeMod[] = [];

        const configPath = "scanner_config.json";
        const configContent = source_code[configPath];
        if (!configContent) return mods;

        let scannerConfig: ScannerConfig;
        try {
            scannerConfig = JSON.parse(configContent) as ScannerConfig;
        } catch {
            return mods; // Skip invalid config
        }

        const { modified, reasons } = this._analyze_thresholds(scannerConfig);
        if (reasons.length === 0) return mods;

        const updated = serialize(modified);
        const original = configContent.endsWith("\n")
            ? configContent
            : configContent + "\n";

        mods.push(
            new CodeMod({
                target_file: configPath,
                description: "Adjust scanner config thresholds",
                diff: buildWholeFileDiff(original, updated),
                rationale: reasons.join("; "),
                expected_impact:
                    "Better calibration of confidence and consistency checks",
            }),
        );

        return mods;
    }

    /**
     * Analyze config thresholds, produce a modified config, and report reasons.
     */
    private _analyze_thresholds(config: ScannerConfig): {
        modified: ScannerConfig;
        reasons: string[];
    } {
        const modified = clone(config);
        const reasons: string[] = [];

        // confidence_threshold too high → missing valid extractions.
        if (modified.confidence_threshold > 0.7) {
            reasons.push(
                `Confidence threshold ${modified.confidence_threshold} may be too high; lowering to 0.5`,
            );
            modified.confidence_threshold = 0.5;
        }

        // balance_tolerance too tight → false failures.
        if (modified.balance_tolerance < 0.01) {
            reasons.push(
                `Balance tolerance ${modified.balance_tolerance} is very tight; allowing 0.01 rounding`,
            );
            modified.balance_tolerance = 0.01;
        }

        // consistency_threshold too high → rejecting valid results.
        if (modified.consistency_threshold > 0.9) {
            reasons.push(
                `Consistency threshold ${modified.consistency_threshold} is very high; lowering to 0.7`,
            );
            modified.consistency_threshold = 0.7;
        }

        // Ensure common Australian date formats are present.
        const requiredFormats = ["DD/MM/YYYY", "DD MMM YYYY"];
        for (const fmt of requiredFormats) {
            if (!modified.date_formats.includes(fmt)) {
                modified.date_formats = [...modified.date_formats, fmt];
                reasons.push(
                    `Date format "${fmt}" is common in Australian banks but not configured`,
                );
            }
        }

        return { modified, reasons };
    }
}
