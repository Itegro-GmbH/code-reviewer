# SPDX-License-Identifier: LicenseRef-Proprietary

"""The relay of the MCP door (#1067): a Streamable HTTP endpoint per MCP server of the step that
forwards each call to the app with the job's credential.

```
agent's harness ──▶ http://<door>:<port>/mcp/<server id> ──▶ app: POST|DELETE
/api/workers/v1/jobs/<job>/mcp/<server id>
  no credential          this relay: holds the JOB credential        adds the SERVER credential and
  calls the server
```

What it does, and nothing else:

* **A server of the step only.** The path names a server id the start document listed; any other
  path or id is `404 mcp_server_unavailable` and nothing is sent.
* **The message, the session and the protocol version, and nothing else, go on.** Of a request it
  reads the JSON-RPC body (at most `MAX_REQUEST_BYTES`), `Mcp-Session-Id` and `MCP-Protocol-Version`
  (each a plain token, otherwise `400`); every other header, the agent's `Authorization` and cookies
  included, is dropped. The request to the app carries the job's credential, which only this
  process holds.
* **Only the content type, the session id and the body come back** (an event stream as it arrives;
  when the agent lets go, the request to the app ends with it). A status passes as it is; a
  `Retry-After` does not (the door has retried once itself, see below).
* **`GET` is `405`**, like the app's route: the endpoint has no stream of its own.
* **Never a retry of a `503`** (`docs/mcp-runtime.md`: a `tools/call` may have run before the
  error); a connection that failed or broke is a `503 mcp_proxy_unreachable` the door makes itself,
  and is not repeated either. The one exception is `429 mcp_too_many_concurrent_calls` with
  `Retry-After` (the call was not made): it waits as told, at most `MAX_RETRY_AFTER_SECONDS`, and
  asks **once** more. `429 mcp_call_limit_reached` and every other status are final.
* **Sessions are closed.** Every `Mcp-Session-Id` the app handed out is remembered; when the step
  ends `close_sessions` sends a `DELETE` for each one that the agent did not end itself, at most
  `CLOSE_PARALLEL` at a time (the app allows 4 calls of a job at once), so no session of a server
  outlives the step. Only a `2xx`, a `404` (the server does not know it any more) and a `405` (the
  server has no `DELETE`) end a session; any other answer leaves it open and it is **left**, as is a
  session beyond the `MAX_OPEN_SESSIONS` that are tracked: both are in the final status.
* **A socket that stalls is closed** (`SOCKET_TIMEOUT_SECONDS`) and the connections are bounded
  (`MAX_CONNECTIONS`; one more is refused with `429`): the door has a small process limit and holds
  the job's credential.

Nothing here logs a header, a body or an address. Standard library only: the door runs in the Worker
image and imports no more of the runner than its own package, `job_loop.http` and `outer_proxy`.
"""

import contextlib
import http.client
import json
import logging
import queue
import re
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Final, Protocol, cast
from urllib.parse import quote

from code_reviewer_runner.job_loop.http import build_opener
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.outer_proxy import OuterProxy

_log = logging.getLogger(__name__)

# The request the app reads: 256 KiB (`MCP_PROXY_MAX_REQUEST_BYTES`). A larger one is refused here,
# so
# that the door never holds more than this per call.
MAX_REQUEST_BYTES: Final = 256 * 1024
# The app caps its answer at 4 MiB; a bit more here is the same limit with the envelope.
MAX_RESPONSE_BYTES: Final = 4 * 1024 * 1024 + 4096
# What the app's deadline is (55 s) plus a margin: a socket that is silent longer is a broken one.
UPSTREAM_TIMEOUT_SECONDS: Final = 70.0
# The most a `Retry-After` is honoured for; the app says 1.
MAX_RETRY_AFTER_SECONDS: Final = 5.0
# Closing the sessions at the end: each DELETE has this long, all of them together `CLOSE_SECONDS`.
CLOSE_CALL_SECONDS: Final = 5.0
CLOSE_SECONDS: Final = 8.0
# Calls the door serves at once (the app allows 4 per job); more is the same `429` the app gives.
MAX_IN_FLIGHT: Final = 16
MAX_OPEN_SESSIONS: Final = 64
# Sessions beyond MAX_OPEN_SESSIONS whose ids are remembered, only to count each once as left; past
# this a further one is counted without its id.
MAX_UNTRACKED_SESSIONS: Final = 1024
# DELETEs of the end of the step in flight at once: the app allows 4 calls per job.
CLOSE_PARALLEL: Final = 3
# An idle or slow socket is closed after this long; open connections are bounded (the container has
# a small process limit, one thread per connection).
SOCKET_TIMEOUT_SECONDS: Final = 30.0
MAX_CONNECTIONS: Final = 32
# What ends a session: 2xx, 404 (the server does not know it) and 405 (it has no DELETE).
_ENDED_STATUS_OTHER: Final = frozenset({404, 405})
_CHUNK: Final = 8192

SERVER_ID: Final = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
JOB_ID: Final = SERVER_ID
# A session id and a protocol version are plain tokens: visible ASCII, no space.
_TOKEN: Final = re.compile(r"[\x21-\x7e]{1,256}")
_CONTENT_TYPE: Final = re.compile(r"[A-Za-z0-9!#$&^_.+/;=\" -]{1,128}")
_PATH: Final = re.compile(r"/mcp/([0-9a-fA-F-]{36})")
# A body of at most 256 KiB: a length is a few ASCII digits (`str.isdigit` also takes `²` and the
# digits of other scripts, which `int` then refuses).
_LENGTH: Final = re.compile(r"[0-9]{1,9}")

CODE_UNAVAILABLE: Final = "mcp_server_unavailable"
CODE_INVALID: Final = "mcp_proxy_request_invalid"
CODE_TOO_LARGE: Final = "mcp_proxy_request_too_large"
CODE_UNREACHABLE: Final = "mcp_proxy_unreachable"
CODE_RESPONSE_TOO_LARGE: Final = "mcp_proxy_response_too_large"
CODE_CONCURRENT: Final = "mcp_too_many_concurrent_calls"


def refusal_body(code: str) -> bytes:
    """A refusal of the door itself, in the shape of the app's (`docs/mcp-runtime.md`)."""
    document = {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": code}}
    return json.dumps(document, separators=(",", ":")).encode("ascii")


@dataclass(frozen=True)
class AppAccess:
    """Where the app is and the credential of the job. `__repr__` shows neither the address nor the
    credential."""

    app_url: str
    job_id: str
    credential: str

    def __repr__(self) -> str:
        return "AppAccess(...)"

    def route(self, server_id: str) -> str:
        return f"{self.app_url.rstrip('/')}/api/workers/v1/jobs/{quote(self.job_id, safe='')}/mcp/{
            quote(server_id, safe='')
        }"


def session_ended(status: int) -> bool:
    """Whether the answer to a `DELETE` of a session means it is over."""
    return 200 <= status < 300 or status in _ENDED_STATUS_OTHER


def _start_thread(target: Callable[..., None], args: tuple[Any, ...]) -> threading.Thread:
    """A started daemon thread; raises `RuntimeError` when the process cannot have one more."""
    thread = threading.Thread(target=target, args=args, daemon=True)
    thread.start()
    return thread


@dataclass
class RelayCounts:
    calls: int = 0
    opened: int = 0
    closed: int = 0


class _Body(Protocol):
    def read(self, count: int = ..., /) -> bytes: ...

    def close(self) -> None: ...


@dataclass
class _Upstream:
    """The app's answer: an open response (read it, then close it)."""

    status: int
    headers: dict[str, str]
    body: _Body

    def close(self) -> None:
        with contextlib.suppress(Exception):  # closing a broken response must not raise
            self.body.close()


Sleeper = Callable[[float], None]


def _is_token(value: str | None) -> bool:
    return value is not None and _TOKEN.fullmatch(value) is not None


def _lowered(headers: Any) -> dict[str, str]:
    return {name.lower(): value for name, value in headers.items()}


class McpRelay:
    """The state of one door: the servers, the access, the open sessions and the opener."""

    def __init__(
        self,
        access: AppAccess,
        servers: frozenset[str],
        *,
        proxy: OuterProxy | None = None,
        sleeper: Sleeper = time.sleep,
        opener: urllib.request.OpenerDirector | None = None,
        socket_timeout: float = SOCKET_TIMEOUT_SECONDS,
    ) -> None:
        self._access: AppAccess | None = access
        self.servers = servers
        self._opener = opener or build_opener(None if proxy is None else proxy.url)
        self._sleep = sleeper
        self._lock = threading.Lock()
        self._sessions: dict[tuple[str, str], None] = {}
        # Sessions the app opened beyond the tracked ones: never ended by the door, always left.
        self._untracked: set[tuple[str, str]] = set()
        self._untracked_overflow = 0
        self._socket_timeout = socket_timeout
        self._slots = threading.BoundedSemaphore(MAX_IN_FLIGHT)
        self.counts = RelayCounts()
        self._closing = False

    # -- the call to the app --------------------------------------------------------------

    def _request(
        self,
        method: str,
        server_id: str,
        body: bytes | None,
        session_id: str | None,
        protocol_version: str | None,
        timeout: float,
    ) -> _Upstream:
        """One request to the app; an error status is an answer like any other. Raises `OSError`
        for a connection that failed or broke (and `http.client.HTTPException`)."""
        access = self._access
        if access is None:
            raise OSError("the door has dropped its credential")
        headers = {
            "Authorization": f"Bearer {access.credential}",
            "Accept": "application/json, text/event-stream",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        if session_id is not None:
            headers["Mcp-Session-Id"] = session_id
        if protocol_version is not None:
            headers["MCP-Protocol-Version"] = protocol_version
        request = urllib.request.Request(
            access.route(server_id), data=body, headers=headers, method=method
        )
        try:
            response: Any = self._opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        except urllib.error.URLError as error:
            raise OSError("the app could not be reached") from error.__cause__
        return _Upstream(
            status=int(response.status if hasattr(response, "status") else response.code),
            headers=_lowered(response.headers),
            body=cast("_Body", response),
        )

    def call(
        self,
        method: str,
        server_id: str,
        body: bytes | None,
        session_id: str | None,
        protocol_version: str | None,
        timeout: float = UPSTREAM_TIMEOUT_SECONDS,
    ) -> _Upstream:
        """The request to the app, with the one allowed retry: a `429 mcp_too_many_concurrent_calls`
        that says when to come back. Everything else, a `503` first, is the answer."""
        reply = self._request(method, server_id, body, session_id, protocol_version, timeout)
        wait = _retry_wait(reply)
        if wait is None:
            return reply
        text = _small(reply.body)
        reply.close()
        if _error_message(text) != CODE_CONCURRENT:
            return _Upstream(reply.status, reply.headers, _Bytes(text))
        self._sleep(wait)
        return self._request(method, server_id, body, session_id, protocol_version, timeout)

    # -- sessions ------------------------------------------------------------------------

    def remember(self, server_id: str, session_id: str) -> None:
        with self._lock:
            key = (server_id, session_id)
            if key in self._sessions or key in self._untracked:
                return
            if len(self._sessions) >= MAX_OPEN_SESSIONS:
                # Not tracked, so never ended by the door: counted, to be said as left.
                if len(self._untracked) < MAX_UNTRACKED_SESSIONS:
                    self._untracked.add(key)
                else:
                    self._untracked_overflow += 1
                return
            self._sessions[key] = None
            self.counts.opened += 1

    def forget(self, server_id: str, session_id: str) -> None:
        with self._lock:
            key = (server_id, session_id)
            self._sessions.pop(key, None)
            self._untracked.discard(key)

    def open_sessions(self) -> list[tuple[str, str]]:
        with self._lock:
            return list(self._sessions)

    def sessions_left(self) -> int:
        """The sessions that are not known to be ended: the tracked ones still open and those the
        door could not track."""
        with self._lock:
            return len(self._sessions) + len(self._untracked) + self._untracked_overflow

    def close_sessions(self) -> int:
        """`DELETE` every session that is still open, `CLOSE_PARALLEL` at a time, within
        `CLOSE_SECONDS`. A session is ended by a `2xx`, `404` or `405` only; anything else (a `409`
        after the claim ended, a `429` after the one retry, a `5xx`, a broken connection) leaves it
        open, and it is said in the final status. Returns how many sessions are left, those beyond
        the tracked ones included. Never raises: a thread that cannot be started means those
        sessions are left. The credential is dropped."""
        try:
            self._close_all()
        except Exception:  # the last word must come, whatever went wrong here
            _log.warning("the MCP sessions could not all be ended")
        finally:
            self._access = None
        return self.sessions_left()

    def _close_all(self) -> None:
        pending = self.open_sessions()
        if not pending:
            return
        work: queue.SimpleQueue[tuple[str, str]] = queue.SimpleQueue()
        for key in pending:
            work.put(key)
        deadline = time.monotonic() + CLOSE_SECONDS
        threads: list[threading.Thread] = []
        for _ in range(min(CLOSE_PARALLEL, len(pending))):
            try:
                threads.append(_start_thread(self._close_worker, (work, deadline)))
            except RuntimeError:
                break  # no more threads: the ones that run take what is left, or nothing is ended
        for thread in threads:
            thread.join(max(0.0, deadline - time.monotonic()))

    def _close_worker(self, work: "queue.SimpleQueue[tuple[str, str]]", deadline: float) -> None:
        while time.monotonic() < deadline:
            try:
                server_id, session_id = work.get_nowait()
            except queue.Empty:
                return
            self._close_one(server_id, session_id)

    def _close_one(self, server_id: str, session_id: str) -> None:
        try:
            # Through `call`: a `429 mcp_too_many_concurrent_calls` is asked once more.
            reply = self.call("DELETE", server_id, None, session_id, None, CLOSE_CALL_SECONDS)
        except (OSError, http.client.HTTPException):
            return
        status = reply.status
        reply.close()
        if session_ended(status):
            self.forget(server_id, session_id)
            with self._lock:
                self.counts.closed += 1

    # -- the endpoint -------------------------------------------------------------------

    def handler_class(self) -> type[BaseHTTPRequestHandler]:
        relay = self

        class Handler(BaseHTTPRequestHandler):
            # One request per connection: an event stream ends by closing it, and the agent's
            # client reads a body without a length to its end.
            protocol_version = "HTTP/1.0"
            server_version = "mcp-door"
            sys_version = ""
            # A client that stops sending, or reading, is let go of after this long.
            timeout = relay._socket_timeout  # pyright: ignore[reportPrivateUsage]

            def log_message(self, format: str, *args: Any) -> None:
                return None

            def do_POST(self) -> None:
                relay._serve(self, "POST")  # pyright: ignore[reportPrivateUsage]

            def do_DELETE(self) -> None:
                relay._serve(self, "DELETE")  # pyright: ignore[reportPrivateUsage]

            def do_GET(self) -> None:
                relay._not_allowed(self)  # pyright: ignore[reportPrivateUsage]

            do_PUT = do_PATCH = do_OPTIONS = do_HEAD = do_GET

        return Handler

    def _not_allowed(self, handler: BaseHTTPRequestHandler) -> None:
        handler.send_response(405)
        handler.send_header("Allow", "POST, DELETE")
        handler.send_header("Content-Length", "0")
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()

    def _refuse(
        self, handler: BaseHTTPRequestHandler, status: int, code: str, **extra: str
    ) -> None:
        body = refusal_body(code)
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Cache-Control", "no-store")
        for name, value in extra.items():
            handler.send_header(name.replace("_", "-"), value)
        handler.end_headers()
        handler.wfile.write(body)

    def _serve(self, handler: BaseHTTPRequestHandler, method: str) -> None:
        match = _PATH.fullmatch(handler.path)
        server_id = match.group(1).lower() if match else None
        if server_id is None or server_id not in self.servers:
            self._drain_refusal(handler, 404, CODE_UNAVAILABLE)
            return
        session_id = handler.headers.get("Mcp-Session-Id")
        protocol_version = handler.headers.get("MCP-Protocol-Version")
        if (session_id is not None and not _is_token(session_id)) or (
            protocol_version is not None and not _is_token(protocol_version)
        ):
            self._drain_refusal(handler, 400, CODE_INVALID)
            return
        body: bytes | None = None
        if method == "POST":
            length_text = handler.headers.get("Content-Length")
            if length_text is None or _LENGTH.fullmatch(length_text) is None:
                self._refuse(handler, 400, CODE_INVALID)
                return
            length = int(length_text)
            if length > MAX_REQUEST_BYTES:
                self._refuse(handler, 413, CODE_TOO_LARGE)
                return
            body = handler.rfile.read(length)
            if len(body) != length:
                return
        if not self._slots.acquire(blocking=False):
            self._refuse(handler, 429, CODE_CONCURRENT)
            return
        try:
            self._forward(handler, method, server_id, body, session_id, protocol_version)
        finally:
            self._slots.release()

    def _drain_refusal(self, handler: BaseHTTPRequestHandler, status: int, code: str) -> None:
        self._refuse(handler, status, code)

    def _forward(
        self,
        handler: BaseHTTPRequestHandler,
        method: str,
        server_id: str,
        body: bytes | None,
        session_id: str | None,
        protocol_version: str | None,
    ) -> None:
        with self._lock:
            self.counts.calls += 1
        try:
            reply = self.call(method, server_id, body, session_id, protocol_version)
        except (OSError, http.client.HTTPException):
            self._refuse(handler, 503, CODE_UNREACHABLE)
            return
        try:
            self._relay(handler, method, server_id, session_id, reply)
        finally:
            reply.close()

    def _relay(
        self,
        handler: BaseHTTPRequestHandler,
        method: str,
        server_id: str,
        sent_session: str | None,
        reply: _Upstream,
    ) -> None:
        returned = reply.headers.get("mcp-session-id")
        if method == "POST" and _is_token(returned) and 200 <= reply.status < 300:
            assert returned is not None
            self.remember(server_id, returned)
        if method == "DELETE" and sent_session is not None and session_ended(reply.status):
            self.forget(server_id, sent_session)
        content_type = reply.headers.get("content-type")
        streaming = content_type is not None and content_type.lower().startswith(
            "text/event-stream"
        )
        head = {"Cache-Control": "no-store"}
        if content_type is not None and _CONTENT_TYPE.fullmatch(content_type):
            head["Content-Type"] = content_type
        if _is_token(returned):
            assert returned is not None
            head["Mcp-Session-Id"] = returned
        try:
            if streaming:
                handler.send_response(reply.status)
                for name, value in head.items():
                    handler.send_header(name, value)
                handler.end_headers()
                self._stream(handler, reply)
                return
            try:
                data = reply.body.read(MAX_RESPONSE_BYTES)
            except (OSError, http.client.HTTPException):
                # The app's answer broke off: not an empty `200`, which the agent would take for
                # the server's answer.
                self._refuse(handler, 503, CODE_UNREACHABLE)
                return
            if len(data) > MAX_RESPONSE_BYTES - 1:
                self._refuse(handler, 503, CODE_RESPONSE_TOO_LARGE)
                return
            declared = reply.headers.get("content-length", "")
            if _LENGTH.fullmatch(declared) is not None and len(data) < int(declared):
                # `read(amount)` does not say that a body ended before its length.
                self._refuse(handler, 503, CODE_UNREACHABLE)
                return
            handler.send_response(reply.status)
            for name, value in head.items():
                handler.send_header(name, value)
            handler.send_header("Content-Length", str(len(data)))
            handler.end_headers()
            handler.wfile.write(data)
        except (OSError, http.client.HTTPException):
            # The agent let go: the request to the app ends with `reply.close()` of the caller.
            return

    def _stream(self, handler: BaseHTTPRequestHandler, reply: _Upstream) -> None:
        read = getattr(reply.body, "read1", None) or reply.body.read
        sent = 0
        while True:
            try:
                chunk: bytes = read(_CHUNK)
            except (OSError, http.client.HTTPException):
                return
            if not chunk:
                return
            sent += len(chunk)
            handler.wfile.write(chunk)
            handler.wfile.flush()
            if sent > MAX_RESPONSE_BYTES:
                return


class _Bytes:
    """A body that was read already, as an answer to pass on."""

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._at = 0

    def read(self, count: int = -1) -> bytes:
        end = len(self._data) if count < 0 else self._at + count
        chunk = self._data[self._at : end]
        self._at += len(chunk)
        return chunk

    read1 = read

    def close(self) -> None:
        return None


def _small(body: _Body, limit: int = 4096) -> bytes:
    try:
        return body.read(limit)
    except (OSError, http.client.HTTPException):
        return b""


def _error_message(body: bytes) -> str | None:
    try:
        document: Any = json.loads(body)
    except (ValueError, RecursionError):
        return None
    given = as_object(document)
    error = as_object(given.get("error")) if given is not None else None
    message = error.get("message") if error is not None else None
    return message if isinstance(message, str) else None


def _retry_wait(reply: _Upstream) -> float | None:
    """The seconds a `429 ... Retry-After` asks for; None for any other answer."""
    if reply.status != 429:
        return None
    raw = reply.headers.get("retry-after")
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        return None
    if seconds != seconds or seconds < 0:
        return None
    return min(seconds, MAX_RETRY_AFTER_SECONDS)


class _LimitedServer(ThreadingHTTPServer):
    """A server with a bound on its connections: one more than `max_connections` is answered `429`
    at once and closed, so that a flood (or a client that opens and goes silent) cannot take the
    threads of the container; a thread that cannot be started is the same refusal."""

    daemon_threads = True

    def __init__(
        self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], max_connections: int
    ) -> None:
        super().__init__(address, handler)
        self._places = threading.BoundedSemaphore(max_connections)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._places.acquire(blocking=False):
            self._turn_away(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:  # RuntimeError: can't start new thread
            self._places.release()
            self._turn_away(request)

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._places.release()

    def _turn_away(self, request: Any) -> None:
        body = refusal_body(CODE_CONCURRENT)
        head = (
            b"HTTP/1.0 429 Too Many Requests\r\nContent-Type: application/json\r\n"
            b"Cache-Control: no-store\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n"
        )
        try:
            request.settimeout(1.0)
            request.sendall(head + body)
        except OSError:
            pass
        self.shutdown_request(request)


def make_server(
    relay: McpRelay, host: str, port: int, *, max_connections: int = MAX_CONNECTIONS
) -> ThreadingHTTPServer:
    return _LimitedServer((host, port), relay.handler_class(), max_connections)
