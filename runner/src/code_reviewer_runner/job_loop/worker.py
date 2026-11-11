# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Worker (#323): runs exactly one job with a per-job credential and then ends.

`code-reviewer-worker --once` reads one document from stdin, `{appUrl, jobId, credential}`, and
nothing else about the job: the job itself is fetched from the app with the credential, run by the
same `JobHost` the runner's loop uses, and its result is delivered with the same credential. The
credential is a secret: it never goes into the arguments, the environment, a file or the log (the
masker knows it from the first line), and the job process never sees it, only the job on stdin.

| Exit | Meaning |
|------|---------|
| 0 | The job succeeded, was given back (SIGTERM, SIGINT), superseded (#396) or cancelled (#891). |
| 1 | The job failed, the app did not hold it any more, or the result could not be delivered. |
| 2 | The Worker could not start the job (`WorkerFailure`, see worker_errors.py). |

A signal during the job ends the process and delivers `runner_shutdown`, which the app takes as a
release. There is no grace period: the platform that stops a Worker does not give one.
"""

import asyncio
import json
import logging
import re
import signal
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final
from urllib.parse import urlsplit

from code_reviewer_runner.dynamic_review.engine_user import sweep_user
from code_reviewer_runner.job_loop.api import ApiError, ApiRejected, ApiUnavailable, ClaimedJob
from code_reviewer_runner.job_loop.clock import Clock, RealClock
from code_reviewer_runner.job_loop.host import JobEnd, JobHost
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.job_loop.local_credential import (
    LOCAL_CREDENTIAL_NAMES,
    LOCAL_CREDENTIAL_VALUE,
    LocalCredential,
)
from code_reviewer_runner.job_loop.masking import SafeLog, SecretMasker
from code_reviewer_runner.job_loop.process import ProcessLauncher, SubprocessLauncher
from code_reviewer_runner.job_loop.settings import WorkerSettings
from code_reviewer_runner.job_loop.worker_api import (
    CredentialInvalid,
    HttpWorkerApi,
    JobEnded,
    JobGivenBack,
    WorkerApi,
    WorkerJob,
)
from code_reviewer_runner.job_loop.worker_errors import (
    WorkerExit,
    WorkerFailure,
    WorkerSetupError,
)
from code_reviewer_runner.outer_proxy import OuterProxy, OuterProxyError
from code_reviewer_runner.result import ErrorCode

LOGGER_NAME = "code_reviewer_runner.loop"
# The start document is small; anything larger is not one.
MAX_START_DOCUMENT_BYTES = 16 * 1024
# The contract allows the job details call three times per claim (each mints a fresh token), so
# this is the most the Worker may try; the pauses grow from the first.
FETCH_ATTEMPTS = 3
FETCH_FIRST_PAUSE_SECONDS = 1.0
FETCH_MAX_PAUSE_SECONDS = 30.0

_JOB_ID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
# WorkerCredential of the runner API contract: `crj_` and 256 bits in base64url.
_CREDENTIAL = re.compile(r"crj_[A-Za-z0-9_-]{43}")
# `ControlToken` of the contracts: the host's per-VM token for the environment control (#977).
_CONTROL_TOKEN = re.compile(r"[A-Za-z0-9_-]{43,128}")


@dataclass(frozen=True)
class WorkerRequest:
    app_url: str
    job_id: str
    credential: str = field(repr=False)
    # The host's per-VM token (vm-init puts it on this stdin with the credential, #977): the
    # environment control sends it in every request. None for a Worker that no vm-init started.
    control_token: str | None = field(default=None, repr=False)
    # The outer wall's proxy of this VM's slot (vm-init puts it on this stdin from the host's start,
    # #994): every client of this Worker that dials the internet goes through it. None: no outer
    # wall (hosted, or a machine without the proxy wall), the clients dial as before.
    outer_proxy: OuterProxy | None = None


def _invalid(detail: str) -> WorkerSetupError:
    # The detail names the field, never a value: the document holds the credential.
    return WorkerSetupError(WorkerFailure.INPUT_INVALID, detail)


def _app_url(raw: object) -> str:
    if not isinstance(raw, str) or not raw:
        raise _invalid("appUrl must be a URL")
    try:
        parts = urlsplit(raw)
        _ = parts.port
    except ValueError:
        raise _invalid("appUrl is not a valid URL") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise _invalid("appUrl must be an http or https URL")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise _invalid("appUrl must not contain credentials, a query or a fragment")
    return raw.rstrip("/")


def parse_request(raw: str) -> WorkerRequest:
    """The start document: `{"appUrl", "jobId", "credential"}` and, from vm-init, `"controlToken"`
    and `"outerProxy"`. Other keys are ignored, so a newer Dispatcher can add one without breaking
    an older Worker."""
    if len(raw.encode("utf-8", errors="replace")) > MAX_START_DOCUMENT_BYTES:
        raise _invalid("the start document is too large")
    try:
        document = json.loads(raw)
    except ValueError:
        raise _invalid("the start document is not JSON") from None
    fields = as_object(document)
    if fields is None:
        raise _invalid("the start document must be an object")
    job_id = fields.get("jobId")
    credential = fields.get("credential")
    if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
        raise _invalid("jobId must be a UUID")
    if not isinstance(credential, str) or not _CREDENTIAL.fullmatch(credential):
        raise _invalid("credential must be a job credential")
    control_token: str | None = None
    if "controlToken" in fields:
        given = fields["controlToken"]
        if not isinstance(given, str) or not _CONTROL_TOKEN.fullmatch(given):
            raise _invalid("controlToken must be a control token")
        control_token = given
    outer_proxy: OuterProxy | None = None
    if "outerProxy" in fields:
        # A proxy that is given and is not one the host could have given is an input error: the
        # Worker never dials directly because it could not read where its way out is.
        try:
            outer_proxy = OuterProxy.from_json(fields["outerProxy"])
        except OuterProxyError as error:
            raise _invalid(f"outerProxy: {error}") from None
    return WorkerRequest(
        app_url=_app_url(fields.get("appUrl")),
        job_id=job_id,
        credential=credential,
        control_token=control_token,
        outer_proxy=outer_proxy,
    )


def parse_local_credential(raw: str) -> LocalCredential | None:
    """The credential of the dispatcher's own device in the start document (`localCredential`,
    #980): a Claude Code subscription token that exists only on that device, as `{"name", "value"}`.
    One shape for the Worker of a process and for Control in a VM (`local_credential.py`). It comes
    from the dispatcher, never from the app. An unknown name, an odd value or an extra field is an
    input error that names the field and never the value."""
    fields = as_object(json.loads(raw))
    given = fields.get("localCredential") if fields is not None else None
    if given is None:
        return None
    record = as_object(given)
    if record is None or set(record) != {"name", "value"}:
        raise _invalid("localCredential must be an object with a name and a value")
    name, value = record["name"], record["value"]
    if not isinstance(name, str) or name not in LOCAL_CREDENTIAL_NAMES:
        raise _invalid("localCredential names a variable that is not a credential of a device")
    if not isinstance(value, str) or not LOCAL_CREDENTIAL_VALUE.fullmatch(value):
        raise _invalid("localCredential holds a value that is not one token")
    return LocalCredential(name, value)


# #980: a job the subscription of the device refused ends with the code the app stores and, for the
# dispatcher of that device, an exit code of its own: the exit code is what reaches it through a
# process and through a VM alike (vm-init passes any status on). Under 125 (Docker's own statuses).
_VERDICT_EXITS: Final = {
    ErrorCode.SUBSCRIPTION_AUTH.value: WorkerExit.SUBSCRIPTION_AUTH,
    ErrorCode.SUBSCRIPTION_LIMIT.value: WorkerExit.SUBSCRIPTION_LIMIT,
    ErrorCode.SUBSCRIPTION_MODEL_REFUSED.value: WorkerExit.SUBSCRIPTION_MODEL_REFUSED,
}


def _exit_for(end: JobEnd, error_code: str | None = None) -> WorkerExit:
    if end in (JobEnd.OK, JobEnd.GIVEN_BACK, JobEnd.SUPERSEDED, JobEnd.CANCELLED):
        return WorkerExit.OK
    if end in (JobEnd.FAILED, JobEnd.NOT_DELIVERED) and error_code in _VERDICT_EXITS:
        return _VERDICT_EXITS[error_code]
    return WorkerExit.FAILED


async def _fetch(api: WorkerApi, job_id: str, clock: Clock, log: SafeLog) -> WorkerJob:
    """Fetch the job: a bounded number of tries, each pause at least the app's `Retry-After`."""
    pause = FETCH_FIRST_PAUSE_SECONDS
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            job = await api.fetch(job_id)
        except WorkerSetupError:
            raise
        except JobGivenBack:
            raise WorkerSetupError(
                WorkerFailure.JOB_GIVEN_BACK, "the app gave the job back before the Worker had it"
            ) from None
        except CredentialInvalid:
            raise WorkerSetupError(
                WorkerFailure.CREDENTIAL_INVALID, "the app does not accept the job credential"
            ) from None
        except ApiUnavailable as error:
            if attempt == FETCH_ATTEMPTS:
                raise WorkerSetupError(
                    WorkerFailure.APP_UNREACHABLE,
                    f"the job could not be fetched after {FETCH_ATTEMPTS} tries ({error})",
                ) from None
            wait = min(max(pause, error.retry_after or 0.0), FETCH_MAX_PAUSE_SECONDS)
            log.warning("%s; fetching the job again in %gs", error, wait)
            await clock.sleep(wait)
            pause = min(pause * 2, FETCH_MAX_PAUSE_SECONDS)
            continue
        except JobEnded:
            raise WorkerSetupError(WorkerFailure.JOB_ENDED, "the app ended the job") from None
        except ApiRejected as error:
            raise WorkerSetupError(
                WorkerFailure.FETCH_REFUSED, f"the app refused the request (HTTP {error.status})"
            ) from None
        except ApiError as error:  # LeaseLost: not held, or not found
            raise WorkerSetupError(
                WorkerFailure.JOB_ENDED, f"the app does not hold the job for this Worker ({error})"
            ) from None
        return job
    raise AssertionError("unreachable: the last try returns or raises")  # pragma: no cover


async def run_worker(
    request: WorkerRequest,
    settings: WorkerSettings,
    environment: Mapping[str, str],
    *,
    api: WorkerApi | None = None,
    launcher: ProcessLauncher | None = None,
    clock: Clock | None = None,
    logger: logging.Logger | None = None,
    sweeper: Callable[[int, int], bool] = sweep_user,
    install_signals: bool = False,
    guard: Callable[[], Awaitable[str]] | None = None,
    extra_secrets: Sequence[str] = (),
) -> WorkerExit:
    """Fetch the job, run it, deliver the result. `install_signals`: SIGTERM and SIGINT end the job
    and give it back (the entry point sets it; a test that runs this in-process does not).

    `guard` and `extra_secrets` are for a Worker a customer's own dispatcher starts (#974): a guard
    that ends the job with a text when the machine's disk budget is used up, and the credentials of
    that device (the environment holds them for the job process; the masker must know them too)."""
    logger = logger or logging.getLogger(LOGGER_NAME)
    clock = clock or RealClock()
    masker = SecretMasker(
        [
            request.credential,
            *([request.control_token] if request.control_token else []),
            *extra_secrets,
        ]
    )
    log = SafeLog(logger, masker)
    api = api or HttpWorkerApi(
        request.app_url,
        request.credential,
        request_timeout=settings.request_timeout,
        proxy=request.outer_proxy,
    )
    host = JobHost(
        settings,
        api,
        launcher or SubprocessLauncher(settings.terminate_grace),
        masker=masker,
        clock=clock,
        logger=logger,
        environment=environment,
        sweeper=sweeper,
        refuse_unadvertised_engine=True,
        guard=guard,
        control_token=request.control_token,
        outer_proxy=request.outer_proxy,
    )
    stopping = asyncio.Event()

    def on_signal() -> None:
        stopping.set()
        host.request_hard_stop()

    running = asyncio.get_running_loop()
    signals = (signal.SIGTERM, signal.SIGINT) if install_signals else ()
    for number in signals:
        running.add_signal_handler(number, on_signal)
    try:
        return await _run(request, api, host, clock, log, stopping)
    finally:
        for number in signals:
            running.remove_signal_handler(number)


async def _run(
    request: WorkerRequest,
    api: WorkerApi,
    host: JobHost,
    clock: Clock,
    log: SafeLog,
    stopping: asyncio.Event,
) -> WorkerExit:
    fetching = asyncio.ensure_future(_prepare(request, api, clock, log))
    stop = asyncio.ensure_future(stopping.wait())
    try:
        await asyncio.wait([fetching, stop], return_when=asyncio.FIRST_COMPLETED)
        if not fetching.done():
            fetching.cancel()
            log.error("worker stopped: %s; the lease will run out", WorkerFailure.STOPPED.value)
            return WorkerExit.FAILED
        try:
            claimed = fetching.result()
        except WorkerSetupError as error:
            log.error("worker cannot run the job: %s", error)
            return WorkerExit.SETUP_ERROR
    finally:
        stop.cancel()
        await asyncio.gather(stop, fetching, return_exceptions=True)
    end = await host.run_job(claimed)
    log.info("worker done: %s", end.value)
    return _exit_for(end, host.last_error_code)


async def _prepare(
    request: WorkerRequest, api: WorkerApi, clock: Clock, log: SafeLog
) -> ClaimedJob:
    await api.check_app(request.job_id)
    job = await _fetch(api, request.job_id, clock, log)
    return ClaimedJob(
        id=job.id,
        # What the host calls the lease token is the proof of the claim: here, the credential. It
        # goes to the masker and back to the API, never to the job process.
        lease_token=request.credential,
        heartbeat_interval=job.heartbeat_interval,
        input=job.input,
    )
