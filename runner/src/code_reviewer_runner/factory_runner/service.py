# SPDX-License-Identifier: LicenseRef-Proprietary

"""The local dispatcher of the Factory-Runner (#854, R1b; #974): announce, claim, start a Worker,
again.

The dispatcher claims like every dispatcher of Runner v2 (ADR 0005): the claim answers with the
job's id and the credential of its Worker and nothing secret. It hands `{appUrl, jobId, credential}`
(and, when the job asks for a credential that exists only on this device, that one) to a Worker it
starts (`sandbox.py`) and waits for it to end. The Worker is the hosted one (`local_worker.py`): it
fetches the job over the Worker API, runs it through the job host (the job process with the job on
its stdin and a minimal environment, the heartbeats, the hard timeout, the masking, the delivery
with retries, the orderly end on a signal) and delivers the result. So the git token and the key of
the workspace are only ever in the Worker and the containers it starts, never in this process, its
state or its log.

- `run` ends on a signal, on a revoked credential (exit 4), or, with `--once`, on an update the app
  requires (exit 3).
- `run --once` ends when one job ran (exit 0 when its Worker did, 1 otherwise), when no job came
  within the wait (exit 0 and a line saying so) or when the app never answered a claim during the
  whole wait (exit 7, so a VM that never spoke to the app is told from one that found nothing to do;
  an app that answered once and was lost later is "no job", exit 0).
- A runner starts only on a daemon that no other runner uses (exit 9): the containers of a turn have
  fixed names, so one daemon serves one runner until R2. Any container (in any state) or network of
  Control that is not its own makes it stop, and the log names the first one; a lock container with
  a fixed name, taken at the start and removed at the end, makes two runners that start together
  meet before either has made anything. A runner with no identity ends with exit 6.

The loop owns what the Worker does not: the credential's renewal between jobs, the claim's rhythm
and what a claim's failure means (revoked: stop for good; update needed: say so and wait;
unavailable: wait and try again, longer each time), the start and the stop of the Worker, the claim
given back when the Worker could not start or ended without a result (`release`), the reaping of a
Worker whose job the app has ended, and the tidying that a hosted VM gets by being thrown away
(`housekeeping.py`): before a claim whenever a job ended (or the last tidy failed), and right after
every job, the leftover containers and networks of Control go and `/work` is emptied. A runner that
cannot tidy does not claim: a job it takes would end `setup_failed`.

With the Firecracker sandbox (#978) none of the Docker housekeeping applies: the Worker's Docker is
inside its VM, so there is no lock on a daemon and nothing to tidy, and the sandbox has more than
one slot: the dispatcher claims only while `sandbox.free` is above zero (a slot whose VMM would not
die stays out of use) and runs the jobs beside each other (a job in `run --once` is still one
job). A Worker that cannot be started is given back (`launch_failed`: the app counts an attempt
for it, and has no release that does not), and the next claim waits, longer for every start that
fails in a row: a fault of the machine does not spend an attempt of every queued job.
"""

import asyncio
import logging
import random
import signal
import socket
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import cast

from code_reviewer_runner.factory_runner.app_client import (
    RELEASE_LAUNCH_FAILED,
    RELEASE_WORKER_EXITED,
    Announcement,
    AppClient,
    ClaimedWorker,
    Revoked,
    UpdateNeeded,
)
from code_reviewer_runner.factory_runner.base import (
    AUTH_SUBSCRIPTION,
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
    home_directory,
    runner_identity,
    update_credential,
    with_credential,
)
from code_reviewer_runner.factory_runner.credential_pool import (
    Chosen,
    Cooldowns,
    CredentialPool,
    Verdict,
    verdict_of_exit,
)
from code_reviewer_runner.factory_runner.housekeeping import (
    NO_IDENTITY,
    TidySeams,
    foreign_object,
    release_lock,
    take_lock,
    tidy,
)
from code_reviewer_runner.factory_runner.prepare import Prepared
from code_reviewer_runner.factory_runner.sandbox import (
    ProcessSandbox,
    RunningWorker,
    SandboxInUse,
    WorkerOutcome,
    WorkerSandbox,
    WorkerStart,
)
from code_reviewer_runner.factory_runner.selftest import summary
from code_reviewer_runner.factory_runner.update import UpdatePolicy
from code_reviewer_runner.implementer.agent_container import AGENT_IMAGE_REFERENCE
from code_reviewer_runner.implementer.claude_code.credentials import store_for
from code_reviewer_runner.implementer.claude_code.login import load_legacy_login
from code_reviewer_runner.implementer.claude_code.readiness import HARNESS_CLAUDE_CODE
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.job import IMPLEMENTER_WORK_DIR, IMPLEMENTER_WORK_DIR_VARIABLE
from code_reviewer_runner.job_loop.api import ApiUnavailable
from code_reviewer_runner.job_loop.clock import Clock, RealClock
from code_reviewer_runner.job_loop.host import IMPLEMENTER_TERMINATE_GRACE_SECONDS
from code_reviewer_runner.job_loop.http import ApiError
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
# How long a dispatcher waits after a Worker that could not be started (a fault of this machine: the
# disk is full, /dev/kvm or a TAP is gone, a cgroup fails), before it claims again; doubled with
# every start that fails in a row, reset by one that works. The app counts an attempt for every
# claim that is given back (three, then the job fails), so a fault that fails every start must not
# be paid for by every job of the queue.
START_FAILURE_BACKOFF_FIRST_SECONDS = 10.0
START_FAILURE_BACKOFF_MAX_SECONDS = 300.0
# How long `run --once` waits for a job by default.
DEFAULT_ONCE_WAIT_SECONDS = 600.0
# A credential this old is renewed between jobs (the app keeps the previous one until the new one
# is used once).
RENEW_AFTER_SECONDS = 7 * 24 * 3600.0
# #974: how often the local reaper asks the app whether the job of the running Worker is over, and
# how long a Worker that outlives its job is left (it is delivering its result and ending) before it
# is ended.
REAP_CHECK_SECONDS = 60.0
REAP_GRACE_SECONDS = 45.0
# What a Worker gets to end after SIGTERM: the job process's grace (`runner_shutdown` is delivered
# inside it) and a margin for the Worker's own delivery. Under the 150 s of `--stop-timeout`.
WORKER_STOP_GRACE_SECONDS = IMPLEMENTER_TERMINATE_GRACE_SECONDS + 15.0
# The lines of a Worker's log the dispatcher repeats in its own when the Worker ended badly.
WORKER_LOG_LINES = 40
# The statuses of a job the app still holds for a Worker (`superseded` drains until its lease ends).
LIVE_JOB_STATUSES = frozenset({"running", "superseded"})


@dataclass(frozen=True)
class Seams:
    """What the tests replace; production leaves the defaults."""

    clock: Clock = RealClock()  # noqa: RUF009 - one stateless clock, shared on purpose
    wall: Callable[[], float] = time.time
    jitter: Callable[[], float] = random.random
    launcher: Callable[[float], ProcessLauncher] = SubprocessLauncher
    docker: Callable[[], DockerApi] = DockerApi
    hostname: Callable[[], str] = socket.gethostname
    # Where a Worker is started (#974); the default is a process of the runner's own container. The
    # Firecracker launcher (#978) is another sandbox.
    sandbox: Callable[[Mapping[str, str], float], WorkerSandbox] | None = None
    reap_check_seconds: float = REAP_CHECK_SECONDS
    reap_grace_seconds: float = REAP_GRACE_SECONDS
    # The credentials of this device and the choice among them (#980); the default reads the store
    # in the runner's home and, while it is empty, the older sources of R3.
    pool: Callable[[Mapping[str, str], Callable[[], float]], CredentialPool] | None = None


class WorkerEnd(StrEnum):
    """How the Worker of a job ended, as far as the dispatcher can tell. Stable: callers branch on
    it."""

    # The Worker ended with exit code 0: it ran the job to its end, or gave it back, or the app
    # superseded or cancelled it.
    OK = "ok"
    # The Worker ended with an error code: its job failed, or its result was not delivered.
    FAILED = "failed"
    # The Worker could not be started: the claim was given back (`launch_failed`).
    NOT_STARTED = "not_started"
    # The app ended the job and the Worker did not follow: the dispatcher ended it.
    REAPED = "reaped"


class RunnerService:
    def __init__(
        self,
        config: RunnerConfig,
        environment: Mapping[str, str],
        prepared: Prepared,
        client: AppClient,
        *,
        logger: logging.Logger | None = None,
        seams: Seams = Seams(),  # noqa: B008
    ) -> None:
        self._config = config
        self._environment = environment
        self._prepared = prepared
        self._client = client
        self._seams = seams
        self._clock = seams.clock
        # The runner's own credential, and the login of this device once a job needed it: neither
        # may be in a line of the log. The dispatcher holds no other secret (#974).
        self._masker = SecretMasker([config.credential] if config.credential else [])
        self._logger = logger or logging.getLogger(LOGGER_NAME)
        self._log = SafeLog(self._logger, self._masker)
        self._stopping = asyncio.Event()
        self._sandbox: WorkerSandbox | None = None
        # The Workers that run now (by job), and the tasks that end them when the dispatcher is
        # told to stop.
        self._workers: dict[str, RunningWorker] = {}
        self._stoppers: dict[str, asyncio.Task[None]] = {}
        self._announced: Announcement | None = None
        self._pool = self._make_pool()
        self._pool_problems = 0
        # The Workers that could not be started one after the other, and the time before which no
        # claim is made because of them.
        self._start_failures = 0
        self._claim_not_before = 0.0
        # The sandbox has no free slot (logged once per spell).
        self._no_slot_logged = False
        # The machine is tidied before the first claim and again whenever a job has ended.
        self._untidy = True
        # This runner holds the lock container (`housekeeping.take_lock`).
        self._locked = False
        self._tidy = TidySeams(
            api=seams.docker,
            work_dir=Path(environment_work_dir(prepared.environment)),
            runner_id=runner_identity(config),
        )
        self._updates = UpdatePolicy(environment, logger=self._logger)

    # -- the run ---------------------------------------------------------------------------------

    async def run(self, *, once: bool, wait_seconds: float = DEFAULT_ONCE_WAIT_SECONDS) -> int:
        """Announce, then claim and run until the mode ends it. Returns the exit code."""
        for line in summary(self._prepared.selftest):
            self._log.info("self-test %s", line)
        for note in self._prepared.harness_notes:
            self._log.info("harness %s", note)
        loop = asyncio.get_running_loop()
        for number in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(number, self.stop)
        try:
            return await self._run(once, wait_seconds)
        finally:
            for number in (signal.SIGTERM, signal.SIGINT):
                loop.remove_signal_handler(number)
            await self._unlock()
            if self._sandbox is not None:
                await self._sandbox.close()

    def stop(self) -> None:
        """A signal: stop claiming, and end the Worker that runs: it gives its job back
        (`runner_shutdown`) within its grace and is killed after it."""
        self._stopping.set()
        for job_id in list(self._workers):
            self._stop_worker(job_id)

    def _stop_worker(self, job_id: str) -> None:
        worker = self._workers.get(job_id)
        if worker is not None and job_id not in self._stoppers:
            self._stoppers[job_id] = asyncio.get_running_loop().create_task(worker.stop())

    async def _run(self, once: bool, wait_seconds: float) -> int:
        try:
            sandbox = self._sandbox = self._make_sandbox()
        except Exception as error:
            # Class name only: the text of an error may name a path or hold a value of the settings.
            self._log.error("the sandbox cannot be made: %s", type(error).__name__)
            return EXIT_NOT_READY
        host_docker = sandbox.uses_host_docker
        other = await self._other_runner() if host_docker else None
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
        try:
            await sandbox.setup()
        except SandboxInUse as error:
            # Its text is the sandbox's own and holds no path or value.
            self._log.error("%s", error)
            return EXIT_SHARED_DAEMON
        except Exception as error:
            # Class name only: the text of an error may name a path or hold a value of the setup.
            self._log.error("the sandbox cannot be used: %s", type(error).__name__)
            return EXIT_NOT_READY
        # A job in `--once` is one job; otherwise as many as the sandbox has slots.
        slots = 1 if once else max(1, sandbox.capacity)
        jobs: set[asyncio.Task[WorkerEnd]] = set()
        started = self._clock.monotonic()
        try:
            return await self._claim_loop(once, wait_seconds, slots, jobs, started, host_docker)
        finally:
            # A signal ended the loop: the Workers were told to stop; wait until each has ended.
            await asyncio.gather(*jobs, return_exceptions=True)

    async def _claim_loop(
        self,
        once: bool,
        wait_seconds: float,
        slots: int,
        jobs: set[asyncio.Task[WorkerEnd]],
        started: float,
        host_docker: bool,
    ) -> int:
        failures = 0
        # The app answered a claim at least once (a job, or none, or an update it requires).
        reached = False
        while not self._stopping.is_set():
            jobs.difference_update({job for job in jobs if job.done()})
            if len(jobs) >= slots:
                await self._wait_for_a_slot(jobs)
                continue
            assert self._sandbox is not None
            if self._sandbox.free <= 0:
                # A claim without a slot to run it in is a job that loses an attempt.
                if not jobs and once:
                    self._log.error("no free slot: nothing can run (every slot is out of use)")
                    return EXIT_FAILED
                if not self._no_slot_logged:
                    self._no_slot_logged = True
                    self._log.error(
                        "no free slot: claiming stops until one is free (a slot whose VM would "
                        "not end is out of use until the service restarts)"
                    )
                await self._wait(self._poll_pause(), jobs)
                continue
            self._no_slot_logged = False
            pause = self._claim_not_before - self._clock.monotonic()
            if pause > 0:
                await self._wait(pause, jobs)
                continue
            if host_docker and self._untidy and not await self._tidy_up(before_claim=True):
                if once:
                    return EXIT_FAILED
                await self._wait(TIDY_RETRY_SECONDS)
                continue
            await self._renew_if_due()
            await self._sync_announcement()
            # Between jobs, never during one: a staged release is switched to here (`update.py`).
            if not once and not jobs and await asyncio.to_thread(self._updates.switch_due):
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
                # The minimum version is the app's: a release that is staged is taken at once;
                # with none staged it is said, and the updater (a root script) is what stages.
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
                await self._wait(self._poll_pause(), jobs)
                continue
            if slots == 1:
                end = await self._run_job(claimed)
                if once:
                    return EXIT_OK if end is WorkerEnd.OK else EXIT_FAILED
                continue
            # More slots than one: the job runs beside the others and the loop claims again while a
            # slot is free (a job that ends frees its slot and wakes the loop).
            jobs.add(asyncio.get_running_loop().create_task(self._run_job(claimed)))
        self._log.info("stopped")
        return EXIT_OK

    async def _wait_for_a_slot(self, jobs: set[asyncio.Task[WorkerEnd]]) -> None:
        """Wait until a job ends (its slot is free) or the runner is told to stop."""
        stopped = asyncio.ensure_future(self._stopping.wait())
        try:
            await asyncio.wait([*jobs, stopped], return_when=asyncio.FIRST_COMPLETED)
        finally:
            stopped.cancel()
            await asyncio.gather(stopped, return_exceptions=True)

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
        announcement = self.announcement()
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

    def _make_sandbox(self) -> WorkerSandbox:
        make = self._seams.sandbox
        if make is not None:
            return make(self._prepared.environment, WORKER_STOP_GRACE_SECONDS)
        return ProcessSandbox(
            self._seams.launcher(WORKER_STOP_GRACE_SECONDS),
            self._prepared.environment,
            grace_seconds=WORKER_STOP_GRACE_SECONDS,
        )

    def _make_pool(self) -> CredentialPool:
        make = self._seams.pool
        if make is not None:
            return make(self._environment, self._seams.wall)
        home = home_directory(self._environment)
        cooldowns, problems = Cooldowns.from_environment(self._environment)
        pool = CredentialPool(
            store_for(self._environment, home),
            lambda: load_legacy_login(self._environment, home),
            self._seams.wall,
            cooldowns=cooldowns,
        )
        pool.problems.extend(problems)
        return pool

    def announcement(self) -> Announcement:
        """What this runner says about itself now: what `prepare` found, with the entry of Claude
        Code kept up to date from the credentials of this device (#980): the models of every
        credential that can be used, and no entry while none can (all are rate limited, or were
        refused). The app never learns a name or a reason, only that the entry is there."""
        base = self._prepared.announcement
        if self._prepared.claude_version is None:
            return base
        entries = [
            entry
            for entry in cast("Sequence[dict[str, object]]", base.manifest.get("harnesses", []))
            if entry.get("harness") != HARNESS_CLAUDE_CODE
        ]
        offer = self._pool.offer()
        if offer is not None:
            entry: dict[str, object] = {
                "harness": HARNESS_CLAUDE_CODE,
                "version": self._prepared.claude_version,
                "auth": AUTH_SUBSCRIPTION,
            }
            if offer.models is not None:
                entry["models"] = list(offer.models)
            entries.append(entry)
        return replace(base, manifest={**base.manifest, "harnesses": entries})

    async def _sync_announcement(self) -> None:
        """Say it again when the entry of Claude Code changed (a credential was limited, refused or
        replaced, a limit ran out). A device without Claude Code announces once, as before. A failed
        call is tried again at the next claim; the app uses the last announcement it got."""
        if self._prepared.claude_version is None:
            return
        for problem in self._pool.problems[self._pool_problems :]:
            self._log.warning("credentials: %s", problem)
        self._pool_problems = len(self._pool.problems)
        desired = self.announcement()
        if self._announced is not None and desired.manifest == self._announced.manifest:
            return
        try:
            await asyncio.to_thread(self._client.announce, desired)
        except (Revoked, UpdateNeeded):
            return  # the claim that follows meets it and ends the run as it should
        except ApiUnavailable as error:
            self._log.warning("the announcement could not be sent (%s); trying again", error)
            return
        self._announced = desired
        models = _claude_models(desired)
        if models is None:
            self._log.warning(
                "claude-code is withdrawn from the manifest: no credential of this device can be "
                "used now (rate limited, refused or without a model)"
            )
        else:
            self._log.info("claude-code is offered (%s)", ", ".join(models) or "any model")

    def _choose_credential(self, claimed: ClaimedWorker) -> tuple[Chosen | None, bool]:
        """The one credential of this device the job needs, as `(credential, needed)`.

        A job on a subscription (`access` of the claim) gets one credential, chosen among those not
        rate limited and not refused whose models allow its model, and the Worker gets that one
        only: handed on its standard input, never through the app, never to a Worker whose job does
        not ask for it. `(None, True)`: the job needs one and none can serve it."""
        access = claimed.access
        if access is None or access.auth != AUTH_SUBSCRIPTION:
            return None, False
        chosen = self._pool.choose(access.model)
        if chosen is not None:
            self._masker.add(f"credential:{chosen.name}", [chosen.credential.value])
        return chosen, True

    def _learn(
        self, claimed: ClaimedWorker, chosen: Chosen | None, exit_code: int
    ) -> Verdict | None:
        """What the end of a job says about the credential it ran on (the Worker's exit code), kept
        in the store so a restart remembers it."""
        verdict = verdict_of_exit(exit_code) if chosen is not None else None
        if verdict is None or chosen is None:
            return None
        model = claimed.access.model if claimed.access is not None else None
        self._pool.report(chosen.name, verdict, model)
        # Every verdict is a hint that expires (the job's own sandbox can forge the exit code that
        # carries it): the owner can end the pause at once with `credential retry`. A name is a
        # label of a-z, 0-9, dot, dash and underscore (`credentials.check_name`).
        what = {
            Verdict.AUTH: "was reported as refused (a 401): it is put aside for hours and tried "
            "again (replace the token: factory-runner credential add claude --name {name} "
            "--replace; or let go: factory-runner credential retry {name})",
            Verdict.LIMIT: "hit the usage limit of its subscription: it is put aside for a while "
            "(factory-runner credential retry {name} ends that sooner)",
            Verdict.MODEL: "was reported not to allow the model of the job: that model is put "
            "aside for hours for this credential (factory-runner credential retry {name} lets "
            "it go)",
        }[verdict]
        self._log.warning(
            "job %s: credential %s %s", claimed.job_id, chosen.name, what.format(name=chosen.name)
        )
        return verdict

    async def _run_job(self, claimed: ClaimedWorker) -> WorkerEnd:
        """Start the Worker of the claim, watch it, and give the claim back when it did not do its
        job."""
        assert self._sandbox is not None
        try:
            end = await self._supervise(claimed)
        finally:
            self._workers.pop(claimed.job_id, None)
            self._stoppers.pop(claimed.job_id, None)
            if self._sandbox.uses_host_docker:
                # The turn's containers hold the workspace's key and its work holds the
                # repository: neither stays until the next claim. A failure here is found again
                # before that claim.
                self._untidy = True
                await self._tidy_up(before_claim=False)
        self._log.info("job %s ended: %s", claimed.job_id, end.value)
        return end

    async def _supervise(self, claimed: ClaimedWorker) -> WorkerEnd:
        assert self._sandbox is not None
        chosen, needed = self._choose_credential(claimed)
        if needed and chosen is None:
            # The entry was withdrawn after the app picked this job (or never matched it): a Worker
            # started without the credential would only fail the job with no way to run it.
            self._log.warning(
                "job %s: no credential of this device can serve it (rate limited, refused or not "
                "allowed for its model); giving the job back",
                claimed.job_id,
            )
            await self._give_back(claimed, RELEASE_LAUNCH_FAILED)
            await self._sync_announcement()
            # The app counts an attempt for every claim given back: a store that cannot serve
            # (the secret cannot be read, say) must not make the next claim follow at once and
            # spend an attempt of every queued job, as a Worker that cannot start would not.
            self._start_failed()
            return WorkerEnd.NOT_STARTED
        start = WorkerStart(
            self._config.url,
            claimed.job_id,
            claimed.credential,
            chosen.credential if chosen is not None else None,
        )
        try:
            worker = await self._sandbox.start(start)
        except Exception as error:
            # Class name only: the text of an error may hold part of the hand-over.
            self._log.error(
                "job %s: the Worker could not be started (%s); giving the job back",
                claimed.job_id,
                type(error).__name__,
            )
            await self._give_back(claimed, RELEASE_LAUNCH_FAILED)
            self._start_failed()
            return WorkerEnd.NOT_STARTED
        self._start_failures = 0
        self._workers[claimed.job_id] = worker
        if self._stopping.is_set():
            self._stop_worker(claimed.job_id)
        reaper = asyncio.ensure_future(self._reap(claimed, worker))
        try:
            outcome = await worker.wait()
        finally:
            reaper.cancel()
            await asyncio.gather(reaper, return_exceptions=True)
            stopper = self._stoppers.get(claimed.job_id)
            if stopper is not None:
                await asyncio.gather(stopper, return_exceptions=True)
        reaped = reaper.done() and not reaper.cancelled() and reaper.result() is True
        if self._learn(claimed, chosen, outcome.exit_code) is not None:
            await self._sync_announcement()
        if outcome.exit_code == 0 and not reaped:
            return WorkerEnd.OK
        self._log_worker(claimed, outcome)
        if reaped:
            return WorkerEnd.REAPED
        # The Worker ended with an error. If it had delivered a result the app answers "ended" and
        # nothing changes; if it had not, the claim goes back to the queue (an attempt is counted).
        await self._give_back(claimed, RELEASE_WORKER_EXITED)
        return WorkerEnd.FAILED

    def _start_failed(self) -> None:
        """No claim for a while, longer for every start that fails in a row."""
        self._start_failures += 1
        pause = min(
            START_FAILURE_BACKOFF_FIRST_SECONDS * 2 ** (self._start_failures - 1),
            START_FAILURE_BACKOFF_MAX_SECONDS,
        )
        self._claim_not_before = self._clock.monotonic() + pause
        self._log.warning("claiming again in %gs at the earliest (a start failed)", pause)

    def _log_worker(self, claimed: ClaimedWorker, outcome: WorkerOutcome) -> None:
        """What the Worker said when it ended badly, in the dispatcher's log: the lines are the
        Worker's own, already masked by it (it knows the job's secrets, this process does not),
        and masked again here."""
        self._log.warning(
            "job %s: the Worker ended with exit code %d", claimed.job_id, outcome.exit_code
        )
        lines = outcome.log_tail.splitlines()[-WORKER_LOG_LINES:]
        for line in lines:
            self._log.warning("worker: %s", line)

    async def _give_back(self, claimed: ClaimedWorker, reason: str) -> None:
        """Release the claim with the credential of the job. Best effort: a claim that cannot be
        given back runs out by itself (the lease), and the job is tried again then."""
        try:
            answer = await asyncio.to_thread(
                self._client.release, claimed.job_id, claimed.credential, reason
            )
        except Revoked:
            self._log.warning(
                "job %s: the claim could not be given back: the runner is revoked", claimed.job_id
            )
        except ApiError as error:
            self._log.warning(
                "job %s: the claim could not be given back now (%s)",
                claimed.job_id,
                type(error).__name__,
            )
        else:
            self._log.info(
                "job %s: the claim was given back (%s): %s", claimed.job_id, reason, answer
            )

    async def _reap(self, claimed: ClaimedWorker, worker: RunningWorker) -> bool:
        """The local reaper (#974): while the Worker runs, ask the app now and then whether the job
        is over. A Worker that is still there a while after the app ended the job (a hung process
        that no heartbeat will reach) is ended, so the slot and the machine are free. True when
        it was."""
        over_since: float | None = None
        clock = self._clock
        while True:
            await clock.sleep(self._seams.reap_check_seconds)
            try:
                status = await asyncio.to_thread(self._client.job_state, claimed.job_id)
            except (Revoked, ApiError):
                continue  # the main loop meets a revoked credential at its next claim
            if status in LIVE_JOB_STATUSES:
                over_since = None
                continue
            now = clock.monotonic()
            over_since = now if over_since is None else over_since
            if now - over_since < self._seams.reap_grace_seconds:
                continue
            self._log.warning(
                "job %s is over (%s) and its Worker is still running: ending it",
                claimed.job_id,
                status or "unknown",
            )
            await worker.stop()
            return True

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

    async def _wait(self, seconds: float, jobs: set[asyncio.Task[WorkerEnd]] | None = None) -> None:
        """Sleep, but end at once when the runner is told to stop, and wake when one of `jobs`
        ends (its slot is free: the claim is made now, not at the next poll)."""
        waiting = asyncio.ensure_future(self._clock.sleep(seconds))
        stopped = asyncio.ensure_future(self._stopping.wait())
        try:
            await asyncio.wait(
                [waiting, stopped, *(jobs or ())], return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            waiting.cancel()
            stopped.cancel()
            await asyncio.gather(waiting, stopped, return_exceptions=True)


def _claude_models(announcement: Announcement) -> list[str] | None:
    """The models the entry of Claude Code lists (empty: any), or None when it has no entry."""
    entries = cast("Sequence[dict[str, object]]", announcement.manifest.get("harnesses", []))
    for entry in entries:
        if entry.get("harness") == HARNESS_CLAUDE_CODE:
            return [str(model) for model in cast("Sequence[object]", entry.get("models") or [])]
    return None


def environment_work_dir(environment: Mapping[str, str]) -> str:
    """The work volume the job process will use (`RUNNER_IMPLEMENTER_WORK_DIR`, else `/work`)."""
    return environment.get(IMPLEMENTER_WORK_DIR_VARIABLE) or IMPLEMENTER_WORK_DIR
