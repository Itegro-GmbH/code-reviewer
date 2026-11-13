# SPDX-License-Identifier: LicenseRef-Proprietary

"""A scripted provider for one wire family (#546): strict about the key, the path and the model.

It answers the chat call of the family in `formats.py` (a JSON document, or server-sent events when
the request asks for a stream), taking the next `Turn` of its script for every request that offers
tools and a short text for every other request (a title). It is as strict as the real provider is
about what a passthrough must get right:

- the real key, and only that, in the header of the family (a bearer token in `authorization`, the
  bare key in `x-api-key` or `x-goog-api-key`); the dummy key of the engine is a 401;
- the Messages API wants an `anthropic-version` header (400 without it);
- exactly one path per family, and for Google the model and the choice of stream in that path
  (`/v1beta/models/<model>:streamGenerateContent`); any other path or method is a 404, and so is a
  model other than the one it serves;
- faults of a test's choice: a status for the next requests (`fail_next`, with a `retry-after` of
  the test's choice), a stream that is cut after some events (`cut_streams`), a stream that ends in
  an error event after HTTP 200 (`error_in_stream`), an answer compressed with gzip for a client
  that accepts it (`compress`), error messages that quote the key they were sent (`quote_key`), and
  an answer without a `Content-Length` (`close_delimited`);
- a fault in the usage of every answer (`usage_fault`, #551: left out, a field nobody can price, a
  count that is no count);
- framing variants of a stream, so that a reader is not written against the tidy case: re-chunked
  at arbitrary byte boundaries (`rechunk`), CRLF line ends (`crlf`) and, for Google, `usageMetadata`
  on every chunk (`google_cumulative_usage`, an assumption about the real stream).

An invalid key is a 401 for every family here. ASSUMPTION, unconfirmed: Gemini answers a bad key
with HTTP 400 and `API_KEY_INVALID`; the live checklist asks for the real status.

A failed or cut request does not use up a turn of the script, so a retry gets the same answer. Every
request is kept, with its headers and body. Dummy keys only; nothing here leaves loopback.
"""

import gzip
import hashlib
import json
import ssl
import threading
import zlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import TracebackType
from typing import Any, Self, cast
from urllib.parse import urlsplit

from fakes.wire.formats import (
    AUTH_HEADER,
    Family,
    Turn,
    UsageFault,
    answer,
    auth_value,
    error_body,
    error_event,
    is_stream,
    request_path,
    request_tool_names,
    stream,
)

Refusal = tuple[int, dict[str, Any]]
# A stricter rule set of a test (for example the Messages API's rules about thinking blocks): the
# refusal of a request, or None; and a hook that sees every answer that was given.
Judge = Callable[[Mapping[str, str], Mapping[str, Any]], Refusal | None]
OnAnswer = Callable[[Mapping[str, Any], Mapping[str, Any]], None]


@dataclass(frozen=True)
class Record:
    """One request as the upstream received it."""

    method: str
    target: str
    headers: dict[str, str]
    body: Any
    sha256: str


def _object(value: object) -> dict[str, Any] | None:
    return cast("dict[str, Any]", value) if isinstance(value, dict) else None


def _invalid(family: Family, status: int, message: str) -> dict[str, Any]:
    if family == "messages":
        body = error_body(family, status)
        body["error"]["message"] = message
        return body
    return {"error": {"message": message, "code": status}}


def _asks_for_usage(body: Mapping[str, Any]) -> bool:
    """Whether a Chat request asks for the usage: `stream_options.include_usage`, or OpenRouter's
    `usage: {include: true}` (what the OpenRouter SDK of the pinned engine sends instead)."""
    options = _object(body.get("stream_options"))
    openrouter = _object(body.get("usage"))
    return bool(
        (options and options.get("include_usage")) or (openrouter and openrouter.get("include"))
    )


class ScriptedUpstream:
    def __init__(
        self,
        family: Family,
        script: Sequence[Turn],
        model: str,
        *,
        real_key: str,
        judge: Judge | None = None,
        on_answer: OnAnswer | None = None,
        also_models: Sequence[str] = (),
        tls: ssl.SSLContext | None = None,
    ) -> None:
        self.family: Family = family
        self.model = model
        # The models it serves: the one of the job and, for a test that needs it, others.
        self.models = (model, *also_models)
        self.records: list[Record] = []
        self.compress = False
        # Error messages quote the key of the request (a real provider may: OpenAI does, masked).
        self.quote_key = False
        # Answer a JSON document without Content-Length and close the connection after it.
        self.close_delimited = False
        # Bytes per HTTP chunk of a stream (None: one chunk per event), CRLF line ends, and Google's
        # `usageMetadata` on every chunk.
        self.rechunk: int | None = None
        self.crlf = False
        self.google_cumulative_usage = False
        # What is wrong with the usage of every answer (#551): left out, a field nobody can price,
        # or a count that is no count.
        self.usage_fault: UsageFault | None = None
        self._script = list(script)
        self._real_key = real_key
        self._judge = judge
        self._on_answer = on_answer
        self._served = 0
        self._failures: list[tuple[int, str | None]] = []
        self._cut_after: int | None = None
        self._cuts_left = 0
        self._error_after: int | None = None
        self._errors_left = 0
        self._lock = threading.Lock()
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def handle_any(self) -> None:
                upstream._handle(self)

            do_GET = do_POST = do_PUT = do_DELETE = handle_any

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._scheme = "https" if tls is not None else "http"
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        if tls is not None:
            # https on the loopback (#999: the lane's provider has a certificate the Worker image
            # trusts); the clients are the same, only the socket is wrapped.
            self._server.socket = tls.wrap_socket(self._server.socket, server_side=True)
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )

    @property
    def port(self) -> int:
        return int(self._server.server_address[1])

    @property
    def url(self) -> str:
        return f"{self._scheme}://127.0.0.1:{self.port}"

    def __enter__(self) -> Self:
        self._thread.start()
        return self

    def __exit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        trace: TracebackType | None,
    ) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)

    def restart(self) -> None:
        """Start the script from its first turn again (for a test that asks several times)."""
        with self._lock:
            self._served = 0

    def reset_faults(self) -> None:
        """Forget every fault that was set and has not happened yet (framing options stay)."""
        with self._lock:
            self._failures.clear()
            self._cut_after, self._cuts_left = None, 0
            self._error_after, self._errors_left = None, 0
            self.compress = self.quote_key = self.close_delimited = False
            self.usage_fault = None

    # -- faults ---------------------------------------------------------------------------------

    def fail_next(self, *statuses: int, retry_after: str | None = None) -> None:
        """Answer the next requests with these statuses.

        429 and 503 carry `retry-after: 0` unless `retry_after` says otherwise; every other status
        carries none unless `retry_after` is given.
        """
        with self._lock:
            self._failures.extend((status, retry_after) for status in statuses)

    def cut_streams(self, *, after_events: int, times: int = 1) -> None:
        """Drop the connection of the next `times` streams after `after_events` events."""
        with self._lock:
            self._cut_after, self._cuts_left = after_events, times

    def error_in_stream(self, *, after_events: int, times: int = 1) -> None:
        """End the next `times` streams after `after_events` events with an error event.

        The status is 200 and the stream is closed properly: the failure is only in the event.
        """
        with self._lock:
            self._error_after, self._errors_left = after_events, times

    # -- one request ----------------------------------------------------------------------------

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length") or 0)
        raw = handler.rfile.read(length) if length else b""
        headers = {name.lower(): value for name, value in handler.headers.items()}
        body: Any = None
        if raw:
            try:
                body = json.loads(raw)
            except ValueError:
                body = raw.decode("utf-8", "replace")
        record = Record(
            handler.command, handler.path, headers, body, hashlib.sha256(raw).hexdigest()
        )
        with self._lock:
            self.records.append(record)
            index = len(self.records)
            failure = self._failures.pop(0) if self._failures else None
        refusal = self._refusal(record, failure[0] if failure else None)
        if refusal is not None:
            waiting = failure[1] if failure else None
            if waiting is None and refusal[0] in (429, 503):
                waiting = "0"
            self._send_json(
                handler, refusal[0], refusal[1], {"retry-after": waiting} if waiting else {}
            )
            return
        document: Mapping[str, Any] = body
        tools = request_tool_names(self.family, document)
        path = urlsplit(handler.path).path
        with self._lock:
            served = self._served
        turn = self._script[min(served, len(self._script) - 1)] if tools else Turn(text="A title")
        call = served + 1 if tools else 100 + index
        if self._on_answer is not None and not is_stream(self.family, path, document):
            self._on_answer(
                document, answer(self.family, turn, call, self.model, usage_fault=self.usage_fault)
            )
        if not is_stream(self.family, path, document):
            # The turn is used up before the answer leaves: a client that asks again, or a test that
            # restarts the script, the moment it has the answer must find it counted (#567).
            self._served_one(bool(tools))
            self._send_json(
                handler,
                200,
                answer(self.family, turn, call, self.model, usage_fault=self.usage_fault),
            )
            return
        if self._on_answer is not None:
            self._on_answer(
                document, answer(self.family, turn, call, self.model, usage_fault=self.usage_fault)
            )
        events = stream(
            self.family,
            turn,
            call,
            self.model,
            # A Chat request without `stream_options.include_usage` gets no usage in the stream.
            include_usage=_asks_for_usage(document),
            cumulative_usage=self.google_cumulative_usage,
            crlf=self.crlf,
            usage_fault=self.usage_fault,
        )
        self._send_stream(handler, events, used_up=lambda: self._served_one(bool(tools)))

    def _served_one(self, with_tools: bool) -> None:
        if with_tools:
            with self._lock:
                self._served += 1

    def _refusal(self, record: Record, failure: int | None) -> Refusal | None:
        family = self.family
        sent = record.headers.get(AUTH_HEADER[family], "")
        quoted = f" (key: {sent.removeprefix('Bearer ')})" if self.quote_key else ""
        if sent != auth_value(family, self._real_key):
            return 401, _invalid(family, 401, "invalid key" + quoted)
        if family == "messages" and "anthropic-version" not in record.headers:
            return 400, _invalid(family, 400, "anthropic-version: header is required")
        path = urlsplit(record.target).path
        body = _object(record.body)
        streaming = is_stream(family, path, body)
        routes = {request_path(family, model, streaming=streaming) for model in self.models}
        if record.method != "POST" or path not in routes:
            return 404, _invalid(family, 404, f"no route for {record.method} {path}")
        if family != "google" and (body is None or body.get("model") not in self.models):
            return 404, _invalid(family, 404, "model not found")
        if failure:
            return failure, error_body(family, failure, quoted.strip())
        if self._judge is not None and body is not None:
            return self._judge(record.headers, body)
        return None

    def _send_json(
        self,
        handler: BaseHTTPRequestHandler,
        status: int,
        document: Mapping[str, Any],
        extra: Mapping[str, str] | None = None,
    ) -> None:
        payload = json.dumps(document).encode()
        encoded = self._accepts_gzip(handler)
        if encoded:
            payload = gzip.compress(payload)
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        if encoded:
            handler.send_header("Content-Encoding", "gzip")
        if self.close_delimited:
            handler.send_header("Connection", "close")
            handler.close_connection = True
        else:
            handler.send_header("Content-Length", str(len(payload)))
        for name, value in (extra or {}).items():
            handler.send_header(name, value)
        handler.end_headers()
        handler.wfile.write(payload)

    def _accepts_gzip(self, handler: BaseHTTPRequestHandler) -> bool:
        return self.compress and "gzip" in (handler.headers.get("Accept-Encoding") or "")

    def _send_stream(
        self,
        handler: BaseHTTPRequestHandler,
        events: list[bytes],
        used_up: Callable[[], None],
    ) -> None:
        """Send the events as a chunked stream. `used_up` counts the turn, before the first byte
        leaves, unless the stream is to end badly on purpose (a cut or an error event): that one
        leaves the turn for the retry."""
        encoder = zlib.compressobj(wbits=31) if self._accepts_gzip(handler) else None
        with self._lock:
            cut_after = self._cut_after if self._cuts_left > 0 else None
            error_after = self._error_after if self._errors_left > 0 else None
        completed, cut = True, False
        pieces = events
        if error_after is not None and error_after < len(events):
            with self._lock:
                self._errors_left -= 1
            pieces, completed = [*events[:error_after], error_event(self.family)], False
        if cut_after is not None and cut_after < len(pieces):
            with self._lock:
                self._cuts_left -= 1
            pieces, completed, cut = pieces[:cut_after], False, True
        if completed:
            used_up()
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Transfer-Encoding", "chunked")
        if encoder is not None:
            handler.send_header("Content-Encoding", "gzip")
        handler.end_headers()
        for data in self._framed(pieces):
            if encoder is not None:
                data = encoder.compress(data) + encoder.flush(zlib.Z_SYNC_FLUSH)
            handler.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            handler.wfile.flush()
        if cut:
            handler.close_connection = True
            handler.connection.shutdown(2)
            return
        if encoder is not None:
            tail = encoder.flush()
            if tail:
                handler.wfile.write(f"{len(tail):x}\r\n".encode() + tail + b"\r\n")
        handler.wfile.write(b"0\r\n\r\n")

    def _framed(self, events: list[bytes]) -> list[bytes]:
        """The HTTP chunks of a stream: one per event, or `rechunk` bytes each at any boundary."""
        if self.rechunk is None:
            return events
        whole = b"".join(events)
        return [whole[at : at + self.rechunk] for at in range(0, len(whole), self.rechunk)]
