# SPDX-License-Identifier: LicenseRef-Proprietary

"""When the job host gives a job process a snapshot channel (#839): only an Implementer turn, and
only when the app lists `implementer_snapshot`; and that the host waits for the upload before the
result is delivered."""

import asyncio
import hashlib
from typing import Any

import pytest
from loop_support import FakeProcess, Harness, make_claim, outcome, run, settle
from test_implementer_job_host import advertising_harness, implementer_claim, line

from code_reviewer_runner.job_loop.process import ProcessOutcome, ProcessSpec, RunningProcess
from code_reviewer_runner.job_loop.snapshot_sender import SnapshotApi
from code_reviewer_runner.snapshot_wire import SnapshotHeader, header_line

pytestmark = pytest.mark.unit


def with_snapshot(harness: Harness, *, supported: bool) -> list[Any]:
    """Give the harness's API the snapshot call; the list collects what is put."""
    put: list[Any] = []

    async def snapshot(job_id: str, part: Any) -> None:
        put.append((job_id, part))

    api: Any = harness.api
    api.supports_snapshot = supported
    api.snapshot = snapshot
    return put


async def spec_of_first_process(harness: Harness) -> Any:
    await harness.start()
    spec = harness.launcher.processes[0].spec
    harness.launcher.processes[0].finish(outcome(stdout=line()))
    await settle()
    return spec


# #839-T13
def test_an_implementer_turn_gets_the_channel_when_the_app_lists_the_feature() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        with_snapshot(harness, supported=True)
        harness.api.claims = [implementer_claim()]

        spec = await spec_of_first_process(harness)

        assert isinstance(harness.api, SnapshotApi)
        assert spec.snapshot is not None

    run(scenario)


# #839-T13
def test_an_app_that_does_not_list_the_feature_gets_no_channel() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        with_snapshot(harness, supported=False)
        harness.api.claims = [implementer_claim()]

        spec = await spec_of_first_process(harness)

        assert spec.snapshot is None

    run(scenario)


# #839-T13
def test_an_api_without_the_snapshot_call_gets_no_channel() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]

        spec = await spec_of_first_process(harness)

        assert spec.snapshot is None

    run(scenario)


# #839-T13
def test_a_review_job_never_gets_the_channel_even_when_the_app_has_the_feature() -> None:
    async def scenario() -> None:
        harness = Harness()
        with_snapshot(harness, supported=True)
        harness.api.claims = [make_claim()]

        await harness.start()
        spec = harness.launcher.processes[0].spec
        harness.launcher.processes[0].finish(outcome())
        await settle()

        assert spec.snapshot is None

    run(scenario)


class ServingProcess(FakeProcess):
    """A process whose handle does what the real one does (`process.py`): after the process has
    ended, its outcome is not known before the handler of the snapshot channel has ended."""

    wire = b""

    async def wait(self) -> ProcessOutcome:
        result = await super().wait()
        handler = self.spec.snapshot
        if handler is not None:
            reader = asyncio.StreamReader()
            reader.feed_data(self.wire)
            reader.feed_eof()

            class Closed:
                def close(self) -> None:
                    return

            await handler(reader, Closed())  # type: ignore[arg-type]
        return result


# #839-T14
def test_the_host_has_the_snapshot_uploaded_before_it_delivers_the_result() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        events: list[str] = []
        release = asyncio.Event()
        put: list[Any] = []

        async def snapshot(job_id: str, part: Any) -> None:
            events.append("snapshot started")
            await release.wait()  # the app is slow
            put.append((job_id, part))
            events.append("snapshot stored")

        api: Any = harness.api
        api.supports_snapshot = True
        api.snapshot = snapshot
        complete = api.complete

        async def completing(*arguments: Any) -> Any:
            events.append("result delivered")
            return await complete(*arguments)

        api.complete = completing
        data = b"\x1f\x8bsession"
        wire = header_line(SnapshotHeader(len(data), 30, hashlib.sha256(data).hexdigest(), "1.19.0")) + data

        async def start(spec: ProcessSpec) -> RunningProcess:
            process = ServingProcess(spec)
            process.wire = wire
            harness.launcher.processes.append(process)
            return process

        harness.launcher.start = start  # type: ignore[method-assign]
        api.claims = [implementer_claim()]

        await harness.start()
        harness.launcher.processes[0].finish(outcome(stdout=line()))
        await settle()

        # The upload has begun and is waiting for the app; the result is not delivered.
        assert events == ["snapshot started"]
        assert harness.api.completions == []

        release.set()
        await settle()

        assert events == ["snapshot started", "snapshot stored", "result delivered"]
        assert [job for job, _ in put] == [harness.api.completions[0][0]]

    run(scenario)
