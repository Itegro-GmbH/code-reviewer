# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job process's end of the steps channel (#745, live view): batches, their size on the wire,
the last flush and what happens when the host is dead, slow or gone."""

import json
import os
import socket
import time

import pytest

from code_reviewer_runner.implementer.step_pump import (
    ANSWER_MARGIN_SECONDS,
    StepPump,
    step_pump_from_environment,
)
from code_reviewer_runner.step_wire import (
    ENVELOPE_BYTES,
    MAX_BATCH_RECORDS,
    MAX_BODY_BYTES,
    STEPS_FD_VARIABLE,
    batch_line,
    body_of,
    parse_batch,
    parse_flush,
)
from step_support import HostEnd, new_feeder, say, wait_until

pytestmark = pytest.mark.unit


def pump_for(host: HostEnd, *, tick: float = 2.0, write_timeout: float = 1.0) -> StepPump:
    return StepPump(host.process_end, tick=tick, write_timeout=write_timeout)


# #745-L20
def test_a_batch_is_at_most_fifty_records_and_the_records_keep_their_order() -> None:
    host = HostEnd()
    feeder = new_feeder()
    for number in range(120):
        say(feeder, number)
    pump = pump_for(host, tick=0.02)

    pump.start(feeder)
    assert wait_until(lambda: len(host.records) == 120)
    notes = pump.finish(2.0)

    assert notes == ()
    assert [count for count, _ in host.batches] == [50, 50, 20]
    assert [record["seq"] for record in host.records] == list(range(1, 121))
    assert [record["partId"] for record in host.records] == [f"prt_{n:06d}" for n in range(120)]
    host.close()


# #745-L20
def test_a_body_is_at_most_48_kib_measured_on_the_escaped_json_as_it_is_sent() -> None:
    host = HostEnd()
    feeder = new_feeder()
    # Eight KiB of text each: small as text, six times as large once the control characters are
    # escaped (`\u0001`), and twelve bytes an emoji (a surrogate pair).
    for number in range(12):
        say(feeder, number, "\x01" * 8_000)
    for number in range(12, 24):
        say(feeder, number, "😀" * 2_000)
    for number in range(24, 36):
        say(feeder, number, "plain " * 1_000)
    pump = pump_for(host, tick=0.02)

    pump.start(feeder)
    assert wait_until(lambda: len(host.records) == 36)
    pump.finish(2.0)

    assert len(host.batches) > 3, "the escaped size, not the text, decides how many fit"
    for count, body in host.batches:
        assert len(body) <= MAX_BODY_BYTES
        assert len(json.loads(body)["records"]) == count <= MAX_BATCH_RECORDS
    # Measured on what is sent: no batch that could have taken one more record of its own size.
    assert [record["partId"] for record in host.records] == [f"prt_{n:06d}" for n in range(36)]
    host.close()


# #745-L21
def test_a_record_too_large_alone_is_cut_to_fit_and_still_arrives() -> None:
    host = HostEnd()
    feeder = new_feeder()
    say(feeder, 1, "\x02" * 20_000)  # 16 KiB after the converter's cut: 96 KiB escaped
    say(feeder, 2, "after it")
    pump = pump_for(host, tick=0.02)

    pump.start(feeder)
    assert wait_until(lambda: len(host.records) == 2)
    pump.finish(2.0)

    first, second = host.records
    assert first["partId"] == "prt_000001" and second["text"] == "after it"
    assert first["text"].endswith("[cut to fit]") and first["bytes"] == 20_000
    assert all(len(body) <= MAX_BODY_BYTES for _, body in host.batches)
    host.close()


# #745-L20
def test_the_envelope_is_counted_in_the_limit() -> None:
    body = body_of(["{}"] * 3)

    assert len(body) == ENVELOPE_BYTES + 3 * 2 + 2
    assert parse_batch(batch_line(3, body)) == (3, body)
    assert parse_batch(batch_line(51, body)) is None
    assert parse_batch(batch_line(1, b"x" * (MAX_BODY_BYTES + 1))) is None
    assert parse_flush(b"F 99\n") == 10.0 and parse_flush(b"F nan\n") is None


# #745-L23
def test_a_host_that_never_reads_costs_one_write_timeout_and_never_the_turn() -> None:
    host = HostEnd(reads=False)
    host.process_end.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
    feeder = new_feeder()
    for number in range(40):
        say(feeder, number, "x" * 12_000)
    pump = pump_for(host, tick=0.02, write_timeout=0.2)
    began = time.monotonic()

    pump.start(feeder)
    # The turn goes on feeding while the pump is stuck in its write; feeding never waits for it.
    for number in range(40, 400):
        say(feeder, number, "y" * 100)
    fed_in = time.monotonic() - began
    notes = pump.finish(1.0)

    assert fed_in < 0.5
    assert time.monotonic() - began < 2.5, "the flush stays within its budget"
    (note,) = notes
    assert note.startswith("the live view could not send ") and note.endswith(
        " step records to the app"
    )
    sent = int(note.split()[6])
    assert 0 < sent <= 400
    assert feeder.dropped == 0, "what the pump gave up is not counted as 'not taken in time'"
    host.close()


# #745-L24
def test_a_host_that_has_gone_stops_the_pump_and_empties_the_queue_without_a_spurious_drop() -> (
    None
):
    host = HostEnd()
    feeder = new_feeder()
    pump = pump_for(host, tick=0.02)
    pump.start(feeder)
    say(feeder, 1)
    assert wait_until(lambda: len(host.records) == 1)

    host.close()  # the host closed its end: the app said the lease is lost
    say(feeder, 2)
    assert wait_until(lambda: pump.closed), "the pump notices at its next tick"
    for number in range(3, 3_000):
        say(feeder, number)
    notes = pump.finish(1.0)

    assert feeder.dropped == 0, "a queue that is closed does not count what it never takes"
    assert feeder.pending == 0
    assert len(notes) <= 1
    for number in range(3_000, 3_010):
        say(feeder, number)
    assert feeder.pending == 0, "a closed feeder takes nothing"


# #745-L25
def test_the_last_flush_hands_over_what_is_left_and_the_hosts_count_is_the_note() -> None:
    host = HostEnd(unsent=7)
    feeder = new_feeder()
    for number in range(30):
        say(feeder, number)
    pump = pump_for(host, tick=60.0)  # the tick never comes: only the flush hands over

    pump.start(feeder)
    notes = pump.finish(3.0)

    assert len(host.records) == 30
    assert len(host.flushes) == 1 and host.flushes[0] <= 3.0 - ANSWER_MARGIN_SECONDS + 0.1
    assert notes == ("the live view could not send 7 step records to the app",)
    host.close()


# #745-L25
def test_a_flush_with_nothing_unsent_says_nothing() -> None:
    host = HostEnd(unsent=0)
    feeder = new_feeder()
    say(feeder, 1)
    pump = pump_for(host, tick=60.0)

    pump.start(feeder)

    assert pump.finish(3.0) == ()
    assert len(host.records) == 1
    host.close()


# #745-L25
def test_a_host_that_does_not_answer_the_flush_is_waited_for_only_as_long_as_the_budget() -> None:
    host = HostEnd(answers=False)
    feeder = new_feeder()
    say(feeder, 1)
    pump = pump_for(host, tick=60.0)
    pump.start(feeder)
    began = time.monotonic()

    notes = pump.finish(1.5)

    assert time.monotonic() - began < 2.0
    assert notes == ("the live view could not confirm that its last step records arrived",)
    host.close()


# #745-L25
def test_the_records_the_flush_had_no_time_for_are_counted_once() -> None:
    host = HostEnd(unsent=0)
    feeder = new_feeder()
    for number in range(60):
        say(feeder, number)
    pump = pump_for(host, tick=60.0)
    pump.start(feeder)

    # No time at all: the margin for the answer is the whole budget, nothing is handed over.
    notes = pump.finish(ANSWER_MARGIN_SECONDS)

    assert notes == ("the live view could not send 60 step records to the app",)
    assert feeder.dropped == 0
    host.close()


# #745-L25
def test_a_pump_that_was_never_started_finishes_at_once_and_says_nothing() -> None:
    host = HostEnd()
    pump = pump_for(host)

    assert pump.finish(3.0) == ()
    host.close()


# #745-L26
def test_a_process_without_a_channel_has_no_pump() -> None:
    assert step_pump_from_environment({}) is None
    assert step_pump_from_environment({STEPS_FD_VARIABLE: "not a number"}) is None
    assert step_pump_from_environment({STEPS_FD_VARIABLE: "9999"}) is None


# #745-L26
def test_the_descriptor_is_not_inherited_by_what_the_process_starts() -> None:
    mine, theirs = socket.socketpair()
    descriptor = os.dup(mine.fileno())
    os.set_inheritable(descriptor, True)

    pump = step_pump_from_environment({STEPS_FD_VARIABLE: str(descriptor)})

    assert pump is not None
    assert os.get_inheritable(descriptor) is False
    assert pump.finish(0.5) == ()
    mine.close()
    theirs.close()


# #745-L22
def test_a_pump_that_keeps_up_leaves_the_feeders_drop_count_at_zero() -> None:
    host = HostEnd()
    feeder = new_feeder()
    pump = pump_for(host, tick=0.01)
    pump.start(feeder)

    for burst in range(30):  # 3,000 records, far more than the queue holds at once
        for number in range(100):
            say(feeder, burst * 100 + number)
        time.sleep(0.03)
    assert wait_until(lambda: len(host.records) == 3_000, 10)
    notes = pump.finish(2.0)

    assert feeder.dropped == 0, "the note 'not taken in time' must not fire on a healthy turn"
    assert notes == ()
    assert [record["seq"] for record in host.records] == list(range(1, 3_001))
    host.close()


# #745-L24
def test_a_closed_feeder_gives_up_its_queue_takes_nothing_and_counts_nothing() -> None:
    feeder = new_feeder()
    for number in range(10):
        say(feeder, number)

    assert feeder.close() == 10
    for number in range(10, 20):
        say(feeder, number)

    assert feeder.pending == 0 and feeder.drain(50) == [] and feeder.dropped == 0
    assert feeder.close() == 0
