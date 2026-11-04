# SPDX-License-Identifier: LicenseRef-Proprietary

"""The engine's event stream on a real loopback socket (#552).

The unit tests give the reader a scripted stream. What they cannot show is what the real response
does: that opening it cannot hang for a turn's length, that a stream which stays open and goes quiet
ends the run, and that closing it from another thread frees the reader. A raw socket server stands
in for the engine and says what the pinned one says (`GET /event` answers with a chunked event
stream whose first event is `server.connected` and which then beats every ten seconds).
"""

import socket
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager
from decimal import Decimal

import pytest

from code_reviewer_runner.dynamic_review import adapter
from code_reviewer_runner.dynamic_review.adapter import EngineClient, EngineError
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.engine_events import EventReader
from code_reviewer_runner.dynamic_review.tool_part_audit import ToolPartAudit
from code_reviewer_runner.result import ErrorCode

CONNECTED = b'data: {"type":"server.connected","properties":{}}\n\n'
HEAD = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n"


def chunk(data: bytes) -> bytes:
    return f"{len(data):x}\r\n".encode() + data + b"\r\n"


@contextmanager
def engine_that(speak: bool) -> Generator[tuple[str, threading.Event]]:
    """A server that accepts one client and, if `speak`, sends the head and the first event; it
    then holds the connection open and says nothing until the test is over."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    done = threading.Event()

    def serve() -> None:
        listener.settimeout(10)
        try:
            connection, _ = listener.accept()
        except OSError:
            return
        with connection:
            connection.recv(65536)
            if speak:
                connection.sendall(HEAD + chunk(CONNECTED))
            done.wait(30)

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{listener.getsockname()[1]}", done
    finally:
        done.set()
        listener.close()
        thread.join(5)


def ledger() -> BudgetLedger:
    return BudgetLedger(
        DynamicLimits(),
        unit_costs=UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4)),
    )


# #552-S4: an engine that takes the connection and never answers does not hold the start for a turn
def test_opening_the_stream_has_a_short_timeout_of_its_own(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(adapter, "EVENTS_OPEN_SECONDS", 0.3, raising=False)
    with engine_that(speak=False) as (url, _):
        outcome: list[BaseException] = []

        def open_it() -> None:
            try:
                EngineClient(url, "/export").open_events()
            except EngineError as error:
                outcome.append(error)

        opener = threading.Thread(target=open_it, daemon=True)
        opener.start()
        opener.join(5)

        assert not opener.is_alive()
        assert len(outcome) == 1
        assert isinstance(outcome[0], EngineError)
        assert outcome[0].code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE


# #552-N3: a stream that stays open and goes quiet is an audit that stopped, with a stable code
def test_a_stream_that_stays_open_and_goes_silent_ends_the_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(adapter, "EVENT_IDLE_SECONDS", 0.5, raising=False)
    with engine_that(speak=True) as (url, _):
        budget = ledger()
        events = EventReader(
            EngineClient(url, "/export").open_events, [ToolPartAudit(budget, "ses_1")], budget
        )
        events.start(5.0)
        try:
            until = time.monotonic() + 5.0
            while budget.failure is None and time.monotonic() < until:
                time.sleep(0.05)
            assert budget.failure is not None
            assert budget.failure.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
        finally:
            events.stop()


# #552-N3: stopping the reader frees the thread that waits on a quiet stream
def test_stopping_the_reader_frees_the_thread_waiting_on_a_quiet_stream() -> None:
    with engine_that(speak=True) as (url, _):
        budget = ledger()
        before = {thread.ident for thread in threading.enumerate()}
        events = EventReader(
            EngineClient(url, "/export").open_events, [ToolPartAudit(budget, "ses_1")], budget
        )
        events.start(5.0)

        started = time.monotonic()
        events.stop()

        assert time.monotonic() - started < 3.0
        assert budget.failure is None  # stopping it ourselves is not a failure
        leftovers = [
            thread
            for thread in threading.enumerate()
            if thread.ident not in before and thread.is_alive()
        ]
        assert leftovers == []
