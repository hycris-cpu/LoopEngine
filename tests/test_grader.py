"""Tests for the out-of-process grader (Feature B).

The grader mirrors EurekAgent's grade/compare contract: scoring runs behind a
process boundary, invalid submissions get a sentinel score so they can never
rank as best, and the optimization direction is explicit.
"""

from __future__ import annotations

import json
import math
import sys

import pytest

from loopengine.evaluation.grader import (
    GradeResult,
    IsolatedGrader,
    is_better,
    make_subprocess_runner,
)


class TestGradeResult:
    def test_invalid_maximize_is_negative_infinity(self):
        r = GradeResult.invalid("maximize")
        assert r.valid is False
        assert r.score == float("-inf")

    def test_invalid_minimize_is_positive_infinity(self):
        r = GradeResult.invalid("minimize")
        assert r.valid is False
        assert r.score == float("inf")


class TestIsBetter:
    def test_valid_beats_invalid_when_maximizing(self):
        good = GradeResult(score=0.1, valid=True)
        bad = GradeResult.invalid("maximize")
        assert is_better(good, bad, "maximize") is True
        assert is_better(bad, good, "maximize") is False

    def test_valid_beats_invalid_when_minimizing(self):
        good = GradeResult(score=999.0, valid=True)
        bad = GradeResult.invalid("minimize")
        assert is_better(good, bad, "minimize") is True
        assert is_better(bad, good, "minimize") is False

    def test_direction_controls_comparison(self):
        a = GradeResult(score=0.3, valid=True)
        b = GradeResult(score=0.7, valid=True)
        assert is_better(b, a, "maximize") is True
        assert is_better(a, b, "minimize") is True


class TestIsolatedGrader:
    async def test_valid_result_is_parsed(self):
        async def runner(submission):
            return {"score": 0.7, "valid": True, "metrics": {"n": 1}}

        grader = IsolatedGrader(runner=runner)
        result = await grader.grade({"x": 1})
        assert result.valid is True
        assert result.score == 0.7
        assert result.metrics == {"n": 1}

    async def test_runner_crash_yields_invalid(self):
        async def runner(submission):
            raise RuntimeError("grader blew up")

        grader = IsolatedGrader(runner=runner, direction="maximize")
        result = await grader.grade({"x": 1})
        assert result.valid is False
        assert result.score == float("-inf")

    async def test_non_finite_score_yields_invalid(self):
        async def runner(submission):
            return {"score": float("nan")}

        grader = IsolatedGrader(runner=runner)
        result = await grader.grade({"x": 1})
        assert result.valid is False

    async def test_missing_score_yields_invalid(self):
        async def runner(submission):
            return {"metrics": {}}

        grader = IsolatedGrader(runner=runner)
        result = await grader.grade({"x": 1})
        assert result.valid is False


class TestSubprocessRunner:
    async def test_grades_in_a_separate_process(self, tmp_path):
        script = tmp_path / "grader_script.py"
        script.write_text(
            "import sys, json\n"
            "sub = json.load(sys.stdin)\n"
            "print(json.dumps({'score': sub['x'] * 2, 'valid': True}))\n",
            encoding="utf-8",
        )
        runner = make_subprocess_runner(str(script))
        grader = IsolatedGrader(runner=runner)
        result = await grader.grade({"x": 3})
        assert result.valid is True
        assert result.score == 6
