"""Evolution checkpoint/resume — durable run state (Feature C).

Plain English: a long self-improvement run is expensive. If the process crashes
on iteration 40, you do not want to throw away the first 39. EurekAgent persists
run state and resumes from a checkpoint; this module gives LoopEngine the same.

An ``EvolutionCheckpoint`` is a snapshot of everything needed to continue: which
iteration we finished, the history so far, the current (possibly evolved) source
and config, and the running counters. ``CheckpointStore`` reads/writes it as JSON
(written atomically so a crash mid-write can never corrupt the file).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


@dataclass
class EvolutionCheckpoint:
    """A resumable snapshot of a LoopEngine run."""

    iteration: int = 0
    history: list[dict[str, Any]] = field(default_factory=list)
    current_source: dict[str, str] = field(default_factory=dict)
    current_config: dict[str, Any] = field(default_factory=dict)
    improvements: int = 0
    rejections: int = 0
    final_score: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "iteration": self.iteration,
            "history": self.history,
            "current_source": self.current_source,
            "current_config": self.current_config,
            "improvements": self.improvements,
            "rejections": self.rejections,
            "final_score": self.final_score,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "EvolutionCheckpoint":
        return cls(
            iteration=d.get("iteration", 0),
            history=d.get("history", []),
            current_source=d.get("current_source", {}),
            current_config=d.get("current_config", {}),
            improvements=d.get("improvements", 0),
            rejections=d.get("rejections", 0),
            final_score=d.get("final_score", 0.0),
        )


class CheckpointStore:
    """Reads and writes an EvolutionCheckpoint as JSON on disk."""

    def __init__(self, path: str) -> None:
        self._path = Path(path)

    def exists(self) -> bool:
        return self._path.exists()

    def save(self, checkpoint: EvolutionCheckpoint) -> None:
        """Persist the checkpoint atomically (write to a temp file, then rename)."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(checkpoint.to_dict(), indent=2), encoding="utf-8")
        os.replace(tmp, self._path)

    def load(self) -> Optional[EvolutionCheckpoint]:
        """Load the checkpoint, or return None if none has been written yet."""
        if not self._path.exists():
            return None
        data = json.loads(self._path.read_text(encoding="utf-8"))
        return EvolutionCheckpoint.from_dict(data)
