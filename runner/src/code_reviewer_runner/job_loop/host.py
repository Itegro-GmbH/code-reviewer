# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job host: runs one job to its end and delivers the result (#323).

Everything between "I have a job and the credential to report it" and "the result is delivered or
given up" lives here, so the runner's job loop (which claims) and the Worker (which is handed its
job) run a job in exactly the same way: the job process with the job on its stdin and a minimal
environment, the heartbeats, the hard timeout, the lease check a Dynamic job asks before it writes
its summary, the masking of every log line and every result, the delivery with retry, the orderly
end on shutdown and the sweep of the engine user after a Dynamic job process.

The host never claims and never decides what to do next: it ends in a `JobEnd` and the caller acts
on it (the loop goes on, the Worker exits). The credential of the job is a `ClaimedJob.lease_token`
to the host; in the loop it is the lease token, in the Worker it is the per-job credential. Either
way it only goes out through the `JobApi` and into the masker, never to the job process.

Rules the code below follows (see the CR-29 decisions):

- A job that is refused (unknown command, unsupported platform, invalid input) never starts a
  process: its result carries the stable error code of the refusal.
- The secrets of a job (git token, LLM key, lease token) reach the process through its stdin only,
  and no log line or result the host produces contains them.
- A lost lease (409 on a heartbeat) ends the process and sends nothing more for that job.
- A heartbeat answer that says the run was superseded (#396) tells the job process once
  (`SIGUSR1`, which it was started with blocked, so an early signal is held until its handler
  exists) and the host goes on: it keeps beating, waits for the process to end by itself (it
  finishes the model requests in flight, sends no more, publishes nothing), delivers its result
  (`superseded`, with the usage) and ends `SUPERSEDED`. A process that has not ended by
  `SUPERSEDED_DRAIN_SECONDS` after it was told, or `KILL_MARGIN_SECONDS` before the lease the
  answer named, is ended and its usage is reported as unknown. Whatever ends it, the result of a
  run that was told is `superseded` (not `runner_error` or `timeout`). The numbers are in
  `supersede_timing.py`.
- A hard stop (the end of the grace period, or a SIGTERM of a Worker) ends the process and reports
  `runner_shutdown`, which the app gives back to the queue (a repeated report may be answered with
  409, which is fine).
"""

import asyncio
import json
import logging
import shlex
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol

from code_reviewer_runner.capabilities import (
    ENGINE_DYNAMIC,
    ENGINE_IMPLEMENTER,
    ENGINES_VARIABLE,
    OPENCODE_COMMAND_VARIABLE,
    RIPGREP_PATH_VARIABLE,
)
from code_reviewer_runner.dynamic_review.engine_user import sweep_user
from code_reviewer_runner.dynamic_review.netguard import EGRESS_MODE_VARIABLE, EgressMode
from code_reviewer_runner.job import (
    IMPLEMENTER_ENVIRONMENT_NAMES,
    ImplementerInput,
    Job,
    JobError,
    ReviewKind,
    parse_runnable_job,
)
from code_reviewer_runner.job_loop.api import (
    ApiError,
    ApiRejected,
    ApiUnavailable,
    ClaimedJob,
    CompleteReply,
    HeartbeatReply,
    LeaseLost,
)
from code_reviewer_runner.job_loop.clock import Clock, RealClock
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.job_loop.masking import SafeLog, SecretMasker
from code_reviewer_runner.job_loop.process import (
    STDOUT_KEEP_BYTES,
    ProcessLauncher,
    ProcessOutcome,
    ProcessSpec,
    RunningProcess,
)
from code_reviewer_runner.job_loop.reporting import (
    NO_RESULT_REASON,
    RUNNER_SHUTDOWN,
    Result,
    TextRedactor,
    failure_result,
    fit_request,
    minimal,
    result_from_outcome,
    stopped_result,
)
from code_reviewer_runner.lease_check import LeaseState
from code_reviewer_runner.pr_agent_config import PASSTHROUGH_VARIABLES
from code_reviewer_runner.result import ErrorCode
from code_reviewer_runner.supersede_timing import (
    KILL_MARGIN_SECONDS,
    SUPERSEDED_DRAIN_SECONDS,
)

TIMEOUT_VARIABLE = "RUNNER_JOB_TIMEOUT_SECONDS"
# #260: the lease check right before a Dynamic run publishes. Up to three tries, a second and two
# seconds apart, within less than the 45 seconds the job process waits for the answer.
LEASE_CHECK_ATTEMPTS = 3
LEASE_CHECK_PAUSE_SECONDS = 1.0
LEASE_CHECK_BUDGET_SECONDS = 40.0
# The operator's non-secret Dynamic configuration, read by the Dynamic job process: the model
# description, the cost limit of a run (#290) and the engine user and ports of the slot (the names
# of `supervisor.py` and `static_isolation.py`).
DYNAMIC_PASSTHROUGH_VARIABLES = (
    "RUNNER_DYNAMIC_CAPABILITIES",
    "RUNNER_DYNAMIC_MAX_COST_USD",
    "RUNNER_DYNAMIC_ENGINE_UID",
    "RUNNER_DYNAMIC_ENGINE_GID",
    "RUNNER_DYNAMIC_PROXY_PORT",
    "RUNNER_DYNAMIC_ENGINE_PORT",
)
# What an Implementer job process is told besides the engines and the engine command: the slot (the
# engine user and its ports, as for Dynamic) and the names of its container profile (#746). The
# Dynamic cost ceiling and model description are not among them: they are the Dynamic Review's.
IMPLEMENTER_PASSTHROUGH_VARIABLES = (
    "RUNNER_DYNAMIC_ENGINE_UID",
    "RUNNER_DYNAMIC_ENGINE_GID",
    "RUNNER_DYNAMIC_PROXY_PORT",
    "RUNNER_DYNAMIC_ENGINE_PORT",
    *IMPLEMENTER_ENVIRONMENT_NAMES,
)
# The newest bytes of its stdout the host keeps of an Implementer job process: its result line
# carries the commits and files of the turn, up to the 4 MB the body is held to (`report.py`).
IMPLEMENTER_STDOUT_KEEP_BYTES = 6 * 1024 * 1024
# A stopped turn of the Implementer has to end its engine, ask the lease and push: the process
# gets this long after SIGTERM before it is killed (the container's own `stopTimeoutSeconds` is 90,
# and the report of the stop comes after it). The process leaves itself less
# (`job_run.SIGTERM_BACKSTOP_SECONDS`).
IMPLEMENTER_TERMINATE_GRACE_SECONDS = 60.0
# One lease question of an Implementer turn is bounded. At a normal end the last push must not
# lose a good turn to a slow app: 25 s a question, and the window of the last push (30 s, asked
# again) fits the grace of 180 s the end keeps. A stop has a minute in all and no time for an app
# that does not answer: 10 s a question.
IMPLEMENTER_LEASE_CHECK_BUDGET_SECONDS = 25.0
IMPLEMENTER_STOP_LEASE_CHECK_BUDGET_SECONDS = 10.0
# A shutdown report is tried for this long; the process is going away either way.
SHUTDOWN_REPORT_WINDOW_SECONDS = 10.0
_FIRST_RETRY_SECONDS = 1.0


class JobApi(Protocol):
    """What the host needs of an API: the heartbeat and the delivery. The runner API (with the lease
    token) and the Worker API (with the job credential) both fit."""

    async def heartbeat(self, job_id: str, lease_token: str) -> HeartbeatReply: ...

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> CompleteReply: ...


class HostSettings(Protocol):
    """The part of the configuration the host reads (`LoopSettings` and `WorkerSettings`)."""

    @property
    def job_command(self) -> tuple[str, ...]: ...

    @property
    def job_timeout(self) -> float: ...

    @property
    def kill_margin(self) -> float: ...

    @property
    def backoff_max(self) -> float: ...

    @property
    def complete_retry_window(self) -> float: ...

    @property
    def engines(self) -> tuple[str, ...]: ...

    @property
    def dynamic_command(self) -> tuple[str, ...] | None: ...

    @property
    def dynamic_ripgrep(self) -> str | None: ...

    @property
    def dynamic_egress_mode(self) -> EgressMode: ...

    @property
    def diff_job_user(self) -> tuple[int, int] | None: ...

    @property
    def dynamic_engine_user(self) -> tuple[int, int] | None: ...


class JobEnd(StrEnum):
    """How a job ended, as far as the host can tell. Stable: callers branch on it."""

    # The job succeeded and the app has the result.
    OK = "ok"
    # The job failed (a failure result was delivered).
    FAILED = "failed"
    # The job was given back to the queue (a shutdown); another Worker will take it.
    GIVEN_BACK = "given_back"
    # The app no longer holds the job for us: nothing was delivered, nothing more can be.
    LEASE_LOST = "lease_lost"
    # The result could not be delivered; the lease will run out and the job is tried again.
    NOT_DELIVERED = "not_delivered"
    # A newer push replaced the run (#396): it stopped gracefully, its result and usage were
    # delivered.
    SUPERSEDED = "superseded"


class Delivery(StrEnum):
    DELIVERED = "delivered"
    GIVEN_BACK = "given_back"
    NOT_HELD = "not_held"
    FAILED = "failed"


@dataclass
class _RunState:
    """What the host learned about one run while it supervised it."""

    # The app said the run was superseded (a heartbeat answer, or the lease check before a write).
    superseded: asyncio.Event = field(default_factory=asyncio.Event)
    # The end of the lease as the answer that said so named it (seconds since the epoch); the drain
    # ends before it.
    lease_expires_at: float | None = None

    def learn_of_supersede(self, lease_expires_at: float | None) -> None:
        """The app said the run was superseded; the first answer's lease bounds the drain."""
        if not self.superseded.is_set():
            self.lease_expires_at = lease_expires_at
            self.superseded.set()


def _kind_of(job: Job | ImplementerInput) -> ReviewKind:
    return ReviewKind.IMPLEMENTER if isinstance(job, ImplementerInput) else job.review_kind


def _label_of(job: Job | ImplementerInput) -> str:
    return "implementer" if isinstance(job, ImplementerInput) else job.command.value


def _supervises_an_engine(kind: ReviewKind) -> bool:
    """A Dynamic job and an Implementer turn are root supervisors of an engine of another user:
    they are the processes that ask the lease before they write, and whose engine user is swept
    after them."""
    return kind in (ReviewKind.DYNAMIC, ReviewKind.IMPLEMENTER)


def _as_superseded(result: Result) -> Result:
    """The result of a run that was told it was superseded, whatever ended it.

    The process names its own end `superseded` (`runner.as_superseded`). A process that died after
    it was told (killed for memory, a crash, the hard timeout) leaves the host to name the end, and
    the host says `runner_error` or `timeout`: that would be stored as a failed run of the quota.
    The run was replaced, so it says so; the usage and the reason it carries stay (a request in
    flight makes the cost unknown). A shutdown stays a shutdown (the job is given back), a success
    stays a success (it had published), and `superseded` stays.
    """
    if result["ok"] or result["errorCode"] in (RUNNER_SHUTDOWN, ErrorCode.SUPERSEDED.value):
        return result
    return {**result, "errorCode": ErrorCode.SUPERSEDED.value}


def _end_of(result: Result, delivery: Delivery, superseded: bool = False) -> JobEnd:
    if delivery is Delivery.NOT_HELD:
        return JobEnd.LEASE_LOST
    if delivery is Delivery.FAILED:
        return JobEnd.NOT_DELIVERED
    if delivery is Delivery.GIVEN_BACK or result["errorCode"] == RUNNER_SHUTDOWN:
        return JobEnd.GIVEN_BACK
    if superseded or result["errorCode"] == ErrorCode.SUPERSEDED.value:
        return JobEnd.SUPERSEDED
    return JobEnd.OK if result["ok"] else JobEnd.FAILED


def _secrets_in(raw_input: Mapping[str, Any]) -> list[str]:
    """The credentials of a job input, found defensively (the input may not be valid)."""
    values: list[str] = []
    for section, key in (("git", "token"), ("llm", "apiKey")):
        part = as_object(raw_input.get(section))
        value = part.get(key) if part else None
        if isinstance(value, str) and value.strip():
            values.append(value)
    return values


class JobHost:
    def __init__(
        self,
        settings: HostSettings,
        api: JobApi,
        launcher: ProcessLauncher,
        *,
        masker: SecretMasker,
        clock: Clock | None = None,
        logger: logging.Logger | None = None,
        environment: Mapping[str, str] | None = None,
        sweeper: Callable[[int, int], bool] = sweep_user,
        refuse_unadvertised_engine: bool = False,
    ) -> None:
        self._settings = settings
        self._api = api
        self._launcher = launcher
        self._clock: Clock = clock or RealClock()
        self._masker = masker
        self._log = SafeLog(logger or logging.getLogger("code_reviewer_runner.loop"), masker)
        self._environment = dict(environment or {})
        self._hard_stop = asyncio.Event()
        # Ends everything the engine user runs (uid, gid); it is only called once no Dynamic job
        # process runs, under the lock that also guards the start of one.
        self._sweeper = sweeper
        self._engine_lock = asyncio.Lock()
        self._engine_jobs = 0
        # A Worker is handed its job and cannot choose: a Dynamic job whose engine this worker did
        # not advertise is refused here with the stable code. The loop never claims such a job.
        self._refuse_unadvertised_engine = refuse_unadvertised_engine

    def request_hard_stop(self) -> None:
        """End the running process now and report `runner_shutdown` (the grace period is over)."""
        self._hard_stop.set()

    # -- one job ------------------------------------------------------------------------------

    async def run_job(self, claimed: ClaimedJob) -> JobEnd:
        """Run the job to its end: supervise the process, then deliver the result.

        Never raises (a cancellation excepted): an unexpected error is logged by its class and the
        lease runs out, which gives the job to someone else.
        """
        self._masker.add(claimed.id, [claimed.lease_token, *_secrets_in(claimed.input)])
        try:
            return await self._run_job(claimed)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Class name only: the text of an error may hold part of the input.
            self._log.error(
                "job %s: unexpected runner error (%s); the lease will run out and the job "
                "is tried again",
                claimed.id,
                type(error).__name__,
            )
            return JobEnd.NOT_DELIVERED
        finally:
            self._masker.discard(claimed.id)

    def _child_environment(self, job: Job | ImplementerInput) -> dict[str, str]:
        """Only the plain runtime variables; never the runner token or anything of another job."""
        env = {
            name: self._environment[name]
            for name in PASSTHROUGH_VARIABLES
            if name in self._environment
        }
        env[TIMEOUT_VARIABLE] = f"{self._settings.job_timeout:g}"
        kind = _kind_of(job)
        if kind is ReviewKind.DYNAMIC:
            env.update(self._dynamic_environment())
        elif kind is ReviewKind.IMPLEMENTER:
            env.update(self._implementer_environment())
        return env

    def _implementer_environment(self) -> dict[str, str]:
        """What only an Implementer job process gets (#765): the engines the startup advertised,
        the engine command and `rg` it verified, the egress mode, the slot and the names of the
        container profile. All of it is the host's own finding or the Dispatcher's variable; none
        comes from the job."""
        env = {
            name: self._environment[name]
            for name in IMPLEMENTER_PASSTHROUGH_VARIABLES
            if name in self._environment
        }
        env[ENGINES_VARIABLE] = ",".join(self._settings.engines)
        env[EGRESS_MODE_VARIABLE] = self._settings.dynamic_egress_mode.value
        if self._settings.dynamic_command:
            env[OPENCODE_COMMAND_VARIABLE] = shlex.join(self._settings.dynamic_command)
            if self._settings.dynamic_ripgrep:
                env[RIPGREP_PATH_VARIABLE] = self._settings.dynamic_ripgrep
        return env

    def _dynamic_environment(self) -> dict[str, str]:
        """What only a Dynamic job process gets (#202), all of it decided by trusted configuration.

        The engines the startup self-check advertised, the engine command and `rg` it verified
        (never ones the operator typed), the egress mode startup found (#345) and the operator's
        description of the model and of the slot. A runner whose check failed hands over no
        command: the job process then refuses with `dynamic_engine_unavailable`.
        """
        env = {
            name: self._environment[name]
            for name in DYNAMIC_PASSTHROUGH_VARIABLES
            if name in self._environment
        }
        env[ENGINES_VARIABLE] = ",".join(self._settings.engines)
        # The ruleset startup installed: the host's own finding, whatever the environment says.
        env[EGRESS_MODE_VARIABLE] = self._settings.dynamic_egress_mode.value
        if ENGINE_DYNAMIC in self._settings.engines and self._settings.dynamic_command:
            env[OPENCODE_COMMAND_VARIABLE] = shlex.join(self._settings.dynamic_command)
            if self._settings.dynamic_ripgrep:
                env[RIPGREP_PATH_VARIABLE] = self._settings.dynamic_ripgrep
        return env

    def _ms_since(self, started: float) -> int:
        return int((self._clock.monotonic() - started) * 1000)

    async def _run_job(self, claimed: ClaimedJob) -> JobEnd:
        started = self._clock.monotonic()
        # Knows the runner token, the secrets of every running job and the lease tokens.
        redactor = self._masker
        try:
            job = parse_runnable_job(json.dumps(claimed.input))
        except JobError as error:
            self._log.warning("job %s refused: %s", claimed.id, error.code.value)
            result = failure_result(
                error.code.value, error.detail, duration_ms=self._ms_since(started)
            )
            return await self._refuse(claimed, result)
        kind = _kind_of(job)
        if kind is ReviewKind.IMPLEMENTER and ENGINE_IMPLEMENTER not in self._settings.engines:
            # Never run on a runner that did not prove its prerequisites, whoever started it (#765).
            self._log.warning(
                "job %s refused: the implementer engine is not advertised", claimed.id
            )
            result = failure_result(
                ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE.value,
                "the implementer engine is not advertised by this worker",
                duration_ms=self._ms_since(started),
            )
            return await self._refuse(claimed, result)
        if self._refuse_unadvertised_engine and not self._engine_advertised(kind):
            self._log.warning("job %s refused: the Dynamic engine is not advertised", claimed.id)
            result = failure_result(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE.value,
                "the Dynamic engine is not advertised by this worker",
                duration_ms=self._ms_since(started),
            )
            return await self._refuse(claimed, result)
        self._log.info("job %s claimed: %s", claimed.id, _label_of(job))
        state = _RunState()
        try:
            # ASCII escapes: a lone surrogate in a text cannot break the encoding, and the job
            # process reads the same JSON.
            spec = ProcessSpec(
                argv=self._settings.job_command,
                env=self._child_environment(job),
                stdin=json.dumps(claimed.input).encode("ascii"),
                # A Dynamic job is the root supervisor (it drops the engine to its own user); every
                # other job drops to the unprivileged job user when the loop itself is root.
                run_as=(None if _supervises_an_engine(kind) else self._settings.diff_job_user),
                # #260: a Dynamic job writes its own comment, so it asks right before (a Diff job
                # does not publish this way). An Implementer job asks before every push (#765).
                lease_check=(
                    (lambda: self._confirm_lease(claimed, state, self._lease_budget_of(kind)))
                    if _supervises_an_engine(kind)
                    else None
                ),
                terminate_grace=(
                    IMPLEMENTER_TERMINATE_GRACE_SECONDS if kind is ReviewKind.IMPLEMENTER else None
                ),
                stdout_keep_bytes=(
                    IMPLEMENTER_STDOUT_KEEP_BYTES
                    if kind is ReviewKind.IMPLEMENTER
                    else STDOUT_KEEP_BYTES
                ),
            )
            process = await self._start_process(spec, job)
        except Exception as error:
            self._log.error(
                "job %s: cannot start the job process (%s)", claimed.id, type(error).__name__
            )
            result = failure_result(
                ErrorCode.RUNNER_ERROR.value,
                "the job process could not be started",
                duration_ms=self._ms_since(started),
            )
            return await self._refuse(claimed, result)
        try:
            result = await self._supervise(
                claimed,
                process,
                redactor,
                started,
                state,
                implementer=_kind_of(job) is ReviewKind.IMPLEMENTER,
            )
        finally:
            await self._after_process(job)
        if result is None:
            return JobEnd.LEASE_LOST
        if state.superseded.is_set():
            result = _as_superseded(result)
        shutdown = result["errorCode"] == RUNNER_SHUTDOWN
        delivery = await self._report(
            claimed,
            result,
            window=(
                SHUTDOWN_REPORT_WINDOW_SECONDS if shutdown else self._settings.complete_retry_window
            ),
            shutdown=shutdown,
        )
        return _end_of(result, delivery, state.superseded.is_set())

    async def _refuse(self, claimed: ClaimedJob, result: Result) -> JobEnd:
        """Deliver the failure of a job that never started a process."""
        delivery = await self._report(claimed, result, window=self._settings.complete_retry_window)
        return _end_of(result, delivery)

    def _engine_advertised(self, kind: ReviewKind) -> bool:
        return kind is not ReviewKind.DYNAMIC or ENGINE_DYNAMIC in self._settings.engines

    def _engine_user(self, job: Job | ImplementerInput) -> tuple[int, int] | None:
        """The engine user whose leftovers follow this job's process, if it has one."""
        if not _supervises_an_engine(_kind_of(job)):
            return None
        return self._settings.dynamic_engine_user

    async def _start_process(
        self, spec: ProcessSpec, job: Job | ImplementerInput
    ) -> RunningProcess:
        if self._engine_user(job) is None:
            return await self._launcher.start(spec)
        # Under the lock that guards the sweep: a sweep that runs while this process is being
        # started would end the engine of a job that has only just begun.
        async with self._engine_lock:
            process = await self._launcher.start(spec)
            self._engine_jobs += 1
            return process

    async def _after_process(self, job: Job | ImplementerInput) -> None:
        """The job process is gone (however it ended): end what its engine user still runs.

        A job killed outright (SIGKILL, an OOM kill) cannot clean up after itself, and a helper
        may have left the engine's process group. The loop is root and holds `KILL`; whatever it
        cannot end here is met by the next job, which sweeps again right after taking the lease
        and does not start while the user still runs something.
        """
        user = self._engine_user(job)
        if user is None:
            return
        async with self._engine_lock:
            self._engine_jobs -= 1
            if self._engine_jobs > 0:
                return  # the user belongs to another job's engine now; its end will sweep
            try:
                ended = await asyncio.shield(asyncio.to_thread(self._sweeper, *user))
            except Exception as error:
                self._log.error("the engine user could not be swept (%s)", type(error).__name__)
                return
        if not ended:
            self._log.warning("a process of the engine user survived the sweep")

    async def _supervise(
        self,
        claimed: ClaimedJob,
        process: RunningProcess,
        redactor: TextRedactor,
        started: float,
        state: _RunState,
        *,
        implementer: bool = False,
    ) -> Result | None:
        """Wait for the process, beat the heart, enforce the timeout. None: report nothing."""
        lost = asyncio.Event()
        finished = asyncio.ensure_future(process.wait())
        helpers: list[asyncio.Future[Any]] = [
            asyncio.ensure_future(self._heartbeats(claimed, lost, state)),
            asyncio.ensure_future(lost.wait()),
            asyncio.ensure_future(
                self._clock.sleep(self._settings.job_timeout + self._settings.kill_margin)
            ),
            asyncio.ensure_future(self._hard_stop.wait()),
            asyncio.ensure_future(self._drain(claimed, process, state)),
        ]
        _, lost_wait, timeout, shutdown, drained = helpers
        try:
            await asyncio.wait([finished, *helpers[1:]], return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            await self._end(process, finished)
            raise
        finally:
            for helper in helpers:
                helper.cancel()
            await asyncio.gather(*helpers, return_exceptions=True)
        if finished.done():
            outcome = finished.result()
            result = result_from_outcome(
                outcome, redactor, self._ms_since(started), implementer=implementer
            )
            self._log_outcome(claimed, result, outcome)
            return result
        outcome = await self._end(process, finished)
        tail = outcome.stderr.decode("utf-8", errors="replace") if outcome else ""
        if lost_wait.done() and not lost_wait.cancelled():
            self._log.warning("job %s: the lease is lost, the process was ended", claimed.id)
            return None
        if timeout.done() and not timeout.cancelled():
            self._log.warning("job %s: hard timeout, the process was ended", claimed.id)
            return failure_result(
                ErrorCode.TIMEOUT.value,
                "the job did not finish within the time limit and was ended",
                duration_ms=self._ms_since(started),
                log_tail=tail,
                redactor=redactor,
                reason=NO_RESULT_REASON,
            )
        if drained.done() and not drained.cancelled():
            # The run was told that it was superseded and did not stop by itself: it is ended here,
            # and what it used is unknown (a model request may have been in flight).
            self._log.warning(
                "job %s: the superseded run did not stop in time, the process was ended", claimed.id
            )
            return failure_result(
                ErrorCode.SUPERSEDED.value,
                "the superseded run did not stop in time and was ended",
                duration_ms=self._ms_since(started),
                log_tail=tail,
                redactor=redactor,
                reason=NO_RESULT_REASON,
            )
        if shutdown.done() and not shutdown.cancelled():
            self._log.warning(
                "job %s: the runner is shutting down, the job is given back", claimed.id
            )
            return stopped_result(
                outcome, redactor, self._ms_since(started), implementer=implementer
            )
        return None

    async def _end(
        self, process: RunningProcess, finished: asyncio.Future[ProcessOutcome]
    ) -> ProcessOutcome | None:
        """End the process and its children; its outcome (with the end of stderr) if available."""
        try:
            await process.terminate()
            return await finished
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._log.error("the job process could not be ended cleanly (%s)", type(error).__name__)
            return None

    async def _drain(self, claimed: ClaimedJob, process: RunningProcess, state: _RunState) -> None:
        """Once the run is superseded (#396): tell the process, then wait for it to drain.

        Returns when the time is over (the caller ends the process); never returns while the run is
        not superseded. The process is signalled once, at once: it was started with the signal
        blocked, so one that comes before its handler exists is held, not fatal. The wait is the
        longest model request (`SUPERSEDED_DRAIN_SECONDS`), but ends `KILL_MARGIN_SECONDS` before
        the lease the app named: the app keeps the claim for the heartbeat, the longest request and
        a margin (`supersede_timing.py`), so the result is reported while the claim holds.
        """
        await state.superseded.wait()
        self._log.info("job %s: superseded by a newer push, the process is told", claimed.id)
        try:
            told = process.notify_superseded()
        except Exception as error:
            self._log.warning(
                "job %s: the process could not be told (%s)", claimed.id, type(error).__name__
            )
        else:
            if not told:
                self._log.warning(
                    "job %s: the process could not be told (SUPERSEDE_SIGNAL_NOT_SENT); "
                    "only the drain bound stops it",
                    claimed.id,
                )
        wait = SUPERSEDED_DRAIN_SECONDS
        if state.lease_expires_at is not None:
            until_lease = state.lease_expires_at - self._clock.wall() - KILL_MARGIN_SECONDS
            wait = min(wait, until_lease)
        await self._clock.sleep(max(wait, 0.0))

    async def _heartbeats(
        self, claimed: ClaimedJob, lost: asyncio.Event, state: _RunState | None = None
    ) -> None:
        while True:
            await self._clock.sleep(claimed.heartbeat_interval)
            try:
                reply = await self._api.heartbeat(claimed.id, claimed.lease_token)
                if reply.superseded and state is not None:
                    state.learn_of_supersede(reply.lease_expires_at)
            except LeaseLost:
                lost.set()
                return
            except Exception as error:
                # A missed beat is not yet a lost lease (it is two minutes long): keep going. Only
                # the class of an unexpected error is logged, its text may hold part of the input.
                detail = str(error) if isinstance(error, ApiError) else type(error).__name__
                self._log.warning("job %s: heartbeat failed (%s)", claimed.id, detail)

    def _lease_budget_of(self, kind: ReviewKind) -> float:
        """How long one lease question may take: the Dynamic job's own, or an Implementer turn's,
        which is shorter while the runner is being stopped."""
        if kind is not ReviewKind.IMPLEMENTER:
            return LEASE_CHECK_BUDGET_SECONDS
        if self._hard_stop.is_set():
            return IMPLEMENTER_STOP_LEASE_CHECK_BUDGET_SECONDS
        return IMPLEMENTER_LEASE_CHECK_BUDGET_SECONDS

    async def _confirm_lease(
        self,
        claimed: ClaimedJob,
        state: _RunState,
        budget: float = LEASE_CHECK_BUDGET_SECONDS,
    ) -> LeaseState:
        """Beat the heart now. A lost lease and a cancelled job are both answered with 409.

        An answer that only says the app could not be reached (5xx, a reset, a timeout) is asked
        again after a short pause, so one hiccup does not cost a finished review. The whole question
        stays inside what the process waits for. 409 and 404 are final, and so is a refusal.
        """
        if state.superseded.is_set():
            return LeaseState.SUPERSEDED
        try:
            async with asyncio.timeout(budget):
                return await self._ask_app(claimed, state)
        except TimeoutError:
            self._log.warning("job %s: the lease check ran out of time", claimed.id)
            return LeaseState.UNCONFIRMED

    async def _ask_app(self, claimed: ClaimedJob, state: _RunState) -> LeaseState:
        for attempt in range(1, LEASE_CHECK_ATTEMPTS + 1):
            try:
                reply = await self._api.heartbeat(claimed.id, claimed.lease_token)
            except LeaseLost:
                self._log.warning("job %s: the lease check before publishing: lost", claimed.id)
                return LeaseState.LOST
            except Exception as error:
                detail = str(error) if isinstance(error, ApiError) else type(error).__name__
                self._log.warning(
                    "job %s: the lease check could not be made (%s)", claimed.id, detail
                )
                if isinstance(error, ApiUnavailable) and attempt < LEASE_CHECK_ATTEMPTS:
                    await self._clock.sleep(LEASE_CHECK_PAUSE_SECONDS * 2 ** (attempt - 1))
                    continue
                return LeaseState.UNCONFIRMED
            if reply.superseded:
                state.learn_of_supersede(reply.lease_expires_at)
                return LeaseState.SUPERSEDED
            return LeaseState.HELD
        return LeaseState.UNCONFIRMED  # pragma: no cover  (the last attempt returns above)

    def _log_outcome(self, claimed: ClaimedJob, result: Result, outcome: ProcessOutcome) -> None:
        if result["ok"]:
            self._log.info("job %s finished: ok in %d ms", claimed.id, result["durationMs"])
            return
        reason = result.get("errorReason")
        self._log.warning(
            "job %s finished: %s%s (exit code %d)",
            claimed.id,
            result["errorCode"],
            f" [{reason}]" if reason else "",
            outcome.exit_code,
        )

    # -- reporting ----------------------------------------------------------------------------

    async def _report(
        self, claimed: ClaimedJob, result: Result, *, window: float, shutdown: bool = False
    ) -> Delivery:
        """Deliver the result. The heart keeps beating until the app has it (or we give up): a
        lease that lapses meanwhile would let another runner take the job a second time."""
        lost = asyncio.Event()
        beating = asyncio.ensure_future(self._heartbeats(claimed, lost))
        try:
            return await self._deliver(claimed, result, window=window, shutdown=shutdown, lost=lost)
        finally:
            beating.cancel()
            await asyncio.gather(beating, return_exceptions=True)

    async def _sleep_unless(
        self, seconds: float, lost: asyncio.Event, *, until_hard_stop: bool
    ) -> bool:
        """Sleep; False if something ended the wait early (lost lease, or the end of the grace)."""
        sleeper = asyncio.ensure_future(self._clock.sleep(seconds))
        waiters: list[asyncio.Future[Any]] = [sleeper, asyncio.ensure_future(lost.wait())]
        if until_hard_stop:
            waiters.append(asyncio.ensure_future(self._hard_stop.wait()))
        try:
            await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
        finally:
            slept = sleeper.done() and not sleeper.cancelled()
            for waiter in waiters:
                waiter.cancel()
            await asyncio.gather(*waiters, return_exceptions=True)
        return slept

    async def _deliver(
        self,
        claimed: ClaimedJob,
        result: Result,
        *,
        window: float,
        shutdown: bool,
        lost: asyncio.Event,
    ) -> Delivery:
        """Send the result until the app takes it, tells us it will never take it, or time is up."""
        body = fit_request(result)
        began = self._clock.monotonic()
        delay = _FIRST_RETRY_SECONDS
        # 0: the whole result, 1: the verdict with its usage, 2: the verdict alone (#273).
        stage = 0
        while True:
            if lost.is_set():
                self._log.info("job %s: the lease is lost, the result is not sent", claimed.id)
                return Delivery.NOT_HELD
            try:
                reply = await self._api.complete(claimed.id, claimed.lease_token, body)
            except LeaseLost:
                # Another result was stored, the lease ran out, or (after a shutdown report) the
                # job was already given back: in all cases there is nothing left to send.
                self._log.info("job %s: the app does not hold this job for us any more", claimed.id)
                return Delivery.NOT_HELD
            except ApiRejected as error:
                if error.status in (400, 413) and stage == 0:
                    stage = 1
                    body = minimal(result)
                    self._log.warning(
                        "job %s: result refused (HTTP %d), sending the verdict only",
                        claimed.id,
                        error.status,
                    )
                    continue
                if error.status in (400, 413) and stage == 1 and body.get("usage") is not None:
                    # The usage may be what the app refuses: the verdict must not be lost for it.
                    stage = 2
                    body = minimal(result, keep_usage=False)
                    self._log.warning(
                        "job %s: verdict refused (HTTP %d), sending it without the usage",
                        claimed.id,
                        error.status,
                    )
                    continue
                self._log.error(
                    "job %s: the result was refused (HTTP %d)", claimed.id, error.status
                )
                return Delivery.FAILED
            except ApiUnavailable as error:
                remaining = window - (self._clock.monotonic() - began)
                if remaining <= 0 or (self._hard_stop.is_set() and not shutdown):
                    self._log.error(
                        "job %s: the result could not be delivered (%s); the lease will run out",
                        claimed.id,
                        error,
                    )
                    return Delivery.FAILED
                pause = min(max(delay, error.retry_after or 0.0), remaining)
                self._log.warning(
                    "job %s: %s; sending the result again in %gs", claimed.id, error, pause
                )
                if not await self._sleep_unless(pause, lost, until_hard_stop=not shutdown):
                    self._log.warning("job %s: stopped waiting to send the result", claimed.id)
                    return Delivery.FAILED
                delay = min(delay * 2, self._settings.backoff_max)
                continue
            if reply.status == "queued":
                self._log.info("job %s given back to the queue", claimed.id)
            else:
                self._log.info("job %s reported: %s", claimed.id, reply.status or "ok")
            return Delivery.GIVEN_BACK if reply.status == "queued" else Delivery.DELIVERED
