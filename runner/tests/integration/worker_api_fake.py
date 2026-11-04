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

EXAMPLES = Path(__file__).resolve().parents[3] / "contracts" / "examples" / "worker-api"
CREDENTIAL = "crj_" + "Q" * 43
_ROUTE = re.compile(r"/api/workers/v1/jobs/([^/?]+)(/heartbeat|/result|/steps)?(\?.*)?")
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
                payload = b"" if body is None else json.dumps(body).encode()
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = handle_any
            do_POST = handle_any

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

    def _handle(
        self, method: str, path: str, headers: dict[str, str], raw: bytes
    ) -> tuple[int, dict[str, str], Any]:
        if _ROUTE.fullmatch(path) is not None and path.split("?")[0].endswith("/steps"):
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
            }[match.group(2)]
            body: Any = json.loads(raw) if raw else None
            self.requests.append(
                {"kind": kind, "job": job_id, "method": method, "headers": headers, "body": body}
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
