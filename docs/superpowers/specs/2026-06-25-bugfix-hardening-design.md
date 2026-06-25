# Spec: Bug-fix & Hardening Pass (Python + TypeScript)

**Date:** 2026-06-25
**Author:** review-driven hardening
**Method:** SDD (this doc) + TDD (test-first per item). Every code fix lands in **both** `loopengine/` (Python) and `typescript/src/` (TS) when the bug exists in both.

## Background

Two reviews surfaced a set of design/logic flaws. A comparison with THU's
**EurekAgent** (environment-engineering-first, container-isolated grader,
explicit `is_better`/validity contract, ranked candidate population,
first-class operational plumbing) informs the fixes below. This pass closes the
flaws and borrows EurekAgent's safer-by-construction ideas where bounded.

## Items (critical first)

### C1 — Quadratic token accounting (runloop)
**Bug:** `run_loop` adds `model.count_tokens(state.messages)` each step, counting
the *entire* conversation every step -> O(N^2) inflation and premature `budget`
exits.
**Fix:** count only the *new* messages added during the step (delta).
**Accept:** with a model whose `count_tokens` returns message count, after a run
the recorded `total_tokens` equals the final message count (linear), not the sum
of running lengths.

### C2 — Safety validated after candidate executed (loop_engine)
**Bug:** unsafe mods are applied, the candidate harness is **built and
benchmarked**, and only then does the gate call the safety check.
**Fix:** check the mod safety *before* materializing/benchmarking a candidate;
unsafe mods are recorded as rejected and never built/run.
**Accept:** given an unsafe mod, `agent_builder` is never invoked for it and it is
counted as a rejection.

### C3 — Silent stub fallbacks mask ImportError / fail-open (evolution modules)
**Bug:** `try/except ImportError` blocks substitute fakes; the `PromotionGate`
stub promotes unconditionally and the `CodeMod` stub reports the safety check as
True. A real import failure silently disables safety.
**Fix:** import siblings directly (fail-loud). The real symbols are used, so a
broken import raises instead of silently degrading.
**Accept:** `loop_engine.CodeMod is code_mod.CodeMod` (and likewise for
`PromotionGate`, `BenchmarkResult`) -- no shadow stub classes.

### C4 — Modified source never materialized/executed (loop_engine)
**Bug:** `source_files` is only stuffed into `harness_config["source_files"]`;
nothing writes it to disk or makes it importable, so candidate == baseline and
nothing can ever be promoted.
**Fix (EurekAgent workspace pattern):** materialize candidate `source_files` to an
isolated on-disk workspace and pass `harness_config["workspace"]` (a path) to the
builder so it can load the evolved code.
**Accept:** materializing a source map writes each file under a fresh workspace
dir and returns its path; the path is present in the harness config given to the
builder.

### H1 — safety check weak + false positives (code_mod)
**Bug:** the check scans `diff + description + rationale` (prose -> false
positives) with a thin blocklist (misses the popen/exec helpers, recursive tree
removal, path unlink, importlib, file writes, ...).
**Fix:** scan only the **added** lines of the diff; expand the dangerous-pattern
set.
**Accept:** a mod whose *rationale* mentions a dangerous call but whose added code
is benign is **safe**; a mod adding a recursive-remove or popen call is **unsafe**.

### H2 — Invalid-candidate guard + `is_better` direction (promotion)
**Bug:** no notion of an invalid run; "higher mean_score wins" is hard-coded; an
invalid/`NaN` candidate could outrank a valid baseline.
**Fix (EurekAgent contract):** reject promotion when the candidate aggregate is
missing/`NaN`; accept an optional `is_better(candidate, baseline)` comparator
(default: higher-is-better) so optimization direction is explicit.
**Accept:** a `NaN`/missing candidate score is never promoted; a custom
lower-is-better comparator promotes a candidate that decreases the score.

### M1 — Diff application silently no-ops (code_mod + loop_engine)
**Bug:** application does a single textual replace; if the anchor text isn't
present it returns files unchanged with no signal, wasting a benchmark on a no-op.
**Fix:** add applied-detection; the engine skips mods that don't apply.
**Accept:** apply-with-detection reports `applied=False` when the diff's
removed/anchor text isn't found; the engine does not benchmark a non-applying mod.

### M2 — "Most impactful" is actually first-that-passes (loop_engine)
**Bug:** the loop breaks on the first gate-passing mod in registration order.
**Fix (EurekAgent ranking):** benchmark all promotable candidates and promote the
one with the best candidate score.
**Accept:** with three passing proposals, the engine promotes the one whose
candidate aggregate is highest, not the first.

### M3 — No convergence guard / cost blow-up (loop_engine)
**Bug:** default `max_iterations=100` runs to the end making no progress.
**Fix:** add `patience` — stop after N consecutive non-promoting iterations.
**Accept:** with always-rejected proposals and `patience=2`, the engine stops at
2 iterations.

### M4 — ConfigEvolver targets a non-existent file (strategies)
**Bug:** hard-coded `target_file="config.py"` is usually absent from
`source_code`, so mods can never apply.
**Fix:** target an existing key from `source_code` when available.
**Accept:** when `source_code` contains a config-like file, the proposed mod's
`target_file` is that key.

### S1 — Significance overclaim (promotion docs)
**Bug:** docstring claims a statistical-significance check that does not exist.
**Fix:** correct the documentation to describe the actual threshold behavior.

## Out of scope (noted, not done here)
Real container isolation (`DockerSandbox`), out-of-process grader, persistence/
resume, and live monitoring — larger efforts tracked separately.
