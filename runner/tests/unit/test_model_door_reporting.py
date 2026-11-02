# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the model door's reporting does when the pipe is gone or a straggler speaks late (#745,
findings of #823): the ledger's own answer to a call is never replaced by a broken pipe, and the
final status stays the last word."""

import io
import json
from typing import Any

import pytest
from door_support import scripted_provider, start_document

from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.implementer.door.ledger import AnnouncingLedger
from code_reviewer_runner.implementer.door.service import (
    ModelDoor,
    _Reporter,  # pyright: ignore[reportPrivateUsage]
    parse_start,
)


def _door(max_cost: float = 2.5) -> ModelDoor:
    provider = scripted_provider()
    door = ModelDoor(
        parse_start(json.dumps(start_document(max_cost=max_cost))),
        bind=("127.0.0.1", 0),
        upstream_for=lambda _destination: provider,
    )
    door.start()
    return door


def _ledger(door: ModelDoor) -> AnnouncingLedger:
    native: Any = door._native  # pyright: ignore[reportPrivateUsage]
    ledger = native.ledger
    assert isinstance(ledger, AnnouncingLedger)
    return ledger


def _broken_pipe() -> None:
    raise BrokenPipeError(32, "Broken pipe")


class _ClosedPipe(io.StringIO):
    def write(self, text: str, /) -> int:
        raise BrokenPipeError(32, "Broken pipe")


# #823-F1
def test_a_broken_pipe_does_not_replace_the_limit_error_of_a_refused_call() -> None:
    door = _door(max_cost=0.000001)
    try:
        ledger = _ledger(door)
        ledger.announce = _broken_pipe

        with pytest.raises(LimitError):
            ledger.reserve_call("x" * 6000)
    finally:
        door.stop()


# #823-F1
def test_a_broken_pipe_does_not_leave_a_reservation_the_caller_never_got() -> None:
    door = _door()
    try:
        ledger = _ledger(door)
        ledger.announce = _broken_pipe

        reservation = ledger.reserve_call("x" * 600)

        assert ledger.open_calls == 1, "the caller got the reservation it can settle"
        ledger.settle_unbilled(reservation)
        assert ledger.open_calls == 0
    finally:
        door.stop()


# #823-F1
def test_the_reporter_survives_a_pipe_that_is_gone() -> None:
    door = _door()
    try:
        reporter = _Reporter(door, _ClosedPipe())
        reporter._open = True  # pyright: ignore[reportPrivateUsage]

        reporter.report()
        reporter.report(final=True)
    finally:
        door.stop()


# #823-F2
def test_a_straggler_cannot_speak_after_the_final_status() -> None:
    door = _door()
    try:
        out = io.StringIO()
        reporter = _Reporter(door, out)
        reporter.ready()
        reporter.report(final=True)
        said = out.getvalue()

        _ledger(door).reserve_call("x" * 600)
        reporter.report()

        assert out.getvalue() == said, "nothing is said after the final status"
        lines = [json.loads(line) for line in said.splitlines()]
        assert lines[-1]["final"] is True
    finally:
        door.stop()


# #823-F2
def test_the_final_status_is_said_once_even_if_asked_twice() -> None:
    door = _door()
    try:
        out = io.StringIO()
        reporter = _Reporter(door, out)
        reporter.ready()
        reporter.report(final=True)
        reporter.report(final=True)

        finals = [json.loads(line).get("final") for line in out.getvalue().splitlines()]
        assert finals.count(True) == 1
    finally:
        door.stop()
