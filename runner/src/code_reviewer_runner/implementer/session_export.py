# SPDX-License-Identifier: LicenseRef-Proprietary

"""The engine's session as a file, just before the agent's container is killed (#839): what a
follow-up turn (#745) imports on a new VM so the agent still has its conversation.

The export is taken **over the engine's HTTP API only**, as the spike measured it on a real VM
(`docs/implementer.md`, "Follow-up turns: what was measured on a real VM"): `GET /session/<id>` for
the session and `GET /session/<id>/message` in pages of `PAGE_SIZE`, newest page first with the
cursor in the `x-next-cursor` header, so the pages are put back in order. That document is equal to
`opencode export`'s, without a second engine process (312 MiB; two in a row got the agent's
container killed by the memory guard) and without the CLI cutting its output at the size of a pipe.

What is done to it, in this order:

1. The output of a tool part the engine's prune marked as compacted (`state.time.compacted`) and
   the long strings of that part's metadata (a tool repeats its output there) are emptied. The
   model is sent a fixed text in their place, so the follow-up sees exactly the history it would
   have seen (measured: the same 137 messages). It is done before the redaction only because there
   is then less to redact; the order does not change the result.
2. The redactor of the turn is applied to **every string value and key**, never to the JSON text:
   its `Bearer ...` shape runs up to a quote, and in JSON text the quote it eats is the backslash of
   an escaped one, which broke the document in the spike.
3. Compact JSON with ASCII escapes (a lone surrogate in a text cannot be encoded as UTF-8), gzip
   with no time in its header, and a cap of `CAP_BYTES` gzipped. Over the cap there is no snapshot;
   the turn goes on and says so in its notes.

**The time.** The whole path is held to the seconds it is given (5 at a normal end, 2 at a stop;
the measured path takes 1.7 s at 18.4 MB). Every call gets the seconds that are left, and the work
between calls looks at the clock, so a slow engine costs the budget and not more. A document is
read up to `MAX_RAW_BYTES` (the spike's worst transcript is 18.4 MB and took 70 MiB of Control's
memory, about four times the document).

Best effort: every failure is an `ExportFailed` with a stable reason, never the engine's text.
"""

import gzip
import hashlib
import http.client
import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Final, cast
from urllib.parse import quote, urlsplit

from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.snapshot_wire import MAX_SNAPSHOT_BYTES

# The plan's cap on what is stored, gzipped. The app holds the same number.
CAP_BYTES: Final = MAX_SNAPSHOT_BYTES
# Messages per page; the engine answers the newest `limit` and a cursor for the older ones.
PAGE_SIZE: Final = 50
# The most raw JSON read from the engine, summed over the pages. About twice the worst measured.
MAX_RAW_BYTES: Final = 32 * 1024 * 1024
# A page count no real session reaches (50,000 messages); a cursor that never ends is a bad answer.
MAX_PAGES: Final = 1000
# A metadata string longer than this is a copy of an output; the spike emptied these.
LONG_METADATA_CHARS: Final = 256
GZIP_LEVEL: Final = 6

# (path, seconds left) -> (status, lower-case headers, body)
Fetch = Callable[[str, float], tuple[int, Mapping[str, str], bytes]]


class ExportReason(StrEnum):
    """Why no snapshot was made; the words of the turn's notes."""

    UNREACHABLE = "engine_unreachable"
    BAD_ANSWER = "bad_answer"
    OUT_OF_TIME = "out_of_time"
    TOO_LARGE = "too_large"


class ExportFailed(Exception):
    def __init__(self, reason: ExportReason) -> None:
        super().__init__(reason.value)
        self.reason = reason


@dataclass(frozen=True)
class SessionSnapshot:
    """The file to keep. `data` is gzip; `raw_bytes` is the size of the JSON inside it."""

    data: bytes
    raw_bytes: int
    sha256: str
    messages: int
    # Tool parts whose output the engine had marked as compacted and the snapshot leaves empty.
    blanked: int


def take_snapshot(
    fetch: Fetch,
    session_id: str,
    *,
    redactor: Redactor,
    seconds: float,
    clock: Callable[[], float] = time.monotonic,
) -> SessionSnapshot:
    """The snapshot of `session_id`, or `ExportFailed`. `seconds` is the whole budget."""
    deadline = clock() + seconds

    def left() -> float:
        remaining = deadline - clock()
        if remaining <= 0:
            raise ExportFailed(ExportReason.OUT_OF_TIME)
        return remaining

    safe = quote(session_id, safe="")
    info = _json(_get(fetch, f"/session/{safe}", left()))
    messages = _messages(fetch, safe, left)
    left()
    document: dict[str, Any] = {"info": info, "messages": messages}
    blanked = _blank_compacted(messages)
    left()
    clean = _redact(document, redactor)
    left()
    raw = json.dumps(clean, separators=(",", ":")).encode("ascii")
    left()
    packed = gzip.compress(raw, compresslevel=GZIP_LEVEL, mtime=0)
    left()
    if len(packed) > CAP_BYTES:
        raise ExportFailed(ExportReason.TOO_LARGE)
    return SessionSnapshot(
        data=packed,
        raw_bytes=len(raw),
        sha256=hashlib.sha256(packed).hexdigest(),
        messages=len(messages),
        blanked=blanked,
    )


def _get(fetch: Fetch, path: str, seconds: float) -> tuple[Mapping[str, str], bytes]:
    try:
        status, headers, body = fetch(path, seconds)
    except ExportFailed:
        raise
    except TimeoutError:
        raise ExportFailed(ExportReason.OUT_OF_TIME) from None
    except Exception:
        raise ExportFailed(ExportReason.UNREACHABLE) from None
    if status != 200:
        raise ExportFailed(ExportReason.BAD_ANSWER)
    return headers, body


def _json(answer: tuple[Mapping[str, str], bytes]) -> Any:
    try:
        return json.loads(answer[1])
    except ValueError:
        raise ExportFailed(ExportReason.BAD_ANSWER) from None


def _messages(fetch: Fetch, safe: str, left: Callable[[], float]) -> list[Any]:
    """Every message, oldest first. The engine answers the newest `PAGE_SIZE` and, while there are
    older ones, the cursor for them in a header; the pages are put back in order."""
    pages: list[list[Any]] = []
    query = f"limit={PAGE_SIZE}"
    received = 0
    previous: str | None = None
    for _ in range(MAX_PAGES):
        headers, body = _get(fetch, f"/session/{safe}/message?{query}", left())
        received += len(body)
        if received > MAX_RAW_BYTES:
            raise ExportFailed(ExportReason.TOO_LARGE)
        page = _json((headers, body))
        if not isinstance(page, list):
            raise ExportFailed(ExportReason.BAD_ANSWER)
        pages.append(cast("list[Any]", page))
        cursor = headers.get("x-next-cursor")
        if not cursor:
            return [item for page in reversed(pages) for item in page]
        if cursor == previous:
            break
        previous = cursor
        query = f"limit={PAGE_SIZE}&before={quote(cursor, safe='')}"
    raise ExportFailed(ExportReason.BAD_ANSWER)


def _blank_compacted(messages: list[Any]) -> int:
    """Empty the output of every compacted tool part and the long strings of its metadata, in place.
    Returns how many parts were changed."""
    changed = 0
    for message in messages:
        if not isinstance(message, dict):
            continue
        parts = cast("dict[str, Any]", message).get("parts")
        if not isinstance(parts, list):
            continue
        for part in cast("list[Any]", parts):
            if not isinstance(part, dict) or cast("dict[str, Any]", part).get("type") != "tool":
                continue
            state = cast("dict[str, Any]", part).get("state")
            if not isinstance(state, dict) or not _compacted(cast("dict[str, Any]", state)):
                continue
            found = cast("dict[str, Any]", state)
            if isinstance(found.get("output"), str):
                found["output"] = ""
            metadata = found.get("metadata")
            if isinstance(metadata, dict):
                values = cast("dict[str, Any]", metadata)
                for key, value in values.items():
                    if isinstance(value, str) and len(value) > LONG_METADATA_CHARS:
                        values[key] = ""
            changed += 1
    return changed


def _compacted(state: dict[str, Any]) -> bool:
    moments = state.get("time")
    return isinstance(moments, dict) and bool(cast("dict[str, Any]", moments).get("compacted"))


def _redact(value: Any, redactor: Redactor) -> Any:
    """The same document with the redactor applied to every string value and key."""
    if isinstance(value, str):
        return redactor.redact(value)
    if isinstance(value, list):
        return [_redact(item, redactor) for item in cast("list[Any]", value)]
    if isinstance(value, dict):
        return {
            redactor.redact(str(key)): _redact(item, redactor)
            for key, item in cast("dict[str, Any]", value).items()
        }
    return value


class EngineFetch:
    """The production `Fetch`: GET requests to the engine's address over one connection (each
    connection through the exec tunnel costs an exec, so the calls share one), scoped to the
    engine's directory by the runner's own header. Loopback only: `http.client` never uses a proxy
    of the environment and never follows a redirect. A body is read up to one byte past
    `MAX_RAW_BYTES`, which `take_snapshot` takes for a document that is too large."""

    def __init__(self, base_url: str, directory: str) -> None:
        parts = urlsplit(base_url)
        self._host = parts.hostname or "127.0.0.1"
        self._port = parts.port
        self._directory = directory
        self._connection: http.client.HTTPConnection | None = None

    def __call__(self, path: str, timeout: float) -> tuple[int, Mapping[str, str], bytes]:
        connection = self._connection
        if connection is None:
            connection = self._connection = http.client.HTTPConnection(
                self._host, self._port, timeout=timeout
            )
        elif connection.sock is not None:
            connection.sock.settimeout(timeout)
        connection.request("GET", path, headers={"x-opencode-directory": self._directory})
        response = connection.getresponse()
        body = response.read(MAX_RAW_BYTES + 1)
        return response.status, {k.lower(): v for k, v in response.getheaders()}, body

    def close(self) -> None:
        connection, self._connection = self._connection, None
        if connection is not None:
            connection.close()
