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
the measured path takes 1.7 s at 18.4 MB). The engine runs in the agent's container, so the agent
can put anything on its port: a server that sends its body a byte at a time never trips a socket
timeout. So the export (fetch, redaction, blanking, dump, gzip) runs in a daemon thread that the
caller `join`s for the seconds it was given; at the deadline the thread is told to stop, the
connection is shut (`abort`) and the export gives up with `out_of_time`. The turn's push never waits
behind it. The deadline is not hard: the thread looks at the stop signal between its phases, after
every page and at every element of the redaction, but one `json.loads` or `json.dumps` of a large
document holds the GIL and can overrun it by a second or two before the thread stops. For a large
document the time is the effective cap, not `MAX_RAW_BYTES`.

**What it will take.** A document is read up to `MAX_RAW_BYTES`, summed over the pages (the
spike's worst transcript is 18.4 MB and took 70 MiB of Control's memory, about four times the
document), and the reading stops at the cap. Before a page is parsed its commas are counted (an
upper bound of its elements; a page of millions of tiny strings is refused without building it), and
the walk of the parsed document counts elements and depth (`MAX_NODES`, `MAX_DEPTH`); a transcript
never comes near them (about 20 bytes an element, nesting of about ten). The session's own record
is held to `MAX_INFO_BYTES` and counted the same way. A comma inside a string counts too, so
dense data (a page of mostly commas) can be `too_large` from about 16 MB on; a known limit.

**What the redaction costs.** The redactor of the turn also knows the *shapes* of secrets
(`sk-` followed by 20 or more characters, `Bearer <token>`), so it rewrites an ordinary path or word
that looks like one. The snapshot is the model's history: a follow-up agent may see `[REDACTED]`
where an old tool input had such a path or word. That is the price of never storing a secret; the
turn itself is redacted the same way.

Best effort: every failure is an `ExportFailed` with a stable reason, never the engine's text.
"""

import contextlib
import gzip
import hashlib
import http.client
import json
import socket
import threading
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
# The most raw JSON read from the engine, summed over the pages, before anything is blanked: three
# or four times the worst measured, so that an edit-heavy session (the metadata of an edit repeats
# the file before, after and as a diff) still fits once its old copies are emptied. The reading is
# what bounds the memory (a few times this at worst); the 8 MiB gzipped cap decides what is stored.
MAX_RAW_BYTES: Final = 64 * 1024 * 1024
# The session's own record (`GET /session/<id>`) is a title, a few ids and times; a megabyte is
# far more than the engine writes, and it is read and counted like a page, not left to the 64 MiB.
MAX_INFO_BYTES: Final = 1024 * 1024
# The most elements (values of lists and objects, at any depth) a document may have, counted as the
# commas of a page before it is parsed (an upper bound: a comma in a string counts) and as the walk
# of the parsed document. A transcript has an element for 20 bytes or more (an estimate from the
# fixtures: the spike's 18.4 MB would be 0.9 M), a page made of tiny strings has one for 4 (7.5 M in
# 30 MB took 680 MB of memory and 11 s to go through).
MAX_NODES: Final = 2_000_000
# The deepest nesting a document may have: a transcript's is about ten (message, part, state,
# metadata, a diff, ...), a tool's own JSON input a few more.
MAX_DEPTH: Final = 100
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


class _Work:
    """What the thread of the export shares with the caller: the stop signal, and the elements
    counted so far."""

    def __init__(self) -> None:
        self.cancelled = threading.Event()
        self.received = 0
        self.announced = 0
        self.nodes = 0

    def check(self) -> None:
        """Stop at once when the caller has given up."""
        if self.cancelled.is_set():
            raise ExportFailed(ExportReason.OUT_OF_TIME)

    def receive(self, size: int) -> None:
        """Bytes read from the engine, over every call. `EngineFetch` reads one byte past what is
        left of its limit, so a document cut at the limit adds up to more than `MAX_RAW_BYTES`."""
        self.received += size
        if self.received > MAX_RAW_BYTES:
            raise ExportFailed(ExportReason.TOO_LARGE)

    def announce(self, upper_bound: int) -> None:
        """Elements a page may hold, from its bytes, before it is parsed."""
        self.announced += upper_bound
        if self.announced > MAX_NODES:
            raise ExportFailed(ExportReason.TOO_LARGE)

    def count(self, more: int) -> None:
        """Elements of the parsed document, as the walk meets them."""
        self.nodes += more
        if self.nodes > MAX_NODES:
            raise ExportFailed(ExportReason.TOO_LARGE)


def take_snapshot(
    fetch: Fetch,
    session_id: str,
    *,
    redactor: Redactor,
    seconds: float,
    clock: Callable[[], float] = time.monotonic,
    abort: Callable[[], None] | None = None,
) -> SessionSnapshot:
    """The snapshot of `session_id`, or `ExportFailed`. `seconds` is the whole budget, held while
    the engine trickles its answer or the document is slow to go through: the work is done in a
    daemon thread and given up on at the deadline, when `abort` (shut the connection) is called."""
    deadline = clock() + seconds
    work = _Work()
    outcome: list[SessionSnapshot | BaseException] = []

    def run() -> None:
        try:
            outcome.append(_export(fetch, session_id, redactor, deadline, clock, work))
        except BaseException as error:
            outcome.append(error)

    worker = threading.Thread(target=run, name="session-export", daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        work.cancelled.set()
        if abort is not None:
            with contextlib.suppress(Exception):
                abort()
        raise ExportFailed(ExportReason.OUT_OF_TIME)
    result = outcome[0]
    if isinstance(result, BaseException):
        raise result
    return result


def _export(
    fetch: Fetch,
    session_id: str,
    redactor: Redactor,
    deadline: float,
    clock: Callable[[], float],
    work: _Work,
) -> SessionSnapshot:
    def left() -> float:
        remaining = deadline - clock()
        if remaining <= 0 or work.cancelled.is_set():
            raise ExportFailed(ExportReason.OUT_OF_TIME)
        return remaining

    safe = quote(session_id, safe="")
    info = _info(fetch, safe, left, work)
    messages = _messages(fetch, safe, left, work)
    left()
    document: dict[str, Any] = {"info": info, "messages": messages}
    blanked = _blank_compacted(messages, work)
    left()
    clean = _redact(document, redactor, work, 0)
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
    except (ValueError, RecursionError):
        raise ExportFailed(ExportReason.BAD_ANSWER) from None


def _info(fetch: Fetch, safe: str, left: Callable[[], float], work: _Work) -> Any:
    """The session's record, held to its own small limit and counted before it is parsed, like a
    page of messages."""
    headers, body = _get(fetch, f"/session/{safe}", left())
    work.receive(len(body))
    if len(body) > MAX_INFO_BYTES:
        raise ExportFailed(ExportReason.TOO_LARGE)
    work.announce(body.count(b",") + 1)
    return _json((headers, body))


def _messages(fetch: Fetch, safe: str, left: Callable[[], float], work: _Work) -> list[Any]:
    """Every message, oldest first. The engine answers the newest `PAGE_SIZE` and, while there are
    older ones, the cursor for them in a header; the pages are put back in order."""
    pages: list[list[Any]] = []
    query = f"limit={PAGE_SIZE}"
    previous: str | None = None
    for _ in range(MAX_PAGES):
        headers, body = _get(fetch, f"/session/{safe}/message?{query}", left())
        work.receive(len(body))
        # An upper bound of the page's elements, before a single one is built.
        work.announce(body.count(b",") + 1)
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


def _blank_compacted(messages: list[Any], work: _Work) -> int:
    """Empty the output of every compacted tool part and the long strings of its metadata (at any
    depth: a diff is nested there), in place. Returns how many parts were changed."""
    changed = 0
    for message in messages:
        work.check()
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
            if "metadata" in found:
                found["metadata"] = _without_long_strings(found["metadata"], 0)
            changed += 1
    return changed


def _without_long_strings(value: Any, depth: int) -> Any:
    """The metadata with every string over `LONG_METADATA_CHARS` emptied, at any depth up to
    `MAX_DEPTH`."""
    if isinstance(value, str):
        return "" if len(value) > LONG_METADATA_CHARS else value
    if not isinstance(value, (list, dict)):
        return value
    if depth >= MAX_DEPTH:
        raise ExportFailed(ExportReason.TOO_LARGE)
    if isinstance(value, list):
        return [_without_long_strings(item, depth + 1) for item in cast("list[Any]", value)]
    return {
        key: _without_long_strings(item, depth + 1)
        for key, item in cast("dict[str, Any]", value).items()
    }


def _compacted(state: dict[str, Any]) -> bool:
    moments = state.get("time")
    return isinstance(moments, dict) and bool(cast("dict[str, Any]", moments).get("compacted"))


def _redact(value: Any, redactor: Redactor, work: _Work, depth: int) -> Any:
    """The same document with the redactor applied to every string value and key. It is also the
    walk that counts the elements and the depth, so a document made to be expensive is refused here
    and the stop signal of the caller is seen on every element."""
    work.check()
    if isinstance(value, str):
        return redactor.redact(value)
    if isinstance(value, list):
        if depth >= MAX_DEPTH:
            raise ExportFailed(ExportReason.TOO_LARGE)
        items = cast("list[Any]", value)
        work.count(len(items))
        return [_redact(item, redactor, work, depth + 1) for item in items]
    if isinstance(value, dict):
        if depth >= MAX_DEPTH:
            raise ExportFailed(ExportReason.TOO_LARGE)
        pairs = cast("dict[str, Any]", value)
        work.count(len(pairs))
        redacted: dict[str, Any] = {}
        for key, item in pairs.items():
            work.check()
            name = redactor.redact(str(key))
            redacted[name] = _redact(item, redactor, work, depth + 1)
        return redacted
    return value


class EngineFetch:
    """The production `Fetch`: GET requests to the engine's address over one connection (each
    connection through the exec tunnel costs an exec, so the calls share one), scoped to the
    engine's directory by the runner's own header. Loopback only: `http.client` never uses a proxy
    of the environment and never follows a redirect. What is read is bounded by `limit`, summed over
    the calls, and a body is read up to one byte past what is left of it, which `take_snapshot`
    takes for a document that is too large. `close` may be called from another thread while a read
    blocks (the deadline of the export): it shuts the socket, which ends the read, and nothing
    connects again afterwards."""

    def __init__(self, base_url: str, directory: str, *, limit: int = MAX_RAW_BYTES) -> None:
        parts = urlsplit(base_url)
        self._host = parts.hostname or "127.0.0.1"
        self._port = parts.port
        self._directory = directory
        self._limit = limit
        self._read = 0
        self._closed = False
        self._lock = threading.Lock()
        self._connection: http.client.HTTPConnection | None = None

    def __call__(self, path: str, timeout: float) -> tuple[int, Mapping[str, str], bytes]:
        with self._lock:
            if self._closed:
                raise ConnectionError("closed")
            connection = self._connection
            if connection is None:
                connection = self._connection = http.client.HTTPConnection(
                    self._host, self._port, timeout=timeout
                )
                # Never let `request` connect by itself: that happens outside the lock, where a
                # `close` has already looked at an empty socket.
                connection.auto_open = 0
            connection.timeout = timeout
            if connection.sock is None:
                connection.connect()
            else:
                connection.sock.settimeout(timeout)
        connection.request("GET", path, headers={"x-opencode-directory": self._directory})
        response = connection.getresponse()
        body = response.read(max(self._limit - self._read, 0) + 1)
        self._read += len(body)
        return response.status, {k.lower(): v for k, v in response.getheaders()}, body

    def close(self) -> None:
        with self._lock:
            self._closed = True
            connection, self._connection = self._connection, None
        if connection is None:
            return
        # `shutdown` is what wakes a read that is blocked in another thread; `close` alone leaves
        # the descriptor open while a reader holds the socket's file.
        sock = connection.sock
        if sock is not None:
            with contextlib.suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)
        connection.close()
