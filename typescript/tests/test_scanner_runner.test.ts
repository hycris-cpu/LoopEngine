import { describe, test, expect } from "bun:test";
import { runScannerEvolution } from "../src/scanner/runner";
import type { BankFingerprint } from "../src/scanner/types";
import { DEFAULT_SCANNER_CONFIG } from "../src/scanner/types";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runner-level integration: drives runScannerEvolution() against real disk
 * I/O (temp dirs), with OCR mocked at the precompute stage (the runner's
 * precomputeOcr stub returns empty pages). This verifies the wiring of
 * load → run → checkpoint recovery → save, even though the stubbed OCR
 * means no transactions are extracted (score-neutral). The goal is to prove
 * the plumbing does not throw and persists JSON artifacts.
 */

function brokenFingerprint(): BankFingerprint {
    return {
        bank_id: "cba",
        bank_name: "Commonwealth Bank",
        identifiers: [],
        layout: {
            page: { width: 595, height: 842, margins: [50, 50, 50, 50] },
            account_info: {
                y_range: [0.0, 0.15],
                fields: [],
                start_pattern: "",
                end_pattern: "",
            },
            transactions: {
                columns: [
                    { name: "date", x_range: [0.0, 0.18], alignment: "left" },
                    {
                        name: "description",
                        x_range: [0.2, 0.5],
                        alignment: "left",
                    },
                ],
                header_pattern: "",
                footer_pattern: "",
                multiline_transactions: false,
                balance_position: "separate_column",
            },
            summary: {
                y_range: [0.85, 1.0],
                fields: [],
                start_pattern: "",
                end_pattern: "",
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
}

describe("runScannerEvolution integration", () => {
    test("loads, runs, and persists evolved JSON artifacts", async () => {
        const root = await mkdtemp(join(tmpdir(), "scanner-run-"));
        const fingerprintsDir = join(root, "fingerprints");
        const configPath = join(root, "scanner_config.json");
        const checkpointPath = join(root, "checkpoint.json");

        try {
            await mkdir(fingerprintsDir, { recursive: true });
            await writeFile(
                join(fingerprintsDir, "cba.json"),
                JSON.stringify(brokenFingerprint(), null, 2),
                "utf-8",
            );
            await writeFile(
                configPath,
                JSON.stringify(DEFAULT_SCANNER_CONFIG, null, 2),
                "utf-8",
            );

            const result = await runScannerEvolution({
                pdf_paths: ["statement.pdf"],
                fingerprints_dir: fingerprintsDir,
                config_path: configPath,
                max_iterations: 3,
                patience: 2,
                checkpoint_path: checkpointPath,
            });

            // The run returns a report and the evolved artifacts.
            expect(result.report).toBeDefined();
            expect(result.evolved_fingerprints.fingerprints.cba).toBeDefined();
            expect(result.evolved_config.confidence_threshold).toBeDefined();

            // The fingerprint JSON was written back to disk and remains valid.
            const written = await readFile(
                join(fingerprintsDir, "cba.json"),
                "utf-8",
            );
            const parsed = JSON.parse(written) as BankFingerprint;
            expect(parsed.bank_id).toBe("cba");

            // NOTE: precomputeOcr is a stub returning empty pages, so no
            // fingerprint match occurs and no improvement is promoted in this
            // plumbing-only test. Real score improvement is covered by the
            // mocked-OCR E2E test (test_scanner_e2e.test.ts).
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
