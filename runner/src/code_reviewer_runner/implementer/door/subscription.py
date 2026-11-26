# SPDX-License-Identifier: LicenseRef-Proprietary

"""The subscription mode of the model door (#1176, epic #1175): a Claude Code turn on a
subscription token keeps the real token in the door, as a turn on an API key keeps the key there.

Claude Code needs `CLAUDE_CODE_OAUTH_TOKEN` and talks to Anthropic itself, so until now the token
was in the agent's container and the network had to be narrowed to keep it from leaving
(`claude_code/gates.py`). Measured with a real token (epic #1175): Claude Code takes any string as
its token, honours `ANTHROPIC_BASE_URL`, and a proxy that swaps `Authorization: Bearer <the
placeholder>` for the real token gets `200` on `/v1/messages`. So the agent is given **the
placeholder** (`SUBSCRIPTION_PLACEHOLDER`, a fixed value that opens nothing) and the door's address;
this module is the door:

* it reads the token from the start document on stdin, like the model door reads its key: in no
  argument, no environment variable, no file and no line it prints;
* it replaces exactly `Authorization: Bearer <placeholder>` with `Bearer <token>`, keeps every other
  header as sent (`anthropic-beta` carries the OAuth marker and must stay), and forwards **only to
  api.anthropic.com** on port 443 (`SUBSCRIPTION_UPSTREAM`: the request line is read as a path on
  that host, whatever the request says, and the host the agent names is not used);
* it **refuses any other credential**: a different bearer, any other scheme, `x-api-key`, a second
  `Authorization`, `Proxy-Authorization` (a `403`; nothing is forwarded). A request that carries
  none (`HEAD /api/hello`) passes through without one;
* it counts nothing and decides nothing about the model: there is no ledger (the money of a
  subscription turn is Claude Code's `--max-budget-usd` and the job's clock), and no request body is
  looked at beyond its length.

The door ends as the model door does: on `{"op": "stop"}`, on the end of stdin, and a while after
the turn's deadline.
"""

import contextlib
import hmac
import json
import re
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Final, cast

from code_reviewer_runner.dynamic_review.model_door_route import MODEL_DOOR_ADDRESS
from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    HttpsUpstream,
    Upstream,
    UpstreamError,
    UpstreamRequest,
)
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.outer_proxy import OuterProxy, OuterProxyError

from .protocol import (
    MAX_START_BYTES,
    REFUSED_LISTEN_FAILED,
    REFUSED_START_INVALID,
    VERSION,
    DoorRefused,
    DoorStatus,
)

# What the agent's container is given as `CLAUDE_CODE_OAUTH_TOKEN`. In the form of a token, a value
# the door recognises and Anthropic would refuse: it is not a secret and opens nothing.
SUBSCRIPTION_PLACEHOLDER: Final = "sk-ant-oat01-code-reviewer-door-placeholder-not-a-credential"
# The one destination of the door, and the host name the network policy and the Dispatcher's switch
# name for a turn of this kind.
SUBSCRIPTION_HOST: Final = "api.anthropic.com"
SUBSCRIPTION_UPSTREAM: Final = f"https://{SUBSCRIPTION_HOST}"
KIND: Final = "subscription"

MAX_TOKEN_CHARS: Final = 4096
_TOKEN: Final = re.compile(rf"[\x21-\x7e]{{1,{MAX_TOKEN_CHARS}}}")
_MIN_PORT = 1024
_MAX_PORT = 32767
_MAX_DEADLINE_SECONDS = 24 * 60 * 60
# The door ends itself this long after the turn's deadline if nobody stopped it.
LINGER_SECONDS: Final = 600.0
# A request body (the whole conversation, images included) is read to its length, at most this much.
MAX_BODY_BYTES: Final = 64 * 1024 * 1024
MAX_CONNECTIONS: Final = 16
FIRST_REQUEST_TIMEOUT_SECONDS: Final = 5.0
IDLE_TIMEOUT_SECONDS: Final = 120.0
IO_TIMEOUT_SECONDS: Final = 120.0
# The wait for connecting to Anthropic and for each read of the answer: a model that thinks for a
# long time says nothing in between.
UPSTREAM_SECONDS: Final = 600.0
CHUNK_BYTES: Final = 64 * 1024

_METHODS: Final = frozenset({"GET", "HEAD", "POST"})
# Headers that are the connection's, not the message's, and `host` (the door's own is the
# destination's). `content-length` is rebuilt from the body that was read.
_HOP_BY_HOP: Final = frozenset(
    {
        "host",
        "connection",
        "keep-alive",
        "proxy-connection",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "content-length",
        "expect",
    }
)
# Every other header that could carry a credential. The only one the door accepts is
# `Authorization: Bearer <placeholder>`.
_OTHER_CREDENTIALS: Final = frozenset(
    {
        "x-api-key",
        "proxy-authorization",
        "api-key",
        "x-goog-api-key",
        "x-auth-token",
        "anthropic-auth-token",
        "cookie",
    }
)
_RESPONSE_HOP_BY_HOP: Final = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-connection",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
    }
)


class SubscriptionStart:
    """The start document, read and checked. Holds the token; never printed."""

    def __init__(
        self,
        *,
        token: str,
        deadline_seconds: float,
        listen_port: int,
        outer_proxy: OuterProxy | None = None,
    ) -> None:
        self.token = token
        self.deadline_seconds = deadline_seconds
        self.listen_port = listen_port
        self.outer_proxy = outer_proxy

    def __repr__(self) -> str:
        return "SubscriptionStart(...)"


def is_subscription_document(text: str) -> bool:
    """Whether the first line of the door's stdin is a document of this mode (the model door's has
    no `kind`). A line that is not JSON is the model door's to refuse."""
    try:
        given = as_object(json.loads(text))
    except (ValueError, RecursionError):
        return False
    return given is not None and "kind" in given


def subscription_start_document(
    token: str,
    *,
    deadline_seconds: float,
    port: int,
    outer_proxy: OuterProxy | None = None,
) -> bytes:
    """The line written to the door's stdin (`protocol.py`). Holds the token."""
    document: dict[str, Any] = {
        "version": VERSION,
        "kind": KIND,
        "token": token,
        "deadlineSeconds": deadline_seconds,
        "listenPort": port,
    }
    if outer_proxy is not None:
        document["outerProxy"] = outer_proxy.to_json()
    return json.dumps(document, separators=(",", ":")).encode() + b"\n"


def parse_subscription_start(text: str) -> SubscriptionStart:
    """The start document of a line. Raises `DoorRefused` with a word; the text of the document is
    never part of an error."""
    if len(text) > MAX_START_BYTES:
        raise DoorRefused(REFUSED_START_INVALID)
    try:
        document: Any = json.loads(text)
    except (ValueError, RecursionError):
        raise DoorRefused(REFUSED_START_INVALID) from None
    given = as_object(document)
    keys = {"version", "kind", "token", "deadlineSeconds", "listenPort"}
    if given is None or not keys <= given.keys() <= keys | {"outerProxy"}:
        raise DoorRefused(REFUSED_START_INVALID)
    token: Any = given["token"]
    deadline: Any = given["deadlineSeconds"]
    port: Any = given["listenPort"]
    if (
        given["version"] != VERSION
        or given["kind"] != KIND
        or not isinstance(token, str)
        or _TOKEN.fullmatch(token) is None
        or isinstance(deadline, bool)
        or not isinstance(deadline, int | float)
        or not 0 < deadline <= _MAX_DEADLINE_SECONDS
        or isinstance(port, bool)
        or not isinstance(port, int)
        or not _MIN_PORT <= port <= _MAX_PORT
    ):
        raise DoorRefused(REFUSED_START_INVALID)
    outer_proxy: OuterProxy | None = None
    if "outerProxy" in given:
        try:
            outer_proxy = OuterProxy.from_json(given["outerProxy"])
        except OuterProxyError:
            raise DoorRefused(REFUSED_START_INVALID) from None
    return SubscriptionStart(
        token=token,
        deadline_seconds=float(deadline),
        listen_port=port,
        outer_proxy=outer_proxy,
    )


class _Refusal(Exception):
    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


def outgoing_headers(
    incoming: list[tuple[str, str]], token: str, placeholder: str = SUBSCRIPTION_PLACEHOLDER
) -> dict[str, str]:
    """The headers the provider is sent: the request's own, with the one `Authorization: Bearer
    <placeholder>` replaced by the token. `_Refusal` for any other credential."""
    outgoing: dict[str, str] = {}
    authorization: str | None = None
    for name, value in incoming:
        lower = name.lower()
        if lower in _OTHER_CREDENTIALS:
            raise _Refusal(403, "credential_refused")
        if lower == "authorization":
            if authorization is not None:
                raise _Refusal(403, "credential_refused")
            authorization = value
            continue
        if lower in _HOP_BY_HOP:
            continue
        if lower in {key.lower() for key in outgoing}:
            # A repeated header is joined, as HTTP says it may be (`anthropic-beta` is one).
            existing = next(key for key in outgoing if key.lower() == lower)
            outgoing[existing] = f"{outgoing[existing]}, {value}"
        else:
            outgoing[name] = value
    if authorization is not None:
        # The comparison is on the whole value, in constant time.
        if not hmac.compare_digest(authorization.encode(), f"Bearer {placeholder}".encode()):
            raise _Refusal(403, "credential_refused")
        outgoing["Authorization"] = f"Bearer {token}"
    return outgoing


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        *,
        token: str,
        upstream: Upstream,
        time_left: Callable[[], float],
    ) -> None:
        self.token = token
        self.upstream = upstream
        self.time_left = time_left
        self._slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        super().__init__(address, _Handler)

    def handle_error(self, request: Any, client_address: Any) -> None:
        return

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class _Handler(BaseHTTPRequestHandler):
    server_version = "code-reviewer-subscription-door/1"
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(FIRST_REQUEST_TIMEOUT_SECONDS)

    def _handle(self) -> None:
        server = cast(_Server, self.server)
        try:
            self._forward(server)
        except _Refusal as refusal:
            self._say(refusal.status, refusal.reason)
        except UpstreamError:
            self._say(502, "upstream_unavailable")
        except OSError:
            self.close_connection = True
        except Exception:
            self.close_connection = True
        with contextlib.suppress(OSError):
            self.connection.settimeout(IDLE_TIMEOUT_SECONDS)

    def _say(self, status: int, reason: str) -> None:
        body = reason.encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            self.wfile.flush()
        except OSError:
            pass
        self.close_connection = True

    def _forward(self, server: _Server) -> None:
        if self.command not in _METHODS:
            raise _Refusal(405, "method_not_allowed")
        target = self.path
        # Only a path on the one host: no absolute form (`http://...`), no authority form.
        if not target.startswith("/") or target.startswith("//") or "\\" in target:
            raise _Refusal(400, "target_refused")
        if self.headers.get("Transfer-Encoding") is not None:
            raise _Refusal(400, "chunked_request_refused")
        headers = outgoing_headers(list(self.headers.items()), server.token)
        body = self._read_body()
        remaining = server.time_left()
        if remaining <= 0:
            raise _Refusal(503, "turn_over")
        request = UpstreamRequest(target, headers, body, method=self.command)
        response = server.upstream.send(request, min(UPSTREAM_SECONDS, remaining))
        try:
            self._relay(response, server)
        finally:
            response.close()

    def _read_body(self) -> bytes:
        raw = self.headers.get("Content-Length")
        if raw is None:
            return b""
        if not raw.isdigit() or len(raw) > 12:
            raise _Refusal(400, "content_length_refused")
        length = int(raw)
        if length > MAX_BODY_BYTES:
            raise _Refusal(413, "body_too_large")
        self.connection.settimeout(IO_TIMEOUT_SECONDS)
        data = self.rfile.read(length)
        if len(data) != length:
            raise OSError("the request body stopped")
        return data

    def _relay(self, response: Any, server: _Server) -> None:
        length: str | None = None
        kept: list[tuple[str, str]] = []
        for name, value in response.headers:
            lower = name.lower()
            if lower == "content-length":
                length = value
            elif lower not in _RESPONSE_HOP_BY_HOP:
                kept.append((name, value))
        head = self.command == "HEAD"
        chunked = length is None and not head and response.status not in (204, 304)
        self.send_response(response.status)
        for name, value in kept:
            self.send_header(name, value)
        if length is not None:
            self.send_header("Content-Length", length)
        elif chunked:
            self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self.wfile.flush()
        if head or response.status in (204, 304):
            return
        try:
            while True:
                chunk = response.read(CHUNK_BYTES, UPSTREAM_SECONDS)
                if not chunk:
                    break
                self.connection.settimeout(IO_TIMEOUT_SECONDS)
                if chunked:
                    self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                else:
                    self.wfile.write(chunk)
                self.wfile.flush()
            if chunked:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except UpstreamError:
            # The answer stopped before its end: the agent sees the connection end, not a
            # complete answer.
            self.close_connection = True
            with contextlib.suppress(OSError):
                self.connection.shutdown(2)

    do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _handle

    def log_message(self, format: str, *args: Any) -> None:
        return  # a request line could carry data


class SubscriptionDoor:
    """The server of one turn, with the interface `run_door` drives (`ModelDoor`'s): `start()`,
    `status()`, `overdue()`, `stop()`."""

    def __init__(
        self,
        start: SubscriptionStart,
        *,
        bind: tuple[str, int] | None = None,
        upstream_for: Callable[[str], Upstream] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._start = start
        self._bind = bind or (MODEL_DOOR_ADDRESS, start.listen_port)
        proxy = start.outer_proxy
        factory: Callable[[str], Upstream] = upstream_for or (
            HttpsUpstream
            if proxy is None
            else (lambda base_url: HttpsUpstream(base_url, proxy=proxy))
        )
        # The one destination, fixed here and in no document.
        self._upstream = factory(SUBSCRIPTION_UPSTREAM)
        self._clock = clock
        self._began = clock()
        self._server: _Server | None = None
        self._thread: threading.Thread | None = None
        self._seq = 0

    def announce_changes_to(self, announce: Callable[[], None]) -> None:
        """Nothing here changes a ledger: there is none."""

    def _time_left(self) -> float:
        return self._start.deadline_seconds + LINGER_SECONDS - (self._clock() - self._began)

    def start(self) -> None:
        try:
            self._server = _Server(
                self._bind,
                token=self._start.token,
                upstream=self._upstream,
                time_left=self._time_left,
            )
        except OSError:
            raise DoorRefused(REFUSED_LISTEN_FAILED) from None
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def status(self, *, final: bool = False) -> DoorStatus:
        self._seq += 1
        return DoorStatus(
            seq=self._seq,
            final=final,
            model_used=False,
            open_calls=0,
            failure=None,
            upstream_error=None,
            usage={
                "promptTokens": 0,
                "completionTokens": 0,
                "totalTokens": 0,
                "aiCalls": 0,
                "costUsd": 0,
            },
        )

    def overdue(self) -> bool:
        return self._clock() - self._began > self._start.deadline_seconds + LINGER_SECONDS

    def stop(self) -> None:
        server, self._server = self._server, None
        if server is None:
            return
        server.shutdown()
        server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
