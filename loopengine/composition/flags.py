"""Feature flags let you turn capabilities on and off without changing code.

Plain English: Think of feature flags like light switches in a house.
Each switch controls one feature (like "enable self-verification" or
"use sliding window memory"). You can flip switches without rewiring
the house. This is especially useful for:
- A/B testing: try a feature on some runs but not others
- Safe rollout: enable a risky feature only after testing
- Ablation studies: turn off features one by one to see their impact
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# FeatureFlag — a single named switch
# ---------------------------------------------------------------------------


@dataclass
class FeatureFlag:
    """A single feature flag — a named switch with a default and current value.

    Plain English: This is one light switch on the wall. It has:
    - name: the label under the switch (e.g., "verbose_mode")
    - default: the position the switch starts in (on/off)
    - value: the current position (may differ from default if flipped)
    - description: a note explaining what this switch controls

    The flag's identity is its NAME — two flags with the same name
    refer to the same capability.

    Attributes:
        name: Unique identifier for this flag (like "enable_verification").
        default: The initial value when the flag is created or reset.
        value: The current value (may have been flipped from the default).
        description: Human-readable explanation of what this flag controls.
    """

    name: str
    default: bool = False
    value: bool | None = None
    description: str = ""

    def __post_init__(self) -> None:
        """Ensure current value starts at the default if not explicitly set.

        Uses None as sentinel to distinguish "not provided" from
        "explicitly set to False". When value is None (not provided),
        it inherits from default. When value is explicitly True or False,
        it stays as-is.
        """
        if self.value is None:
            self.value = self.default

    @property
    def is_enabled(self) -> bool:
        """Check if this flag is currently on (value is True).

        Returns:
            True if the flag's current value is True, False otherwise.
        """
        return self.value

    def to_dict(self) -> dict[str, Any]:
        """Serialize this flag to a plain dictionary.

        Returns:
            A dict with name, default, value, and description.
        """
        return {
            "name": self.name,
            "default": self.default,
            "value": self.value,
            "description": self.description,
        }


# ---------------------------------------------------------------------------
# FlagRegistry — manages a collection of named flags
# ---------------------------------------------------------------------------


class FlagRegistry:
    """A registry that manages named feature flags.

    Plain English: Think of FlagRegistry as the main electrical panel in
    a building. It holds all the circuit breakers (flags) and lets you:
    - register(): Install a new breaker
    - get(): Look up a breaker by label
    - set(): Flip a breaker on or off
    - is_enabled(): Check if a breaker is on
    - reset(): Return a breaker (or all breakers) to default position
    - all(): See all installed breakers and their states

    Attributes:
        _flags: Internal dict mapping flag name to FeatureFlag.
    """

    def __init__(self) -> None:
        """Initialize an empty registry with no flags."""
        self._flags: dict[str, FeatureFlag] = {}

    def register(self, flag: FeatureFlag) -> FeatureFlag:
        """Register a new flag in the registry.

        Args:
            flag: The FeatureFlag to register.

        Returns:
            The registered FeatureFlag.

        Raises:
            ValueError: If a flag with the same name is already registered.
        """
        if flag.name in self._flags:
            raise ValueError(
                f"Flag {flag.name!r} is already registered. "
                "Use set() to change its value or reset() to restore defaults."
            )
        self._flags[flag.name] = flag
        return flag

    def get(self, name: str) -> FeatureFlag | None:
        """Look up a flag by name.

        Args:
            name: The flag name to search for.

        Returns:
            The FeatureFlag if found, None otherwise.
        """
        return self._flags.get(name)

    def set(self, name: str, value: bool) -> None:
        """Set the current value of a flag.

        Args:
            name: The flag name to update.
            value: The new value (True = enabled, False = disabled).

        Raises:
            KeyError: If the flag is not registered.
        """
        if name not in self._flags:
            raise KeyError(
                f"Flag {name!r} is not registered. Register it first with register()."
            )
        self._flags[name].value = value

    def is_enabled(self, name: str) -> bool:
        """Check if a flag is currently enabled.

        Non-existent flags return False (safe default — if the capability
        isn't even registered, it's definitely not enabled).

        Args:
            name: The flag name to check.

        Returns:
            True if the flag exists and is enabled, False otherwise.
        """
        flag = self._flags.get(name)
        if flag is None:
            return False
        return flag.value

    def reset(self, name: str | None = None) -> None:
        """Reset one or all flags to their default values.

        Args:
            name: The flag to reset. If None, resets ALL flags.
        """
        if name is not None:
            if name in self._flags:
                self._flags[name].value = self._flags[name].default
        else:
            for f in self._flags.values():
                f.value = f.default

    def all(self) -> dict[str, FeatureFlag]:
        """Return all registered flags as a dict.

        Returns:
            A dict mapping flag name to FeatureFlag.
        """
        return dict(self._flags)


# ---------------------------------------------------------------------------
# flag() — convenience function to create and register a flag in one step
# ---------------------------------------------------------------------------


def flag(
    registry: FlagRegistry,
    name: str,
    default: bool = False,
    description: str = "",
) -> FeatureFlag:
    """Create a FeatureFlag and register it in one step.

    This is a convenience shortcut — instead of:
        f = FeatureFlag(name="x", default=True)
        registry.register(f)

    You can write:
        f = flag(registry, "x", default=True)

    Args:
        registry: The FlagRegistry to register the flag in.
        name: Unique name for the flag.
        default: Initial value (True or False).
        description: Human-readable explanation.

    Returns:
        The created and registered FeatureFlag.
    """
    f = FeatureFlag(name=name, default=default, description=description)
    registry.register(f)
    return f
