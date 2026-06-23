"""Tests for the Events module.

BDD Scenarios:
- Given event data, When I create an Event, Then it has the expected fields
- Given a frozen Event, When I try to mutate it, Then it raises FrozenInstanceError
- Given two Events with the same data, When I compare them, Then they are equal
"""

import pytest


class TestEventCreation:
    """Given event data, When I create an Event, Then it has the expected fields."""

    def test_event_has_required_fields(self):
        from loopengine.primitives.events import Event

        event = Event(type="test", run_id="r1", step_id=0, ts=123.456)
        assert event.type == "test"
        assert event.run_id == "r1"
        assert event.step_id == 0
        assert event.ts == 123.456


class TestEventImmutability:
    """Given a frozen Event, When I try to mutate it, Then it raises FrozenInstanceError."""

    def test_event_is_frozen(self):
        from dataclasses import FrozenInstanceError
        from loopengine.primitives.events import Event

        event = Event(type="test", run_id="r1", step_id=0, ts=1.0)
        with pytest.raises(FrozenInstanceError):
            event.type = "mutated"  # type: ignore[misc]


class TestEventEquality:
    """Given two Events with the same data, When I compare them, Then they are equal."""

    def test_equal_events_are_equal(self):
        from loopengine.primitives.events import Event

        a = Event(type="test", run_id="r1", step_id=0, ts=1.0)
        b = Event(type="test", run_id="r1", step_id=0, ts=1.0)
        assert a == b

    def test_different_events_are_not_equal(self):
        from loopengine.primitives.events import Event

        a = Event(type="test", run_id="r1", step_id=0, ts=1.0)
        b = Event(type="test", run_id="r2", step_id=0, ts=1.0)
        assert a != b


class TestMessageTypeEnum:
    """Given the MessageType enum, When I access its members, Then the four roles exist."""

    def test_message_type_has_all_roles(self):
        from loopengine.primitives.events import MessageType

        assert MessageType.SYSTEM == "system"
        assert MessageType.USER == "user"
        assert MessageType.ASSISTANT == "assistant"
        assert MessageType.TOOL == "tool"

    def test_message_type_values_are_strings(self):
        from loopengine.primitives.events import MessageType

        for member in MessageType:
            assert isinstance(member.value, str)


class TestMessage:
    """Given message data, When I create a Message, Then it behaves correctly."""

    def test_message_creation(self):
        """Given role and content, When I create a Message, Then it has the right fields."""
        from loopengine.primitives.events import Message

        msg = Message(run_id="r1", step_id=0, ts=1.0, role="user", content="hello")
        assert msg.type == "message"
        assert msg.role == "user"
        assert msg.content == "hello"
        assert msg.tool_calls == ()
        assert msg.metadata == {}

    def test_message_defaults(self):
        """Given only run_id and step_id, When I create a Message, Then defaults are applied."""
        from loopengine.primitives.events import Message

        msg = Message(run_id="r1", step_id=0, ts=1.0)
        assert msg.role == "user"
        assert msg.content == ""
        assert msg.tool_calls == ()

    def test_message_is_frozen(self):
        """Given a Message, When I try to mutate it, Then FrozenInstanceError is raised."""
        from dataclasses import FrozenInstanceError
        from loopengine.primitives.events import Message

        msg = Message(run_id="r1", step_id=0, ts=1.0, role="user", content="hello")
        with pytest.raises(FrozenInstanceError):
            msg.content = "mutated"  # type: ignore[misc]


class TestToolCall:
    """Given tool call data, When I create a ToolCall, Then it behaves correctly."""

    def test_tool_call_creation(self):
        """Given id, name, and input, When I create a ToolCall, Then it has the right fields."""
        from loopengine.primitives.events import ToolCall

        tc = ToolCall(run_id="r1", step_id=0, ts=1.0, id="call_1", name="search", input={"q": "test"})
        assert tc.type == "tool_call"
        assert tc.id == "call_1"
        assert tc.name == "search"
        assert tc.input == {"q": "test"}

    def test_tool_call_auto_generates_id(self):
        """Given no id, When I create a ToolCall, Then an id is auto-generated."""
        from loopengine.primitives.events import ToolCall

        tc = ToolCall(run_id="r1", step_id=0, ts=1.0, name="search", input={})
        assert tc.id.startswith("call_")
        assert len(tc.id) > 5

    def test_tool_call_is_frozen(self):
        """Given a ToolCall, When I try to mutate it, Then FrozenInstanceError is raised."""
        from dataclasses import FrozenInstanceError
        from loopengine.primitives.events import ToolCall

        tc = ToolCall(run_id="r1", step_id=0, ts=1.0, id="c1", name="search", input={})
        with pytest.raises(FrozenInstanceError):
            tc.name = "mutated"  # type: ignore[misc]


class TestToolResult:
    """Given tool result data, When I create a ToolResult, Then it behaves correctly."""

    def test_tool_result_creation(self):
        """Given call_id and output, When I create a ToolResult, Then it has the right fields."""
        from loopengine.primitives.events import ToolResult

        tr = ToolResult(run_id="r1", step_id=0, ts=1.0, call_id="call_1", output="ok")
        assert tr.type == "tool_result"
        assert tr.call_id == "call_1"
        assert tr.output == "ok"
        assert tr.error is None

    def test_tool_result_is_error_when_error_set(self):
        """Given an error, When I check is_error, Then it returns True."""
        from loopengine.primitives.events import ToolResult

        tr = ToolResult(run_id="r1", step_id=0, ts=1.0, call_id="c1", output="", error="boom")
        assert tr.is_error is True

    def test_tool_result_is_not_error_when_no_error(self):
        """Given no error, When I check is_error, Then it returns False."""
        from loopengine.primitives.events import ToolResult

        tr = ToolResult(run_id="r1", step_id=0, ts=1.0, call_id="c1", output="ok")
        assert tr.is_error is False

    def test_tool_result_is_frozen(self):
        """Given a ToolResult, When I try to mutate it, Then FrozenInstanceError is raised."""
        from dataclasses import FrozenInstanceError
        from loopengine.primitives.events import ToolResult

        tr = ToolResult(run_id="r1", step_id=0, ts=1.0, call_id="c1", output="ok")
        with pytest.raises(FrozenInstanceError):
            tr.output = "mutated"  # type: ignore[misc]


class TestEvalResult:
    """Given evaluation data, When I create an EvalResult, Then it behaves correctly."""

    def test_eval_result_creation(self):
        """Given evaluation fields, When I create an EvalResult, Then it has the right fields."""
        from loopengine.primitives.events import EvalResult

        er = EvalResult(run_id="r1", step_id=0, ts=1.0, passed=True, score=0.9, reason="good job", reward=1.0)
        assert er.type == "eval_result"
        assert er.passed is True
        assert er.score == 0.9
        assert er.reason == "good job"
        assert er.reward == 1.0

    def test_eval_result_defaults(self):
        """Given no fields, When I create an EvalResult, Then defaults are applied."""
        from loopengine.primitives.events import EvalResult

        er = EvalResult(run_id="r1", step_id=0, ts=1.0)
        assert er.passed is False
        assert er.score == 0.0
        assert er.reason == ""
        assert er.reward == 0.0

    def test_eval_result_is_frozen(self):
        """Given an EvalResult, When I try to mutate it, Then FrozenInstanceError is raised."""
        from dataclasses import FrozenInstanceError
        from loopengine.primitives.events import EvalResult

        er = EvalResult(run_id="r1", step_id=0, ts=1.0, passed=True, score=0.9, reason="ok", reward=1.0)
        with pytest.raises(FrozenInstanceError):
            er.score = 0.5  # type: ignore[misc]


class TestSerialization:
    """Given various event types, When I serialize them, Then the output is correct."""

    def test_event_to_dict(self):
        """Given an Event, When I call to_dict, Then it returns the expected dict."""
        from loopengine.primitives.events import Event

        event = Event(type="test", run_id="r1", step_id=0, ts=1.0)
        d = event.to_dict()
        assert d == {"type": "test", "run_id": "r1", "step_id": 0, "ts": 1.0}

    def test_event_to_json(self):
        """Given an Event, When I call to_json, Then it returns valid JSON."""
        import json
        from loopengine.primitives.events import Event

        event = Event(type="test", run_id="r1", step_id=0, ts=1.0)
        j = event.to_json()
        parsed = json.loads(j)
        assert parsed["type"] == "test"

    def test_message_to_dict_includes_role_and_content(self):
        """Given a Message, When I call to_dict, Then role and content are included."""
        from loopengine.primitives.events import Message

        msg = Message(run_id="r1", step_id=0, ts=1.0, role="assistant", content="hi")
        d = msg.to_dict()
        assert d["type"] == "message"
        assert d["role"] == "assistant"
        assert d["content"] == "hi"
        assert d["tool_calls"] == []

    def test_message_to_openai_dict(self):
        """Given a Message, When I call to_openai_dict, Then it matches OpenAI format."""
        from loopengine.primitives.events import Message

        msg = Message(run_id="r1", step_id=0, ts=1.0, role="user", content="hello")
        d = msg.to_openai_dict()
        assert d == {"role": "user", "content": "hello"}

    def test_tool_call_to_dict(self):
        """Given a ToolCall, When I call to_dict, Then id, name, input are included."""
        from loopengine.primitives.events import ToolCall

        tc = ToolCall(run_id="r1", step_id=0, ts=1.0, id="c1", name="search", input={"q": "hi"})
        d = tc.to_dict()
        assert d["type"] == "tool_call"
        assert d["id"] == "c1"
        assert d["name"] == "search"
        assert d["input"] == {"q": "hi"}

    def test_tool_call_to_openai_dict(self):
        """Given a ToolCall, When I call to_openai_dict, Then it matches OpenAI format."""
        import json
        from loopengine.primitives.events import ToolCall

        tc = ToolCall(run_id="r1", step_id=0, ts=1.0, id="c1", name="search", input={"q": "hi"})
        d = tc.to_openai_dict()
        assert d["id"] == "c1"
        assert d["type"] == "function"
        assert d["function"]["name"] == "search"
        assert json.loads(d["function"]["arguments"]) == {"q": "hi"}

    def test_tool_result_to_dict(self):
        """Given a ToolResult, When I call to_dict, Then call_id and output are included."""
        from loopengine.primitives.events import ToolResult

        tr = ToolResult(run_id="r1", step_id=0, ts=1.0, call_id="c1", output="ok", error=None)
        d = tr.to_dict()
        assert d["type"] == "tool_result"
        assert d["call_id"] == "c1"
        assert d["output"] == "ok"
        assert d["error"] is None

    def test_eval_result_to_dict(self):
        """Given an EvalResult, When I call to_dict, Then evaluation fields are included."""
        from loopengine.primitives.events import EvalResult

        er = EvalResult(run_id="r1", step_id=0, ts=1.0, passed=True, score=0.9, reason="good", reward=1.0)
        d = er.to_dict()
        assert d["type"] == "eval_result"
        assert d["passed"] is True
        assert d["score"] == 0.9
        assert d["reason"] == "good"
        assert d["reward"] == 1.0

    def test_tool_call_metadata_defaults(self):
        """Given a ToolCallMetadata, When I check defaults, Then they are correct."""
        from loopengine.primitives.events import ToolCallMetadata

        meta = ToolCallMetadata()
        assert meta.processor_name == ""
        assert meta.retry_count == 0
        assert meta.timeout_ms == 30_000
        assert meta.tags == {}

    def test_tool_call_metadata_is_frozen(self):
        """Given a ToolCallMetadata, When I try to mutate it, Then FrozenInstanceError is raised."""
        from dataclasses import FrozenInstanceError
        from loopengine.primitives.events import ToolCallMetadata

        meta = ToolCallMetadata()
        with pytest.raises(FrozenInstanceError):
            meta.retry_count = 5  # type: ignore[misc]
