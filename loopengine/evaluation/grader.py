"""Out-of-process grader — isolated, tamper-resistant scoring (Feature B).

Plain English: EurekAgent runs its grader in a separate, read-only container so
the agent can submit work but never see or modify the scoring logic. That single
idea is what stops "reward hacking" — the agent can't rewrite the judge to give
itself a perfect score.

This module brings the same shape to LoopEngine:

- A grading CONTRACT (`GradeResult` + `is_better`) that mirrors EurekAgent's
  ``grade_submission`` / ``is_better`` pair, including sentinel scores so an
  invalid submission can NEVER rank as best.
- An `IsolatedGrader` that runs the grading behind an injected process boundary.
  If the grading crashes or returns nonsense, the submission is marked invalid
  rather than silently trusted.
- A real `make_subprocess_runner` that grades in a genuinely separate process.
"""

from __future__ import annotations

import asyncio
import json
import math
import sys
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional


# ---------------------------------------------------------------------------
# GradeResult — the verdict for one submission
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GradeResult:
    """The score and validity of one graded submission.

    Attributes:
        score: The numeric score. For invalid submissions this is a sentinel
            (``-inf`` when maximizing, ``+inf`` when minimizing) so they can
            never compare as best.
        valid: Whether the submission was valid and the score is trustworthy.
        metrics: Optional extra measurements (timing, sub-scores, etc.).
    """

    score: float
    valid: bool = True
    metrics: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def invalid(
        cls, direction: str = "maximize", metrics: Optional[dict[str, Any]] = None
    ) -> "GradeResult":
        """Build an invalid result whose sentinel score can never rank best."""
        sentinel = float("-inf") if direction == "maximize" else float("inf")
        return cls(score=sentinel, valid=False, metrics=metrics or {})

    def to_dict(self) -> dict[str, Any]:
        return {"score": self.score, "valid": self.valid, "metrics": dict(self.metrics)}


def is_better(a: GradeResult, b: GradeResult, direction: str = "maximize") -> bool:
    """Return whether ``a`` is a strictly better result than ``b``.

    An invalid result is never better than anything; a valid result always beats
    an invalid one. Among valid results, ``direction`` decides: 'maximize' means
    higher is better, 'minimize' means lower is better.
    """
    if not a.valid:
        return False
    if not b.valid:
        return True
    if direction == "minimize":
        return a.score < b.score
    return a.score > b.score


# A grading runner: given a serialized submission, return a result mapping (with
# at least a ``score``), or raise. The mapping is serializable — the runner is a
# process boundary, so live agent objects never cross it.
GraderRunner = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


# ---------------------------------------------------------------------------
# IsolatedGrader — runs grading behind a process boundary
# ---------------------------------------------------------------------------


class IsolatedGrader:
    """Grades a submission via an injected (typically out-of-process) runner.

    The grading logic lives behind ``runner``. Whatever happens there, the
    submission is only trusted when the runner returns a finite numeric score:
    a crash, a missing score, or a non-finite score all collapse to an invalid
    sentinel result. This is the defense against a tampered or broken grader.
    """

    def __init__(
        self,
        runner: GraderRunner,
        direction: str = "maximize",
    ) -> None:
        self._run = runner
        self._direction = direction

    async def grade(self, submission: dict[str, Any]) -> GradeResult:
        try:
            raw = await self._run(submission)
        except Exception:
            # A grader that crashes (or is tampered with) cannot be trusted.
            return GradeResult.invalid(self._direction)

        if not isinstance(raw, dict) or "score" not in raw:
            return GradeResult.invalid(self._direction)

        score = raw.get("score")
        if not isinstance(score, (int, float)) or not math.isfinite(float(score)):
            metrics = raw.get("metrics") if isinstance(raw, dict) else None
            return GradeResult.invalid(self._direction, metrics=metrics)

        return GradeResult(
            score=float(score),
            valid=bool(raw.get("valid", True)),
            metrics=dict(raw.get("metrics", {})),
        )


# ---------------------------------------------------------------------------
# Real out-of-process runner
# ---------------------------------------------------------------------------


def make_subprocess_runner(
    script_path: str,
    python_executable: Optional[str] = None,
    timeout: float = 60,
) -> GraderRunner:
    """Build a runner that grades in a genuinely separate process.

    The grader script reads a JSON submission from stdin and writes a JSON result
    (``{"score": ..., "valid": ..., "metrics": ...}``) to stdout. Running it in a
    child process means the agent's process never touches the grading code.
    """
    exe = python_executable or sys.executable

    async def _runner(submission: dict[str, Any]) -> dict[str, Any]:
        process = await asyncio.create_subprocess_exec(
            exe,
            script_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        payload = json.dumps(submission).encode("utf-8")
        out_b, err_b = await asyncio.wait_for(
            process.communicate(payload), timeout=timeout
        )
        if process.returncode != 0:
            detail = err_b.decode("utf-8", "replace")
            raise RuntimeError(f"Grader exited {process.returncode}: {detail}")
        return json.loads(out_b.decode("utf-8"))

    return _runner
