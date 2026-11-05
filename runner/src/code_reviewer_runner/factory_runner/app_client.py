# SPDX-License-Identifier: LicenseRef-Proprietary

"""The runner's calls to the app that are not about one job (#854, R1b): the registration, the
announcement, the renewal of the credential and the claim.

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
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from code_reviewer_runner import __version__
from code_reviewer_runner.job_loop.api import ClaimedJob
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
from code_reviewer_runner.job_loop.worker_api import (
    MAX_HEARTBEAT_INTERVAL_SECONDS,
    WORKER_FEATURES,
)
from code_reviewer_runner.llm_providers import registered_provider_ids

REGISTER_PATH = "/api/runners/v1/register"
SELF_PATH = "/api/runners/v1/self"
CREDENTIAL_PATH = "/api/runners/v1/credential"
CLAIM_PATH = "/api/runners/v1/claim"
ENGINE_IMPLEMENTER = "implementer"


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

    def claim(self) -> ClaimedJob | None:
        """The next job of this runner, or None (204: nothing for its labels now).

        The claim names the engine `implementer` and the features the job host understands, so the
        job carries everything the hosted Worker gets (`WORKER_FEATURES`): the app sends an optional
        field only to a caller that names it.
        """
        body = {
            "engines": [ENGINE_IMPLEMENTER],
            "features": list(WORKER_FEATURES),
            "llmProviders": list(registered_provider_ids()),
        }
        reply = self._send("POST", CLAIM_PATH, body)
        if reply.status == 204:
            return None
        if reply.status != 200:
            raise self._failure(reply)
        return _parse_claim(reply)

    # -- internals ---------------------------------------------------------------------------

    def _send(
        self, method: str, path: str, body: Mapping[str, Any], *, authenticated: bool = True
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
            data=json.dumps(body, separators=(",", ":")).encode("ascii"),
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


def _parse_claim(reply: Reply) -> ClaimedJob:
    body = as_object(parse_json(reply))
    job = as_object(body.get("job")) if body and body.get("version") == 1 else None
    interval = job.get("heartbeatIntervalSeconds") if job else None
    job_input = as_object(job.get("input")) if job else None
    job_id = job.get("id") if job else None
    lease = job.get("leaseToken") if job else None
    if (
        job is None
        or not isinstance(job_id, str)
        or not isinstance(lease, str)
        or not isinstance(interval, int)
        or isinstance(interval, bool)
        or interval < 1
        or job_input is None
    ):
        raise ApiUnavailable("the claim answer does not match the contract", 200)
    return ClaimedJob(
        id=job_id,
        lease_token=lease,
        heartbeat_interval=float(min(interval, MAX_HEARTBEAT_INTERVAL_SECONDS)),
        input=job_input,
    )
