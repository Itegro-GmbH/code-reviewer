# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Worker's side of the Worker API (`contracts/worker-api.v1.json`, #323).

Three calls with the per-job credential: the job details (`GET /api/workers/v1/jobs/{id}`), the
heartbeat and the result. The credential is valid for one job only; the Worker holds nothing else
(`Authorization: Bearer <credential>`), and no error carries a value of a request or an answer.

What a caller has to tell apart is the same small set as in the runner API (`api.py`):

- `ApiUnavailable`: the app cannot answer now (no connection, 5xx, 429, an answer that is not the
  contract). The caller waits and tries again.
- `LeaseLost`: the app does not hold the job for this Worker any more (409, 404, and a credential it
  does not accept, which no retry can fix). `CredentialInvalid` and `JobEnded` say which, for the
  log. Nothing more may be sent for the job.
- `ApiRejected`: the app refused this request for good (another 4xx).
- `JobGivenBack`: the app could not mint the git token for the fetch and gave the job back
  (`503 RUNNER_GIT_ACCESS_UNAVAILABLE`): the credential is void and the Worker exits.
"""

import asyncio
import contextlib
import hashlib
import json
import re
import threading
import time
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar, cast

from code_reviewer_runner import __version__
from code_reviewer_runner.job_loop.api import CompleteReply, HeartbeatReply, parse_heartbeat
from code_reviewer_runner.job_loop.http import (
    MAX_RESPONSE_BYTES,
    ApiError,
    ApiRejected,
    ApiUnavailable,
    LeaseLost,
    Reply,
    build_opener,
    error_code,
    parse_json,
    retry_after,
    send,
)
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.job_loop.resume_download import (
    RESUME_REQUEST_TIMEOUT_SECONDS,
    RESUME_TOTAL_SECONDS,
    ResumeFile,
    ResumeUnavailable,
)
from code_reviewer_runner.job_loop.snapshot_sender import SnapshotPart
from code_reviewer_runner.job_loop.worker_errors import WorkerFailure, WorkerSetupError
from code_reviewer_runner.llm_providers import registered_provider_ids
from code_reviewer_runner.resume_wire import (
    HEADER_BYTES,
    HEADER_PARTS,
    HEADER_RAW_BYTES,
    HEADER_SHA256,
    HEADER_VERSION,
    ResumeReason,
)
from code_reviewer_runner.snapshot_wire import (
    CHUNK_BYTES,
    FEATURE_IMPLEMENTER_SNAPSHOT,
    MAX_SNAPSHOT_BYTES,
    SnapshotHeader,
    parse_header,
    parts_of,
)
from code_reviewer_runner.step_wire import FEATURE_IMPLEMENTER_STEPS

_T = TypeVar("_T")
_JOB_ID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
# A heartbeat interval above this would let the 2 minute lease run out between two beats.
MAX_HEARTBEAT_INTERVAL_SECONDS = 60
# What this Worker understands beyond the plain job (`features` of the details request): an app
# sends an optional job field only to a Worker that names it.
WORKER_FEATURES: tuple[str, ...] = (
    "dynamic_capabilities",
    "supersede",
    "dynamic_cost_policy",
    "cost_limit",
    "operator_cost_limit",
    # #818: the Worker reads `implementer.environment` and runs its setup script before the model.
    "implementer_environment",
    # #745, step 7: the Worker reads `implementer.environment.network` and starts the door for it.
    "implementer_network",
    # #843: the Worker reads `implementer.profile` (the version's instructions and push right).
    "implementer_profile",
    # #843: the Worker reads `implementer.resultSchema`, gives the agent the finish tool made from
    # it and reports the result the agent handed in.
    "implementer_result",
    # #838: the Worker reads `implementer.resume` and starts a follow-up turn from the branches of
    # the session.
    "implementer_resume",
    # #909: the Worker reads `implementer.startBranch` and starts the work from that branch.
    "implementer_start_branch",
    # #920: the Worker reads `implementer.canAsk` and offers the agent the question next to the
    # result.
    "implementer_ask",
)
# The feature of `GET /api/runners/v1/version` that says the Worker API exists.
FEATURE_WORKER_API = "worker_api"
# One steps request (#745): short, because the live view must never hold anything up. It bounds each
# socket operation, not the call (nor the name lookup), so the sender bounds a call by its own clock
# as well (`step_sender.REQUEST_SECONDS`).
STEPS_REQUEST_TIMEOUT_SECONDS = 5.0
# One part of the session snapshot (#839): up to 3 MiB, so the socket may be slower than for a batch
# of steps; the sender bounds the call by its own clock as well (`snapshot_sender.REQUEST_SECONDS`).
SNAPSHOT_REQUEST_TIMEOUT_SECONDS = 20.0
# The whole version call, which runs before the host takes the job: the answer is a few hundred
# bytes, so a server that keeps it going longer is treated as one that gave no list. It counts
# against the lease (see the budget in `resume_download.py`).
VERSION_CALL_TOTAL_SECONDS = 10.0


def snapshot_query(part: SnapshotPart) -> str:
    """The query of one part of the snapshot (`SessionPartQuery` in the Worker contract)."""
    return (
        f"part={part.index}&parts={part.count}&bytes={part.size}&rawBytes={part.raw_bytes}"
        f"&sha256={part.sha256}&opencodeVersion={part.version}"
    )


# How long a call waits for the thread of the one before it, which has answered, to end.
ENDING_THREAD_SECONDS = 0.25
ENDING_THREAD_POLL_SECONDS = 0.01


class CredentialInvalid(LeaseLost):
    """401: the credential is not the job's (unknown, from an earlier claim, expired)."""


class JobEnded(LeaseLost):
    """409 RUNNER_JOB_ENDED: the app ended the job (for example, a permanent access failure)."""


class JobGivenBack(ApiUnavailable):
    """503 RUNNER_GIT_ACCESS_UNAVAILABLE at fetch: the app gave the job back; do not ask again."""


@dataclass(frozen=True)
class WorkerJob:
    id: str
    heartbeat_interval: float
    input: dict[str, Any]


class WorkerApi(Protocol):
    async def check_app(self, job_id: str) -> None: ...

    async def fetch(self, job_id: str) -> WorkerJob: ...

    async def heartbeat(self, job_id: str, lease_token: str) -> HeartbeatReply: ...

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> CompleteReply: ...


class HttpWorkerApi:
    """The Worker API over HTTP. Blocking calls run in a thread, so the event loop stays free."""

    def __init__(self, base_url: str, credential: str, *, request_timeout: float = 30.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._credential = credential
        self._timeout = request_timeout
        self._opener = build_opener()
        # The features the app listed in the version answer (empty: none or not asked).
        self._features: frozenset[str] = frozenset()
        # The thread of the steps call in flight, if any, and of the snapshot call (`_call_alone`).
        self._steps_thread: threading.Thread | None = None
        self._snapshot_thread: threading.Thread | None = None

    # -- the checks and the three calls -------------------------------------------------------

    async def check_app(self, job_id: str) -> None:
        """Refuse an app that says it has no Worker API (`GET /api/runners/v1/version?jobId=...`).

        The Worker holds the job credential and not the dispatcher credential: the app accepts it
        on this call only together with the id of its job (#322), which is sent as `jobId`. An app
        from before that may answer 401; only a contract answer that leaves `worker_api` out is a
        refusal here.
        Any other answer (an app from before the call, a 401, no answer) is left to the details
        call, which is a Worker API call and tells the two apart (`fetch`).
        """
        features = await self._read_features(job_id)
        if features is not None and FEATURE_WORKER_API not in features:
            raise WorkerSetupError(
                WorkerFailure.APP_UNSUPPORTED, "the app does not list the Worker API (worker_api)"
            )

    async def _read_features(self, job_id: str) -> list[str] | None:
        """Ask the version call which features the app lists and keep them in `_features`. None
        when the app gave no list (no answer within `VERSION_CALL_TOTAL_SECONDS`, an app from
        before, a 401): `_features` is then what it was."""
        path = f"/api/runners/v1/version?jobId={self._safe_id(job_id)}"
        deadline = time.monotonic() + VERSION_CALL_TOTAL_SECONDS
        try:
            # The deadline ends a read that trickles; `wait_for` ends a connect or a thread that
            # does not (a daemon thread, left to end by itself).
            reply = await asyncio.wait_for(
                self._run_on_thread(
                    "version-call",
                    lambda: self._send_bytes(
                        "GET",
                        path,
                        None,
                        min(self._timeout, VERSION_CALL_TOTAL_SECONDS),
                        max_bytes=MAX_RESPONSE_BYTES,
                        deadline=deadline,
                    ),
                ),
                VERSION_CALL_TOTAL_SECONDS,
            )
        except (ApiUnavailable, TimeoutError):
            return None
        body = as_object(parse_json(reply)) if reply.status == 200 else None
        features = body.get("features") if body and body.get("version") == 1 else None
        if not isinstance(features, list):
            return None
        listed = [name for name in cast("list[object]", features) if isinstance(name, str)]
        self._features = frozenset(listed)
        return listed

    async def fetch(self, job_id: str) -> WorkerJob:
        path = f"/api/workers/v1/jobs/{self._safe_id(job_id)}"
        features = ",".join(WORKER_FEATURES)
        # #424: and the providers of the registry, a comma separated list like the features. An app
        # from before ignores the parameter; a newer one reads its absence as `openrouter`.
        providers = ",".join(registered_provider_ids())
        reply = await asyncio.to_thread(
            self._send, "GET", f"{path}?features={features}&llmProviders={providers}", None
        )
        if reply.status in (404, 405, 501) and error_code(reply) is None:
            # An answer of a Worker API route always has the contract's error body.
            raise WorkerSetupError(
                WorkerFailure.APP_UNSUPPORTED, f"the app has no Worker API (HTTP {reply.status})"
            )
        if reply.status != 200:
            raise self._failure(reply)
        return self._parse_job(reply, job_id)

    async def heartbeat(self, job_id: str, lease_token: str) -> HeartbeatReply:
        # `lease_token` is the host's name for the proof of the claim; here it is the credential
        # this client already holds.
        reply = await asyncio.to_thread(
            self._send, "POST", f"/api/workers/v1/jobs/{self._safe_id(job_id)}/heartbeat", {}
        )
        if reply.status != 200:
            raise self._failure(reply)
        return parse_heartbeat(reply, job_id)

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> CompleteReply:
        reply = await asyncio.to_thread(
            self._send,
            "POST",
            f"/api/workers/v1/jobs/{self._safe_id(job_id)}/result",
            {"result": dict(result)},
        )
        if reply.status != 200:
            raise self._failure(reply)
        body = as_object(parse_json(reply))
        job = as_object(body.get("job")) if body else None
        status = job.get("status") if job else None
        return CompleteReply(
            status=status if isinstance(status, str) else None,
            already_completed=bool(body and body.get("alreadyCompleted") is True),
        )

    @property
    def supports_steps(self) -> bool:
        """True when the app listed `implementer_steps` (#745): it has the steps call. An app that
        did not answer the version call, or does not list it, gets none."""
        return FEATURE_IMPLEMENTER_STEPS in self._features

    async def steps(self, job_id: str, body: bytes) -> None:
        """Post one batch of step records (`body` is the request body, see `step_wire.py`).

        The call runs on a daemon thread of its own, one at a time: a hung app costs this thread
        and nothing else (the shared executor of the heartbeat and the result is never used), the
        thread cannot hold the process back at its end, and a second call does not pile up behind
        a first that is still waiting: it is `ApiUnavailable` until that one is over.
        """
        path = f"/api/workers/v1/jobs/{self._safe_id(job_id)}/steps"
        reply = await self._call_alone(
            "_steps_thread",
            "steps-call",
            lambda: self._send_bytes("POST", path, body, STEPS_REQUEST_TIMEOUT_SECONDS),
        )
        if reply.status != 200:
            raise self._failure(reply)

    @property
    def supports_snapshot(self) -> bool:
        """True when the app listed `implementer_snapshot` (#839): it has the snapshot call. An app
        that did not answer the version call, or does not list it, gets none."""
        return FEATURE_IMPLEMENTER_SNAPSHOT in self._features

    async def snapshot(self, job_id: str, part: SnapshotPart) -> None:
        """Put one part of the session snapshot (`PUT /api/workers/v1/jobs/{id}/session`). The
        description of the whole file travels with every part, in the query, so a part is judged
        on its own and a part sent twice is the same call; the body is the bytes of the part.

        On a thread of its own like `steps`, one at a time."""
        path = f"/api/workers/v1/jobs/{self._safe_id(job_id)}/session?{snapshot_query(part)}"
        reply = await self._call_alone(
            "_snapshot_thread",
            "snapshot-call",
            lambda: self._send_bytes(
                "PUT",
                path,
                part.data,
                SNAPSHOT_REQUEST_TIMEOUT_SECONDS,
                content_type="application/octet-stream",
            ),
        )
        if reply.status != 200:
            raise self._failure(reply)

    async def resume_session(self, job_id: str) -> ResumeFile:
        """Get the stored session of the follow-up turn this job is (`GET /api/workers/v1/jobs/{id}/
        resume-session?part=n`, #840), in the parts the app serves it in (a response is held to 4.5
        MB like a request, so the file comes in parts of at most 3 MiB). Checks every part against
        the description of the whole and the whole against its size and digest. Raises
        `ResumeUnavailable`; nothing it raises carries a value of the answer.

        The whole is bounded by `RESUME_TOTAL_SECONDS`: the thread reads against that deadline, and
        the wait ends at it even when the thread does not (a daemon thread, left to end by itself):
        a socket timeout bounds one wait, and a server that sends a byte now and then never trips
        it."""
        path = f"/api/workers/v1/jobs/{self._safe_id(job_id)}/resume-session"
        deadline = time.monotonic() + RESUME_TOTAL_SECONDS
        try:
            return await asyncio.wait_for(
                self._run_on_thread(
                    "resume-download", lambda: self._download_resume(path, deadline)
                ),
                RESUME_TOTAL_SECONDS,
            )
        except TimeoutError:
            raise ResumeUnavailable(ResumeReason.DOWNLOAD_FAILED) from None

    def _download_resume(self, path: str, deadline: float) -> ResumeFile:
        failed = ResumeUnavailable(ResumeReason.DOWNLOAD_FAILED)
        header: SnapshotHeader | None = None
        chunks: list[bytes] = []
        count = 1
        index = 0
        while index < count:
            left = deadline - time.monotonic()
            if left < 1.0:
                raise failed
            try:
                reply = self._send_bytes(
                    "GET",
                    f"{path}?part={index}",
                    None,
                    min(RESUME_REQUEST_TIMEOUT_SECONDS, left),
                    max_bytes=CHUNK_BYTES + 1,
                    deadline=deadline,
                )
            except ApiError:
                raise failed from None
            if reply.status == 204:  # the session has no stored conversation
                raise ResumeUnavailable(ResumeReason.NO_SNAPSHOT)
            if reply.status != 200:
                raise failed
            described = _resume_header(reply.headers)
            if described is None or (header is not None and described != (header, count)):
                raise failed
            header, count = described
            wanted = min(CHUNK_BYTES, header.size - index * CHUNK_BYTES)
            if count != parts_of(header.size) or len(reply.body) != wanted:
                raise failed
            chunks.append(reply.body)
            index += 1
        data = b"".join(chunks)
        if header is None or len(data) != header.size:
            raise failed
        if hashlib.sha256(data).hexdigest() != header.sha256:
            raise failed
        return ResumeFile(header, data)

    async def _call_alone(self, slot: str, name: str, call: Callable[[], Reply]) -> Reply:
        """Run `call` on a daemon thread kept in `slot`, and refuse (`ApiUnavailable`) while the
        call before it on the same slot has not ended."""
        running: threading.Thread | None = getattr(self, slot)
        if running is not None and running.is_alive():
            # The thread of the call before this one hands its answer to the loop and ends a moment
            # later: a caller that goes on at once (the next part of a snapshot) finds it alive.
            # A call that is really still running is not waited for beyond this moment. The wait
            # gives the loop back (a `join` here would stop the heartbeat for the moment). The slot
            # is read again after every pause: a second caller that waited for the same thread may
            # have started its own by then, and that one is the call before this one now.
            loop = asyncio.get_running_loop()
            deadline = loop.time() + ENDING_THREAD_SECONDS
            while running is not None and running.is_alive() and loop.time() < deadline:
                await asyncio.sleep(ENDING_THREAD_POLL_SECONDS)
                running = getattr(self, slot)
        if running is not None and running.is_alive():
            raise ApiUnavailable(f"an earlier {name} has not ended")
        return await self._run_on_thread(name, call, slot=slot)

    async def _run_on_thread(
        self, name: str, call: Callable[[], _T], *, slot: str | None = None
    ) -> _T:
        """Run `call` on a daemon thread and wait for its answer. A wait that is cancelled or ends
        by a timeout leaves the thread to end by itself, and nothing waits for it (nor does the
        interpreter, which is why this is not `asyncio.to_thread`)."""
        loop = asyncio.get_running_loop()
        done: asyncio.Future[_T] = loop.create_future()

        def settle(setter: Any, value: Any) -> None:
            if not done.done():
                setter(value)

        def run() -> None:
            try:
                reply = call()
            except BaseException as error:
                outcome = (done.set_exception, error)
            else:
                outcome = (done.set_result, reply)
            # A closed loop (RuntimeError) means nobody waits for the answer.
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(settle, *outcome)

        thread = threading.Thread(target=run, name=name, daemon=True)
        if slot is not None:
            setattr(self, slot, thread)
        thread.start()
        return await done

    # -- internals ----------------------------------------------------------------------------

    @staticmethod
    def _safe_id(job_id: str) -> str:
        if not _JOB_ID.fullmatch(job_id):
            raise ApiRejected("the job id is not a UUID", 400, None)
        return job_id

    def _send(self, method: str, path: str, body: Mapping[str, Any] | None) -> Reply:
        data = json.dumps(body, separators=(",", ":")).encode("ascii") if body is not None else None
        return self._send_bytes(method, path, data, self._timeout)

    def _send_bytes(
        self,
        method: str,
        path: str,
        data: bytes | None,
        timeout: float,
        *,
        content_type: str = "application/json",
        max_bytes: int | None = None,
        deadline: float | None = None,
    ) -> Reply:
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self._credential}",
                "Content-Type": content_type,
                "Accept": "application/json",
                "User-Agent": f"code-reviewer-worker/{__version__}",
            },
        )
        if max_bytes is None:
            return send(self._opener, request, timeout)
        return send(self._opener, request, timeout, max_bytes, deadline)

    @staticmethod
    def _failure(reply: Reply) -> ApiError:
        status = reply.status
        code = error_code(reply)
        if status == 401:
            return CredentialInvalid("the app does not accept the job credential (HTTP 401)", 401)
        if status == 409 and code == "RUNNER_JOB_ENDED":
            return JobEnded("the app ended the job (HTTP 409)", 409)
        if status in (409, 404):
            return LeaseLost(f"the app says the job is not held (HTTP {status})", status)
        if status == 503 and code == "RUNNER_GIT_ACCESS_UNAVAILABLE":
            return JobGivenBack(
                "the app could not prepare the job and gave it back (HTTP 503)",
                503,
                retry_after(reply.headers),
            )
        if status >= 500 or status in (408, 425, 429):
            return ApiUnavailable(
                f"the app cannot serve the request (HTTP {status})",
                status,
                retry_after(reply.headers),
            )
        if 300 <= status < 400:
            return ApiUnavailable(f"the app answered with a redirect (HTTP {status})", status)
        return ApiRejected(f"the app refused the request (HTTP {status})", status, code)

    @staticmethod
    def _parse_job(reply: Reply, job_id: str) -> WorkerJob:
        body = as_object(parse_json(reply))
        job = as_object(body.get("job")) if body and body.get("version") == 1 else None
        interval = job.get("heartbeatIntervalSeconds") if job else None
        job_input = as_object(job.get("input")) if job else None
        if (
            job is None
            or job.get("id") != job_id
            or not isinstance(interval, int)
            or isinstance(interval, bool)
            or interval < 1
            or job_input is None
        ):
            raise ApiUnavailable("the job details do not match the contract", 200)
        return WorkerJob(
            id=job_id,
            heartbeat_interval=float(min(interval, MAX_HEARTBEAT_INTERVAL_SECONDS)),
            input=job_input,
        )


def _resume_header(headers: Mapping[str, str]) -> tuple[SnapshotHeader, int] | None:
    """The description of the whole file in the headers of one part, and how many parts there are;
    None when a header is missing or is not what the contract says."""
    lower = {name.lower(): value for name, value in headers.items()}
    try:
        parts = lower[HEADER_PARTS]
        line = (
            f"S {lower[HEADER_BYTES]} {lower[HEADER_RAW_BYTES]} {lower[HEADER_SHA256]} "
            f"{lower[HEADER_VERSION]}\n"
        )
    except KeyError:
        return None
    header = parse_header(line.encode("ascii", "replace"))
    if header is None or not parts.isascii() or not parts.isdigit():
        return None
    # Between one part and the most a snapshot of the cap takes.
    if not 1 <= int(parts) <= parts_of(MAX_SNAPSHOT_BYTES):
        return None
    return header, int(parts)
