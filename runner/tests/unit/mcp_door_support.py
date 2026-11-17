# SPDX-License-Identifier: LicenseRef-Proprietary

"""Doubles for the tests of the MCP door (#1067); not a test file.

`FakeApp` stands in for the app's route `POST|DELETE /api/workers/v1/jobs/{job}/mcp/{server}`
(#1053, `docs/mcp-runtime.md`) on a loopback socket: it checks the job credential, plays a small
MCP server behind it (`initialize` opens a session, `tools/call` answers `called <name>`) that
"sees" the SERVER's credential, as the app's proxy adds it, and records every request it got. The
door is the real code; nothing here is the network.
"""

import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

JOB_ID = "11111111-1111-4111-8111-111111111111"
SERVER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SERVER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
# Built, so that the secret scan sees no credential in the source.
JOB_CREDENTIAL = "crj_" + "J" * 43
SERVER_CREDENTIAL = "Bearer " + "server-secret-" + "S" * 20


@dataclass
class Seen:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes


@dataclass
class Answer:
    status: int
    body: bytes = b""
    headers: dict[str, str] = field(default_factory=lambda: {})


def jsonrpc(method: str, **params: Any) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()


class FakeApp:
    def __init__(self) -> None:
        self.requests: list[Seen] = []
        # Answers handed out first, one for each request, before the server plays itself.
        self.script: list[Answer] = []
        # What the MCP server behind the app saw: the SERVER's credential, and the open sessions.
        self.server_saw: list[str] = []
        self.sessions: set[str] = set()
        self.tools_called: list[str] = []
        self.stream_release = threading.Event()
        self.stream_started = threading.Event()
        self.stream_closed = threading.Event()
        self._count = 0
        self._lock = threading.Lock()
        app = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, format: str, *args: Any) -> None:
                return None

            def _serve(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                app._handle(self, body)

            do_POST = do_DELETE = do_GET = _serve

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        ).start()

    def stop(self) -> None:
        self.stream_release.set()
        self.server.shutdown()
        self.server.server_close()

    def _reply(self, handler: BaseHTTPRequestHandler, answer: Answer) -> None:
        handler.send_response(answer.status)
        for name, value in answer.headers.items():
            handler.send_header(name, value)
        handler.send_header("Content-Length", str(len(answer.body)))
        handler.end_headers()
        handler.wfile.write(answer.body)

    def _handle(self, handler: BaseHTTPRequestHandler, body: bytes) -> None:
        headers = {name.lower(): value for name, value in handler.headers.items()}
        with self._lock:
            self.requests.append(Seen(handler.command, handler.path, headers, body))
            scripted = self.script.pop(0) if self.script else None
        if scripted is not None:
            self._reply(handler, scripted)
            return
        if headers.get("authorization") != f"Bearer {JOB_CREDENTIAL}":
            self._reply(handler, Answer(401, error("WORKER_CREDENTIAL_INVALID")))
            return
        # The app adds the SERVER's credential; the fake server behind it records what it saw.
        self.server_saw.append(SERVER_CREDENTIAL)
        session = headers.get("mcp-session-id")
        if handler.command == "DELETE":
            self.sessions.discard(session or "")
            self._reply(handler, Answer(200))
            return
        message = json.loads(body or b"{}")
        method = message.get("method")
        if method == "initialize":
            with self._lock:
                self._count += 1
                made = f"session-{self._count}"
            self.sessions.add(made)
            answer = result(message, {"protocolVersion": "2025-06-18"})
            self._reply(
                handler,
                Answer(200, answer, {"Content-Type": "application/json", "Mcp-Session-Id": made}),
            )
        elif method == "tools/call":
            name = str(message["params"]["name"])
            self.tools_called.append(name)
            answer = result(message, {"content": [{"type": "text", "text": f"called {name}"}]})
            self._reply(handler, Answer(200, answer, {"Content-Type": "application/json"}))
        elif method == "stream":
            self._stream(handler)
        else:
            self._reply(handler, Answer(202))

    def _stream(self, handler: BaseHTTPRequestHandler) -> None:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.end_headers()
        handler.wfile.write(b'event: message\ndata: {"first":1}\n\n')
        handler.wfile.flush()
        self.stream_started.set()
        try:
            self.stream_release.wait(10)
            # A consumer that let go makes this write (or the next) fail.
            for _ in range(50):
                handler.wfile.write(b": keep-alive\n\n")
                handler.wfile.flush()
                if self.stream_closed.wait(0.02):
                    break
        except OSError:
            self.stream_closed.set()


def error(code: str) -> bytes:
    return json.dumps(
        {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": code}}
    ).encode()


def result(message: dict[str, Any], value: dict[str, Any]) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "id": message.get("id"), "result": value}).encode()
