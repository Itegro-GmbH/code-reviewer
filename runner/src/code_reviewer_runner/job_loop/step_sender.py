# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job host's end of the steps channel: it sends the batches of an Implementer turn to the app
(#745, live view).

The job process hands over batches (`step_wire.py`); the host holds the Worker's credential and
posts them with it (`POST /api/workers/v1/jobs/{id}/steps`). It runs only when the app lists the
feature `implementer_steps`; for an app that does not, the process gets no channel at all.

**Fail open, off the turn's path.** The sender is one task of the host's own event loop beside the
heartbeat; its calls run on a thread of their own (`HttpWorkerApi.steps`) with a short timeout, one
at a time, so a dead or slow app costs the sender its patience and nothing else: the heartbeat, the
lease question, the push and the result never wait for it. It never raises into the host.

- **A lost claim stops it for good** (409 or 404 or 401): nothing more is posted, the host closes
  its end of the channel (the process sees it and gives up), and what was held is counted.
- **Other failures back off** (`BACKOFF_FIRST_SECONDS` doubling to `BACKOFF_MAX_SECONDS`) and the
  same batch is posted again; the call is idempotent (the app keeps the highest `seq` of a part).
  A batch the app refuses for good (another 4xx) is dropped and counted.
- **The backlog is bounded**: at most `BACKLOG_SECONDS` of age and `MAX_BACKLOG_BATCHES` batches
  (about 2 MiB), the oldest dropped first and counted. The process's own queue is bounded too, so a
  turn costs a fixed amount of memory however long the app is away.
- **The last flush** (`F`): the process asks the sender to say when everything it holds is sent, for
  at most the seconds it names. The answer is the count of records the sender received and could
  not send; a backed off sender tries at once instead of waiting out its pause.
"""

import asyncio
import contextlib
from collections import deque
from dataclasses import dataclass
from typing import Final, Protocol, runtime_checkable

from code_reviewer_runner.job_loop.clock import Clock
from code_reviewer_runner.job_loop.http import ApiError, ApiRejected, LeaseLost
from code_reviewer_runner.job_loop.masking import SafeLog
from code_reviewer_runner.step_wire import (
    FEATURE_IMPLEMENTER_STEPS,
    answer_line,
    parse_batch,
    parse_flush,
)

# What the post of one batch may take, all in: the client's own timeout is below this.
REQUEST_SECONDS: Final = 8.0
BACKOFF_FIRST_SECONDS: Final = 2.0
BACKOFF_MAX_SECONDS: Final = 30.0
# While the process waits for the last flush there is no time for a long pause.
FLUSH_PAUSE_SECONDS: Final = 0.25
# About one minute of backlog, and a fixed memory bound beside it (a batch is at most 48 KiB).
BACKLOG_SECONDS: Final = 60.0
MAX_BACKLOG_BATCHES: Final = 40

__all__ = ["FEATURE_IMPLEMENTER_STEPS", "StepSender", "StepsApi"]


@runtime_checkable
class StepsApi(Protocol):
    """What the sender needs of an API: whether the app has the steps call, and the call. The
    Worker API fits; a double without it gets no sender."""

    @property
    def supports_steps(self) -> bool: ...

    async def steps(self, job_id: str, body: bytes) -> None:
        """Post `body`. Raises `LeaseLost` for a claim the app does not hold, `ApiRejected` for a
        body it refuses for good, `ApiUnavailable` for anything that may work later."""
        ...


@dataclass
class _Batch:
    count: int
    body: bytes
    received: float


class StepSender:
    """One per turn. `serve` is the channel's handler (`ProcessSpec.steps`)."""

    def __init__(
        self,
        api: StepsApi,
        job_id: str,
        *,
        clock: Clock,
        log: SafeLog,
        request_seconds: float = REQUEST_SECONDS,
    ) -> None:
        self._api = api
        self._request_seconds = request_seconds
        self._job_id = job_id
        self._clock = clock
        self._log = log
        self._backlog: deque[_Batch] = deque()
        self._inflight = 0
        self._unsent = 0
        self._sent = 0
        self._stopped = False
        self._flushing = False
        self._failing = False
        self._work = asyncio.Event()
        self._idle = asyncio.Event()
        self._idle.set()
        self._poke = asyncio.Event()
        self._writer: asyncio.StreamWriter | None = None

    # -- the channel -------------------------------------------------------------

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """Read the process's lines until it goes away. Never raises, whatever the process sends."""
        self._writer = writer
        poster = asyncio.ensure_future(self._post_loop())
        try:
            while line := await reader.readline():
                if not await self._handle(line, writer):
                    break
        except (ConnectionError, ValueError, asyncio.LimitOverrunError):
            pass  # the process went away, or sent a line that is not one
        except Exception as error:
            self._log.warning(
                "job %s: the steps channel failed (%s)", self._job_id, type(error).__name__
            )
        finally:
            poster.cancel()
            await asyncio.gather(poster, return_exceptions=True)
            with contextlib.suppress(Exception):
                writer.close()
            self._end_report()

    async def _handle(self, line: bytes, writer: asyncio.StreamWriter) -> bool:
        batch = parse_batch(line)
        if batch is not None:
            self._accept(*batch)
            return True
        seconds = parse_flush(line)
        if seconds is None:
            return False  # not a line of the protocol: the channel is not trusted any more
        await self._flush(seconds)
        writer.write(answer_line(self._unsent_now()))
        await writer.drain()
        return True

    def _accept(self, count: int, body: bytes) -> None:
        if self._stopped:
            self._unsent += count
            return
        self._backlog.append(_Batch(count, body, self._clock.monotonic()))
        self._trim()
        self._refresh()

    # -- the sending ----------------------------------------------------------------

    async def _post_loop(self) -> None:
        pause = BACKOFF_FIRST_SECONDS
        while not self._stopped:
            await self._work.wait()
            self._trim()
            if not self._backlog:
                self._refresh()
                continue
            batch = self._backlog.popleft()
            self._inflight = batch.count
            try:
                await asyncio.wait_for(
                    self._api.steps(self._job_id, batch.body), self._request_seconds
                )
            except LeaseLost:
                self._inflight = 0
                self._unsent += batch.count
                self._stop_for_good()
                return
            except ApiRejected as error:
                self._inflight = 0
                self._unsent += batch.count
                self._warn_once(f"the app refused a batch (HTTP {error.status})")
                self._refresh()
                continue
            except Exception as error:
                self._inflight = 0
                self._backlog.appendleft(batch)
                self._trim()
                self._warn_once(str(error) if isinstance(error, ApiError) else type(error).__name__)
                self._refresh()
                await self._pause(FLUSH_PAUSE_SECONDS if self._flushing else pause)
                pause = min(pause * 2, BACKOFF_MAX_SECONDS)
                continue
            self._inflight = 0
            self._sent += batch.count
            self._failing = False
            pause = BACKOFF_FIRST_SECONDS
            self._refresh()

    async def _pause(self, seconds: float) -> None:
        """Wait `seconds`, or until a flush asks for an attempt now."""
        sleeper = asyncio.ensure_future(self._clock.sleep(seconds))
        poked = asyncio.ensure_future(self._poke.wait())
        try:
            await asyncio.wait([sleeper, poked], return_when=asyncio.FIRST_COMPLETED)
        finally:
            sleeper.cancel()
            poked.cancel()
            await asyncio.gather(sleeper, poked, return_exceptions=True)
            self._poke.clear()

    async def _flush(self, seconds: float) -> None:
        """Return when everything received is sent (or given up), or after `seconds`."""
        if self._stopped:
            return
        self._flushing = True
        self._poke.set()
        idle = asyncio.ensure_future(self._idle.wait())
        timer = asyncio.ensure_future(self._clock.sleep(seconds))
        try:
            await asyncio.wait([idle, timer], return_when=asyncio.FIRST_COMPLETED)
        finally:
            idle.cancel()
            timer.cancel()
            await asyncio.gather(idle, timer, return_exceptions=True)
            self._flushing = False
            self._poke.clear()

    # -- the bounds --------------------------------------------------------------------

    def _trim(self) -> None:
        """Drop what is older than the backlog may hold, then the oldest of too many."""
        now = self._clock.monotonic()
        while self._backlog and (
            now - self._backlog[0].received > BACKLOG_SECONDS
            or len(self._backlog) > MAX_BACKLOG_BATCHES
        ):
            self._unsent += self._backlog.popleft().count

    def _refresh(self) -> None:
        busy = bool(self._backlog) or self._inflight > 0
        if self._backlog:
            self._work.set()
        else:
            self._work.clear()
        if busy:
            self._idle.clear()
        else:
            self._idle.set()

    def _stop_for_good(self) -> None:
        self._stopped = True
        self._unsent += sum(batch.count for batch in self._backlog)
        self._backlog.clear()
        self._work.clear()
        self._idle.set()
        self._log.info(
            "job %s: the app does not hold the job; no more steps are sent", self._job_id
        )
        if self._writer is not None:
            with contextlib.suppress(Exception):
                self._writer.close()

    def _unsent_now(self) -> int:
        return self._unsent + self._inflight + sum(batch.count for batch in self._backlog)

    def _warn_once(self, detail: str) -> None:
        """One line when a run of failures begins; the retries after it are silent."""
        if self._failing:
            return
        self._failing = True
        self._log.warning(
            "job %s: steps could not be sent (%s); trying again", self._job_id, detail
        )

    def _end_report(self) -> None:
        unsent = self._unsent_now()
        if unsent:
            self._log.info("job %s: %d step records sent, %d not", self._job_id, self._sent, unsent)
