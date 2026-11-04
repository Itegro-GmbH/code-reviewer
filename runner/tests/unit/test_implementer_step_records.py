# SPDX-License-Identifier: LicenseRef-Proprietary

"""The step records of an Implementer turn and the feeder that queues them (#745).

The events below follow the part shapes of OpenCode v1.19.0 (the pin): `Part`, `ToolState*` and
`StepFinishPart` of `packages/sdk/js/src/v2/gen/types.gen.ts` (lines 378-560), the events
`message.updated` and `message.part.updated` (6216-6242), and the order in which
`packages/opencode/src/session/processor.ts` and `session/prompt.ts` publish them: a message before
its parts, a reasoning or text part once empty when it starts and once with `time.end` when it ends,
a tool part once per state, and on an abort the open parts closed with `time.end` and the open tools
turned into `error: "Tool execution aborted"`.
"""

import json
import threading
import time
from collections.abc import Callable, Mapping
from decimal import Decimal
from typing import Any, cast

import pytest

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, UnitCosts
from code_reviewer_runner.implementer.agent import ImplementerAgent
from code_reviewer_runner.implementer.limits import agent_limits
from code_reviewer_runner.implementer.step_feed import (
    MAX_QUEUED_BYTES,
    MAX_QUEUED_RECORDS,
    StepFeeder,
)
from code_reviewer_runner.implementer.step_records import (
    MAX_ERROR_BYTES,
    MAX_INPUT_BYTES,
    MAX_RECORDS,
    MAX_SHORT_RECORDS,
    MAX_TEXT_BYTES,
    MAX_TEXT_TOTAL_BYTES,
    StepConverter,
    StepRecord,
)
from code_reviewer_runner.redaction import REDACTED, Redactor

SESSION = "ses_1"
SECRET = "hunter2-" + "x7Qp9Zr"  # a job secret, only known to the redactor
TOKEN = "sk-" + "a1b2c3d4" * 4  # a shape the redactor knows without being told
OUTPUT_MARK = "THE-OUTPUT-OF-THE-TOOL"

Event = dict[str, Any]


def converter() -> StepConverter:
    return StepConverter(SESSION, Redactor([SECRET]))


def message(identity: str, role: str, session: str = SESSION) -> Event:
    return {
        "type": "message.updated",
        "properties": {"sessionID": session, "info": {"id": identity, "role": role}},
    }


def part(body: Mapping[str, Any], at: int = 1_000, session: str = SESSION) -> Event:
    return {
        "type": "message.part.updated",
        "properties": {"sessionID": session, "part": dict(body), "time": at},
    }


def words(
    kind: str, identity: str, text: str, start: int = 10, end: int | None = None, mid: str = "msg_a"
) -> Event:
    time: dict[str, int] = {"start": start}
    if end is not None:
        time["end"] = end
    return part(
        {
            "id": identity,
            "sessionID": SESSION,
            "messageID": mid,
            "type": kind,
            "text": text,
            "time": time,
        }
    )


def tool(identity: str, state: Mapping[str, Any], name: str = "bash") -> Event:
    return part(
        {
            "id": identity,
            "sessionID": SESSION,
            "messageID": "msg_a",
            "type": "tool",
            "callID": f"call_{identity}",
            "tool": name,
            "state": dict(state),
        }
    )


def running(command: str = "npm test", title: str | None = "run the tests") -> dict[str, Any]:
    state: dict[str, Any] = {
        "status": "running",
        "input": {"command": command},
        "time": {"start": 100},
    }
    if title is not None:
        state["title"] = title
    return state


def completed(command: str = "npm test") -> dict[str, Any]:
    return {
        "status": "completed",
        "input": {"command": command},
        "output": OUTPUT_MARK + " 42 passed",
        "title": "run the tests",
        "metadata": {"exit": 0},
        "time": {"start": 100, "end": 160},
    }


def step_finish(identity: str = "prt_fin") -> Event:
    return part(
        {
            "id": identity,
            "sessionID": SESSION,
            "messageID": "msg_a",
            "type": "step-finish",
            "reason": "tool-calls",
            "cost": 0.0125,
            "tokens": {
                "total": 1500,
                "input": 1000,
                "output": 300,
                "reasoning": 150,
                "cache": {"read": 40, "write": 10},
            },
        },
        at=2_000,
    )


def convert_all(events: list[Event], subject: StepConverter | None = None) -> list[StepRecord]:
    subject = subject or converter()
    records = (subject.convert(event) for event in events)
    return [record for record in records if record is not None]


def a_turn() -> list[Event]:
    """The user's message, then one assistant message: thinking, a tool, an answer, the end."""
    return [
        message("msg_u", "user"),
        words("text", "prt_user", "Please fix the build.", end=5, mid="msg_u"),
        message("msg_a", "assistant"),
        part({"id": "prt_s", "sessionID": SESSION, "messageID": "msg_a", "type": "step-start"}),
        words("reasoning", "prt_r", "", start=10),
        words("reasoning", "prt_r", "The build fails in a test.", start=10, end=20),
        tool("prt_t", {"status": "pending", "input": {}, "raw": ""}),
        tool("prt_t", running()),
        tool("prt_t", completed()),
        words("text", "prt_x", "", start=170),
        words("text", "prt_x", "Done: all tests pass.", start=170, end=180),
        step_finish(),
    ]


def as_json(records: list[StepRecord]) -> list[dict[str, Any]]:
    return [record.as_json() for record in records]


# -- the records of a turn ----------------------------------------------------------------------


# #745-L01
def test_a_turn_becomes_one_record_per_finished_part_in_the_order_of_the_events() -> None:
    records = as_json(convert_all(a_turn()))

    assert [(r["kind"], r["partId"]) for r in records] == [
        ("reasoning", "prt_r"),
        ("tool", "prt_t"),  # running
        ("tool", "prt_t"),  # completed
        ("text", "prt_x"),
        ("step", "prt_fin"),
    ]
    assert [r["seq"] for r in records] == [1, 2, 3, 4, 5]
    assert records[0] == {
        "kind": "reasoning",
        "partId": "prt_r",
        "seq": 1,
        "startedAt": 10,
        "endedAt": 20,
        "text": "The build fails in a test.",
        "bytes": 26,
    }
    assert records[4] == {
        "kind": "step",
        "partId": "prt_fin",
        "seq": 5,
        "endedAt": 2_000,
        "reason": "tool-calls",
        "tokens": {
            "input": 1000,
            "output": 300,
            "reasoning": 150,
            "cacheRead": 40,
            "cacheWrite": 10,
        },
        "cost": 0.0125,
    }


# #745-L02
def test_a_tool_part_is_reported_when_it_runs_and_again_when_it_ends_with_the_same_part_id() -> (
    None
):
    running_record, completed_record = as_json(
        convert_all([tool("prt_t", running()), tool("prt_t", completed())])
    )

    assert running_record["partId"] == completed_record["partId"] == "prt_t"
    assert completed_record["seq"] > running_record["seq"]
    assert (running_record["status"], completed_record["status"]) == ("running", "completed")
    assert running_record["startedAt"] == 100 and "endedAt" not in running_record
    assert completed_record["startedAt"] == 100 and completed_record["endedAt"] == 160
    assert completed_record["tool"] == "bash" and completed_record["title"] == "run the tests"
    assert completed_record["input"] == '{"command":"npm test"}'


# #745-L02
def test_a_running_tool_whose_metadata_changes_is_reported_once() -> None:
    subject = converter()

    records = convert_all([tool("prt_t", running()) for _ in range(50)], subject)

    assert len(records) == 1


# #745-L03
def test_the_output_of_a_tool_is_in_no_record() -> None:
    records = convert_all(a_turn())

    assert OUTPUT_MARK not in json.dumps(as_json(records))
    assert all("output" not in record.as_json() for record in records)


# #745-L04
def test_a_tool_that_is_aborted_in_the_middle_ends_as_an_error_record_of_the_same_part() -> None:
    aborted = {
        "status": "error",
        "input": {"command": "sleep 600"},
        "error": "Tool execution aborted",
        "metadata": {"interrupted": True},
        "time": {"start": 100, "end": 400},
    }

    first, last = as_json(
        convert_all([tool("prt_t", running("sleep 600")), tool("prt_t", aborted)])
    )

    assert last["partId"] == first["partId"] and last["seq"] > first["seq"]
    assert last["status"] == "error" and last["error"] == "Tool execution aborted"
    assert last["endedAt"] == 400


# #745-L04
def test_a_reasoning_part_closed_by_an_abort_is_kept_but_one_still_open_is_not() -> None:
    records = convert_all(
        [
            words("reasoning", "prt_open", "half a thought", start=10),
            words("reasoning", "prt_closed", "half a thought", start=10, end=30),
        ]
    )

    assert [record.part_id for record in records] == ["prt_closed"]


# #745-L05
def test_the_text_of_the_user_and_of_an_unknown_message_is_not_recorded() -> None:
    events = [
        message("msg_u", "user"),
        words("text", "prt_1", "the instruction", end=5, mid="msg_u"),
        words("text", "prt_2", "from a message nobody announced", end=5, mid="msg_ghost"),
        message("msg_a", "assistant"),
        words("text", "prt_3", "my answer", end=5, mid="msg_a"),
    ]

    assert [record.part_id for record in convert_all(events)] == ["prt_3"]


# #745-L05
def test_events_of_another_session_and_parts_of_other_kinds_are_skipped() -> None:
    events = [
        message("msg_a", "assistant"),
        part({"id": "prt_f", "type": "file", "mime": "text/plain", "url": "x"}),
        part({"id": "prt_p", "type": "patch", "hash": "abc", "files": []}),
        part({"id": "prt_s", "type": "step-start"}),
        {"type": "session.idle", "properties": {"sessionID": SESSION}},
        tool("prt_other", running(), name="bash") | {"properties": {"sessionID": "ses_2"}},
    ]

    assert convert_all(events) == []


# #745-L05
@pytest.mark.parametrize(
    "event",
    [
        {},
        {"type": "message.part.updated"},
        {"type": "message.part.updated", "properties": []},
        {"type": "message.part.updated", "properties": {"sessionID": SESSION, "part": "x"}},
        {
            "type": "message.part.updated",
            "properties": {"sessionID": SESSION, "part": {"type": "tool"}},
        },
        {"type": "message.updated", "properties": {"sessionID": SESSION, "info": 3}},
        part({"id": "p" * 300, "type": "tool", "tool": "bash", "state": {"status": "running"}}),
        part(
            {"id": "prt_a", "type": "tool", "tool": 7, "state": {"status": "running", "input": []}}
        ),
        part({"id": "prt_b", "type": "tool", "tool": "bash", "state": {"status": 3}}),
        part({"id": "prt_c", "type": "step-finish", "tokens": "many", "cost": "free"}),
        part({"id": "prt_d", "type": "reasoning", "text": 5, "time": []}),
    ],
)
def test_an_event_of_a_shape_it_does_not_know_never_raises(event: Event) -> None:
    subject = converter()

    subject.convert(message("msg_a", "assistant"))
    subject.convert(event)  # may or may not make a record; it must not raise


# -- the caps of a part -------------------------------------------------------------------------


# #745-L06
def test_a_long_text_is_cut_at_16_kib_with_the_true_size_and_a_mark() -> None:
    (record,) = as_json(convert_all([words("reasoning", "prt_r", "a" * 100_000, end=20)]))

    assert record["bytes"] == 100_000
    assert record["text"] == "a" * MAX_TEXT_BYTES + f"\n[{100_000 - MAX_TEXT_BYTES} bytes cut]"


# #745-L06
@pytest.mark.parametrize("letter", ["é", "€", "🙂"])
def test_a_cut_never_splits_a_character_whatever_its_width(letter: str) -> None:
    width = len(letter.encode("utf-8"))
    for shift in range(width):  # every offset of the boundary within a character
        text = "x" * shift + letter * (MAX_TEXT_BYTES // width + 50)
        events = [message("msg_a", "assistant"), words("text", "prt_x", text, end=1)]
        (record,) = as_json(convert_all(events))

        shown, mark = record["text"].rsplit("\n", 1)
        shown.encode("utf-8").decode("utf-8")  # whole characters only
        assert "�" not in shown
        assert len(shown.encode("utf-8")) <= MAX_TEXT_BYTES
        assert len(shown.encode("utf-8")) > MAX_TEXT_BYTES - width
        assert mark == f"[{record['bytes'] - len(shown.encode('utf-8'))} bytes cut]"


# #745-L06
def test_the_input_and_the_error_of_a_tool_are_capped_at_4_kib() -> None:
    state = {
        "status": "error",
        "input": {"content": "w" * 50_000},
        "error": "e" * 50_000,
        "time": {"start": 1, "end": 2},
    }

    (record,) = as_json(convert_all([tool("prt_t", state, name="write")]))

    assert record["input"].startswith('{"content":"www')
    assert len(record["input"]) < MAX_INPUT_BYTES + 40 and record["input"].endswith("bytes cut]")
    assert len(record["error"]) < MAX_ERROR_BYTES + 40 and record["error"].endswith("bytes cut]")


# #745-L06
def test_a_text_that_fits_has_no_mark_and_an_empty_one_makes_no_record() -> None:
    subject = converter()
    subject.convert(message("msg_a", "assistant"))

    exact = subject.convert(words("text", "prt_1", "z" * MAX_TEXT_BYTES, end=1))
    blank = subject.convert(words("text", "prt_2", "  \n ", end=1))

    assert exact is not None and exact.text == "z" * MAX_TEXT_BYTES
    assert blank is None


# -- redaction ----------------------------------------------------------------------------------


# #745-L07
def test_secrets_are_gone_from_every_text_of_every_kind() -> None:
    leaking = {
        "status": "error",
        "input": {"command": f"curl -H 'x: {SECRET}' https://{TOKEN}.example"},
        "error": f"failed with {SECRET}",
        "title": f"curl {SECRET}",
        "time": {"start": 1, "end": 2},
    }
    events = [
        message("msg_a", "assistant"),
        words("reasoning", "prt_r", f"the key is {SECRET}", end=2),
        words("text", "prt_x", f"I used {TOKEN} for it", end=2),
        tool("prt_t", leaking, name=f"mcp_{SECRET}"),
    ]

    shown = json.dumps(as_json(convert_all(events)))

    assert SECRET not in shown and TOKEN not in shown
    assert shown.count(REDACTED) >= 6


def long_secret(length: int) -> str:
    """A job secret of `length` characters that begins with a mark no other text here contains."""
    return ("QZX9-" + "".join(f"{n:04x}" for n in range(length)))[:length]


def one_text(text: str, secret: str) -> dict[str, Any]:
    (record,) = as_json(
        convert_all(
            [message("msg_a", "assistant"), words("text", "p", text, end=1)],
            StepConverter(SESSION, Redactor([secret])),
        )
    )
    return record


# #745-L07
def test_a_secret_that_begins_before_the_cap_is_redacted_whole_and_its_front_is_not_shown() -> None:
    secret = long_secret(40)
    text = (
        "a" * (MAX_TEXT_BYTES - 20) + secret + "b" * 5_000
    )  # 20 characters of it fall before the cap

    record = one_text(text, secret)

    assert "QZX9" not in record["text"], "cutting first and redacting after would show this"
    assert record["bytes"] == len(text)
    assert record["text"].startswith("a" * 100)


# #745-L07
def test_a_secret_longer_than_the_margin_that_begins_before_the_cap_does_not_show_its_front() -> (
    None
):
    # Longer than the 1 KiB read past the cap: the redactor never sees it whole, so only what is
    # held back from the end of what was read keeps the front of it out of the text.
    secret = long_secret(3_000)
    text = "a" * (MAX_TEXT_BYTES - 100) + secret + "b" * 2_000

    record = one_text(text, secret)

    assert "QZX9" not in record["text"], "without the held-back tail the first 100 characters show"
    assert record["bytes"] == len(text)


# #745-L07
def test_a_token_in_a_text_of_megabytes_is_not_shown_at_the_cap_nor_just_after_it() -> None:
    at_the_cap = "b" * (MAX_TEXT_BYTES - 10) + TOKEN  # 10 characters of it before the cap
    pasted = at_the_cap + "b" * 465 + TOKEN + "b" * 3_000_000  # the other at cap + 500 bytes

    record = one_text(pasted, SECRET)

    assert TOKEN[:8] not in record["text"], "a cut before the redaction would show this"
    assert record["bytes"] == len(pasted)
    assert len(record["text"]) < MAX_TEXT_BYTES + 100


# #745-L07
def test_a_secret_with_quotes_backslashes_and_newlines_is_gone_from_the_input_of_a_tool() -> None:
    pem = '-----BEGIN KEY-----\nabc"def\\ghi\n-----END KEY-----'
    state = {
        "status": "running",
        "input": {
            "command": f"printf '%s' '{pem}' > key.pem",
            pem: "as a key",
            "nested": [{"file": pem, "n": 3}, pem],
        },
        "time": {"start": 1},
    }

    (record,) = as_json(
        convert_all([tool("prt_t", state)], StepConverter(SESSION, Redactor([pem])))
    )

    for piece in ("BEGIN KEY", "abc", "ghi", "END KEY"):
        assert piece not in record["input"], "redacting the JSON text misses the escaped form"
    assert json.loads(record["input"])["nested"][0]["n"] == 3
    assert record["input"].count(REDACTED) >= 3


# #745-L07
def test_the_status_and_the_reason_are_redacted_too() -> None:
    subject = converter()
    ended = subject.convert(tool("prt_t", {"status": SECRET, "input": {}, "time": {"start": 1}}))
    finish = part(
        {
            "id": "prt_f",
            "type": "step-finish",
            "reason": SECRET,
            "cost": 0,
            "tokens": {},
        }
    )

    reasoned = subject.convert(finish)

    assert ended is not None and SECRET not in json.dumps(ended.as_json())
    assert reasoned is not None and reasoned.reason == REDACTED


# #745-L05
def test_a_part_id_is_capped_at_256_characters() -> None:
    subject = converter()

    exact = subject.convert(tool("p" * 256, running()))
    over = subject.convert(tool("p" * 257, running()))

    assert exact is not None and exact.part_id == "p" * 256
    assert over is None


# #745-L02
def test_a_tool_that_could_not_be_recorded_is_reported_when_it_comes_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    subject = converter()
    real = subject._tool_detail  # pyright: ignore[reportPrivateUsage]
    calls = 0

    def failing_once(record: StepRecord, state: Mapping[str, Any], *, failed: bool) -> StepRecord:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("a bug")
        return real(record, state, failed=failed)

    monkeypatch.setattr(subject, "_tool_detail", failing_once)

    with pytest.raises(RuntimeError):
        subject.convert(tool("prt_t", running()))
    again = subject.convert(tool("prt_t", running()))

    assert again is not None and again.status == "running", "the failed event left no mark"


# -- the caps of a turn -------------------------------------------------------------------------


# #745-L08
def test_after_5000_records_only_the_tool_calls_go_on_as_name_and_status() -> None:
    subject = converter()
    subject.convert(message("msg_a", "assistant"))
    full = [
        subject.convert(words("reasoning", f"prt_r{i}", "t", end=2)) for i in range(MAX_RECORDS)
    ]

    assert all(record is not None for record in full) and not subject.shortened
    assert subject.convert(words("reasoning", "prt_late", "t", end=2)) is None
    assert subject.shortened
    assert subject.convert(step_finish("prt_late_step")) is None
    late = subject.convert(tool("prt_t", running("ls -la")))

    assert late is not None
    assert late.as_json() == {
        "kind": "tool",
        "partId": "prt_t",
        "seq": MAX_RECORDS + 1,
        "startedAt": 100,
        "tool": "bash",
        "status": "running",
    }
    ended = subject.convert(tool("prt_t", completed("ls -la")))
    assert ended is not None and ended.as_json()["status"] == "completed"
    assert "input" not in ended.as_json() and "title" not in ended.as_json()


# #745-L08
def test_after_2_mib_of_text_the_turn_is_shortened_and_the_tool_calls_stay() -> None:
    subject = converter()
    subject.convert(message("msg_a", "assistant"))
    kept = 0
    for i in range(MAX_TEXT_TOTAL_BYTES // MAX_TEXT_BYTES + 5):
        record = subject.convert(words("text", f"prt_x{i}", "w" * MAX_TEXT_BYTES, end=2))
        kept += record is not None

    assert subject.shortened
    assert kept == MAX_TEXT_TOTAL_BYTES // MAX_TEXT_BYTES
    tool_record = subject.convert(tool("prt_t", completed()))
    assert tool_record is not None and tool_record.input is None and tool_record.tool == "bash"


# #745-L08
def test_the_tool_records_of_a_shortened_turn_are_bounded_too() -> None:
    subject = converter()
    subject.convert(message("msg_a", "assistant"))
    for i in range(MAX_RECORDS):
        subject.convert(words("reasoning", f"prt_r{i}", "t", end=2))

    made = 0
    for i in range(MAX_SHORT_RECORDS + 100):
        made += subject.convert(tool(f"prt_t{i}", running())) is not None

    assert made == MAX_SHORT_RECORDS


# #745-L08
def test_a_tool_that_ends_after_the_short_budget_is_spent_still_reports_its_end() -> None:
    subject = converter()
    subject.convert(message("msg_a", "assistant"))
    for i in range(MAX_RECORDS):
        subject.convert(words("reasoning", f"prt_r{i}", "t", end=2))
    for i in range(MAX_SHORT_RECORDS + 5):
        subject.convert(tool(f"prt_t{i}", running()))  # the last five are over the budget

    first = subject.convert(tool("prt_t0", completed()))
    unseen = subject.convert(tool(f"prt_t{MAX_SHORT_RECORDS + 2}", completed()))
    again = subject.convert(tool("prt_t0", completed()))
    fresh = subject.convert(tool("prt_new", running()))

    assert first is not None and first.as_json()["status"] == "completed"
    assert "input" not in first.as_json() and "title" not in first.as_json()
    assert unseen is not None and unseen.status == "completed"
    assert again is None, "an end is reported once"
    assert fresh is None, "a new call over the budget is still not reported"


# #745-L08
def test_the_converter_holds_a_bounded_number_of_parts_and_messages() -> None:
    subject = converter()
    for i in range(30_000):
        subject.convert(message(f"msg_{i}", "assistant"))
        subject.convert(tool(f"prt_{i}", {"status": "running", "input": {}, "time": {"start": 1}}))

    assert len(subject._roles) <= 2_000  # pyright: ignore[reportPrivateUsage]
    assert len(subject._tool_status) <= 20_000  # pyright: ignore[reportPrivateUsage]


# -- the queue ----------------------------------------------------------------------------------


def feeder() -> StepFeeder:
    return StepFeeder(SESSION, Redactor([SECRET]))


# #745-L09
def test_a_queue_nobody_drains_holds_a_fixed_amount_of_memory_and_drops_the_oldest() -> None:
    queue = feeder()
    queue.feed(message("msg_a", "assistant"))

    for i in range(MAX_RECORDS):
        queue.feed(words("text", f"prt_x{i}", "k" * 3_000, end=2))

    held = queue.drain(10 * MAX_QUEUED_RECORDS)
    assert 0 < len(held) < MAX_RECORDS
    assert sum(record.weight for record in held) <= MAX_QUEUED_BYTES
    assert queue.dropped > 0
    assert [r.seq for r in held] == sorted(r.seq for r in held)
    assert held[0].seq > 1, "the oldest were pushed out, the newest are the ones kept"


# #745-L09
def test_many_small_records_are_bounded_by_their_number() -> None:
    queue = feeder()
    queue.feed(message("msg_a", "assistant"))

    for i in range(MAX_RECORDS - 1):
        queue.feed(words("reasoning", f"prt_r{i}", "t", end=2))

    held = queue.drain(MAX_RECORDS)
    assert len(held) == MAX_QUEUED_RECORDS
    assert queue.dropped == MAX_RECORDS - 1 - MAX_QUEUED_RECORDS
    assert held[-1].seq == MAX_RECORDS - 1


# #745-L09
def test_drain_gives_the_oldest_first_and_frees_the_room() -> None:
    queue = feeder()
    for event in a_turn():
        queue.feed(event)

    first = queue.drain(2)
    rest = queue.drain(100)

    assert [r.seq for r in first] == [1, 2] and [r.seq for r in rest] == [3, 4, 5]
    assert queue.drain(5) == [] and queue.dropped == 0 and not queue.shortened


# #745-L09
def test_the_feeder_says_when_the_turn_is_shortened() -> None:
    queue = feeder()
    queue.feed(message("msg_a", "assistant"))

    for i in range(MAX_RECORDS + 1):
        queue.feed(words("reasoning", f"prt_r{i}", "t", end=2))

    assert queue.shortened


# -- the agent (#745) ---------------------------------------------------------------------------


class OneShotStream:
    """An event stream that says it is connected, plays `events` and then stays quiet."""

    def __init__(self, events: list[Event]) -> None:
        connected: Event = {"type": "server.connected", "properties": {}}
        self._lines = [
            line
            for event in [connected, *events]
            for line in (f"data: {json.dumps(event)}\n".encode(), b"\n")
        ]
        self._quiet = threading.Event()

    def readline(self, limit: int = -1, /) -> bytes:
        if self._lines:
            return self._lines.pop(0)
        self._quiet.wait(5)
        return b""

    def close(self) -> None:
        self._quiet.set()


class StreamClient:
    def __init__(self, stream: OneShotStream) -> None:
        self._stream = stream

    def open_events(self) -> OneShotStream:
        return self._stream


class QuietRuntime:
    """The agent's place, which only has to say it is gone."""

    def stop(self) -> bool:
        return True


def an_agent(redactor: Redactor | None) -> ImplementerAgent:
    ledger = BudgetLedger(
        agent_limits(600.0, Decimal("5"), "cost_limit"),
        unit_costs=UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4)),
    )
    return ImplementerAgent(
        ledger=ledger,
        runtime=cast("Any", QuietRuntime()),
        command=["opencode"],
        directory="/work/repo",
        make_config=lambda path: {},
        instructions=("instructions.md", "text"),
        environment={},
        model="m",
        provider_id="p",
        redactor=redactor,
    )


def started(agent: ImplementerAgent, events: list[Event]) -> None:
    client = cast("Any", StreamClient(OneShotStream(events)))
    agent._open_audit(client, SESSION)  # pyright: ignore[reportPrivateUsage]


def wait_for(condition: Callable[[], bool]) -> None:
    until = time.monotonic() + 5
    while time.monotonic() < until and not condition():
        time.sleep(0.01)
    assert condition()


# #745-L12
def test_the_agent_feeds_the_audit_and_the_step_feeder_from_one_stream() -> None:
    agent = an_agent(Redactor([SECRET]))

    started(agent, a_turn())
    try:
        assert agent.steps is not None
        wait_for(lambda: agent.ledger.tool_calls == 1)
        records = agent.steps.drain(100)
        assert [record.kind for record in records] == ["reasoning", "tool", "tool", "text", "step"]
        assert agent.ledger.failure is None
    finally:
        agent._events.stop()  # pyright: ignore[reportPrivateUsage, reportOptionalMemberAccess]


# #745-L12
def test_without_a_redactor_there_are_no_step_records() -> None:
    agent = an_agent(None)

    started(agent, a_turn())
    try:
        wait_for(lambda: agent.ledger.tool_calls == 1)
        assert agent.steps is None
    finally:
        agent._events.stop()  # pyright: ignore[reportPrivateUsage, reportOptionalMemberAccess]


# #745-L12
def test_the_agent_notes_what_the_step_feeder_dropped_at_the_end_of_the_turn() -> None:
    agent = an_agent(Redactor([SECRET]))
    events = [
        message("msg_a", "assistant"),
        *(words("reasoning", f"prt_r{i}", "t", end=2) for i in range(MAX_QUEUED_RECORDS + 7)),
    ]

    started(agent, events)
    try:
        assert agent.steps is not None
        wait_for(lambda: agent.steps is not None and agent.steps.dropped == 7)
    finally:
        agent.stop()

    assert agent.step_notes() == (
        "the live view dropped 7 step records that were not taken in time",
    )


# #745-L12
def test_the_agent_notes_events_the_step_feeder_could_not_convert(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def broken(self: StepFeeder, event: Mapping[str, Any]) -> None:
        raise RuntimeError("a bug")

    monkeypatch.setattr(StepFeeder, "feed", broken)
    agent = an_agent(Redactor([SECRET]))

    started(agent, a_turn())
    try:
        wait_for(lambda: agent.ledger.tool_calls == 1)
    finally:
        agent.stop()

    (note,) = agent.step_notes()
    assert note.startswith("the live view could not convert ") and "events" in note


# #745-L12
def test_a_turn_that_lost_nothing_has_no_step_notes() -> None:
    agent = an_agent(Redactor([SECRET]))

    started(agent, a_turn())
    try:
        wait_for(lambda: agent.ledger.tool_calls == 1)
    finally:
        agent.stop()

    assert agent.step_notes() == ()
