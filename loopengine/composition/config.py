"""HarnessConfig is the "blueprint" for building an agent.

Plain English: If a Harness (agent) is a house, then HarnessConfig is the
architectural blueprint. It lists all the parts:
- Which processors (behavioral checkpoints) to install
- Which tools (apps) to make available
- Which feature flags (light switches) to set
- Which config slots (settings) to use

The config is SERIALIZABLE — you can save it to YAML and load it back.
This is critical for reproducibility: given the same config, you get the
same agent behavior every time.

It's also CONTENT-ADDRESSABLE: we compute a SHA-256 hash of the config,
so two identical configs produce the same fingerprint, and any change
produces a different one.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from loopengine.primitives.processors import Processor
from loopengine.primitives.tools import Tool


# ---------------------------------------------------------------------------
# ProcessorEntry — a registered processor with metadata
# ---------------------------------------------------------------------------


@dataclass
class ProcessorEntry:
    """A processor registered in a config, with its hook point and priority.

    Think of this as a job assignment slip — it says WHO (processor),
    WHERE (hook point — which checkpoint), and WHEN (order — priority).

    Attributes:
        processor: The Processor instance.
        hook: Which hook point this processor attaches to (e.g., "step_end").
        order: Priority ordering — lower numbers run first within the same hook.
    """

    processor: Processor
    hook: str = "step_end"
    order: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a plain dict (processor name only — instances aren't serializable).

        Returns:
            A dict with processor name, hook point, and order.
        """
        return {
            "processor": self.processor.name,
            "hook": self.hook,
            "order": self.order,
        }


# ---------------------------------------------------------------------------
# HarnessConfig — the full agent blueprint
# ---------------------------------------------------------------------------


class HarnessConfig:
    """The complete blueprint for building an agent.

    Plain English: This is the shopping list + assembly instructions for
    your agent. It holds every piece:
    - processors: The behavioral checkpoints (what the agent does at each step)
    - tools: The capabilities (what the agent CAN do)
    - flags: The feature switches (what's enabled/disabled)
    - slots: Custom settings (working directory, model name, etc.)

    Key properties:
    - SERIALIZABLE: to_dict() gives you a JSON-safe representation
    - CONTENT-ADDRESSABLE: fingerprint() gives a SHA-256 hash — identical
      configs always produce the same hash
    - VALIDATABLE: validate() checks for common mistakes

    Attributes:
        processors: Ordered list of ProcessorEntry objects.
        tools: List of Tool instances available to the agent.
        flags: Dict mapping flag names to boolean values.
        slots: Dict of arbitrary config key-value pairs.
    """

    def __init__(
        self,
        processors: list[ProcessorEntry] | None = None,
        tools: list[Tool] | None = None,
        flags: dict[str, bool] | None = None,
        slots: dict[str, Any] | None = None,
    ) -> None:
        """Initialize a HarnessConfig.

        Args:
            processors: Processor entries (defaults to empty list).
            tools: Tool instances (defaults to empty list).
            flags: Feature flag values (defaults to empty dict).
            slots: Config slot key-value pairs (defaults to empty dict).
        """
        self.processors: list[ProcessorEntry] = list(processors) if processors else []
        self.tools: list[Tool] = list(tools) if tools else []
        self.flags: dict[str, bool] = dict(flags) if flags else {}
        self.slots: dict[str, Any] = dict(slots) if slots else {}

    def fingerprint(self) -> str:
        """Compute a SHA-256 hash of this config for identity comparison.

        Plain English: This is the config's "DNA" — a unique fingerprint.
        Two configs with identical contents produce the same fingerprint.
        Change anything, and the fingerprint changes.

        This is deterministic: call it 100 times, get the same answer.

        Returns:
            A hex string (64 chars) representing the SHA-256 hash.
        """
        canonical = json.dumps(self.to_dict(), sort_keys=True, default=str)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def to_dict(self) -> dict[str, Any]:
        """Serialize this config to a JSON-safe dictionary.

        Returns:
            A dict with processors, tools (by name), flags, and slots.
        """
        return {
            "processors": [pe.to_dict() for pe in self.processors],
            "tools": [
                {"name": t.name, "description": t.description}
                for t in self.tools
            ],
            "flags": dict(self.flags),
            "slots": dict(self.slots),
        }

    def validate(self) -> list[str]:
        """Check this config for common mistakes.

        Plain English: Like a building inspector checking a blueprint
        before construction begins. Returns a list of problems found.

        Checks performed:
        - Processor hook points must be valid HOOK_POINTS
        - No duplicate processor+hook+order combinations
        - Tool names must be unique
        - Flag values must be booleans

        Returns:
            A list of error message strings. Empty list means valid.
        """
        from loopengine.primitives.processors import HOOK_POINTS

        errors: list[str] = []

        # Check processor hook points
        seen_combos: set[tuple[str, str, int]] = set()
        for pe in self.processors:
            if pe.hook not in HOOK_POINTS:
                errors.append(
                    f"Processor '{pe.processor.name}' has invalid hook '{pe.hook}'. "
                    f"Must be one of: {HOOK_POINTS}"
                )
            combo = (pe.processor.name, pe.hook, pe.order)
            if combo in seen_combos:
                errors.append(
                    f"Duplicate processor entry: '{pe.processor.name}' "
                    f"at hook '{pe.hook}' with order {pe.order}"
                )
            seen_combos.add(combo)

        # Check tool names are non-empty and unique
        tool_names = [t.name for t in self.tools]
        for t in self.tools:
            if not t.name:
                errors.append(
                    f"Tool has empty name (description: '{t.description}')"
                )
        if len(tool_names) != len(set(tool_names)):
            seen = set()
            for name in tool_names:
                if name in seen:
                    errors.append(f"Duplicate tool name: '{name}'")
                seen.add(name)

        # Check flag types
        for name, value in self.flags.items():
            if not isinstance(value, bool):
                errors.append(
                    f"Flag '{name}' has non-boolean value: {type(value).__name__}"
                )

        return errors
