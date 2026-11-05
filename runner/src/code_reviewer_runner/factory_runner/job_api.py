# SPDX-License-Identifier: LicenseRef-Proprietary

"""The calls of a runner about the job it holds (#854, R1b): heartbeat, result and step records.

The job host (`job_loop/host.py`) runs a job through a small interface that the hosted Worker
implements with its per-job credential (`HttpWorkerApi`, the Worker API). A customer's runner holds
a different proof: its own credential in `Authorization` and the lease token of the claim in the
body, on the routes of the runner API (`POST /api/runners/v1/jobs/{id}/heartbeat`, `/complete`,
`/steps`), which accept the runner credential for a job of its own workspace. This class is the
Worker client with those routes; everything else it inherits (the HTTP, the failure mapping, the
threads of the steps, the snapshot and the stored session).

**The snapshot and the stored session.** The Worker API routes `PUT .../session` and
`GET .../resume-session` take the per-job credential alone; the app does not let a runner
credential reach them yet (docs/runner.md, "Known limits"). Until it does, `supports_snapshot` is
False: the turn takes no export, and a follow-up turn continues from the summary of the earlier
ones (the fallback of the plan). `snapshot=True` switches the calls on for an app that has them
(the integration test does).

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
from code_reviewer_runner.snapshot_wire import FEATURE_IMPLEMENTER_SNAPSHOT
from code_reviewer_runner.step_wire import FEATURE_IMPLEMENTER_STEPS

RUNNER_JOBS = "/api/runners/v1/jobs"


class RunnerJobApi(HttpWorkerApi):
    """The job calls of a customer's runner, with its credential and the lease token."""

    def __init__(
        self,
        base_url: str,
        credential: str,
        *,
        snapshot: bool = False,
        request_timeout: float = 30.0,
    ) -> None:
        super().__init__(base_url, credential, request_timeout=request_timeout)
        self._lease_tokens: dict[str, str] = {}
        self._features = frozenset(
            {FEATURE_IMPLEMENTER_STEPS, *([FEATURE_IMPLEMENTER_SNAPSHOT] if snapshot else [])}
        )
        self._snapshot = snapshot

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

    # -- the calls ---------------------------------------------------------------------------

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

    async def snapshot(self, job_id: str, part: SnapshotPart) -> None:
        if not self._snapshot:
            raise ApiUnavailable("the app does not take a snapshot from a runner credential")
        await super().snapshot(job_id, part)

    async def resume_session(self, job_id: str) -> ResumeFile:
        if not self._snapshot:
            raise ResumeUnavailable(ResumeReason.DOWNLOAD_FAILED)
        return await super().resume_session(job_id)
