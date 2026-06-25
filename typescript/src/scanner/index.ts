/**
 * Bank Statement Scanner — Public Exports
 *
 * This barrel file exports all public APIs of the scanner module.
 * Internal helpers are not exported.
 */

// Types
export type {
    BankIdentifier,
    ColumnDef,
    SectionLayout,
    TransactionTableLayout,
    PageLayout,
    LayoutRules,
    BankFingerprint,
    ExtractedField,
    ExtractedAccountInfo,
    ExtractedTransaction,
    StatementPeriod,
    ExtractedSummary,
    ProcessingMetadata,
    FieldComparison,
    ConsistencyReport,
    StatementResult,
    OcrTextBlock,
    OcrPageResult,
    VlmPageResult,
    ScannerConfig,
    FingerprintLibrary,
} from "./types";

export { DEFAULT_SCANNER_CONFIG } from "./types";

// Scoring (LOCKED)
export {
    scoreStatement,
    checkBalanceArithmetic,
    checkFormatValidity,
    computeConsistency,
} from "./scoring";

export type { BalanceCheck, FormatCheck } from "./scoring";

// Fingerprint engine
export {
    matchFingerprint,
    createFingerprint,
    refineFingerprint,
    loadFingerprintLibrary,
    saveFingerprintLibrary,
} from "./fingerprint";

// Parser
export { parseOcrText, parseDate, parseAmount, buildField } from "./parser";

// Consistency (LOCKED)
export { compareResults, computeFieldSimilarity } from "./consistency";

// Cache
export {
    hashFile,
    hashString,
    getOcrCachePath,
    getVlmCachePath,
    saveToCache,
    loadFromCache,
    isOcrCached,
    isVlmCached,
    loadOcrCache,
    loadVlmCache,
} from "./cache";

// Evolution integration
export {
    ScannerHarness,
    ScannerJudge,
    ScannerBenchmark,
} from "./evolution_integration";

export type { ScannerTask, ScannerResult } from "./evolution_integration";

// Evolution strategies
export {
    FingerprintEvolver,
    ScannerPromptEvolver,
    ScannerConfigEvolver,
} from "./strategies";

// Runner (entry point)
export { runScannerEvolution } from "./runner";
export type { ScannerRunnerConfig } from "./runner";
