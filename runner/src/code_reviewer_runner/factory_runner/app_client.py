# SPDX-License-Identifier: LicenseRef-Proprietary

"""The local dispatcher's calls to the app (#854, R1b; #974): the registration, the announcement,
the renewal of the credential, the claim, the release of a claim and the state of a job.

The claim is the split one (`worker_credential`): it answers with the job's id and the credential of
its Worker and **nothing secret**: no git token, no key of the workspace, no job input. The Worker
fetches the job with that credential over the Worker API (`/api/workers/v1`); this client never
holds what only the Worker may hold.

The formats are `contracts/runner-registration.v1.json` and `contracts/runner-api.v1.json`; the
runner is the writer of the bodies and a reader that ignores what it does not know. Blocking calls
(the loop runs them on a thread). Like every client of this runner (`job_loop/http.py`) it sends no
proxy and follows no redirect, and no error carries a value of a request or an answer: they hold
the credential.

What a caller tells apart:

- `Revoked`: 401 `RUNNER_UNAUTHORIZED`. The app does not know the credential (revoked, or never
  valid). The runner stops; nothing retries it.
- `UpdateNeeded`: 426. The base is older than the app's minimum. The runner says so and waits.
- `RegistrationRefused`: the token is unknown, used or expired, or the body does not fit.
- `ApiUnavailable`: the app cannot answer now. The caller waits and tries again.
"""

import json
import re
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, cast
from urllib.parse import quote

from code_reviewer_runner import __version__
from code_reviewer_runner.job_loop.http import (
    ApiError,
    ApiRejected,
    ApiUnavailable,
    Reply,
    build_opener,
    error_code,
    parse_json,
    retry_after,
    send,
)
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.llm_providers import registered_provider_ids

REGISTER_PATH = "/api/runners/v1/register"
SELF_PATH = "/api/runners/v1/self"
CREDENTIAL_PATH = "/api/runners/v1/credential"
CLAIM_PATH = "/api/runners/v1/claim"
JOBS_PATH = "/api/runners/v1/jobs"
ENGINE_IMPLEMENTER = "implementer"
# The one claim feature this client names: the split answer (`worker_credential`, #320). What the
# Worker reads of a job (`WORKER_FEATURES`) it says itself when it fetches the job.
FEATURE_WORKER_CREDENTIAL = "worker_credential"
# Why a dispatcher gives a claim back (`KnownReleaseReason` of the runner API contract).
RELEASE_LAUNCH_FAILED = "launch_failed"
RELEASE_WORKER_EXITED = "worker_exited"
_JOB_ID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
# `WorkerCredential` of the runner API contract: `crj_` and 256 bits in base64url.
_WORKER_CREDENTIAL = re.compile(r"crj_[A-Za-z0-9_-]{43}")


class Revoked(ApiError):
    """The app does not accept the credential."""


class UpdateNeeded(ApiError):
    """The base of this runner is older than the minimum the app requires."""

    def __init__(self, min_base_version: str | None) -> None:
        super().__init__("the base of this runner is older than the app requires", 426)
        self.min_base_version = min_base_version


class RegistrationRefused(ApiError):
    """The app refused the registration; `code` is the contract's error code, if there is one."""

    def __init__(self, message: str, status: int, code: str | None) -> None:
        super().__init__(message, status)
        self.code = code


@dataclass(frozen=True)
class Registered:
    runner_id: str
    credential: str
    min_base_version: str | None


@dataclass(frozen=True)
class Announced:
    min_base_version: str | None
    update_needed: bool


@dataclass(frozen=True)
class JobAccess:
    """What a job asks of this device (`access` of the split claim answer): the harness, the auth
    and, for a device-bound access, the model. Never a credential."""

    harness: str
    auth: str
    model: str | None = None


@dataclass(frozen=True)
class ClaimedWorker:
    """What a claim hands the local dispatcher (`SplitClaimResponse`): the job and the credential of
    its Worker. No git token, no key, no job input: the dispatcher cannot hold what it is not
    given."""

    job_id: str
    credential: str = field(repr=False)
    labels: tuple[str, ...] = ()
    access: JobAccess | None = None


@dataclass(frozen=True)
class Announcement:
    """What a runner says about itself (`RunnerAnnouncement` of the registration contract)."""

    labels: Sequence[str]
    base_version: str
    manifest: Mapping[str, object]
    limits: Mapping[str, int]

    def body(self) -> dict[str, object]:
        return {
            "labels": list(self.labels),
            "baseVersion": self.base_version,
            "manifest": dict(self.manifest),
            "limits": dict(self.limits),
        }


class AppClient:
    def __init__(self, base_url: str, *, credential: str | None, timeout: float = 30.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._credential = credential
        self._timeout = timeout
        self._opener = build_opener()

    def use_credential(self, credential: str) -> None:
        self._credential = credential

    # -- registration ------------------------------------------------------------------------

    def register(self, token: str, name: str, announcement: Announcement) -> Registered:
        """Exchange the registration token for the runner's own credential."""
        body = {"token": token, "name": name, **announcement.body()}
        reply = self._send("POST", REGISTER_PATH, body, authenticated=False)
        if reply.status != 201:
            raise self._registration_failure(reply)
        answer = _object(reply)
        runner_id, credential = answer.get("runnerId"), answer.get("credential")
        if not isinstance(runner_id, str) or not isinstance(credential, str):
            raise ApiUnavailable("the registration answer does not match the contract", 201)
        return Registered(runner_id, credential, _optional_text(answer.get("minBaseVersion")))

    def announce(self, announcement: Announcement) -> Announced:
        """Tell the app what the runner is now (labels, base, manifest, limits)."""
        reply = self._send("PUT", SELF_PATH, announcement.body())
        if reply.status != 200:
            raise self._failure(reply)
        answer = _object(reply)
        return Announced(
            min_base_version=_optional_text(answer.get("minBaseVersion")),
            update_needed=answer.get("updateNeeded") is True,
        )

    def renew(self) -> str:
        """A new credential. The one in use stays valid until the new one is used once."""
        reply = self._send("POST", CREDENTIAL_PATH, {})
        if reply.status != 200:
            raise self._failure(reply)
        credential = _object(reply).get("credential")
        if not isinstance(credential, str):
            raise ApiUnavailable("the renewal answer does not match the contract", 200)
        return credential

    # -- the claim ---------------------------------------------------------------------------

    def claim(self) -> ClaimedWorker | None:
        """The next job of this runner (the oldest due one it matches), or None (204: nothing for
        its labels and its manifest now).

        The claim names the engine `implementer` and the feature `worker_credential`: the answer is
        the job's id and the credential of its Worker, and the app sends nothing else of the job.
        The providers this runner knows go along so that the app can refuse a turn this runner
        cannot run.
        """
        body = {
            "engines": [ENGINE_IMPLEMENTER],
            "features": [FEATURE_WORKER_CREDENTIAL],
            "llmProviders": list(registered_provider_ids()),
        }
        reply = self._send("POST", CLAIM_PATH, body)
        if reply.status == 204:
            return None
        if reply.status != 200:
            raise self._failure(reply)
        return _parse_claim(reply)

    def release(self, job_id: str, credential: str, reason: str) -> str:
        """Give a claim back because the Worker could not be started or ended without a result
        (`POST /api/runners/v1/jobs/{id}/release`, the credential of the claim in the body).
        Answers `released`, `ended` (the job already has its result or another claim holds it:
        nothing to do) or `not_holder`. Never a value of the answer."""
        if not _JOB_ID.fullmatch(job_id):
            raise ApiRejected("the job id is not a UUID", 400, None)
        reply = self._send(
            "POST",
            f"{JOBS_PATH}/{quote(job_id)}/release",
            {"credential": credential, "reason": reason},
        )
        if reply.status == 200:
            return "released"
        if reply.status == 409:
            return "ended"
        if reply.status in (401, 404):
            if reply.status == 401 and error_code(reply) == "RUNNER_UNAUTHORIZED":
                raise Revoked("the app does not accept the runner credential (HTTP 401)", 401)
            return "not_holder"
        raise self._failure(reply)

    def job_state(self, job_id: str) -> str | None:
        """The status of a job of this runner's workspace (`GET /api/runners/v1/jobs/{id}`):
        `queued`, `running`, `superseded`, `succeeded`, `failed` or `cancelled`. None for a job
        that is not there (or not this workspace's). The local reaper's question: is the job of a
        Worker over?"""
        if not _JOB_ID.fullmatch(job_id):
            raise ApiRejected("the job id is not a UUID", 400, None)
        reply = self._send("GET", f"{JOBS_PATH}/{quote(job_id)}", None)
        if reply.status == 404:
            return None
        if reply.status != 200:
            raise self._failure(reply)
        body = as_object(parse_json(reply))
        job = as_object(body.get("job")) if body and body.get("version") == 1 else None
        status = job.get("status") if job and job.get("id") == job_id else None
        if not isinstance(status, str):
            raise ApiUnavailable("the job state answer does not match the contract", 200)
        return status

    # -- internals ---------------------------------------------------------------------------

    def _send(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None,
        *,
        authenticated: bool = True,
    ) -> Reply:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"factory-runner/{__version__}",
        }
        if authenticated:
            if self._credential is None:
                raise Revoked("the runner has no credential", 401)
            headers["Authorization"] = f"Bearer {self._credential}"
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=None if body is None else json.dumps(body, separators=(",", ":")).encode("ascii"),
            method=method,
            headers=headers,
        )
        return send(self._opener, request, self._timeout)

    @staticmethod
    def _registration_failure(reply: Reply) -> ApiError:
        status, code = reply.status, error_code(reply)
        if status >= 500 or status in (408, 425, 429):
            return ApiUnavailable(
                f"the app cannot serve the request (HTTP {status})",
                status,
                retry_after(reply.headers),
            )
        return RegistrationRefused(
            f"the app refused the registration (HTTP {status})", status, code
        )

    @staticmethod
    def _failure(reply: Reply) -> ApiError:
        status = reply.status
        if status == 401:
            return Revoked("the app does not accept the runner credential (HTTP 401)", 401)
        if status == 426:
            return UpdateNeeded(_min_base_version(reply))
        if status >= 500 or status in (408, 425, 429):
            return ApiUnavailable(
                f"the app cannot serve the request (HTTP {status})",
                status,
                retry_after(reply.headers),
            )
        if 300 <= status < 400:
            return ApiUnavailable(f"the app answered with a redirect (HTTP {status})", status)
        return ApiRejected(
            f"the app refused the request (HTTP {status})", status, error_code(reply)
        )


def _object(reply: Reply) -> dict[str, Any]:
    answer = as_object(parse_json(reply))
    if answer is None:
        raise ApiUnavailable("the app's answer is not the contract's", reply.status)
    return answer


def _min_base_version(reply: Reply) -> str | None:
    """`error.minBaseVersion` of a 426 answer, if it has one."""
    body = as_object(parse_json(reply))
    error = as_object(body.get("error")) if body else None
    return _optional_text(error.get("minBaseVersion")) if error else None


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _parse_claim(reply: Reply) -> ClaimedWorker:
    """The split answer. Only the id, the credential and what the dispatcher needs to start are
    read: an answer that is not the split one (it would hold a job input) is never read further."""
    body = as_object(parse_json(reply))
    job = as_object(body.get("job")) if body and body.get("version") == 1 else None
    job_id = job.get("id") if job else None
    credential = job.get("credential") if job else None
    if (
        job is None
        or not isinstance(job_id, str)
        or not _JOB_ID.fullmatch(job_id)
        or not isinstance(credential, str)
        or not _WORKER_CREDENTIAL.fullmatch(credential)
        or "input" in job
    ):
        raise ApiUnavailable("the claim answer does not match the contract", 200)
    return ClaimedWorker(
        job_id=job_id,
        credential=credential,
        labels=_labels(job.get("labels")),
        access=_access(job.get("access")),
    )


def _labels(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(label for label in cast("list[object]", value) if isinstance(label, str))


def _access(value: object) -> JobAccess | None:
    fields = as_object(value)
    if fields is None:
        return None
    harness, auth, model = fields.get("harness"), fields.get("auth"), fields.get("model")
    if not isinstance(harness, str) or not isinstance(auth, str):
        return None
    return JobAccess(harness, auth, model if isinstance(model, str) else None)
