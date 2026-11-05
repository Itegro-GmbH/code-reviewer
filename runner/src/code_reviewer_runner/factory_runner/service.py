# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Factory-Runner's loop (#854, R1b): announce, claim, run a job like the hosted Control, again.

The job is run by the same `JobHost` as the hosted Worker's: the job process with the job on its
stdin and a minimal environment, the heartbeats, the hard timeout, the lease questions, the masking
of every line, the delivery with retries, the orderly end on shutdown. What differs is the door into
the app (`RunnerJobApi`: the runner's credential and the lease token of the claim) and that the
runner claims by itself instead of being handed a job by a Dispatcher.

- `run` ends on a signal, on a revoked credential (exit 4), or, with `--once`, on an update the app
  requires (exit 3).
- `run --once` ends when one job ran (its exit code), when no job came within the wait (exit 0
  and a line saying so) or when the app never answered a claim during the whole wait (exit 7, so a
  VM that never spoke to the app is told from one that found nothing to do; an app that answered
  once and was lost later is "no job", exit 0).
- A runner starts only on a daemon that no other runner uses (exit 9): the containers of a turn have
  fixed names, so one daemon serves one runner until R2. Any container (in any state) or network of
  Control that is not its own makes it stop, and the log names the first one; a lock container with
  a fixed name, taken at the start and removed at the end, makes two runners that start together
  meet before either has made anything. A runner with no identity ends with exit 6.

The loop owns four things the host does not: the credential's renewal between jobs, the claim's
rhythm and what a claim's failure means (revoked: stop for good; update needed: say so and wait;
unavailable: wait and try again, longer each time), and the tidying that a hosted VM gets by being
thrown away (`housekeeping.py`): before a claim whenever a job ended (or the last tidy failed), and
right after every job, the leftover containers and networks of Control go and `/work` is emptied.
A runner that cannot tidy does not claim: a job it takes would end `setup_failed`.
"""

import asyncio
import logging
import random
import signal
import socket
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from pathlib import Path

from code_reviewer_runner.factory_runner.app_client import (
    Announcement,
    AppClient,
    Revoked,
    UpdateNeeded,
)
from code_reviewer_runner.factory_runner.base import (
    EXIT_APP_UNREACHABLE,
    EXIT_CONFIG,
    EXIT_FAILED,
    EXIT_NOT_READY,
    EXIT_OK,
    EXIT_REVOKED,
    EXIT_SHARED_DAEMON,
    EXIT_UPDATE_NEEDED,
    EXIT_UPDATED,
)
from code_reviewer_runner.factory_runner.config import (
    CREDENTIAL_FROM_FILE,
    ConfigError,
    RunnerConfig,
    runner_identity,
    update_credential,
    with_credential,
)
from code_reviewer_runner.factory_runner.disk_budget import (
    MEASURE_SECONDS,
    budget_bytes,
    guard_for,
    used_bytes,
)
from code_reviewer_runner.factory_runner.housekeeping import (
    NO_IDENTITY,
    TidySeams,
    foreign_object,
    release_lock,
    take_lock,
    tidy,
)
from code_reviewer_runner.factory_runner.job_api import RunnerJobApi
from code_reviewer_runner.factory_runner.prepare import Prepared
from code_reviewer_runner.factory_runner.selftest import summary
from code_reviewer_runner.factory_runner.update import (
    Fetch,
    ReleaseChannel,
    UpdatePolicy,
    fetch_https,
    load_channel,
)
from code_reviewer_runner.implementer.agent_container import AGENT_IMAGE_REFERENCE
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.job import IMPLEMENTER_WORK_DIR, IMPLEMENTER_WORK_DIR_VARIABLE
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
# A service that is not ready waits this long before it ends (exit code 5), so that the unit's
# restart (every 10 seconds) does not run the self-test over and over, which is what a bad update
# would do. `run --once` ends at once.
NOT_READY_WAIT_SECONDS = 300.0
# How long a runner that cannot tidy waits before it tries again (it claims nothing meanwhile).
TIDY_RETRY_SECONDS = 60.0
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
    docker: Callable[[], DockerApi] = DockerApi
    hostname: Callable[[], str] = socket.gethostname
    # How often the disk budget is measured while a job runs.
    measure_seconds: float = MEASURE_SECONDS
    # The release channel of the image and how its documents are fetched (`update.py`).
    channel: Callable[[], ReleaseChannel | None] = load_channel
    fetch: Fetch = fetch_https


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
        # The machine is tidied before the first claim and again whenever a job has ended.
        self._untidy = True
        # This runner holds the lock container (`housekeeping.take_lock`).
        self._locked = False
        self._tidy = TidySeams(
            api=seams.docker,
            work_dir=Path(environment_work_dir(prepared.environment)),
            runner_id=runner_identity(config),
        )
        self._updates = UpdatePolicy(
            seams.docker,
            environment,
            auto_update=config.auto_update,
            hostname=seams.hostname,
            now=seams.wall,
            jitter=seams.jitter,
            channel=seams.channel,
            fetch=seams.fetch,
            logger=self._logger,
        )

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
            await self._unlock()

    def stop(self) -> None:
        """A signal: stop claiming, and give back the job that runs (`runner_shutdown`)."""
        self._stopping.set()
        if self._host is not None:
            self._host.request_hard_stop()

    async def _run(self, once: bool, wait_seconds: float) -> int:
        other = await self._other_runner()
        if other is not None:
            return other
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
            if not once:
                await self._wait(NOT_READY_WAIT_SECONDS)
            return EXIT_NOT_READY
        await asyncio.to_thread(self._updates.tidy_references)
        self._host = self._make_host()
        started = self._clock.monotonic()
        failures = 0
        # The app answered a claim at least once (a job, or none, or an update it requires).
        reached = False
        while not self._stopping.is_set():
            if self._untidy and not await self._tidy_up(before_claim=True):
                if once:
                    return EXIT_FAILED
                await self._wait(TIDY_RETRY_SECONDS)
                continue
            await self._renew_if_due()
            # Between jobs, never during one: a staged image is switched to here (`update.py`).
            if not once and await asyncio.to_thread(self._updates.switch_due):
                return EXIT_UPDATED
            try:
                claimed = await asyncio.to_thread(self._client.claim)
            except Revoked:
                self._log.error("the app does not know this runner any more (revoked): stopping")
                return EXIT_REVOKED
            except UpdateNeeded as needed:
                reached = True
                self._log.error(
                    "update needed: the app requires a base of at least %s, this runner has %s",
                    needed.min_base_version or "a newer version",
                    self._prepared.announcement.base_version,
                )
                if once:
                    return EXIT_UPDATE_NEEDED
                # The minimum version is the app's: look for the release at once, whatever the
                # setting for automatic updates says.
                if await asyncio.to_thread(self._updates.switch_due, needed=True):
                    return EXIT_UPDATED
                await self._wait(UPDATE_NEEDED_WAIT_SECONDS)
                continue
            except ApiUnavailable as error:
                failures += 1
                pause = min(BACKOFF_FIRST_SECONDS * 2 ** (failures - 1), BACKOFF_MAX_SECONDS)
                self._log.warning(
                    "the app cannot be reached (%s); trying again in %gs", error, pause
                )
                if once and self._clock.monotonic() - started + pause > wait_seconds:
                    if reached:
                        self._log.warning("no job: the app answered earlier, then was lost")
                        return EXIT_OK
                    self._log.warning("no job: the app could not be reached within the wait")
                    return EXIT_APP_UNREACHABLE
                await self._wait(max(pause, error.retry_after or 0.0))
                continue
            failures = 0
            reached = True
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

    async def _other_runner(self) -> int | None:
        """The exit code when this runner may not use the daemon: it has no identity (6), or
        another runner holds the lock or has a container or network on it (9)."""
        runner_id = self._tidy.runner_id
        if not runner_id:
            self._log.error("%s", NO_IDENTITY)
            return EXIT_CONFIG
        api = self._tidy.api()
        holder = await asyncio.to_thread(take_lock, api, runner_id, AGENT_IMAGE_REFERENCE)
        if holder is not None:
            found = holder
        else:
            self._locked = True
            found = await asyncio.to_thread(foreign_object, api, runner_id)
        if found is None:
            return None
        # The containers of a turn have fixed names: a second runner on this daemon would fail
        # every turn with a 409 (and, without the labels, would remove the first one's).
        self._log.error(
            "another factory-runner uses this Docker daemon: %s; one runner per daemon for now "
            "(if none is running, remove it: the label code-reviewer.role or the lock container)",
            found,
        )
        await self._unlock()
        return EXIT_SHARED_DAEMON

    async def _unlock(self) -> None:
        if self._locked:
            self._locked = False
            await asyncio.to_thread(release_lock, self._tidy.api(), self._tidy.runner_id)

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
            guard=self._disk_guard(),
        )

    def _disk_guard(self) -> Callable[[], Awaitable[str]] | None:
        """The job host's guard for the disk budget (`disk_budget.py`); none without `diskGb`."""
        limit = budget_bytes(self._config.limits)
        if limit is None:
            return None
        tidy_seams = self._tidy
        return guard_for(
            limit,
            lambda: used_bytes(tidy_seams.api(), tidy_seams.work_dir, tidy_seams.runner_id),
            interval=self._seams.measure_seconds,
        )

    async def _run_job(self, claimed: ClaimedJob) -> JobEnd:
        assert self._host is not None
        self._api.hold(claimed.id, claimed.lease_token)
        try:
            # Which features this app lists decides, for this job, whether the host opens the
            # snapshot channel and downloads the stored session (`RunnerJobApi.supports_snapshot`).
            # The job does not depend on it: whatever goes wrong here, it runs without a snapshot.
            try:
                await self._api.check_app(claimed.id)
            except Exception as error:
                self._log.warning(
                    "job %s: the features of the app could not be read (%s): running without "
                    "the session snapshot",
                    claimed.id,
                    type(error).__name__,
                )
            else:
                if not self._api.features_listed:
                    self._log.warning(
                        "job %s: the app listed no features: running without the session snapshot",
                        claimed.id,
                    )
            end = await self._host.run_job(claimed)
        finally:
            self._api.forget(claimed.id)
            # The turn's containers hold the workspace's key and its work holds the repository:
            # neither stays until the next claim. A failure here is found again before that claim.
            self._untidy = True
            await self._tidy_up(before_claim=False)
        self._log.info("job %s ended: %s", claimed.id, end.value)
        return end

    async def _tidy_up(self, *, before_claim: bool) -> bool:
        """Remove the leftovers of Control and empty the work folders. True when the machine is
        clean (`_untidy` is then off)."""
        problems = await asyncio.to_thread(tidy, self._tidy)
        if not problems:
            self._untidy = False
            return True
        what = "; ".join(problems)
        if before_claim:
            self._log.error(
                "this runner cannot be cleaned and takes no job until it can: %s "
                "(trying again in %gs)",
                what,
                TIDY_RETRY_SECONDS,
            )
        else:
            self._log.warning("the machine could not be cleaned after the job: %s", what)
        return False

    async def _renew_if_due(self) -> None:
        """Between jobs: a credential older than `RENEW_AFTER_SECONDS` is renewed, when it was read
        from the configuration file. A credential from the environment belongs to whoever set it
        (a VM that runs one job) and is never renewed, whatever the file holds.

        The new credential is written before it is used, so a crash cannot lose both; the app keeps
        the old one valid until the new one is used once. Only the credential and its time are
        written, into the file as it is: nothing the environment overrides ends up in it.
        """
        config = self._config
        if config.credential is None or config.credential_source != CREDENTIAL_FROM_FILE:
            return
        now = self._seams.wall()
        if config.credential_renewed_at <= 0:
            # Registered before the time was recorded: record it, renew at the next due time.
            if self._write_credential(now):
                self._config = replace(config, credential_renewed_at=now)
            return
        if now - config.credential_renewed_at < RENEW_AFTER_SECONDS:
            return
        try:
            credential = await asyncio.to_thread(self._client.renew)
        except (Revoked, ApiUnavailable) as error:
            self._log.warning("the credential could not be renewed now (%s)", type(error).__name__)
            return
        if not self._write_credential(now, credential):
            # The old credential stays valid until the new one is used once: keep using it, ask
            # again at the next job. The new one is dropped unused, so it is never lost unsaved.
            return
        self._config = with_credential(config, credential, now)
        self._masker.add("credential", [credential])
        self._client.use_credential(credential)
        self._api.use_credential(credential)
        self._log.info("the runner's credential was renewed")

    def _write_credential(self, now: float, credential: str | None = None) -> bool:
        try:
            update_credential(
                self._environment,
                runner_id=self._config.runner_id,
                renewed_at=now,
                credential=credential,
            )
        except (OSError, ConfigError):
            self._log.warning(
                "the configuration file cannot be written: the credential is left as it is"
            )
            return False
        return True

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


def environment_work_dir(environment: Mapping[str, str]) -> str:
    """The work volume the job process will use (`RUNNER_IMPLEMENTER_WORK_DIR`, else `/work`)."""
    return environment.get(IMPLEMENTER_WORK_DIR_VARIABLE) or IMPLEMENTER_WORK_DIR
