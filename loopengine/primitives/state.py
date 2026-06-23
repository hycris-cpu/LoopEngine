"""The State module manages the agent's "working memory" during execution.

Plain English: Think of State as the agent's desk while it's working.
It has:
- raw_messages: A notebook where EVERYTHING is written down (append-only, factual)
- messages: The "clean" version the AI actually sees (processors may modify this)
- slots: Sticky notes for passing info between processors
- step: Which step number we're on
- budget: How many tokens/money we've spent

The DUAL-TRACK design (raw_messages vs messages) is key:
- raw_messages = what actually happened (ground truth)
- messages = what the model sees (may include processor-injected hints)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from loopengine.primitives.events import Event, Message


# ---------------------------------------------------------------------------
# Budget — immutable resource limits for a run
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Budget:
    """Immutable resource limits for an agent run (like a spending limit on a credit card).

    Plain English: Think of Budget as your "allowance" for the agent.
    It sets hard ceilings:
    - max_tokens: How many tokens the AI can consume (tokens ≈ words)
    - max_cost_usd: How much money you're willing to spend (in dollars)
    - max_steps: How many reasoning steps the agent can take

    Budget is FROZEN (immutable) — once set, limits never change during a run.
    Usage tracking lives in State itself, not in Budget.
    """
    max_tokens: int = 128_000
    max_cost_usd: float = 10.0
    max_steps: int = 100


# ---------------------------------------------------------------------------
# StateSlot — cross-processor communication slots
# ---------------------------------------------------------------------------

@dataclass
class StateSlot:
    """A named slot for passing information between processors (like a sticky note).

    Plain English: Processors need to talk to each other, but they can't
    directly see each other's internal state. StateSlots are the mailbox
    system — any processor can write to a slot, and any later processor
    can read it.

    Attributes:
        key: Unique name for this slot (like a sticky note label).
        value: The data stored in this slot (can be anything).
        slot_type: Category tag for filtering (e.g., "context", "hint", "tool_result").
        metadata: Extra key-value pairs for debugging and analysis.
    """
    key: str = ""
    value: Any = None
    slot_type: str = "general"
    metadata: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# StateDelta — records what changed between two state snapshots
# ---------------------------------------------------------------------------

@dataclass
class StateDelta:
    """Records what changed in a State between two points in time (like a diff).

    Plain English: When the State changes, a StateDelta captures exactly
    what was different:
    - created_slots: New sticky notes added
    - updated_slots: Sticky notes whose values changed
    - deleted_slots: Sticky notes that were removed
    - messages_added: Number of new messages added to raw_messages
    - step_delta: Change in step number (usually +1)
    - budget_delta: Change in resource usage (tokens, cost)

    This is useful for debugging ("what changed?") and for training
    ("what did the agent experience?").
    """
    created_slots: list[str] = field(default_factory=list)
    updated_slots: list[str] = field(default_factory=list)
    deleted_slots: list[str] = field(default_factory=list)
    messages_added: int = 0
    step_delta: int = 0
    budget_delta: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# StateSnapshot — frozen checkpoint of State
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class StateSnapshot:
    """An immutable snapshot of a State at a point in time (like a photograph).

    Plain English: Sometimes you want to "save" the current state — like
    taking a photo of your desk before you leave for lunch. A StateSnapshot
    captures everything exactly as it was. You can use snapshots to:
    - Roll back to a previous state (retry after failure)
    - Compare states across steps (did things improve?)
    - Fork a state (try multiple strategies from the same starting point)

    It's frozen (immutable) so the snapshot can never be accidentally changed.
    """
    raw_messages: tuple[Event, ...] = ()
    messages: tuple[Message, ...] = ()
    slots: dict[str, StateSlot] = field(default_factory=dict)
    step: int = 0
    budget: Budget = field(default_factory=Budget)

    def to_dict(self) -> dict[str, Any]:
        """Serialize this snapshot to a plain dictionary.

        Useful for JSON serialization (e.g., saving trajectory steps to JSONL).

        Returns:
            A dictionary with all snapshot fields converted to basic types.
        """
        return {
            "raw_messages": [m.to_dict() for m in self.raw_messages],
            "messages": [m.to_dict() for m in self.messages],
            "slots": {
                k: {"key": s.key, "value": s.value, "slot_type": s.slot_type, "metadata": s.metadata}
                for k, s in self.slots.items()
            },
            "step": self.step,
            "budget": {
                "max_tokens": self.budget.max_tokens,
                "max_cost_usd": self.budget.max_cost_usd,
                "max_steps": self.budget.max_steps,
            },
        }


# ---------------------------------------------------------------------------
# State — the agent's mutable working memory
# ---------------------------------------------------------------------------

@dataclass
class State:
    """The agent's mutable working memory during a task execution (like a desk).

    Plain English: This is where all the action happens. The State holds:
    - raw_messages: What ACTUALLY happened (append-only truth)
    - messages: What the MODEL sees (may differ due to processors)
    - slots: Sticky notes for cross-processor communication
    - step: Current step number (0, 1, 2, ...)
    - budget: Immutable resource limits
    - usage_tokens: Actual tokens consumed so far
    - usage_cost_usd: Actual dollars spent so far

    DUAL-TRACK DESIGN:
    The key insight is that raw_messages and messages can diverge.
    A processor might inject a "system hint" into messages that doesn't
    appear in raw_messages. This lets us:
    - Keep ground truth (raw_messages) for auditing/training
    - Give the model helpful context (messages) for better responses

    State is MUTABLE — it changes as the agent works. But you can take
    a frozen StateSnapshot at any time to checkpoint the current state.
    """
    raw_messages: list[Event] = field(default_factory=list)
    messages: list[Message] = field(default_factory=list)
    slots: dict[str, StateSlot] = field(default_factory=dict)
    step: int = 0
    budget: Budget = field(default_factory=Budget)
    usage_tokens: int = 0
    usage_cost_usd: float = 0.0

    # ------------------------------------------------------------------
    # Message operations (dual-track)
    # ------------------------------------------------------------------

    def add_message(self, message: Message) -> None:
        """Add a message to BOTH raw_messages and messages (dual-track append).

        This is the standard way to add a message that actually happened.
        The message goes into raw_messages (ground truth) AND messages
        (what the model sees). If a processor needs to modify only what
        the model sees, it should modify self.messages directly.

        BDD: Given a fresh state, When I add a message,
             Then raw_messages and messages both contain it.

        Args:
            message: The Message event to record.
        """
        self.raw_messages.append(message)
        self.messages.append(message)

    def add_raw_event(self, event: Event) -> None:
        """Add an event to raw_messages only (not to messages).

        Use this for events that should be recorded in history but are
        NOT conversation messages (e.g., ToolCall, ToolResult, EvalResult).

        BDD: Given a fresh state, When I add a raw event,
             Then raw_messages contains it but messages does not.

        Args:
            event: The Event to record in raw history.
        """
        self.raw_messages.append(event)

    def inject_message(self, message: Message) -> None:
        """Add a message to messages ONLY (not raw_messages).

        Use this for processor-injected hints that the model should see
        but that aren't part of the "real" conversation history.

        BDD: Given a fresh state, When I inject a message,
             Then messages contains it but raw_messages does not.

        Args:
            message: The Message to inject into the model's view.
        """
        self.messages.append(message)

    # ------------------------------------------------------------------
    # Slot operations (cross-processor communication)
    # ------------------------------------------------------------------

    def set_slot(self, key: str, value: Any, slot_type: str = "general",
                 metadata: dict[str, Any] | None = None) -> StateSlot:
        """Create or update a named slot.

        BDD: Given a state, When I set a slot with a key and value,
             Then get_slot returns that slot with the correct value.

        Args:
            key: Unique name for this slot.
            value: The data to store.
            slot_type: Category tag for filtering.
            metadata: Optional extra key-value pairs.

        Returns:
            The created/updated StateSlot.
        """
        slot = StateSlot(key=key, value=value, slot_type=slot_type,
                         metadata=metadata or {})
        self.slots[key] = slot
        return slot

    def get_slot(self, key: str) -> StateSlot | None:
        """Retrieve a slot by key, or None if it doesn't exist.

        BDD: Given a state with slot "x", When I get_slot("x"),
             Then I get the slot. When I get_slot("missing"), Then I get None.

        Args:
            key: The slot name to look up.

        Returns:
            The StateSlot if found, None otherwise.
        """
        return self.slots.get(key)

    def delete_slot(self, key: str) -> bool:
        """Remove a slot by key.

        BDD: Given a state with slot "x", When I delete_slot("x"),
             Then the slot is gone and True is returned.
             Deleting a non-existent slot returns False.

        Args:
            key: The slot name to remove.

        Returns:
            True if the slot existed and was removed, False otherwise.
        """
        if key in self.slots:
            del self.slots[key]
            return True
        return False

    # ------------------------------------------------------------------
    # Budget / usage tracking
    # ------------------------------------------------------------------

    def record_usage(self, tokens: int = 0, cost_usd: float = 0.0) -> None:
        """Record resource consumption after a model call.

        BDD: Given a fresh state, When I record 100 tokens and $0.50,
             Then usage_tokens is 100 and usage_cost_usd is 0.50.

        Args:
            tokens: Number of tokens consumed in this step.
            cost_usd: Dollar cost of this step.
        """
        self.usage_tokens += tokens
        self.usage_cost_usd += cost_usd

    @property
    def is_budget_exhausted(self) -> bool:
        """Check if any resource limit has been reached or exceeded.

        BDD: Given a state with usage >= budget limits,
             When I check is_budget_exhausted, Then it returns True.
        """
        return (
            self.usage_tokens >= self.budget.max_tokens
            or self.usage_cost_usd >= self.budget.max_cost_usd
            or self.step >= self.budget.max_steps
        )

    # ------------------------------------------------------------------
    # Snapshot / restore
    # ------------------------------------------------------------------

    def snapshot(self) -> StateSnapshot:
        """Create a frozen snapshot of the current state.

        Use this for checkpointing — saving the exact state at a point in time
        so you can restore it later (e.g., for rollback or retry).

        BDD: Given a state with some messages and slots,
             When I take a snapshot, Then it captures everything exactly.

        Returns:
            An immutable StateSnapshot capturing this moment.
        """
        return StateSnapshot(
            raw_messages=tuple(self.raw_messages),
            messages=tuple(self.messages),
            slots=dict(self.slots),
            step=self.step,
            budget=self.budget,
        )

    def restore(self, snapshot: StateSnapshot) -> None:
        """Restore state from a frozen snapshot.

        This overwrites the current state entirely with the snapshot's data.
        Like rewinding a video to a saved point.

        BDD: Given a snapshot from earlier, When I restore it,
             Then the state matches exactly what was snapshotted.

        Args:
            snapshot: The StateSnapshot to restore from.
        """
        self.raw_messages = list(snapshot.raw_messages)
        self.messages = list(snapshot.messages)
        self.slots = dict(snapshot.slots)
        self.step = snapshot.step
        self.budget = snapshot.budget

    # ------------------------------------------------------------------
    # Delta computation
    # ------------------------------------------------------------------

    def compute_delta(self, snapshot: StateSnapshot) -> StateDelta:
        """Compute what changed since a previous snapshot.

        BDD: Given a snapshot and then modifications to the state,
             When I compute_delta(snapshot), Then it lists all changes.

        Args:
            snapshot: The earlier snapshot to compare against.

        Returns:
            A StateDelta describing all changes.
        """
        old_keys = set(snapshot.slots.keys())
        new_keys = set(self.slots.keys())

        created = list(new_keys - old_keys)
        deleted = list(old_keys - new_keys)

        # Slots that exist in both but have different values
        updated = []
        for key in old_keys & new_keys:
            if snapshot.slots[key].value != self.slots[key].value:
                updated.append(key)

        return StateDelta(
            created_slots=created,
            updated_slots=updated,
            deleted_slots=deleted,
            messages_added=len(self.raw_messages) - len(snapshot.raw_messages),
            step_delta=self.step - snapshot.step,
        )

    # Alias for backwards compatibility / shorter name
    def diff(self, snapshot: StateSnapshot) -> StateDelta:
        """Alias for compute_delta — compute what changed since a snapshot.

        Args:
            snapshot: The earlier snapshot to compare against.

        Returns:
            A StateDelta describing all changes.
        """
        return self.compute_delta(snapshot)
