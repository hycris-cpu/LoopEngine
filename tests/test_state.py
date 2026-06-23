"""Tests for the State module — the agent's "working memory" during execution.

We use TDD (Test-Driven Development), BDD (Behavior-Driven Development),
and DDD (Domain-Driven Design) principles.

TDD: Write ONE test → implement → verify → repeat (vertical slices)
BDD: Each test has a Given/When/Then docstring
DDD: Tests verify domain behavior through public interfaces only
"""

from __future__ import annotations

import pytest
from loopengine.primitives.state import (
    Budget,
    State,
    StateDelta,
    StateSlot,
    StateSnapshot,
)
from loopengine.primitives.events import Message


# ============================================================================
# Test 1: Budget creation (frozen dataclass)
# ============================================================================

class TestBudget:
    """Tests for the Budget resource limits type."""

    def test_budget_creation_with_defaults(self):
        """Given no arguments, When I create a Budget, Then it has sensible defaults."""
        budget = Budget()
        assert budget.max_tokens == 128_000
        assert budget.max_cost_usd == 10.0
        assert budget.max_steps == 100

    def test_budget_creation_with_custom_values(self):
        """Given custom limits, When I create a Budget, Then it stores them."""
        budget = Budget(max_tokens=4096, max_cost_usd=1.0, max_steps=10)
        assert budget.max_tokens == 4096
        assert budget.max_cost_usd == 1.0
        assert budget.max_steps == 10

    def test_budget_is_frozen(self):
        """Given a Budget, When I try to change a field, Then it raises FrozenInstanceError."""
        budget = Budget()
        with pytest.raises(AttributeError):
            budget.max_tokens = 999

    def test_budget_equality(self):
        """Given two Budgets with same values, When I compare them, Then they are equal."""
        b1 = Budget(max_tokens=4096, max_cost_usd=1.0, max_steps=10)
        b2 = Budget(max_tokens=4096, max_cost_usd=1.0, max_steps=10)
        assert b1 == b2

    def test_budget_inequality(self):
        """Given two Budgets with different values, When I compare them, Then they differ."""
        b1 = Budget(max_tokens=4096)
        b2 = Budget(max_tokens=8192)
        assert b1 != b2


# ============================================================================
# Test 2: StateSlot — cross-processor communication
# ============================================================================

class TestStateSlot:
    """Tests for the StateSlot sticky-note type."""

    def test_slot_creation_with_defaults(self):
        """Given no arguments, When I create a StateSlot, Then it has defaults."""
        slot = StateSlot()
        assert slot.key == ""
        assert slot.value is None
        assert slot.slot_type == "general"
        assert slot.metadata == {}

    def test_slot_creation_with_values(self):
        """Given specific values, When I create a StateSlot, Then it stores them."""
        slot = StateSlot(key="retry_count", value=3, slot_type="counter",
                         metadata={"processor": "retry"})
        assert slot.key == "retry_count"
        assert slot.value == 3
        assert slot.slot_type == "counter"
        assert slot.metadata == {"processor": "retry"}

    def test_slot_is_mutable(self):
        """Given a StateSlot, When I change its value, Then the change sticks."""
        slot = StateSlot(key="x", value=1)
        slot.value = 2
        assert slot.value == 2


# ============================================================================
# Test 3: State — creation and defaults
# ============================================================================

class TestStateCreation:
    """Tests for creating a fresh State."""

    def test_state_creation_with_defaults(self):
        """Given no arguments, When I create a State, Then it starts empty at step 0."""
        state = State()
        assert state.raw_messages == []
        assert state.messages == []
        assert state.slots == {}
        assert state.step == 0
        assert isinstance(state.budget, Budget)
        assert state.usage_tokens == 0
        assert state.usage_cost_usd == 0.0

    def test_state_creation_with_custom_budget(self):
        """Given a custom budget, When I create a State, Then it uses that budget."""
        budget = Budget(max_tokens=4096, max_steps=10)
        state = State(budget=budget)
        assert state.budget.max_tokens == 4096
        assert state.budget.max_steps == 10


# ============================================================================
# Test 4: State — dual-track message operations
# ============================================================================

class TestStateMessages:
    """Tests for the dual-track message design (raw_messages vs messages)."""

    def _make_msg(self, role: str = "user", content: str = "hello",
                  run_id: str = "test-run", step_id: int = 0) -> Message:
        """Helper to create a Message with sensible defaults."""
        return Message(
            role=role, content=content,
            run_id=run_id, step_id=step_id, ts=1234567890.0,
        )

    def test_add_message_dual_track(self, run_id):
        """Given a fresh state, When I add a message,
        Then raw_messages and messages both contain it."""
        state = State()
        msg = self._make_msg(run_id=run_id)
        state.add_message(msg)
        assert len(state.raw_messages) == 1
        assert len(state.messages) == 1
        assert state.raw_messages[0] is msg
        assert state.messages[0] is msg

    def test_add_raw_event_only(self, run_id):
        """Given a fresh state, When I add a raw event,
        Then raw_messages contains it but messages does not."""
        state = State()
        msg = self._make_msg(run_id=run_id)
        state.add_raw_event(msg)
        assert len(state.raw_messages) == 1
        assert len(state.messages) == 0

    def test_inject_message_only(self, run_id):
        """Given a fresh state, When I inject a message,
        Then messages contains it but raw_messages does not."""
        state = State()
        hint = self._make_msg(role="system", content="Be concise.", run_id=run_id)
        state.inject_message(hint)
        assert len(state.messages) == 1
        assert len(state.raw_messages) == 0

    def test_dual_track_divergence(self, run_id):
        """Given a state with both real and injected messages,
        When I compare raw_messages and messages, Then they differ."""
        state = State()
        real_msg = self._make_msg(content="real", run_id=run_id)
        hint = self._make_msg(role="system", content="hint", run_id=run_id)
        state.add_message(real_msg)
        state.inject_message(hint)
        # raw_messages has 1, messages has 2
        assert len(state.raw_messages) == 1
        assert len(state.messages) == 2
        assert state.messages[1].content == "hint"

    def test_multiple_adds_preserve_order(self, run_id):
        """Given a state, When I add messages in order,
        Then both tracks preserve that order."""
        state = State()
        msg1 = self._make_msg(content="first", run_id=run_id, step_id=0)
        msg2 = self._make_msg(content="second", run_id=run_id, step_id=1)
        state.add_message(msg1)
        state.add_message(msg2)
        assert state.raw_messages[0].content == "first"
        assert state.raw_messages[1].content == "second"
        assert state.messages[0].content == "first"
        assert state.messages[1].content == "second"


# ============================================================================
# Test 5: State — slot CRUD operations
# ============================================================================

class TestStateSlots:
    """Tests for creating, reading, updating, and deleting slots on a State."""

    def test_set_and_get_slot(self):
        """Given a fresh state, When I set a slot, Then I can get it back."""
        state = State()
        state.set_slot("retry_count", 3, slot_type="counter")
        slot = state.get_slot("retry_count")
        assert slot is not None
        assert slot.key == "retry_count"
        assert slot.value == 3
        assert slot.slot_type == "counter"

    def test_get_missing_slot_returns_none(self):
        """Given a fresh state, When I get a nonexistent slot, Then I get None."""
        state = State()
        assert state.get_slot("nonexistent") is None

    def test_set_slot_overwrites_value(self):
        """Given a state with slot "x", When I set "x" again, Then the value updates."""
        state = State()
        state.set_slot("x", 1)
        state.set_slot("x", 2)
        assert state.get_slot("x").value == 2
        assert len(state.slots) == 1

    def test_delete_existing_slot(self):
        """Given a state with slot "x", When I delete it, Then True is returned and it's gone."""
        state = State()
        state.set_slot("x", 42)
        result = state.delete_slot("x")
        assert result is True
        assert state.get_slot("x") is None

    def test_delete_missing_slot(self):
        """Given a state without slot "x", When I delete it, Then False is returned."""
        state = State()
        result = state.delete_slot("x")
        assert result is False

    def test_multiple_slots_independent(self):
        """Given a state, When I set multiple slots, Then they are independent."""
        state = State()
        state.set_slot("a", 1)
        state.set_slot("b", 2)
        state.set_slot("c", 3)
        assert state.get_slot("a").value == 1
        assert state.get_slot("b").value == 2
        assert state.get_slot("c").value == 3
        assert len(state.slots) == 3

    def test_set_slot_with_metadata(self):
        """Given a state, When I set a slot with metadata, Then metadata is stored."""
        state = State()
        state.set_slot("hint", "be concise", metadata={"from": "processor"})
        slot = state.get_slot("hint")
        assert slot.metadata == {"from": "processor"}


# ============================================================================
# Test 6: StateSnapshot — frozen checkpoint creation
# ============================================================================

class TestStateSnapshot:
    """Tests for the frozen StateSnapshot type."""

    def test_snapshot_captures_state(self, run_id):
        """Given a state with messages and slots, When I snapshot,
        Then the snapshot captures everything."""
        state = State()
        msg = Message(role="user", content="hi", run_id=run_id, step_id=0, ts=1.0)
        state.add_message(msg)
        state.set_slot("x", 42)
        state.step = 3

        snap = state.snapshot()
        assert len(snap.raw_messages) == 1
        assert len(snap.messages) == 1
        assert snap.slots["x"].value == 42
        assert snap.step == 3

    def test_snapshot_is_frozen(self, run_id):
        """Given a snapshot, When I try to mutate it, Then it raises an error."""
        state = State()
        snap = state.snapshot()
        with pytest.raises(AttributeError):
            snap.step = 99

    def test_snapshot_is_independent_of_state(self, run_id):
        """Given a snapshot taken from a state, When I mutate the state,
        Then the snapshot is unchanged."""
        state = State()
        state.set_slot("x", 1)
        snap = state.snapshot()
        # Mutate state
        state.set_slot("x", 2)
        state.add_message(Message(role="user", content="new", run_id=run_id, step_id=0, ts=1.0))
        # Snapshot still has old values
        assert snap.slots["x"].value == 1
        assert len(snap.raw_messages) == 0

    def test_snapshot_default_is_empty(self):
        """Given no state, When I create a snapshot directly, Then it's empty."""
        snap = StateSnapshot()
        assert snap.raw_messages == ()
        assert snap.messages == ()
        assert snap.slots == {}
        assert snap.step == 0


# ============================================================================
# Test 7: State — snapshot/restore roundtrip
# ============================================================================

class TestStateSnapshotRestore:
    """Tests for the snapshot → restore roundtrip."""

    def test_restore_roundtrip(self, run_id):
        """Given a state with data, When I snapshot then restore,
        Then the state matches the original."""
        state = State()
        msg = Message(role="user", content="hello", run_id=run_id, step_id=0, ts=1.0)
        state.add_message(msg)
        state.set_slot("key", "value")
        state.step = 5

        snap = state.snapshot()

        # Mutate state
        state.set_slot("key", "CHANGED")
        state.step = 99
        state.add_message(Message(role="user", content="noise", run_id=run_id, step_id=1, ts=2.0))

        # Restore
        state.restore(snap)

        assert len(state.raw_messages) == 1
        assert state.raw_messages[0].content == "hello"
        assert state.get_slot("key").value == "value"
        assert state.step == 5

    def test_restore_clears_current_state(self, run_id):
        """Given a state with current data, When I restore an older snapshot,
        Then current data is overwritten."""
        state = State()
        snap_empty = state.snapshot()  # Empty snapshot

        # Add data
        state.add_message(Message(role="user", content="added", run_id=run_id, step_id=0, ts=1.0))
        state.set_slot("x", 1)
        assert len(state.raw_messages) == 1

        # Restore empty
        state.restore(snap_empty)
        assert len(state.raw_messages) == 0
        assert len(state.slots) == 0


# ============================================================================
# Test 8: StateDelta — tracking what changed
# ============================================================================

class TestStateDelta:
    """Tests for computing state deltas."""

    def test_delta_detects_new_slots(self, run_id):
        """Given a snapshot and new slots added, When I compute delta,
        Then created_slots lists them."""
        state = State()
        snap = state.snapshot()
        state.set_slot("a", 1)
        state.set_slot("b", 2)
        delta = state.compute_delta(snap)
        assert sorted(delta.created_slots) == ["a", "b"]
        assert delta.updated_slots == []
        assert delta.deleted_slots == []

    def test_delta_detects_updated_slots(self):
        """Given a snapshot and a slot value changed, When I compute delta,
        Then updated_slots lists it."""
        state = State()
        state.set_slot("x", 1)
        snap = state.snapshot()
        state.set_slot("x", 2)
        delta = state.compute_delta(snap)
        assert delta.updated_slots == ["x"]
        assert delta.created_slots == []
        assert delta.deleted_slots == []

    def test_delta_detects_deleted_slots(self):
        """Given a snapshot and a slot deleted, When I compute delta,
        Then deleted_slots lists it."""
        state = State()
        state.set_slot("x", 1)
        state.set_slot("y", 2)
        snap = state.snapshot()
        state.delete_slot("y")
        delta = state.compute_delta(snap)
        assert delta.deleted_slots == ["y"]
        assert delta.created_slots == []
        assert delta.updated_slots == []

    def test_delta_detects_new_messages(self, run_id):
        """Given a snapshot and new messages added, When I compute delta,
        Then messages_added is correct."""
        state = State()
        snap = state.snapshot()
        state.add_message(Message(role="user", content="a", run_id=run_id, step_id=0, ts=1.0))
        state.add_message(Message(role="assistant", content="b", run_id=run_id, step_id=1, ts=2.0))
        delta = state.compute_delta(snap)
        assert delta.messages_added == 2

    def test_delta_detects_step_change(self):
        """Given a snapshot and step advanced, When I compute delta,
        Then step_delta is correct."""
        state = State()
        state.step = 0
        snap = state.snapshot()
        state.step = 3
        delta = state.compute_delta(snap)
        assert delta.step_delta == 3

    def test_delta_empty_when_no_changes(self):
        """Given a snapshot and no changes, When I compute delta,
        Then everything is empty/zero."""
        state = State()
        state.set_slot("x", 1)
        snap = state.snapshot()
        delta = state.compute_delta(snap)
        assert delta.created_slots == []
        assert delta.updated_slots == []
        assert delta.deleted_slots == []
        assert delta.messages_added == 0
        assert delta.step_delta == 0

    def test_delta_combined_changes(self, run_id):
        """Given a snapshot, When I create, update, and delete slots plus add messages,
        Then the delta captures all changes."""
        state = State()
        state.set_slot("keep", "old")
        state.set_slot("delete_me", "bye")
        snap = state.snapshot()

        state.set_slot("keep", "new")      # updated
        state.delete_slot("delete_me")       # deleted
        state.set_slot("brand_new", "hello") # created
        state.add_message(Message(role="user", content="hi", run_id=run_id, step_id=0, ts=1.0))
        state.step = 1

        delta = state.compute_delta(snap)
        assert delta.created_slots == ["brand_new"]
        assert delta.updated_slots == ["keep"]
        assert delta.deleted_slots == ["delete_me"]
        assert delta.messages_added == 1
        assert delta.step_delta == 1


# ============================================================================
# Test 9: State — budget tracking
# ============================================================================

class TestStateBudgetTracking:
    """Tests for resource usage tracking in State."""

    def test_record_usage(self):
        """Given a fresh state, When I record usage, Then totals update."""
        state = State()
        state.record_usage(tokens=100, cost_usd=0.50)
        assert state.usage_tokens == 100
        assert state.usage_cost_usd == 0.50

    def test_record_usage_accumulates(self):
        """Given a state, When I record usage twice, Then totals accumulate."""
        state = State()
        state.record_usage(tokens=100, cost_usd=0.50)
        state.record_usage(tokens=200, cost_usd=1.00)
        assert state.usage_tokens == 300
        assert state.usage_cost_usd == 1.50

    def test_budget_not_exhausted_initially(self):
        """Given a fresh state, When I check is_budget_exhausted, Then it's False."""
        state = State()
        assert state.is_budget_exhausted is False

    def test_budget_exhausted_by_tokens(self):
        """Given a state whose token usage >= max_tokens,
        When I check is_budget_exhausted, Then it's True."""
        state = State(budget=Budget(max_tokens=100))
        state.usage_tokens = 100
        assert state.is_budget_exhausted is True

    def test_budget_exhausted_by_cost(self):
        """Given a state whose cost >= max_cost_usd,
        When I check is_budget_exhausted, Then it's True."""
        state = State(budget=Budget(max_cost_usd=5.0))
        state.usage_cost_usd = 5.0
        assert state.is_budget_exhausted is True

    def test_budget_exhausted_by_steps(self):
        """Given a state whose step >= max_steps,
        When I check is_budget_exhausted, Then it's True."""
        state = State(budget=Budget(max_steps=10))
        state.step = 10
        assert state.is_budget_exhausted is True
