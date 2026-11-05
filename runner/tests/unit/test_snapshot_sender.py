# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job host's end of the snapshot channel (#839): what it uploads, in how many parts, when it
retries and when it gives up. The clock is the tests' own, so the pauses cost no time."""

import asyncio
import hashlib
import logging
import os
import socket
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from loop_support import ManualClock, settle

from code_reviewer_runner.job_loop.http import ApiRejected, ApiUnavailable, LeaseLost
from code_reviewer_runner.job_loop.masking import SafeLog, SecretMasker
from code_reviewer_runner.job_loop.snapshot_sender import (
    PAUSE_SECONDS,
    TOTAL_SECONDS,
    SnapshotPart,
    SnapshotSender,
)
from code_reviewer_runner.snapshot_wire import CHUNK_BYTES, SnapshotHeader, header_line

pytestmark = pytest.mark.unit

JOB = "00000000-0000-4000-8000-000000000001"


class FakeSnapshotApi:
    """The upload call in memory. `outcomes` are what the next calls do (None: succeed)."""

    def __init__(self, clock: ManualClock) -> None:
        self._clock = clock
        self.supports_snapshot = True
        self.calls: list[tuple[float, SnapshotPart]] = []
        self.outcomes: list[Exception | None] = []
        self.hang = False

    async def snapshot(self, job_id: str, part: SnapshotPart) -> None:
        assert job_id == JOB
        self.calls.append((self._clock.now, part))
        if self.hang:
            await asyncio.Event().wait()
        if self.outcomes:
            outcome = self.outcomes.pop(0)
            if outcome is not None:
                raise outcome

    @property
    def data(self) -> bytes:
        return b"".join(part.data for _, part in self.calls)


def make(clock: ManualClock, **options: Any) -> tuple[SnapshotSender, FakeSnapshotApi]:
    api = FakeSnapshotApi(clock)
    log = SafeLog(logging.getLogger("test.snapshot_sender"), SecretMasker([]))
    return SnapshotSender(api, JOB, clock=clock, log=log, **options), api


async def deliver(sender: SnapshotSender, wire: bytes) -> None:
    """The process's end writes `wire` and closes; the sender's `serve` runs to its end."""
    host_end, process_end = socket.socketpair()
    host_reader, host_writer = await asyncio.open_connection(sock=host_end)
    _, writer = await asyncio.open_connection(sock=process_end)
    served = asyncio.ensure_future(sender.serve(host_reader, host_writer))
    writer.write(wire)
    await writer.drain()
    writer.close()
    await asyncio.wait_for(served, 20)


def wire_of(data: bytes, *, digest: str | None = None, version: str = "1.19.0") -> bytes:
    header = SnapshotHeader(
        len(data), len(data) * 5, digest or hashlib.sha256(data).hexdigest(), version
    )
    return header_line(header) + data


def run(scenario: Callable[[ManualClock], Awaitable[None]]) -> None:
    asyncio.run(asyncio.wait_for(scenario(ManualClock()), 30))


# #839-T10
def test_a_small_snapshot_is_one_request_with_everything_the_app_checks() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        data = os.urandom(5_000)

        await deliver(sender, wire_of(data))

        assert len(api.calls) == 1
        part = api.calls[0][1]
        assert (part.index, part.count, part.size) == (0, 1, len(data))
        assert part.sha256 == hashlib.sha256(data).hexdigest()
        assert part.raw_bytes == len(data) * 5 and part.version == "1.19.0"
        assert part.data == data
        assert sender.stored is True

    run(scenario)


# #839-T10
def test_a_large_snapshot_is_cut_in_parts_in_order_and_each_is_below_the_platform_limit() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        data = os.urandom(2 * CHUNK_BYTES + 100)

        await deliver(sender, wire_of(data))

        assert [(p.index, p.count) for _, p in api.calls] == [(0, 3), (1, 3), (2, 3)]
        assert all(len(p.data) <= CHUNK_BYTES for _, p in api.calls)
        assert api.data == data
        assert sender.stored is True

    run(scenario)


# #839-T11
def test_a_part_the_app_could_not_take_is_tried_again_after_a_pause() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        api.outcomes = [ApiUnavailable("busy", 503), None]
        data = os.urandom(1_000)

        task = asyncio.ensure_future(deliver(sender, wire_of(data)))
        await settle()
        assert len(api.calls) == 1
        await clock.advance(PAUSE_SECONDS + 0.1)
        await task

        assert [at for at, _ in api.calls] == [0.0, pytest.approx(PAUSE_SECONDS + 0.1, abs=0.2)]
        assert api.calls[0][1].data == api.calls[1][1].data
        assert sender.stored is True

    run(scenario)


# #839-T11
def test_a_lost_claim_stops_the_upload_for_good() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        api.outcomes = [None, LeaseLost("not held", 409)]
        data = os.urandom(CHUNK_BYTES + 10)

        await deliver(sender, wire_of(data))

        assert len(api.calls) == 2, "nothing after the 409"
        assert sender.stored is False

    run(scenario)


# #839-T11
def test_a_snapshot_the_app_refuses_is_not_sent_again() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        api.outcomes = [ApiRejected("too large", 413, None)]

        await deliver(sender, wire_of(os.urandom(100)))

        assert len(api.calls) == 1
        assert sender.stored is False

    run(scenario)


# #839-T11
def test_an_app_that_stays_away_is_given_up_after_the_total_time_and_the_turn_is_not_held_up() -> (
    None
):
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)
        api.outcomes = [ApiUnavailable("down", 503)] * 100

        task = asyncio.ensure_future(deliver(sender, wire_of(os.urandom(100))))
        for _ in range(int(TOTAL_SECONDS) + 5):
            await clock.advance(1.0)
            if task.done():
                break
        await task

        assert sender.stored is False
        assert clock.now <= TOTAL_SECONDS + PAUSE_SECONDS * 4 + 1

    run(scenario)


# #839-T11
def test_a_call_that_hangs_costs_its_request_time_and_nothing_more() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock, request_seconds=0.05)
        api.hang = True

        task = asyncio.ensure_future(deliver(sender, wire_of(os.urandom(100))))
        for _ in range(int(TOTAL_SECONDS) + 20):
            await asyncio.sleep(0.06)  # the request's own (real) timeout
            await clock.advance(1.0)
            if task.done():
                break
        await task

        assert sender.stored is False

    run(scenario)


# #839-T12
def test_bytes_that_do_not_match_their_digest_are_not_uploaded() -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)

        await deliver(sender, wire_of(os.urandom(100), digest="0" * 64))

        assert api.calls == []
        assert sender.stored is False

    run(scenario)


# #839-T12
@pytest.mark.parametrize(
    "wire",
    [b"", b"nonsense\n", b"S 10 40 abc 1.19.0\n", b"S 100 400 " + b"0" * 64 + b" 1.19.0\n"],
    ids=["empty", "not the protocol", "bad digest", "short body"],
)
def test_anything_that_is_not_one_whole_snapshot_uploads_nothing(wire: bytes) -> None:
    async def scenario(clock: ManualClock) -> None:
        sender, api = make(clock)

        await deliver(sender, wire)

        assert api.calls == []
        assert sender.stored is False

    run(scenario)
