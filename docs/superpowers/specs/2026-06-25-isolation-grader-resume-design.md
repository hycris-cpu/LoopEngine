# Spec: Container Isolation, Out-of-Process Grader, Checkpoint/Resume

**Date:** 2026-06-25
**Author:** review-driven hardening (phase 2)
**Method:** SDD (this doc) + TDD (test-first per item), implemented in **both**
`loopengine/` (Python) and `typescript/src/` (TS).

## Background

Phase 1 closed the logic/safety bugs. The three remaining EurekAgent-inspired
gaps need infrastructure, not just logic:

1. **No real isolation** — `LocalSandbox` runs unconfined shell on the host.
2. **In-process grader** — the agent shares a process with the judge, so once
   self-modification works it could tamper with scoring (reward hacking).
3. **No durability** — `EvolutionReport` is in-memory; a crash loses the run.

EurekAgent solves these with a containerized agent, a separate read-only grader
container, and resumable on-disk run state. We adopt bounded, testable versions.

## Testability principle

These features touch external systems (Docker daemon, subprocesses, the
filesystem). To keep TDD deterministic, every boundary to an external system is
an **injectable runner**. Default runners do the real thing; tests inject fakes
that record calls and return canned output. The filesystem (checkpoint) is
tested against a real temp directory (always available).

## Feature A — DockerSandbox (real container isolation)

A `Sandbox` implementation that translates each operation into a container
command against a running container, plus a `DockerSandboxProvider` that
starts/removes containers. Host docker invocation goes through an injected
`runner(argv, stdin, timeout) -> (stdout, stderr, exit_code)`.

**Behaviors / accept:**
- The run operation issues `docker exec -w <resolved cwd> <container> sh -c
  <cmd>` (argv list) and returns the runner's `(stdout, stderr, code)`.
- The read operation runs `cat`; a non-zero exit raises `FileNotFoundError`.
- The write operation issues `mkdir -p <parent>` then writes the file with the
  content delivered on stdin.
- **Path confinement:** paths resolve under the container workdir; a path
  escaping it (`../etc/passwd`, absolute outside workdir) raises `ValueError`.
- `DockerSandboxProvider.acquire()` starts a detached container and returns a
  `DockerSandbox` bound to the new container id; `release`/`shutdown` force-remove
  it.

## Feature B — Isolated (out-of-process) grader

A scoring contract mirroring EurekAgent's grade/compare pair, run behind a
process boundary so the agent never touches grading code.

- `GradeResult { score: float, valid: bool, metrics: dict }`, with
  `GradeResult.invalid(direction)` returning a sentinel (`-inf` for maximize,
  `+inf` for minimize) so an invalid submission can never rank best.
- `is_better(a, b, direction)` — invalid is never better; direction-aware.
- `IsolatedGrader(runner, direction)` whose `grade(submission: dict)`:
  - returns `GradeResult.invalid` if the runner raises (crash/tamper),
  - returns `GradeResult.invalid` if the result is missing or has a non-finite
    score,
  - otherwise returns the parsed `GradeResult`.
- A real `make_subprocess_runner(script_path)` that launches the interpreter,
  pipes the submission as JSON over stdin, and reads a JSON result from stdout —
  genuinely out-of-process.

**Accept:**
- runner raises → `grade` returns an invalid (sentinel) result, `valid=False`.
- non-finite/missing score → invalid.
- valid dict → parsed `GradeResult` with `valid=True`.
- the subprocess runner round-trips a real grader script in a separate process.
- `is_better`: a valid result beats an invalid one in both directions.

## Feature C — Checkpoint / resume

Durable evolution state so a run survives a crash and continues.

- `EvolutionCheckpoint` dataclass: `iteration, history, current_source,
  current_config, improvements, rejections, final_score` with
  `to_dict`/`from_dict`.
- `CheckpointStore(path)`: `save` (atomic write), `load` (-> checkpoint or
  `None`), `exists`.
- `LoopEngine(..., checkpoint_path=None)`: writes a checkpoint after each
  iteration; `run(resume=True)` restores state and continues from the next
  iteration instead of restarting.

**Accept:**
- `CheckpointStore` save->load round-trips all fields.
- After a run with `checkpoint_path`, the checkpoint file exists and holds the
  final history/counters.
- A fresh engine with the same `checkpoint_path` and `run(resume=True)` restores
  prior counters (e.g. `improvements`) even if its strategy now proposes nothing
  — proving state was loaded rather than recomputed.

## Out of scope
Networked/remote sandboxes, a long-lived grader daemon, and multi-host
orchestration.
