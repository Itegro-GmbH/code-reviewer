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
import json
import re
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from code_reviewer_runner import __version__
from code_reviewer_runner.job_loop.api import CompleteReply, HeartbeatReply, parse_heartbeat
from code_reviewer_runner.job_loop.http import (
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
from code_reviewer_runner.job_loop.worker_errors import WorkerFailure, WorkerSetupError
from code_reviewer_runner.llm_providers import registered_provider_ids

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
    # #745, step 7: the Worker reads `implementer.environment.network` and starts the network door for it.
    "implementer_network",
)
# The feature of `GET /api/runners/v1/version` that says the Worker API exists.
FEATURE_WORKER_API = "worker_api"


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
        try:
            reply = await asyncio.to_thread(
                self._send, "GET", f"/api/runners/v1/version?jobId={self._safe_id(job_id)}", None
            )
        except ApiUnavailable:
            return
        body = as_object(parse_json(reply)) if reply.status == 200 else None
        features = body.get("features") if body and body.get("version") == 1 else None
        if isinstance(features, list) and FEATURE_WORKER_API not in features:
            raise WorkerSetupError(
                WorkerFailure.APP_UNSUPPORTED, "the app does not list the Worker API (worker_api)"
            )

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

    # -- internals ----------------------------------------------------------------------------

    @staticmethod
    def _safe_id(job_id: str) -> str:
        if not _JOB_ID.fullmatch(job_id):
            raise ApiRejected("the job id is not a UUID", 400, None)
        return job_id

    def _send(self, method: str, path: str, body: Mapping[str, Any] | None) -> Reply:
        data = json.dumps(body, separators=(",", ":")).encode("ascii") if body is not None else None
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self._credential}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": f"code-reviewer-worker/{__version__}",
            },
        )
        return send(self._opener, request, self._timeout)

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
