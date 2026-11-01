# SPDX-License-Identifier: LicenseRef-Proprietary

"""How long a stopped job process gets before it is killed (#765): the Implementer's own grace for
a spec that names one, the launcher's for every other job."""

import asyncio
import sys
import time

import pytest

from code_reviewer_runner.job_loop.process import ProcessSpec, SubprocessLauncher

pytestmark = pytest.mark.integration

# A process that ignores SIGTERM and says it is ready.
STUBBORN = (
    "import signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
    "print('ready', flush=True); time.sleep(60)"
)


async def seconds_to_end(grace: float | None, launcher_grace: float) -> float:
    launcher = SubprocessLauncher(terminate_grace=launcher_grace)
    spec = ProcessSpec(
        argv=(sys.executable, "-c", STUBBORN), env={}, stdin=b"", terminate_grace=grace
    )
    process = await launcher.start(spec)
    await asyncio.sleep(1.0)  # the handler is in place
    began = time.monotonic()
    await process.terminate()
    return time.monotonic() - began


# #765-R5b
def test_a_job_that_names_its_grace_gets_it_not_the_launchers() -> None:
    took = asyncio.run(seconds_to_end(grace=0.4, launcher_grace=30.0))

    assert took < 10.0  # the launcher's 30 s were not waited


# #765-R5b
def test_every_other_job_keeps_the_launchers_grace() -> None:
    took = asyncio.run(seconds_to_end(grace=None, launcher_grace=1.5))

    assert 1.0 <= took < 10.0
