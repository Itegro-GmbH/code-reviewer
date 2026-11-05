# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job host's end of the snapshot channel: it uploads the session file of an Implementer turn
to the app (#839, follow-up turns).

The job process hands over one gzip file (`snapshot_wire.py`); the host holds the Worker's
credential and puts it to the app in parts (`PUT /api/workers/v1/jobs/{id}/session`). It runs only
when the app lists the feature `implementer_snapshot`; for an app that does not, the process gets
no channel at all.

**Why parts.** A snapshot is up to 8 MiB gzipped and a function of the platform refuses a request
body over 4.5 MB before the app is called, so the file goes in parts of at most `CHUNK_BYTES`
(three at the cap). Every part carries the whole description (index, count, size, digest, version),
the app keeps the parts of the job and swaps the snapshot in when the last one arrives, so a part
that is sent twice changes nothing and a half-sent snapshot is never read.

**Before the result, never in its way.** The process hands the file over right after the export and
goes on to push; this upload runs beside it. The job's process handle waits for it after the
process has ended, for at most `SETTLE_SECONDS` (`process.py`), so the session is never idle
without its snapshot, and a dead app costs `TOTAL_SECONDS` and no more. Nothing here changes the
outcome of the turn, its push or its billing: a failure is a line in the log and the next turn
starts from a summary (the fallback of the plan).

- **A lost claim stops it for good** (409, 404 or 401).
- **A snapshot the app refuses** (another 4xx) is not sent again.
- **Other failures** pause `PAUSE_SECONDS` and try the same part again, until `TOTAL_SECONDS`.
"""

import asyncio
import contextlib
import hashlib
from dataclasses import dataclass
from typing import Final, Protocol, runtime_checkable

from code_reviewer_runner.job_loop.clock import Clock
from code_reviewer_runner.job_loop.http import ApiRejected, LeaseLost
from code_reviewer_runner.job_loop.masking import SafeLog
from code_reviewer_runner.snapshot_wire import (
    CHUNK_BYTES,
    FEATURE_IMPLEMENTER_SNAPSHOT,
    parse_header,
    parts_of,
)

# What one request may take, all in: the client's own timeout is below this.
REQUEST_SECONDS: Final = 25.0
PAUSE_SECONDS: Final = 2.0
# From the moment the file is read to the last part: after this the upload is given up.
TOTAL_SECONDS: Final = 40.0
# Reading the bytes from the process: it writes them as fast as the socket takes them.
READ_SECONDS: Final = 15.0

__all__ = [
    "FEATURE_IMPLEMENTER_SNAPSHOT",
    "SnapshotApi",
    "SnapshotPart",
    "SnapshotSender",
]


@dataclass(frozen=True)
class SnapshotPart:
    """One request of the upload."""

    index: int
    count: int
    # The size and digest of the whole gzip file, and the size of the JSON inside it.
    size: int
    sha256: str
    raw_bytes: int
    version: str
    data: bytes


@runtime_checkable
class SnapshotApi(Protocol):
    """What the sender needs of an API: whether the app has the snapshot call, and the call."""

    @property
    def supports_snapshot(self) -> bool: ...

    async def snapshot(self, job_id: str, part: SnapshotPart) -> None:
        """Put `part`. Raises `LeaseLost` for a claim the app does not hold, `ApiRejected` for a
        snapshot it refuses for good, `ApiUnavailable` for anything that may work later."""
        ...


class SnapshotSender:
    """One per turn. `serve` is the channel's handler (`ProcessSpec.snapshot`)."""

    def __init__(
        self,
        api: SnapshotApi,
        job_id: str,
        *,
        clock: Clock,
        log: SafeLog,
        request_seconds: float = REQUEST_SECONDS,
    ) -> None:
        self._api = api
        self._job_id = job_id
        self._clock = clock
        self._log = log
        self._request_seconds = request_seconds
        # True once every part is in the app's hands.
        self.stored = False

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """Read the one message of the process and upload it. Never raises, whatever the process
        sends."""
        try:
            data = await self._read(reader)
            if data is not None:
                await self._upload(*data)
        except asyncio.CancelledError:
            self._log.warning("job %s: the session snapshot upload was cut short", self._job_id)
            raise
        except Exception as error:
            self._log.warning(
                "job %s: the snapshot channel failed (%s)", self._job_id, type(error).__name__
            )
        finally:
            with contextlib.suppress(Exception):
                writer.close()

    async def _read(self, reader: asyncio.StreamReader) -> tuple[SnapshotPart, bytes] | None:
        try:
            line = await reader.readline()
            header = parse_header(line)
            if header is None:
                if line:  # an empty line is a process that took no export
                    self._log.warning("job %s: the snapshot header is not valid", self._job_id)
                return None
            data = await asyncio.wait_for(reader.readexactly(header.size), READ_SECONDS)
        except (
            ConnectionError,
            ValueError,
            asyncio.LimitOverrunError,
            asyncio.IncompleteReadError,
        ):
            self._log.warning("job %s: the snapshot did not arrive whole", self._job_id)
            return None
        except TimeoutError:
            self._log.warning("job %s: the snapshot was not read in time", self._job_id)
            return None
        if hashlib.sha256(data).hexdigest() != header.sha256:
            self._log.warning("job %s: the snapshot does not match its digest", self._job_id)
            return None
        whole = SnapshotPart(
            0,
            parts_of(header.size),
            header.size,
            header.sha256,
            header.raw_bytes,
            header.version,
            b"",
        )
        return whole, data

    async def _upload(self, whole: SnapshotPart, data: bytes) -> None:
        started = self._clock.monotonic()
        for index in range(whole.count):
            part = SnapshotPart(
                index,
                whole.count,
                whole.size,
                whole.sha256,
                whole.raw_bytes,
                whole.version,
                data[index * CHUNK_BYTES : (index + 1) * CHUNK_BYTES],
            )
            if not await self._put(part, started):
                return
        self.stored = True
        self._log.info(
            "job %s: the session snapshot is stored (%d bytes in %d parts)",
            self._job_id,
            whole.size,
            whole.count,
        )

    async def _put(self, part: SnapshotPart, started: float) -> bool:
        """One part, again after a pause while the app is away and the time is not used up."""
        while True:
            try:
                await asyncio.wait_for(
                    self._api.snapshot(self._job_id, part), self._request_seconds
                )
                return True
            except LeaseLost:
                self._log.info(
                    "job %s: the app does not hold the job; the session snapshot is not stored",
                    self._job_id,
                )
                return False
            except ApiRejected as error:
                self._log.warning(
                    "job %s: the app refused the session snapshot (HTTP %s)",
                    self._job_id,
                    error.status,
                )
                return False
            except Exception as error:
                if self._clock.monotonic() - started + PAUSE_SECONDS >= TOTAL_SECONDS:
                    self._log.warning(
                        "job %s: the session snapshot could not be stored (%s)",
                        self._job_id,
                        type(error).__name__,
                    )
                    return False
            await self._clock.sleep(PAUSE_SECONDS)
