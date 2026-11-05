# SPDX-License-Identifier: LicenseRef-Proprietary

"""The HTTP pieces the runner API client and the Worker API client share.

One blocking request without proxy and without redirects (a redirect or a proxy would carry the
token to wherever it points), the answer reduced to status, headers and a bounded body, and the
readers for the parts of an answer both clients look at. No error here carries a value of the
request or the response: they hold secrets.
"""

import http.client
import json
import re
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from code_reviewer_runner.job_loop.jsonvalues import as_object

MAX_RESPONSE_BYTES = 1024 * 1024
MAX_RETRY_AFTER_SECONDS = 15 * 60
# The body is read in pieces of this size when a deadline is given.
READ_PIECE_BYTES = 64 * 1024


class ApiError(Exception):
    """Base of the errors of both API clients. `status` is the HTTP status, or None without one."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class ApiUnavailable(ApiError):
    def __init__(
        self, message: str, status: int | None = None, retry_after: float | None = None
    ) -> None:
        super().__init__(message, status)
        self.retry_after = retry_after


class LeaseLost(ApiError):
    pass


class ApiRejected(ApiError):
    def __init__(self, message: str, status: int, code: str | None) -> None:
        super().__init__(message, status)
        self.code = code


class NoRedirects(urllib.request.HTTPRedirectHandler):
    """A redirect would carry the token to wherever it points: refuse it instead."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        return None


@dataclass(frozen=True)
class Reply:
    status: int
    headers: Mapping[str, str]
    body: bytes


def build_opener() -> urllib.request.OpenerDirector:
    # No proxy: the token must only go to the app, and the app is reached directly.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects)


def retry_after(headers: Mapping[str, str]) -> float | None:
    raw = headers.get("Retry-After")
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        return None
    return min(max(seconds, 0.0), MAX_RETRY_AFTER_SECONDS) if seconds == seconds else None


def parse_json(reply: Reply) -> Any:
    try:
        return json.loads(reply.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def error_code(reply: Reply) -> str | None:
    body = as_object(parse_json(reply))
    error = as_object(body.get("error")) if body else None
    code = error.get("code") if error else None
    if isinstance(code, str) and re.fullmatch(r"[A-Z_]{1,64}", code):
        return code
    return None


def send(
    opener: urllib.request.OpenerDirector,
    request: urllib.request.Request,
    timeout: float,
    max_bytes: int = MAX_RESPONSE_BYTES,
    deadline: float | None = None,
) -> Reply:
    """Make the request; any answer is a `Reply`, no answer is `ApiUnavailable`. At most `max_bytes`
    of the body are read (a caller that expects more says so, and checks what it got).

    `timeout` bounds each wait of the socket, not the call: a server that sends a byte now and then
    keeps `read` going for as long as it likes. With `deadline` (a `time.monotonic` value) the body
    is read in pieces and the call ends with `ApiUnavailable` once it has passed."""
    try:
        with opener.open(request, timeout=timeout) as response:
            if deadline is None:
                body = response.read(max_bytes)
            else:
                body = _read_until(response, max_bytes, deadline)
            return Reply(response.status, dict(response.headers), body)
    except urllib.error.HTTPError as error:
        try:
            body_bytes = error.read(MAX_RESPONSE_BYTES)
        except Exception:
            body_bytes = b""
        return Reply(error.code, dict(error.headers), body_bytes)
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as error:
        # The class of the error is enough: its text can hold the URL.
        raise ApiUnavailable(f"no answer from the app ({type(error).__name__})") from None


def _read_until(response: Any, max_bytes: int, deadline: float) -> bytes:
    pieces: list[bytes] = []
    left = max_bytes
    while left > 0:
        if time.monotonic() >= deadline:
            raise ApiUnavailable("the answer did not arrive in time")
        # `read1`: what one wait of the socket brings (`read(n)` waits for all n bytes).
        piece: bytes = response.read1(min(READ_PIECE_BYTES, left))
        if not piece:
            break
        pieces.append(piece)
        left -= len(piece)
    return b"".join(pieces)
