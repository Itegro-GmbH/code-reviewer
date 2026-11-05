# SPDX-License-Identifier: LicenseRef-Proprietary

"""A fake App for the Factory-Runner (#854, R1b), on the loopback. Not a test file.

It speaks the registration and the runner API as the app does, from the shared contract files:
every request body the runner sends is checked against the contracts
(`contracts/runner-registration.v1.json` and `contracts/runner-api.v1.json`), and a body that
does not fit is answered 400 and kept in `violations`, so a test asserts there are none.

It knows the rules the runner depends on: the registration token is good once, every other
call needs a live credential (`401 RUNNER_UNAUTHORIZED` once it is revoked), a renewed
credential is valid beside the previous one until it is used, a claim below the minimum base
version is `426`, and a call about a job needs the lease token of the claim.

It lists its features at `GET /version` (`features`, a test sets it) and keeps the session snapshot
a runner puts at `PUT .../session` and gives it back at `GET .../resume-session` (#879): the lease
token is the header `X-Lease-Token`, the query and the answer headers are held to the contract,
and the snapshot belongs to the session of the job (`QueuedJob.session`), so a later turn of the
same session reads what an earlier one stored.
"""

import hashlib
import json
import secrets
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
_REGISTRATION = json.loads((CONTRACTS / "runner-registration.v1.json").read_text())
_RUNNER_API = json.loads((CONTRACTS / "runner-api.v1.json").read_text())


def _registry() -> Registry[Any]:
    registry: Registry[Any] = Registry()
    for schema in (_REGISTRATION, _RUNNER_API):
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return registry


_REGISTRY = _registry()


def _validator(schema: dict[str, Any], definition: str) -> Draft202012Validator:
    return Draft202012Validator(
        {"$ref": f"{schema['$id']}#/$defs/{definition}"}, registry=_REGISTRY
    )


_VALIDATORS = {
    ("POST", "/api/runners/v1/register"): _validator(_REGISTRATION, "RegisterRequest"),
    ("PUT", "/api/runners/v1/self"): _validator(_REGISTRATION, "AnnounceRequest"),
    ("POST", "/api/runners/v1/claim"): _validator(_RUNNER_API, "ClaimRequest"),
    "heartbeat": _validator(_RUNNER_API, "HeartbeatRequest"),
    "complete": _validator(_RUNNER_API, "CompleteRequest"),
    "steps": _validator(_RUNNER_API, "StepsRequest"),
    "session": _validator(_RUNNER_API, "RunnerSessionPartQuery"),
    "resume-session": _validator(_RUNNER_API, "RunnerResumeSessionQuery"),
    "lease-header": _validator(_RUNNER_API, "RunnerLeaseTokenHeader"),
    "session-response": _validator(_RUNNER_API, "RunnerSessionPartResponse"),
    "resume-headers": _validator(_RUNNER_API, "RunnerResumeSessionHeaders"),
}
PART_BYTES = 3 * 1024 * 1024
DEFAULT_FEATURES = (
    "worker_api",
    "implementer_steps",
    "implementer_snapshot",
    "runner_session_snapshot",
)
EXAMPLE_JOB = json.loads(
    (CONTRACTS / "examples" / "implementer" / "RunnerJobInput.json").read_text()
)


def _version_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("-")[0].split("."))


@dataclass
class Request:
    method: str
    path: str
    authorization: str | None
    body: Any


@dataclass
class QueuedJob:
    job_id: str
    lease_token: str
    input: dict[str, Any]
    heartbeat_seconds: int = 30
    claimed: bool = False
    # The conversation the job continues: its snapshot is shared by the turns of one session.
    session: str = "session-1"


@dataclass
class SessionCall:
    """A call of `PUT .../session` or `GET .../resume-session` as the fake saw it."""

    method: str
    job_id: str
    query: dict[str, str]
    lease_token: str | None
    size: int
    status: int = 0


@dataclass
class FakeRunnerApp:
    """Start with `start()`, stop with `stop()`; the state is plain attributes a test sets."""

    registration_tokens: set[str] = field(default_factory=lambda: set[str]())
    min_base_version: str | None = None
    credentials: dict[str, str] = field(
        default_factory=lambda: dict[str, str]()
    )  # credential -> runner id
    revoked: set[str] = field(default_factory=lambda: set[str]())  # runner ids
    runner_base_version: dict[str, str] = field(default_factory=lambda: dict[str, str]())
    announcements: list[dict[str, Any]] = field(default_factory=lambda: list[dict[str, Any]]())
    jobs: list[QueuedJob] = field(default_factory=lambda: list[QueuedJob]())
    requests: list[Request] = field(default_factory=lambda: list[Request]())
    violations: list[str] = field(default_factory=lambda: list[str]())
    heartbeats: list[str] = field(default_factory=lambda: list[str]())
    completions: list[dict[str, Any]] = field(default_factory=lambda: list[dict[str, Any]]())
    steps: list[dict[str, Any]] = field(default_factory=lambda: list[dict[str, Any]]())
    features: list[str] = field(default_factory=lambda: list(DEFAULT_FEATURES))
    session_calls: list[SessionCall] = field(default_factory=lambda: list[SessionCall]())
    # session -> (the query of a part, the whole file); parts wait in `_parts` until all are in.
    snapshots: dict[str, tuple[dict[str, str], bytes]] = field(
        default_factory=lambda: dict[str, tuple[dict[str, str], bytes]]()
    )
    _parts: dict[str, dict[int, bytes]] = field(
        default_factory=lambda: dict[str, dict[int, bytes]]()
    )
    # The claim ends the job it hands out with this status when the runner completes it.
    complete_status: str = "succeeded"
    _server: ThreadingHTTPServer | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    # -- control -----------------------------------------------------------------------------

    @property
    def url(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def start(self) -> "FakeRunnerApp":
        app = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:
                return

            def _serve(self) -> None:
                app._handle(self)

            do_POST = do_PUT = do_GET = _serve

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    def new_registration_token(self) -> str:
        token = "crt_" + secrets.token_urlsafe(32)[:43].ljust(43, "A")
        self.registration_tokens.add(token)
        return token

    def queue_job(self, job_id: str, input: dict[str, Any] | None = None) -> QueuedJob:
        job = QueuedJob(job_id, "lease-" + secrets.token_hex(8), input or EXAMPLE_JOB)
        self.jobs.append(job)
        return job

    def revoke_all(self) -> None:
        self.revoked.update(self.credentials.values())

    # -- the app -------------------------------------------------------------------------------

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("content-length", "0") or 0)
        raw = handler.rfile.read(length) if length else b""
        split = urlsplit(handler.path)
        path = split.path
        authorization = handler.headers.get("authorization")
        parts = path.strip("/").split("/")
        if (
            len(parts) == 6
            and parts[:4] == ["api", "runners", "v1", "jobs"]
            and parts[5]
            in (
                "session",
                "resume-session",
            )
        ):
            with self._lock:
                self.requests.append(Request(handler.command, path, authorization, None))
                answer = self._session_call(
                    handler.command, parts[4], parts[5], split.query, authorization,
                    handler.headers.get("x-lease-token"), raw,
                )  # fmt: skip
            self._respond(handler, *answer)
            return
        try:
            body: Any = json.loads(raw) if raw else None
        except ValueError:
            body = None
        with self._lock:
            self.requests.append(Request(handler.command, path, authorization, body))
            status, payload = self._route(handler.command, path, authorization, body)
        data = b"" if payload is None else json.dumps(payload).encode()
        self._respond(handler, status, data, {"content-type": "application/json"} if data else {})

    @staticmethod
    def _respond(
        handler: BaseHTTPRequestHandler, status: int, data: bytes, headers: dict[str, str]
    ) -> None:
        handler.send_response(status)
        for name, value in headers.items():
            handler.send_header(name, value)
        handler.send_header("content-length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    def _session_call(
        self,
        method: str,
        job_id: str,
        call: str,
        query_string: str,
        authorization: str | None,
        lease_token: str | None,
        raw: bytes,
    ) -> tuple[int, bytes, dict[str, str]]:
        """The two calls of the session snapshot (#879): the runner credential, then the job of
        this runner's claim, then the lease token in the header, then the call."""
        query = dict(parse_qsl(query_string, keep_blank_values=True))
        record = SessionCall(method, job_id, query, lease_token, len(raw))
        self.session_calls.append(record)

        def error(status: int, code: str, **extra: Any) -> tuple[int, bytes, dict[str, str]]:
            record.status = status
            body = {"error": {"code": code, "message": "fake", **extra}}
            return status, json.dumps(body).encode(), {"content-type": "application/json"}

        if (method, call) not in (("PUT", "session"), ("GET", "resume-session")):
            return error(405, "RUNNER_REQUEST_INVALID")
        if self._runner_of(authorization) is None:
            return error(401, "RUNNER_UNAUTHORIZED")
        job = next((j for j in self.jobs if j.job_id == job_id and j.claimed), None)
        if job is None:
            return error(404, "RUNNER_JOB_NOT_FOUND")
        if lease_token is None or not self._check("lease-header", {"x-lease-token": lease_token}):
            return error(400, "RUNNER_REQUEST_INVALID", fields=[{"field": "x-lease-token"}])
        if lease_token != job.lease_token:
            return error(409, "RUNNER_LEASE_LOST")
        if not self._check(call, query):
            return error(400, "RUNNER_REQUEST_INVALID")
        if call == "session":
            return self._put_part(job, query, raw, error, record)
        return self._get_part(job, query, record, error)

    def _put_part(
        self, job: QueuedJob, query: dict[str, str], raw: bytes, error: Any, record: SessionCall
    ) -> tuple[int, bytes, dict[str, str]]:
        part, count, size = int(query["part"]), int(query["parts"]), int(query["bytes"])
        if count != max(1, -(-size // PART_BYTES)) or len(raw) != min(
            PART_BYTES, size - part * PART_BYTES
        ):
            return error(400, "RUNNER_REQUEST_INVALID", fields=[{"field": "body"}])
        waiting = self._parts.setdefault(job.session, {})
        waiting[part] = raw
        complete = len(waiting) == count
        if complete:
            whole = b"".join(waiting[index] for index in range(count))
            waiting.clear()
            if hashlib.sha256(whole).hexdigest() != query["sha256"]:
                return error(400, "RUNNER_REQUEST_INVALID", fields=[{"field": "sha256"}])
            self.snapshots[job.session] = (query, whole)
        answer = {"version": 1, "part": part, "parts": count, "complete": complete}
        self._check("session-response", answer)
        record.status = 200
        return 200, json.dumps(answer).encode(), {"content-type": "application/json"}

    def _get_part(
        self, job: QueuedJob, query: dict[str, str], record: SessionCall, error: Any
    ) -> tuple[int, bytes, dict[str, str]]:
        stored = self.snapshots.get(job.session)
        if stored is None:
            record.status = 204
            return 204, b"", {}
        described, whole = stored
        count = max(1, -(-len(whole) // PART_BYTES))
        part = int(query.get("part", "0"))
        if part >= count:
            return error(400, "RUNNER_REQUEST_INVALID", fields=[{"field": "part"}])
        headers = {
            "x-snapshot-parts": str(count),
            "x-snapshot-bytes": described["bytes"],
            "x-snapshot-raw-bytes": described["rawBytes"],
            "x-snapshot-sha256": described["sha256"],
            "x-snapshot-opencode-version": described["opencodeVersion"],
        }
        self._check("resume-headers", headers)
        record.status = 200
        body = whole[part * PART_BYTES : (part + 1) * PART_BYTES]
        return 200, body, {"content-type": "application/octet-stream", **headers}

    @staticmethod
    def _error(status: int, code: str, **extra: Any) -> tuple[int, dict[str, Any]]:
        return status, {"error": {"code": code, "message": "fake", **extra}}

    def _check(self, key: str | tuple[str, str], body: Any) -> bool:
        errors = [e.message for e in _VALIDATORS[key].iter_errors(body)]  # pyright: ignore[reportUnknownMemberType]
        if errors:
            self.violations.append(f"{key}: {errors[0][:120]}")
        return not errors

    def _runner_of(self, authorization: str | None) -> str | None:
        credential = (authorization or "").removeprefix("Bearer ")
        runner = self.credentials.get(credential)
        return None if runner is None or runner in self.revoked else runner

    def _route(
        self, method: str, path: str, authorization: str | None, body: Any
    ) -> tuple[int, dict[str, Any] | None]:
        if (method, path) == ("POST", "/api/runners/v1/register"):
            return self._register(body)
        runner = self._runner_of(authorization)
        if runner is None:
            return self._error(401, "RUNNER_UNAUTHORIZED")
        if (method, path) == ("PUT", "/api/runners/v1/self"):
            return self._announce(runner, body)
        if (method, path) == ("POST", "/api/runners/v1/credential"):
            credential = "crc_" + secrets.token_urlsafe(32)[:43].ljust(43, "A")
            self.credentials[credential] = runner
            return 200, {"version": 1, "credential": credential}
        if (method, path) == ("POST", "/api/runners/v1/claim"):
            return self._claim(runner, body)
        if (method, path) == ("GET", "/api/runners/v1/version"):
            return 200, {"version": 1, "appVersion": "0.0.0-test", "features": self.features}
        parts = path.strip("/").split("/")
        if len(parts) == 6 and parts[:4] == ["api", "runners", "v1", "jobs"]:
            return self._job_call(parts[4], parts[5], body)
        return self._error(404, "RUNNER_JOB_NOT_FOUND")

    def _register(self, body: Any) -> tuple[int, dict[str, Any]]:
        if not self._check(("POST", "/api/runners/v1/register"), body):
            return self._error(400, "RUNNER_REQUEST_INVALID")
        if body["token"] not in self.registration_tokens:
            return self._error(401, "RUNNER_REGISTRATION_TOKEN_INVALID")
        self.registration_tokens.discard(body["token"])
        runner = "runner-" + secrets.token_hex(4)
        credential = "crc_" + secrets.token_urlsafe(32)[:43].ljust(43, "A")
        self.credentials[credential] = runner
        self.runner_base_version[runner] = body["baseVersion"]
        self.announcements.append({k: v for k, v in body.items() if k != "token"})
        return 201, {
            "version": 1,
            "runnerId": runner,
            "credential": credential,
            "minBaseVersion": self.min_base_version,
        }

    def _announce(self, runner: str, body: Any) -> tuple[int, dict[str, Any]]:
        if not self._check(("PUT", "/api/runners/v1/self"), body):
            return self._error(400, "RUNNER_REQUEST_INVALID")
        self.announcements.append(body)
        self.runner_base_version[runner] = body["baseVersion"]
        needed = self._update_needed(runner)
        return 200, {
            "version": 1,
            "runnerId": runner,
            "minBaseVersion": self.min_base_version,
            "updateNeeded": needed,
        }

    def _update_needed(self, runner: str) -> bool:
        if self.min_base_version is None:
            return False
        return _version_tuple(self.runner_base_version[runner]) < _version_tuple(
            self.min_base_version
        )

    def _claim(self, runner: str, body: Any) -> tuple[int, dict[str, Any] | None]:
        if not self._check(("POST", "/api/runners/v1/claim"), body or {}):
            return self._error(400, "RUNNER_REQUEST_INVALID")
        if self._update_needed(runner):
            return self._error(426, "RUNNER_UPDATE_NEEDED", minBaseVersion=self.min_base_version)
        for job in self.jobs:
            if not job.claimed:
                job.claimed = True
                return 200, {
                    "version": 1,
                    "job": {
                        "id": job.job_id,
                        "leaseToken": job.lease_token,
                        "leaseExpiresAt": "2026-11-05T12:02:00.000Z",
                        "heartbeatIntervalSeconds": job.heartbeat_seconds,
                        "tokenExpiresAt": None,
                        "input": job.input,
                    },
                }
        return 204, None

    def _job_call(self, job_id: str, call: str, body: Any) -> tuple[int, dict[str, Any]]:
        job = next((j for j in self.jobs if j.job_id == job_id and j.claimed), None)
        if job is None:
            return self._error(404, "RUNNER_JOB_NOT_FOUND")
        if call not in ("heartbeat", "complete", "steps"):
            return self._error(404, "RUNNER_JOB_NOT_FOUND")
        if not self._check(call, body):
            return self._error(400, "RUNNER_REQUEST_INVALID")
        if body["leaseToken"] != job.lease_token:
            return self._error(409, "RUNNER_LEASE_LOST")
        if call == "heartbeat":
            self.heartbeats.append(job_id)
            return 200, {
                "version": 1,
                "job": {
                    "id": job_id,
                    "heartbeatAt": "2026-11-05T12:00:30.000Z",
                    "leaseExpiresAt": "2026-11-05T12:02:30.000Z",
                },
            }
        if call == "steps":
            self.steps.append(body)
            count = len(body["records"])
            return 200, {"version": 1, "stored": count, "stale": 0, "dropped": 0}
        self.completions.append(body["result"])
        return 200, {
            "version": 1,
            "job": {"id": job_id, "status": self.complete_status},
            "alreadyCompleted": False,
        }
