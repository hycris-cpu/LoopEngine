"""Execution layer — the runtime engine of LoopEngine.

This layer provides:
- runloop (runloop.py): The main execution loop — the "game loop" that drives the agent
- harness (harness.py): The user-facing API that ties model + config + sandbox together
"""

from loopengine.execution.runloop import RunResult, ModelProvider, run_loop
from loopengine.execution.harness import Harness

__all__ = [
    # RunLoop
    "RunResult", "ModelProvider", "run_loop",
    # Harness
    "Harness",
]
