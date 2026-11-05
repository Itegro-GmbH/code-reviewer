# SPDX-License-Identifier: LicenseRef-Proprietary

"""The snapshot descriptor of a real job process (#839): the process gets it, the host's handler
reads what the process writes, and the process handle waits for the handler after the process has
ended (so the upload is done before the result), but never for longer than it may."""

import asyncio
import sys
import time

import pytest

from code_reviewer_runner.job_loop.process import ProcessSpec, SubprocessLauncher
from code_reviewer_runner.snapshot_wire import SNAPSHOT_FD_VARIABLE

pytestmark = pytest.mark.unit

WRITER = (
    "import os, socket, sys;"
    f"s = socket.socket(fileno=int(os.environ['{SNAPSHOT_FD_VARIABLE}']));"
    "s.sendall(b'hello snapshot'); s.close(); print('done')"
)


def spec_for(code: str, handler: object) -> ProcessSpec:
    return ProcessSpec(
        argv=(sys.executable, "-c", code),
        env={},
        stdin=b"",
        snapshot=handler,  # type: ignore[arg-type]
    )


# #839-T14
def test_the_handler_reads_what_the_process_writes_before_the_outcome_is_known() -> None:
    received: list[bytes] = []
    finished: list[float] = []

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        received.append(await reader.read())
        await asyncio.sleep(0.3)  # an upload that takes a moment
        finished.append(time.monotonic())

    async def scenario() -> None:
        running = await SubprocessLauncher().start(spec_for(WRITER, handler))
        outcome = await running.wait()
        assert outcome.exit_code == 0
        assert received == [b"hello snapshot"]
        assert finished and finished[0] <= time.monotonic(), "the upload ended before the outcome"

    asyncio.run(asyncio.wait_for(scenario(), 20))


# #839-T14
def test_a_handler_that_never_ends_does_not_hold_the_outcome_back_past_the_settle_time() -> None:
    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await asyncio.Event().wait()

    async def scenario() -> None:
        spec = ProcessSpec(
            argv=(sys.executable, "-c", WRITER),
            env={},
            stdin=b"",
            snapshot=handler,
            snapshot_settle_seconds=0.5,
        )
        running = await SubprocessLauncher().start(spec)
        started = time.monotonic()
        outcome = await running.wait()
        assert outcome.exit_code == 0
        assert 0.4 <= time.monotonic() - started < 5

    asyncio.run(asyncio.wait_for(scenario(), 20))


# #839-T14
def test_a_process_without_the_channel_has_no_descriptor() -> None:
    code = f"import os; print('{SNAPSHOT_FD_VARIABLE}' in os.environ)"

    async def scenario() -> None:
        running = await SubprocessLauncher().start(
            ProcessSpec(argv=(sys.executable, "-c", code), env={}, stdin=b"")
        )
        outcome = await running.wait()
        assert outcome.stdout.strip() == b"False"

    asyncio.run(asyncio.wait_for(scenario(), 20))
