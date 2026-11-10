# SPDX-License-Identifier: LicenseRef-Proprietary

"""A fake App for the Factory-Runner (#854, R1b; #974), on the loopback. Not a test file.

It speaks the registration, the runner API of a customer's local dispatcher and the Worker API of
the Worker that dispatcher starts, from the shared contract files: every request body the
dispatcher or the Worker sends is checked against the contracts
(`contracts/runner-registration.v1.json`, `contracts/runner-api.v1.json`,
`contracts/worker-api.v1.json`), and a body that does not fit is answered 400 and kept in
`violations`, so a test asserts there are none.

It knows the rules the runner depends on: the registration token is good once, every call of the
dispatcher needs a live runner credential (`401 RUNNER_UNAUTHORIZED` once it is revoked, which also
ends the job it holds), a renewed credential is valid beside the previous one until it is used, a
claim below the minimum base version is `426`, and the claim is the split one (#974): the job's id
and the credential of its Worker (`crj_`), **no job input**. The job is fetched by the Worker over
`/api/workers/v1` with that credential, which is the only proof of the claim; the runner credential
opens the state of a job, the release of a claim and nothing else about a job (the old job routes
answer 404).

It keeps the session snapshot a Worker puts at `PUT /api/workers/v1/jobs/{id}/session` and gives it
back at `GET .../resume-session`: the query and the answer headers are held to the contract, and the
snapshot belongs to the session of the job (`QueuedJob.session`), so a later turn of the same
session reads what an earlier one stored.
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
_WORKER_API = json.loads((CONTRACTS / "worker-api.v1.json").read_text())


def _registry() -> Registry[Any]:
    registry: Registry[Any] = Registry()
    for schema in (_REGISTRATION, _RUNNER_API, _WORKER_API):
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
    "claim-response": _validator(_RUNNER_API, "SplitClaimResponse"),
    "release": _validator(_RUNNER_API, "ReleaseRequest"),
    "job-state": _validator(_RUNNER_API, "JobStateResponse"),
    "details-response": _validator(_WORKER_API, "WorkerJobDetailsResponse"),
    "heartbeat": _validator(_WORKER_API, "WorkerHeartbeatRequest"),
    "heartbeat-response": _validator(_WORKER_API, "WorkerHeartbeatResponse"),
    "result": _validator(_WORKER_API, "WorkerResultRequest"),
    "result-response": _validator(_WORKER_API, "WorkerResultResponse"),
    "steps": _validator(_WORKER_API, "WorkerStepsRequest"),
    "session": _validator(_WORKER_API, "SessionPartQuery"),
    "resume-session": _validator(_WORKER_API, "ResumeSessionQuery"),
    "session-response": _validator(_WORKER_API, "SessionPartResponse"),
    "resume-headers": _validator(_WORKER_API, "ResumeSessionHeaders"),
}
PART_BYTES = 3 * 1024 * 1024
# The fields of a part's query that describe the whole file; the parts of one upload agree on them.
_DESCRIPTION = ("parts", "bytes", "rawBytes", "sha256", "opencodeVersion")
DEFAULT_FEATURES = (
    "worker_api",
    "implementer_steps",
    "implementer_snapshot",
)
EXAMPLE_JOB = json.loads(
    (CONTRACTS / "examples" / "implementer" / "RunnerJobInput.json").read_text()
)
# What a secret of the job looks like in the example: the git token and the key of the workspace
# are the ones the local dispatcher must never hold.
GIT_TOKEN = EXAMPLE_JOB["git"]["token"]
MODEL_KEY = EXAMPLE_JOB["llm"]["apiKey"]


def _version_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("-")[0].split("."))


def _token(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(32)[:43].ljust(43, "A")


@dataclass
class Request:
    method: str
    path: str
    authorization: str | None
    body: Any
    query: str = ""


@dataclass
class QueuedJob:
    job_id: str
    input: dict[str, Any]
    heartbeat_seconds: int = 30
    claimed: bool = False
    # The credential of the claim's Worker, made when the job is claimed (`crj_`).
    credential: str = ""
    status: str = "queued"
    # What the claim says about the job besides its id: the labels it required and what it asks of
    # the device (`access` of the split answer).
    labels: list[str] = field(default_factory=lambda: list[str]())
    access: dict[str, Any] | None = None
    # The conversation the job continues: its snapshot is shared by the turns of one session.
    session: str = "session-1"
    # The details requests the Worker made (`features` and `llmProviders` of the query).
    fetches: list[dict[str, str]] = field(default_factory=lambda: list[dict[str, str]]())
    # The releases asked for this job (`reason` of the body and what the app answered).
    releases: list[tuple[str, int]] = field(default_factory=lambda: list[tuple[str, int]]())


@dataclass
class SessionCall:
    """A call of `PUT .../session` or `GET .../resume-session` as the fake saw it."""

    method: str
    job_id: str
    query: dict[str, str]
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
    # session -> the job whose turn stored its snapshot.
    snapshot_jobs: dict[str, str] = field(default_factory=lambda: dict[str, str]())
    # session -> (the job the waiting parts belong to, part index -> (query, bytes)).
    _parts: dict[str, tuple[str, dict[int, tuple[dict[str, str], bytes]]]] = field(
        default_factory=lambda: dict[str, tuple[str, dict[int, tuple[dict[str, str], bytes]]]]()
    )
    # The Worker's result ends the job with this status.
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

    def queue_job(
        self,
        job_id: str,
        input: dict[str, Any] | None = None,
        *,
        access: dict[str, Any] | None = None,
        labels: list[str] | None = None,
    ) -> QueuedJob:
        job = QueuedJob(job_id, input or EXAMPLE_JOB, access=access, labels=labels or [])
        self.jobs.append(job)
        return job

    def job(self, job_id: str) -> QueuedJob:
        return next(job for job in self.jobs if job.job_id == job_id)

    def revoke_all(self) -> None:
        """Revoke every runner; the claims they hold end at once (the app ends them with it)."""
        self.revoked.update(self.credentials.values())
        with self._lock:
            for job in self.jobs:
                if job.status == "running":
                    job.status = "failed"

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
            and parts[:4] == ["api", "workers", "v1", "jobs"]
            and parts[5] in ("session", "resume-session")
        ):
            with self._lock:
                self.requests.append(
                    Request(handler.command, path, authorization, None, split.query)
                )
                answer = self._session_call(
                    handler.command, parts[4], parts[5], split.query, authorization, raw
                )
            self._respond(handler, *answer)
            return
        try:
            body: Any = json.loads(raw) if raw else None
        except ValueError:
            body = None
        with self._lock:
            self.requests.append(Request(handler.command, path, authorization, body, split.query))
            status, payload = self._route(handler.command, path, split.query, authorization, body)
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

    def _held_by(self, authorization: str | None, job_id: str) -> QueuedJob | None:
        """The job whose claim this Worker credential is the proof of."""
        credential = (authorization or "").removeprefix("Bearer ")
        return next(
            (
                j
                for j in self.jobs
                if j.job_id == job_id and j.claimed and j.credential == credential
            ),
            None,
        )

    # -- the routes ----------------------------------------------------------------------------

    def _route(
        self, method: str, path: str, query: str, authorization: str | None, body: Any
    ) -> tuple[int, dict[str, Any] | None]:
        parts = path.strip("/").split("/")
        if parts[:4] == ["api", "workers", "v1", "jobs"] and len(parts) in (5, 6):
            return self._worker_call(
                method, parts[4], parts[5] if len(parts) == 6 else "", query, authorization, body
            )
        if (method, path) == ("POST", "/api/runners/v1/register"):
            return self._register(body)
        if (method, path) == ("GET", "/api/runners/v1/version"):
            return self._version(authorization, query)
        runner = self._runner_of(authorization)
        if runner is None:
            return self._error(401, "RUNNER_UNAUTHORIZED")
        if (method, path) == ("PUT", "/api/runners/v1/self"):
            return self._announce(runner, body)
        if (method, path) == ("POST", "/api/runners/v1/credential"):
            credential = _token("crc_")
            self.credentials[credential] = runner
            return 200, {"version": 1, "credential": credential}
        if (method, path) == ("POST", "/api/runners/v1/claim"):
            return self._claim(runner, body)
        if parts[:4] == ["api", "runners", "v1", "jobs"] and len(parts) in (5, 6):
            return self._runner_job_call(
                method, parts[4], parts[5] if len(parts) == 6 else "", body
            )
        return self._error(404, "RUNNER_JOB_NOT_FOUND")

    def _version(self, authorization: str | None, query: str) -> tuple[int, dict[str, Any] | None]:
        job_id = dict(parse_qsl(query)).get("jobId")
        if self._runner_of(authorization) is None and (
            job_id is None or self._held_by(authorization, job_id) is None
        ):
            return self._error(401, "RUNNER_UNAUTHORIZED")
        return 200, {"version": 1, "appVersion": "0.0.0-test", "features": self.features}

    def _register(self, body: Any) -> tuple[int, dict[str, Any]]:
        if not self._check(("POST", "/api/runners/v1/register"), body):
            return self._error(400, "RUNNER_REQUEST_INVALID")
        if body["token"] not in self.registration_tokens:
            return self._error(401, "RUNNER_REGISTRATION_TOKEN_INVALID")
        self.registration_tokens.discard(body["token"])
        runner = "runner-" + secrets.token_hex(4)
        credential = _token("crc_")
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
                job.status = "running"
                job.credential = _token("crj_")
                answer: dict[str, Any] = {
                    "version": 1,
                    "job": {
                        "id": job.job_id,
                        "credential": job.credential,
                        "reviewKind": "implementer",
                        "leaseExpiresAt": "2026-11-05T12:02:00.000Z",
                        "heartbeatIntervalSeconds": job.heartbeat_seconds,
                        **({"labels": job.labels} if job.labels else {}),
                        **({"access": job.access} if job.access is not None else {}),
                    },
                }
                self._check("claim-response", answer)
                return 200, answer
        return 204, None

    def _runner_job_call(
        self, method: str, job_id: str, call: str, body: Any
    ) -> tuple[int, dict[str, Any]]:
        """What the runner credential may ask about a job: its state, and the release of its claim.
        Every other route of the old customer API (#974) is gone."""
        job = next((j for j in self.jobs if j.job_id == job_id), None)
        if job is None:
            return self._error(404, "RUNNER_JOB_NOT_FOUND")
        if (method, call) == ("GET", ""):
            answer = {"version": 1, "job": {"id": job_id, "status": job.status}}
            self._check("job-state", answer)
            return 200, answer
        if (method, call) == ("POST", "release"):
            if not self._check("release", body):
                return self._error(400, "RUNNER_REQUEST_INVALID")
            if body["credential"] != job.credential:
                job.releases.append((body["reason"], 401))
                return self._error(401, "WORKER_CREDENTIAL_INVALID")
            if job.status != "running":
                job.releases.append((body["reason"], 409))
                return self._error(409, "RUNNER_JOB_ENDED")
            job.status = "queued"
            job.claimed = False
            job.credential = ""  # the claim is over: the credential proves nothing any more
            job.releases.append((body["reason"], 200))
            return 200, {"version": 1, "job": {"id": job_id, "status": "queued"}}
        return self._error(404, "RUNNER_JOB_NOT_FOUND")

    # -- the Worker API ----------------------------------------------------------------------

    def _worker_call(
        self,
        method: str,
        job_id: str,
        call: str,
        query: str,
        authorization: str | None,
        body: Any,
    ) -> tuple[int, dict[str, Any] | None]:
        job = self._held_by(authorization, job_id)
        if job is None:
            return self._error(401, "WORKER_CREDENTIAL_INVALID")
        if job.status != "running":
            return self._error(409, "RUNNER_JOB_ENDED")
        if (method, call) == ("GET", ""):
            job.fetches.append(dict(parse_qsl(query)))
            answer = {
                "version": 1,
                "job": {
                    "id": job_id,
                    "leaseExpiresAt": "2026-11-05T12:02:00.000Z",
                    "heartbeatIntervalSeconds": job.heartbeat_seconds,
                    "tokenExpiresAt": None,
                    "input": job.input,
                },
            }
            self._check("details-response", answer)
            return 200, answer
        if (method, call) == ("POST", "heartbeat"):
            if not self._check("heartbeat", body or {}):
                return self._error(400, "RUNNER_REQUEST_INVALID")
            self.heartbeats.append(job_id)
            answer = {
                "version": 1,
                "job": {
                    "id": job_id,
                    "heartbeatAt": "2026-11-05T12:00:30.000Z",
                    "leaseExpiresAt": "2026-11-05T12:02:30.000Z",
                },
            }
            self._check("heartbeat-response", answer)
            return 200, answer
        if (method, call) == ("POST", "steps"):
            if not self._check("steps", body):
                return self._error(400, "RUNNER_REQUEST_INVALID")
            self.steps.append(body)
            return 200, {"version": 1, "stored": len(body["records"]), "stale": 0, "dropped": 0}
        if (method, call) == ("POST", "result"):
            if not self._check("result", body):
                return self._error(400, "RUNNER_REQUEST_INVALID")
            self.completions.append(body["result"])
            job.status = self.complete_status
            answer = {
                "version": 1,
                "job": {"id": job_id, "status": self.complete_status},
                "alreadyCompleted": False,
            }
            self._check("result-response", answer)
            return 200, answer
        return self._error(404, "RUNNER_JOB_NOT_FOUND")

    def _session_call(
        self,
        method: str,
        job_id: str,
        call: str,
        query_string: str,
        authorization: str | None,
        raw: bytes,
    ) -> tuple[int, bytes, dict[str, str]]:
        """The two calls of the session snapshot (#839, #840): the credential of the claim, then the
        call."""
        query = dict(parse_qsl(query_string, keep_blank_values=True))
        record = SessionCall(method, job_id, query, len(raw))
        self.session_calls.append(record)

        def error(status: int, code: str, **extra: Any) -> tuple[int, bytes, dict[str, str]]:
            record.status = status
            body = {"error": {"code": code, "message": "fake", **extra}}
            return status, json.dumps(body).encode(), {"content-type": "application/json"}

        if (method, call) not in (("PUT", "session"), ("GET", "resume-session")):
            return error(405, "RUNNER_REQUEST_INVALID")
        job = self._held_by(authorization, job_id)
        if job is None:
            return error(401, "WORKER_CREDENTIAL_INVALID")
        if job.status != "running":
            return error(409, "RUNNER_JOB_ENDED")
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
        stored = self.snapshots.get(job.session)
        if (
            stored is not None
            and self.snapshot_jobs.get(job.session) == job.job_id
            and stored[0]["sha256"] == query["sha256"]
        ):
            # The snapshot of this very turn is in already: a part sent again after it is whole.
            return self._part_answer(record, part, count, True)
        holder, waiting = self._parts.get(job.session, (job.job_id, {}))
        if holder != job.job_id:
            # What a turn that ended in the middle of its upload left behind is dropped with the
            # first part of another job of the session (a session has one running turn).
            waiting = {}
        self._parts[job.session] = (job.job_id, waiting)
        waiting[part] = (query, raw)
        described = {tuple(q[key] for key in _DESCRIPTION) for q, _ in waiting.values()}
        if len(described) > 1:
            # Parts that do not describe the same file: nothing of this upload is kept.
            del self._parts[job.session]
            return error(400, "RUNNER_REQUEST_INVALID", fields=[{"field": "sha256"}])
        complete = len(waiting) == count
        if complete:
            whole = b"".join(waiting[index][1] for index in range(count))
            del self._parts[job.session]
            if hashlib.sha256(whole).hexdigest() != query["sha256"]:
                return error(400, "RUNNER_REQUEST_INVALID", fields=[{"field": "sha256"}])
            self.snapshots[job.session] = (query, whole)
            self.snapshot_jobs[job.session] = job.job_id
        return self._part_answer(record, part, count, complete)

    def _part_answer(
        self, record: SessionCall, part: int, count: int, complete: bool
    ) -> tuple[int, bytes, dict[str, str]]:
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
