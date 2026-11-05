# SPDX-License-Identifier: LicenseRef-Proprietary

"""The calls of a runner about the job it holds (#854, R1b): heartbeat, result and step records.

The job host (`job_loop/host.py`) runs a job through a small interface that the hosted Worker
implements with its per-job credential (`HttpWorkerApi`, the Worker API). A customer's runner holds
a different proof: its own credential in `Authorization` and the lease token of the claim in the
body, on the routes of the runner API (`POST /api/runners/v1/jobs/{id}/heartbeat`, `/complete`,
`/steps`), which accept the runner credential for a job of its own workspace. This class is the
Worker client with those routes; everything else it inherits (the HTTP, the failure mapping, the
threads of the steps, the snapshot and the stored session).

**The snapshot and the stored session** (#879). A customer's runner has two calls of its own,
`PUT /api/runners/v1/jobs/{id}/session` and `GET /api/runners/v1/jobs/{id}/resume-session?part=n`:
the query, the parts and the answers are those of the Worker API (the inherited code), the runner
credential is in `Authorization` and the lease token of the claim in `X-Lease-Token`, because the
body is raw bytes. The app lists the feature `runner_session_snapshot` when it has them
(`implementer_snapshot` says only that the Worker routes exist, which refuse a runner). It is read
from the version call at every job (`check_app`, with the runner's credential) and
`supports_snapshot` is true only then: otherwise the host opens no snapshot channel, the turn takes
no export, and a follow-up turn continues from the summary of the earlier ones.

The host passes the lease token to `heartbeat` and `complete` and not to `steps`, so the client
keeps the token of the job it was given at the claim.
"""

import asyncio
import json
from collections.abc import Mapping
from typing import Any

from code_reviewer_runner.job_loop.api import CompleteReply, HeartbeatReply, parse_heartbeat
from code_reviewer_runner.job_loop.http import ApiRejected, ApiUnavailable, parse_json
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.job_loop.resume_download import ResumeFile, ResumeUnavailable
from code_reviewer_runner.job_loop.snapshot_sender import SnapshotPart
from code_reviewer_runner.job_loop.worker_api import (
    STEPS_REQUEST_TIMEOUT_SECONDS,
    HttpWorkerApi,
)
from code_reviewer_runner.resume_wire import ResumeReason
from code_reviewer_runner.snapshot_wire import FEATURE_RUNNER_SESSION_SNAPSHOT
from code_reviewer_runner.step_wire import FEATURE_IMPLEMENTER_STEPS

RUNNER_JOBS = "/api/runners/v1/jobs"
LEASE_TOKEN_HEADER = "X-Lease-Token"
# What a client that has not asked the version call (yet) may assume: the steps call, which the
# app has had since the runner API began.
_DEFAULT_FEATURES = frozenset({FEATURE_IMPLEMENTER_STEPS})


class RunnerJobApi(HttpWorkerApi):
    """The job calls of a customer's runner, with its credential and the lease token."""

    _session_prefix = RUNNER_JOBS

    def __init__(self, base_url: str, credential: str, *, request_timeout: float = 30.0) -> None:
        super().__init__(base_url, credential, request_timeout=request_timeout)
        self._lease_tokens: dict[str, str] = {}
        self._features = _DEFAULT_FEATURES
        # Whether the last `check_app` got a list of features from the app.
        self.features_listed = False

    def use_credential(self, credential: str) -> None:
        """A renewed credential, for the calls after it (a job in flight keeps working)."""
        self._credential = credential

    def hold(self, job_id: str, lease_token: str) -> None:
        self._lease_tokens[job_id] = lease_token

    def forget(self, job_id: str) -> None:
        self._lease_tokens.pop(job_id, None)

    def _token(self, job_id: str) -> str:
        token = self._lease_tokens.get(job_id)
        if token is None:
            raise ApiRejected("the runner does not hold this job", 409, None)
        return token

    def _session_headers(self, job_id: str) -> Mapping[str, str]:
        return {LEASE_TOKEN_HEADER: self._token(job_id)}

    # -- the calls ---------------------------------------------------------------------------

    async def check_app(self, job_id: str) -> None:
        """Read the features the app lists (`GET /api/runners/v1/version`, the runner's credential)
        for the job about to run, and nothing else: a runner's job is not a Worker API job, so
        `worker_api` is not asked for. What an earlier job found is forgotten first, so an app that
        does not answer now is treated as one that lists nothing. The call is bounded as a whole
        (`VERSION_CALL_TOTAL_SECONDS`): an app that is too slow is one that gave no list."""
        self._features = _DEFAULT_FEATURES
        self.features_listed = False
        self.features_listed = await self._read_features(job_id) is not None

    async def heartbeat(self, job_id: str, lease_token: str) -> HeartbeatReply:
        path = f"{RUNNER_JOBS}/{self._safe_id(job_id)}/heartbeat"
        reply = await asyncio.to_thread(self._send, "POST", path, {"leaseToken": lease_token})
        if reply.status != 200:
            raise self._failure(reply)
        return parse_heartbeat(reply, job_id)

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> CompleteReply:
        path = f"{RUNNER_JOBS}/{self._safe_id(job_id)}/complete"
        reply = await asyncio.to_thread(
            self._send, "POST", path, {"leaseToken": lease_token, "result": dict(result)}
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

    async def steps(self, job_id: str, body: bytes) -> None:
        """One batch of step records: the sender's body (`{"records": [...]}`) with the lease token
        added, as the runner route wants it. On a thread of its own, one at a time."""
        path = f"{RUNNER_JOBS}/{self._safe_id(job_id)}/steps"
        try:
            document = json.loads(body)
        except ValueError:
            raise ApiRejected("the steps body is not JSON", 400, None) from None
        if not isinstance(document, dict):
            raise ApiRejected("the steps body is not an object", 400, None)
        document["leaseToken"] = self._token(job_id)  # pyright: ignore[reportUnknownVariableType]
        payload = json.dumps(document, separators=(",", ":")).encode("ascii")
        reply = await self._call_alone(
            "_steps_thread",
            "steps-call",
            lambda: self._send_bytes("POST", path, payload, STEPS_REQUEST_TIMEOUT_SECONDS),
        )
        if reply.status != 200:
            raise self._failure(reply)

    @property
    def supports_snapshot(self) -> bool:
        """True when the app listed `runner_session_snapshot` (#879): it has the runner's session
        routes. `implementer_snapshot` is the Worker routes' and does not count."""
        return FEATURE_RUNNER_SESSION_SNAPSHOT in self._features

    async def snapshot(self, job_id: str, part: SnapshotPart) -> None:
        if not self.supports_snapshot:
            raise ApiUnavailable("the app does not list the session routes of a runner")
        await super().snapshot(job_id, part)

    async def resume_session(self, job_id: str) -> ResumeFile:
        if not self.supports_snapshot:
            raise ResumeUnavailable(ResumeReason.DOWNLOAD_FAILED)
        try:
            self._session_headers(job_id)
        except ApiRejected:  # the job is not held: nothing is sent
            raise ResumeUnavailable(ResumeReason.DOWNLOAD_FAILED) from None
        return await super().resume_session(job_id)
