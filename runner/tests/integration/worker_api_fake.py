# SPDX-License-Identifier: LicenseRef-Proprietary

"""Test helper, not a test: the Worker API of the app on loopback, with scriptable answers.

`FakeWorkerApp` answers like the contract examples and records every request; a test scripts the
next answer of a call (a redirect, a 5xx, a conflict) or sets a job superseded. `RawServer` answers
every connection with fixed bytes, for answers that are not HTTP at all.
"""

import json
import re
import socket
import threading
import time
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

EXAMPLES = Path(__file__).resolve().parents[3] / "contracts" / "examples" / "worker-api"
CREDENTIAL = "crj_" + "Q" * 43
_ROUTE = re.compile(
    r"/api/workers/v1/jobs/([^/?]+)(/heartbeat|/result|/steps|/session|/resume-session)?(\?.*)?"
)
_VERSION = re.compile(r"/api/runners/v1/version(\?.*)?")


def example(name: str) -> Any:
    return json.loads((EXAMPLES / f"{name}.json").read_text(encoding="utf-8"))


class Scripted:
    def __init__(self, status: int, body: Any = None, headers: dict[str, str] | None = None):
        self.status = status
        self.body = body
        self.headers = headers or {}


class FakeWorkerApp:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.completions: list[dict[str, Any]] = []
        self.superseded: set[str] = set()
        self.complete_status = "succeeded"
        # The features the version call lists (None: the call is not served, as before #745).
        self.features: list[str] | None = None
        # Seconds the steps call waits before it answers (a slow or hung app).
        self.steps_delay = 0.0
        # The stored session the resume-session call serves (#840): the gzip file, its raw size,
        # and the headers of the whole file it should say (None: computed from the file).
        self.resume_file: bytes | None = None
        self.resume_raw_bytes = 12_345
        self.resume_headers: dict[str, str] | None = None
        self._scripted: dict[str, list[Scripted]] = defaultdict(list)
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None
        self.url = ""

    def script(self, kind: str, *answers: Scripted) -> None:
        """The next calls of `kind` ("fetch", "heartbeat", "result") answer like this."""
        with self._lock:
            self._scripted[kind].extend(answers)

    def start(self) -> "FakeWorkerApp":
        app = self

        class Handler(BaseHTTPRequestHandler):
            def handle_any(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                status, headers, body = app._handle(
                    self.command, self.path, dict(self.headers), raw
                )
                payload = (
                    body
                    if isinstance(body, bytes)
                    else (b"" if body is None else json.dumps(body).encode())
                )
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = handle_any
            do_POST = handle_any
            do_PUT = handle_any

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        ).start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    def _resume(self, path: str) -> tuple[int, dict[str, str], Any]:
        """One part of the stored session, as the app serves it: the bytes, and the description of
        the whole file in the headers."""
        import hashlib

        if self.resume_file is None:
            return 204, {}, None
        query = parse_qs(urlsplit(path).query)
        index = int(query.get("part", ["0"])[0])
        whole = self.resume_file
        described = {
            "x-snapshot-parts": str(max(1, -(-len(whole) // (3 * 1024 * 1024)))),
            "x-snapshot-bytes": str(len(whole)),
            "x-snapshot-raw-bytes": str(self.resume_raw_bytes),
            "x-snapshot-sha256": hashlib.sha256(whole).hexdigest(),
            "x-snapshot-opencode-version": "1.19.0",
            **(self.resume_headers or {}),
        }
        return (
            200,
            {"Content-Type": "application/octet-stream", **described},
            _resume_part(whole, index),
        )

    def _handle(
        self, method: str, path: str, headers: dict[str, str], raw: bytes
    ) -> tuple[int, dict[str, str], Any]:
        if _ROUTE.fullmatch(path) is not None and path.split("?")[0].endswith(
            ("/steps", "/session")
        ):
            time.sleep(self.steps_delay)
        with self._lock:
            if self.features is not None and _VERSION.fullmatch(path) is not None:
                self.requests.append({"kind": "version", "headers": headers})
                return 200, {}, {"version": 1, "features": self.features}
            match = _ROUTE.fullmatch(path)
            if match is None:
                self.requests.append({"kind": "other", "path": path, "headers": headers})
                return 404, {}, None
            job_id = match.group(1)
            kind = {
                None: "fetch",
                "/heartbeat": "heartbeat",
                "/result": "result",
                "/steps": "steps",
                "/session": "session",
                "/resume-session": "resume",
            }[match.group(2)]
            # The session snapshot (#839) is bytes, not JSON; its description is in the query.
            body: Any = json.loads(raw) if raw and kind not in ("session", "resume") else None
            self.requests.append(
                {
                    "kind": kind,
                    "job": job_id,
                    "method": method,
                    "headers": headers,
                    "body": body,
                    "raw": raw,
                    "query": parse_qs(urlsplit(path).query),
                }
            )
            if self._scripted[kind]:
                answer = self._scripted[kind].pop(0)
                return answer.status, answer.headers, answer.body
            if headers.get("Authorization") != f"Bearer {CREDENTIAL}":
                return 401, {}, {"error": {"code": "RUNNER_UNAUTHORIZED", "message": "credential"}}
            if kind == "fetch":
                return 200, {}, _with_job_id(example("WorkerJobDetailsResponse"), job_id)
            if kind == "heartbeat":
                answer = _with_job_id(example("WorkerHeartbeatResponse"), job_id)
                if job_id in self.superseded:
                    answer["job"]["superseded"] = True
                return 200, {}, answer
            if kind == "session":
                query = parse_qs(urlsplit(path).query)
                part, parts = int(query["part"][0]), int(query["parts"][0])
                return (
                    200,
                    {},
                    {"version": 1, "part": part, "parts": parts, "complete": part == parts - 1},
                )
            if kind == "resume":
                return self._resume(path)
            if kind == "steps":
                return (
                    200,
                    {},
                    {"version": 1, "stored": len(body["records"]), "stale": 0, "dropped": 0},
                )
            self.completions.append({"job": job_id, "result": body["result"]})
            answer = _with_job_id(example("WorkerResultResponse"), job_id)
            answer["job"]["status"] = self.complete_status
            return 200, {}, answer


def _resume_part(self_file: bytes, index: int) -> bytes:
    return self_file[index * 3 * 1024 * 1024 : (index + 1) * 3 * 1024 * 1024]


def _with_job_id(answer: dict[str, Any], job_id: str) -> dict[str, Any]:
    answer["job"]["id"] = job_id
    return answer


class RawServer:
    """A loopback server that answers every connection with fixed bytes, then closes it."""

    def __init__(self, answer: bytes) -> None:
        self._answer = answer
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(8)
        self.url = f"http://127.0.0.1:{self._listener.getsockname()[1]}"
        self.connections = 0
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while True:
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            self.connections += 1
            with connection:
                connection.settimeout(2)
                try:
                    connection.recv(65536)
                    connection.sendall(self._answer)
                except OSError:
                    pass

    def close(self) -> None:
        self._listener.close()
