# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job host's end of the steps channel (#745, live view): what it posts, when it gives up and
what it keeps while the app is away. The clock is the tests' own, so backoff costs no time."""

import asyncio
import contextlib
import itertools
import logging
import socket
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from loop_support import ManualClock, settle

from code_reviewer_runner.job_loop.http import ApiRejected, ApiUnavailable, LeaseLost
from code_reviewer_runner.job_loop.masking import SafeLog, SecretMasker
from code_reviewer_runner.job_loop.step_sender import (
    BACKLOG_SECONDS,
    BACKOFF_FIRST_SECONDS,
    BACKOFF_MAX_SECONDS,
    MAX_BACKLOG_BATCHES,
    StepSender,
)
from code_reviewer_runner.step_wire import (
    answer_line,
    batch_line,
    body_of,
    flush_line,
    parse_answer,
)

pytestmark = pytest.mark.unit

JOB = "00000000-0000-4000-8000-000000000001"


class FakeStepsApi:
    """The steps call in memory. `outcomes` are what the next calls do (None: succeed); once they
    are used up every call succeeds. `hang` makes calls wait for ever."""

    def __init__(self, clock: ManualClock) -> None:
        self._clock = clock
        self.supports_steps = True
        self.calls: list[tuple[float, bytes]] = []
        self.outcomes: list[Exception | None] = []
        self.hang = False

    async def steps(self, job_id: str, body: bytes) -> None:
        self.calls.append((self._clock.now, body))
        if self.hang:
            await asyncio.Event().wait()
        if self.outcomes:
            outcome = self.outcomes.pop(0)
            if outcome is not None:
                raise outcome


class Channel:
    """The process's end of the channel, in the same event loop."""

    def __init__(self, sender: StepSender) -> None:
        self.sender = sender

    async def open(self) -> None:
        host_end, process_end = socket.socketpair()
        host_reader, host_writer = await asyncio.open_connection(sock=host_end)
        self.reader, self.writer = await asyncio.open_connection(sock=process_end)
        self.served = asyncio.ensure_future(self.sender.serve(host_reader, host_writer))

    def send(self, count: int = 1, tag: str = "a") -> bytes:
        body = body_of(
            [f'{{"kind":"text","partId":"prt_{tag}{i}","seq":{i + 1}}}' for i in range(count)]
        )
        self.writer.write(batch_line(count, body))
        return body

    async def flush(self, seconds: float) -> int | None:
        self.writer.write(flush_line(seconds))
        line = await self.reader.readline()
        return parse_answer(line) if line else None

    async def close(self) -> None:
        self.writer.close()
        await asyncio.wait_for(self.served, 5)


def make(clock: ManualClock, **options: Any) -> tuple[StepSender, FakeStepsApi]:
    api = FakeStepsApi(clock)
    log = SafeLog(logging.getLogger("test.step_sender"), SecretMasker([]))
    return StepSender(api, JOB, clock=clock, log=log, **options), api


def run(scenario: Callable[[ManualClock], Awaitable[None]]) -> None:
    clock = ManualClock()
    asyncio.run(asyncio.wait_for(scenario(clock), 30))


# #745-L22
def test_batches_are_posted_in_the_order_they_came_with_the_body_as_it_was_sent() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        channel = Channel(sender)
        await channel.open()

        bodies = [channel.send(2, tag) for tag in "abc"]
        assert await channel.flush(1.0) == 0

        assert [body for _, body in api.calls] == bodies
        await channel.close()

    run(scenario)


# #745-L27
def test_a_lost_claim_stops_the_sender_for_good_and_closes_the_channel() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        api.outcomes = [LeaseLost("not held", 409)]
        channel = Channel(sender)
        await channel.open()

        channel.send(3, "a")
        await settle()
        channel.send(2, "b")
        channel.send(2, "c")
        await settle()

        assert len(api.calls) == 1, "nothing is posted after the 409"
        # The host closed its end: the process reads the end of the stream (or a reset).
        with contextlib.suppress(ConnectionError):
            assert await channel.reader.read() == b""
        await asyncio.wait_for(channel.served, 5)

    run(scenario)


# #745-L27
def test_a_credential_the_app_refuses_and_a_job_it_does_not_know_stop_it_too() -> None:
    async def scenario(clock: ManualClock) -> None:
        for status in (401, 404):
            sender, api = make(clock)
            api.outcomes = [LeaseLost("refused", status)]
            channel = Channel(sender)
            await channel.open()
            channel.send()
            await settle()
            channel.send()
            await settle()
            assert len(api.calls) == 1
            await asyncio.wait_for(channel.served, 5)

    run(scenario)


# #745-L28
def test_a_failing_app_is_tried_again_after_a_growing_pause_that_stops_growing() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        api.outcomes = [ApiUnavailable("down", 503)] * 8
        channel = Channel(sender)
        await channel.open()
        body = channel.send()

        await clock.advance(400)

        times = [at for at, _ in api.calls]
        gaps = [round(b - a) for a, b in itertools.pairwise(times)]
        assert gaps[:5] == [2, 4, 8, 16, 30]
        assert max(gaps) == BACKOFF_MAX_SECONDS == 30 and gaps[0] == BACKOFF_FIRST_SECONDS
        assert {call for _, call in api.calls} == {body}, "the same batch is posted again"
        await channel.close()

    run(scenario)


# #745-L28
def test_the_app_coming_back_gets_the_batch_that_waited_and_the_backoff_starts_over() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        api.outcomes = [ApiUnavailable("down", 503)] * 3
        channel = Channel(sender)
        await channel.open()
        first = channel.send(1, "a")
        await clock.advance(10)  # tries at 0, 2, 6; the fourth at 14 succeeds
        await clock.advance(10)
        api.outcomes = [ApiUnavailable("down", 503)]
        second = channel.send(1, "b")
        await clock.advance(10)

        bodies = [call for _, call in api.calls]
        assert bodies == [first] * 4 + [second] * 2
        times = [at for at, call in api.calls if call == second]
        assert round(times[1] - times[0]) == 2, "after a success the pause is the first again"
        assert await channel.flush(1.0) == 0
        await channel.close()

    run(scenario)


# #745-L29
def test_an_app_that_stays_away_keeps_about_a_minute_of_backlog_and_drops_the_oldest() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        api.outcomes = [ApiUnavailable("down", 503)] * 500
        channel = Channel(sender)
        await channel.open()

        sent: list[bytes] = []
        for step in range(90):  # three minutes, a batch every two seconds
            sent.append(channel.send(1, f"{step:03d}"))
            await clock.advance(2)
            assert len(sender._backlog) <= MAX_BACKLOG_BATCHES  # pyright: ignore[reportPrivateUsage]
        oldest_kept = min(
            (b.received for b in sender._backlog),  # pyright: ignore[reportPrivateUsage]
        )
        assert clock.now - oldest_kept <= BACKLOG_SECONDS + 2

        api.outcomes = []
        before = len(api.calls)
        answer = await channel.flush(5.0)

        recovered = [call for _, call in api.calls[before:]]
        assert answer is not None and answer > 0, "what was dropped is counted"
        assert answer + len(recovered) == 90, "every batch was either sent or counted, once"
        assert recovered[-1] == sent[-1], "the newest batch arrived"
        assert sent[0] not in recovered, "the oldest were dropped first"
        await channel.close()

    run(scenario)


# #745-L29
def test_a_burst_cannot_make_the_backlog_larger_than_its_bound() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        api.hang = True
        channel = Channel(sender)
        await channel.open()

        for number in range(MAX_BACKLOG_BATCHES * 5):
            channel.send(1, f"{number:04d}")
        await settle(200)

        assert len(sender._backlog) <= MAX_BACKLOG_BATCHES  # pyright: ignore[reportPrivateUsage]
        flushing = asyncio.ensure_future(channel.flush(1.0))
        await settle(200)
        await clock.advance(1)
        unsent = await asyncio.wait_for(flushing, 5)
        assert unsent == MAX_BACKLOG_BATCHES * 5, "all of it is unsent, none of it is lost track of"
        await channel.close()

    run(scenario)


# #745-L30
def test_an_app_that_hangs_costs_the_flush_its_seconds_and_nothing_else() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock, request_seconds=0.05)
        api.hang = True
        channel = Channel(sender)
        await channel.open()
        channel.send(4, "a")
        channel.send(5, "b")

        waiting = asyncio.ensure_future(channel.flush(3.0))
        await settle(200)
        assert not waiting.done()
        await clock.advance(3.0)

        assert await asyncio.wait_for(waiting, 5) == 9, "everything held is unsent"
        # The sender only awaits: the loop it runs on, and the heartbeat with it, is free.
        beat = asyncio.ensure_future(clock.sleep(1))
        await clock.advance(1)
        assert beat.done()
        await channel.close()

    run(scenario)


# #745-L30
def test_a_flush_makes_a_sender_that_waits_to_retry_try_at_once() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        api.outcomes = [ApiUnavailable("down", 503)]
        channel = Channel(sender)
        await channel.open()
        channel.send()
        await settle()
        assert len(api.calls) == 1  # now it waits two seconds

        unsent = await asyncio.wait_for(channel.flush(5.0), 5)

        assert unsent == 0 and len(api.calls) == 2
        assert clock.now == 0.0, "no clock time passed"
        await channel.close()

    run(scenario)


# #745-L27
def test_a_batch_the_app_refuses_for_good_is_dropped_and_counted_and_the_next_goes_on() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        api.outcomes = [ApiRejected("bad", 400, "RUNNER_REQUEST_INVALID")]
        channel = Channel(sender)
        await channel.open()
        channel.send(3, "a")
        good = channel.send(2, "b")

        unsent = await channel.flush(1.0)

        assert unsent == 3
        assert [call for _, call in api.calls] == [api.calls[0][1], good]
        await channel.close()

    run(scenario)


# #745-L27
def test_a_line_that_is_not_the_protocol_ends_the_channel_and_nothing_else() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        channel = Channel(sender)
        await channel.open()

        channel.writer.write(b"GET / HTTP/1.1\n")
        await asyncio.wait_for(channel.served, 5)

        assert api.calls == []

    run(scenario)


# #745-L25
def test_a_flush_with_nothing_held_is_answered_at_once() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, _ = make(clock)
        channel = Channel(sender)
        await channel.open()
        channel.writer.write(flush_line(2.0))

        line = await asyncio.wait_for(channel.reader.readline(), 5)

        assert line == answer_line(0)
        await channel.close()

    run(scenario)
