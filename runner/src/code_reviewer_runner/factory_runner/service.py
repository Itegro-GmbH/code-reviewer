# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Factory-Runner's loop (#854, R1b): announce, claim, run a job like the hosted Control, again.

The job is run by the same `JobHost` as the hosted Worker's: the job process with the job on its
stdin and a minimal environment, the heartbeats, the hard timeout, the lease questions, the masking
of every line, the delivery with retries, the orderly end on shutdown. What differs is the door into
the app (`RunnerJobApi`: the runner's credential and the lease token of the claim) and that the
runner claims by itself instead of being handed a job by a Dispatcher.

- `run` ends on a signal, on a revoked credential (exit 4), or, with `--once`, on an update the app
  requires (exit 3).
- `run --once` ends when one job ran (its exit code) or when no job came within the wait (exit 0
  and a line saying so).

The loop owns three things the host does not: the credential's renewal between jobs, the claim's
rhythm and what a claim's failure means (revoked: stop for good; update needed: say so and wait;
unavailable: wait and try again, longer each time).
"""

import asyncio
import logging
import random
import signal
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace

from code_reviewer_runner.factory_runner.app_client import (
    Announcement,
    AppClient,
    Revoked,
    UpdateNeeded,
)
from code_reviewer_runner.factory_runner.base import (
    EXIT_FAILED,
    EXIT_NOT_READY,
    EXIT_OK,
    EXIT_REVOKED,
    EXIT_UPDATE_NEEDED,
)
from code_reviewer_runner.factory_runner.config import (
    RunnerConfig,
    config_path,
    save_config,
    with_credential,
)
from code_reviewer_runner.factory_runner.job_api import RunnerJobApi
from code_reviewer_runner.factory_runner.prepare import Prepared
from code_reviewer_runner.factory_runner.selftest import summary
from code_reviewer_runner.job_loop.api import ApiUnavailable, ClaimedJob
from code_reviewer_runner.job_loop.clock import Clock, RealClock
from code_reviewer_runner.job_loop.host import JobEnd, JobHost
from code_reviewer_runner.job_loop.masking import SafeLog, SecretMasker
from code_reviewer_runner.job_loop.process import ProcessLauncher, SubprocessLauncher

LOGGER_NAME = "code_reviewer_runner.loop"
# The claim is the runner's heartbeat to the app (it is "online" for two minutes after it).
POLL_SECONDS = 30.0
POLL_JITTER = 0.2
BACKOFF_FIRST_SECONDS = 5.0
BACKOFF_MAX_SECONDS = 300.0
UPDATE_NEEDED_WAIT_SECONDS = 300.0
# How long `run --once` waits for a job by default.
DEFAULT_ONCE_WAIT_SECONDS = 600.0
# A credential this old is renewed between jobs (the app keeps the previous one until the new one
# is used once).
RENEW_AFTER_SECONDS = 7 * 24 * 3600.0


@dataclass(frozen=True)
class Seams:
    """What the tests replace; production leaves the defaults."""

    clock: Clock = RealClock()  # noqa: RUF009 - one stateless clock, shared on purpose
    wall: Callable[[], float] = time.time
    jitter: Callable[[], float] = random.random
    launcher: Callable[[float], ProcessLauncher] = SubprocessLauncher


class RunnerService:
    def __init__(
        self,
        config: RunnerConfig,
        environment: Mapping[str, str],
        prepared: Prepared,
        client: AppClient,
        job_api: RunnerJobApi,
        *,
        logger: logging.Logger | None = None,
        seams: Seams = Seams(),  # noqa: B008
    ) -> None:
        self._config = config
        self._environment = environment
        self._prepared = prepared
        self._client = client
        self._api = job_api
        self._seams = seams
        self._clock = seams.clock
        credentials = [config.credential] if config.credential else []
        self._masker = SecretMasker(credentials)
        self._logger = logger or logging.getLogger(LOGGER_NAME)
        self._log = SafeLog(self._logger, self._masker)
        self._stopping = asyncio.Event()
        self._host: JobHost | None = None
        self._announced: Announcement | None = None

    # -- the run ---------------------------------------------------------------------------------

    async def run(self, *, once: bool, wait_seconds: float = DEFAULT_ONCE_WAIT_SECONDS) -> int:
        """Announce, then claim and run until the mode ends it. Returns the exit code."""
        for line in summary(self._prepared.selftest):
            self._log.info("self-test %s", line)
        loop = asyncio.get_running_loop()
        for number in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(number, self.stop)
        try:
            return await self._run(once, wait_seconds)
        finally:
            for number in (signal.SIGTERM, signal.SIGINT):
                loop.remove_signal_handler(number)

    def stop(self) -> None:
        """A signal: stop claiming, and give back the job that runs (`runner_shutdown`)."""
        self._stopping.set()
        if self._host is not None:
            self._host.request_hard_stop()

    async def _run(self, once: bool, wait_seconds: float) -> int:
        refused = await self._announce()
        if refused is not None:
            return refused
        if not self._prepared.ready:
            failed = self._prepared.selftest.failed()
            self._log.error(
                "this runner is not ready: %s (%s)",
                failed.name if failed else "the self-test",
                failed.detail if failed else "",
            )
            return EXIT_NOT_READY
        self._host = self._make_host()
        started = self._clock.monotonic()
        failures = 0
        while not self._stopping.is_set():
            await self._renew_if_due()
            try:
                claimed = await asyncio.to_thread(self._client.claim)
            except Revoked:
                self._log.error("the app does not know this runner any more (revoked): stopping")
                return EXIT_REVOKED
            except UpdateNeeded as needed:
                self._log.error(
                    "update needed: the app requires a base of at least %s, this runner has %s",
                    needed.min_base_version or "a newer version",
                    self._prepared.announcement.base_version,
                )
                if once:
                    return EXIT_UPDATE_NEEDED
                await self._wait(UPDATE_NEEDED_WAIT_SECONDS)
                continue
            except ApiUnavailable as error:
                failures += 1
                pause = min(BACKOFF_FIRST_SECONDS * 2 ** (failures - 1), BACKOFF_MAX_SECONDS)
                self._log.warning(
                    "the app cannot be reached (%s); trying again in %gs", error, pause
                )
                if once and self._clock.monotonic() - started + pause > wait_seconds:
                    self._log.warning("no job: the app could not be reached within the wait")
                    return EXIT_OK
                await self._wait(max(pause, error.retry_after or 0.0))
                continue
            failures = 0
            if claimed is None:
                if once and self._clock.monotonic() - started >= wait_seconds:
                    self._log.info(
                        "no job for the labels of this runner within %gs: nothing to do",
                        wait_seconds,
                    )
                    return EXIT_OK
                await self._wait(self._poll_pause())
                continue
            end = await self._run_job(claimed)
            if once:
                return (
                    EXIT_OK
                    if end in (JobEnd.OK, JobEnd.GIVEN_BACK, JobEnd.SUPERSEDED)
                    else EXIT_FAILED
                )
        self._log.info("stopped")
        return EXIT_OK

    # -- steps -------------------------------------------------------------------------------------

    async def _announce(self) -> int | None:
        """Tell the app what this runner is. An exit code if that ends the run."""
        announcement = self._prepared.announcement
        try:
            answer = await asyncio.to_thread(self._client.announce, announcement)
        except Revoked:
            self._log.error("the app does not accept this runner's credential (revoked?): stopping")
            return EXIT_REVOKED
        except UpdateNeeded:
            return EXIT_UPDATE_NEEDED
        except ApiUnavailable as error:
            # Not fatal: the claim announces nothing, but the app already holds the last word it
            # got; the next start says it again.
            self._log.warning("the announcement could not be sent (%s); going on", error)
            return None
        self._announced = announcement
        if answer.update_needed:
            self._log.error(
                "update needed: the app requires a base of at least %s",
                answer.min_base_version or "a newer version",
            )
        return None

    def _make_host(self) -> JobHost:
        return JobHost(
            self._prepared.settings,
            self._api,
            self._seams.launcher(self._prepared.settings.terminate_grace),
            masker=self._masker,
            clock=self._clock,
            logger=self._logger,
            environment=dict(self._prepared.environment),
        )

    async def _run_job(self, claimed: ClaimedJob) -> JobEnd:
        assert self._host is not None
        self._api.hold(claimed.id, claimed.lease_token)
        try:
            end = await self._host.run_job(claimed)
        finally:
            self._api.forget(claimed.id)
        self._log.info("job %s ended: %s", claimed.id, end.value)
        return end

    async def _renew_if_due(self) -> None:
        """Between jobs: a credential older than `RENEW_AFTER_SECONDS` is renewed, when it lives in
        the configuration file (a credential from the environment belongs to whoever set it).

        The new credential is written before it is used, so a crash cannot lose both; the app keeps
        the old one valid until the new one is used once.
        """
        config = self._config
        if config.credential is None or not config_path(self._environment).exists():
            return
        now = self._seams.wall()
        if config.credential_renewed_at <= 0:
            # Registered before the time was recorded: record it, renew at the next due time.
            self._config = replace(config, credential_renewed_at=now)
            save_config(self._config, self._environment)
            return
        if now - config.credential_renewed_at < RENEW_AFTER_SECONDS:
            return
        try:
            credential = await asyncio.to_thread(self._client.renew)
        except (Revoked, ApiUnavailable) as error:
            self._log.warning("the credential could not be renewed now (%s)", type(error).__name__)
            return
        self._config = with_credential(config, credential, now)
        save_config(self._config, self._environment)
        self._masker.add("credential", [credential])
        self._client.use_credential(credential)
        self._api.use_credential(credential)
        self._log.info("the runner's credential was renewed")

    def _poll_pause(self) -> float:
        return POLL_SECONDS * (1 + POLL_JITTER * (self._seams.jitter() - 0.5) * 2)

    async def _wait(self, seconds: float) -> None:
        """Sleep, but end at once when the runner is told to stop."""
        waiting = asyncio.ensure_future(self._clock.sleep(seconds))
        stopped = asyncio.ensure_future(self._stopping.wait())
        try:
            await asyncio.wait([waiting, stopped], return_when=asyncio.FIRST_COMPLETED)
        finally:
            waiting.cancel()
            stopped.cancel()
            await asyncio.gather(waiting, stopped, return_exceptions=True)
