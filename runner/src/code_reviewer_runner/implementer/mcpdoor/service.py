# SPDX-License-Identifier: LicenseRef-Proprietary

"""The MCP door process (#1067): the relay of `relay.py` behind one port, started with the job's
credential on stdin, reporting on stdout.

It holds the job credential and the app's address and nothing else of the job: no git token, no
model
key, no repository, no tool name. It reads the start document from stdin, binds the address it was
given, says `ready`, and ends on `{"op": "stop"}`, on the end of stdin (Control is gone) and by
itself
a while after the turn's deadline. When it ends it sends a `DELETE` for every MCP session still
open,
then drops the credential and says its last word.
"""

import json
import logging
import re
import sys
import threading
import time
from collections.abc import Callable
from typing import Any, Final, TextIO
from urllib.parse import urlsplit

from code_reviewer_runner.dynamic_review.model_door_route import MCP_DOOR_ADDRESS
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.outer_proxy import OuterProxy, OuterProxyError

from .protocol import (
    MAX_COMMAND_BYTES,
    MAX_SERVERS,
    MAX_START_BYTES,
    MESSAGE_READY,
    MESSAGE_REFUSED,
    MESSAGE_STATUS,
    OP_STOP,
    REFUSED_LISTEN_FAILED,
    REFUSED_START_INVALID,
    VERSION,
)
from .relay import JOB_ID, SERVER_ID, AppAccess, McpRelay, make_server

_log = logging.getLogger(__name__)

LINGER_SECONDS: Final = 600.0
_MIN_PORT: Final = 1024
_MAX_PORT: Final = 32767
_MAX_DEADLINE_SECONDS: Final = 24 * 60 * 60
# `WorkerCredential` of the runner API contract: `crj_` and 256 bits in base64url.
_CREDENTIAL: Final = re.compile(r"crj_[A-Za-z0-9_-]{43}")
_KEYS: Final = {
    "version",
    "appUrl",
    "jobId",
    "credential",
    "servers",
    "listenPort",
    "deadlineSeconds",
}


class StartRefused(Exception):
    """The door cannot start. Carries a word, never a value."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class McpStart:
    def __init__(
        self,
        *,
        access: AppAccess,
        servers: frozenset[str],
        port: int,
        deadline_seconds: float,
        outer_proxy: OuterProxy | None,
    ) -> None:
        self.access = access
        self.servers = servers
        self.port = port
        self.deadline_seconds = deadline_seconds
        self.outer_proxy = outer_proxy

    def __repr__(self) -> str:
        return "McpStart(...)"


def _app_url(raw: Any) -> str | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parts = urlsplit(raw)
        _ = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    if parts.username or parts.password or parts.query or parts.fragment:
        return None
    return raw.rstrip("/")


def parse_start(text: str) -> McpStart:
    """The start document of a line. Raises `StartRefused` with a word; the text of the document,
    which
    holds the credential, is never part of an error."""
    if len(text) > MAX_START_BYTES:
        raise StartRefused(REFUSED_START_INVALID)
    try:
        document: Any = json.loads(text)
    except (ValueError, RecursionError):
        raise StartRefused(REFUSED_START_INVALID) from None
    given = as_object(document)
    if given is None or not _KEYS <= given.keys() <= _KEYS | {"outerProxy"}:
        raise StartRefused(REFUSED_START_INVALID)
    if given["version"] != VERSION:
        raise StartRefused(REFUSED_START_INVALID)
    outer_proxy: OuterProxy | None = None
    if "outerProxy" in given:
        try:
            outer_proxy = OuterProxy.from_json(given["outerProxy"])
        except OuterProxyError:
            raise StartRefused(REFUSED_START_INVALID) from None
    app_url = _app_url(given["appUrl"])
    job_id: Any = given["jobId"]
    credential: Any = given["credential"]
    servers: Any = given["servers"]
    port: Any = given["listenPort"]
    deadline: Any = given["deadlineSeconds"]
    if (
        app_url is None
        or not isinstance(job_id, str)
        or not JOB_ID.fullmatch(job_id)
        or not isinstance(credential, str)
        or not _CREDENTIAL.fullmatch(credential)
        or not isinstance(servers, list)
        or not 1 <= len(servers) <= MAX_SERVERS  # pyright: ignore[reportUnknownArgumentType]
        or not all(isinstance(item, str) and SERVER_ID.fullmatch(item) for item in servers)  # pyright: ignore[reportUnknownVariableType]
        or isinstance(port, bool)
        or not isinstance(port, int)
        or not _MIN_PORT <= port <= _MAX_PORT
        or isinstance(deadline, bool)
        or not isinstance(deadline, int | float)
        or not 0 < deadline <= _MAX_DEADLINE_SECONDS
    ):
        raise StartRefused(REFUSED_START_INVALID)
    return McpStart(
        access=AppAccess(app_url, job_id, credential),
        servers=frozenset(str(item).lower() for item in servers),  # pyright: ignore[reportUnknownVariableType, reportUnknownArgumentType]
        port=port,
        deadline_seconds=float(deadline),
        outer_proxy=outer_proxy,
    )


def _emit(stdout: TextIO, document: dict[str, Any]) -> None:
    stdout.write(json.dumps(document, separators=(",", ":")) + "\n")
    stdout.flush()


def _read_stop(stdin: TextIO, stop: threading.Event) -> None:
    """Sets `stop` on `{"op": "stop"}`, on the end of stdin and on anything unreadable: whatever
    ends
    this thread ends the door, so that a reader that died never leaves the credential served."""
    try:
        while not stop.is_set():
            line = stdin.readline(MAX_COMMAND_BYTES + 1)
            if line == "" or len(line) > MAX_COMMAND_BYTES:
                break
            try:
                command: Any = json.loads(line)
            except ValueError:
                break
            given = as_object(command)
            if given is not None and given.get("op") == OP_STOP:
                break
    except (OSError, ValueError):
        pass
    finally:
        stop.set()


def run_mcp_door(
    stdin: TextIO,
    stdout: TextIO,
    *,
    bind: tuple[str, int] | None = None,
    clock: Callable[[], float] = time.monotonic,
    relay_factory: Callable[[McpStart], McpRelay] | None = None,
) -> int:
    """The door process: read the start document, serve, close the sessions, end. Returns the exit
    code: 0 for an end that was asked for (a stop, or Control gone), 2 for a door that could not
    start
    (`refused` was printed)."""
    first = stdin.readline(MAX_START_BYTES + 1)
    try:
        start = parse_start(first)
    except StartRefused as refusal:
        _log.error("the MCP door cannot start: %s", refusal.reason)
        _emit(stdout, {"t": MESSAGE_REFUSED, "reason": refusal.reason})
        return 2
    finally:
        # The start document held the credential; nothing here needs the text again.
        first = ""
    relay = (
        relay_factory(start)
        if relay_factory is not None
        else McpRelay(start.access, start.servers, proxy=start.outer_proxy)
    )
    host, port = bind or (MCP_DOOR_ADDRESS, start.port)
    try:
        server = make_server(relay, host, port)
    except OSError:
        _log.error("the MCP door cannot listen")
        _emit(stdout, {"t": MESSAGE_REFUSED, "reason": REFUSED_LISTEN_FAILED})
        return 2
    began = clock()
    stop = threading.Event()
    threading.Thread(target=_read_stop, args=(stdin, stop), daemon=True).start()
    threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True
    ).start()
    _emit(stdout, {"t": MESSAGE_READY})
    try:
        while not stop.wait(0.2):
            if clock() - began > start.deadline_seconds + LINGER_SECONDS:
                break
    finally:
        # No new call is taken, then the sessions are ended while the credential is still held.
        server.shutdown()
        server.server_close()
        try:
            left = relay.close_sessions()
        except Exception:  # the last word must come
            _log.warning("the MCP door could not end its sessions")
            left = relay.sessions_left()
        try:
            _emit(
                stdout,
                {
                    "t": MESSAGE_STATUS,
                    "final": True,
                    "calls": relay.counts.calls,
                    "sessionsOpened": relay.counts.opened,
                    "sessionsClosed": relay.counts.closed,
                    "sessionsLeft": left,
                },
            )
        except (OSError, ValueError):
            _log.warning("the MCP door could not write its final status")
    return 0


def main(arguments: list[str] | None = None) -> int:
    given = list(sys.argv[1:] if arguments is None else arguments)
    bind = None
    if given[:1] == ["--bind"] and len(given) == 2:
        host, _, port = given[1].rpartition(":")
        if not host or not port.isdigit() or not 0 < int(port) < 65536:
            return 2
        bind = (host, int(port))
    elif given:
        return 2
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="mcpdoor: %(message)s")
    sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]  # a text stream here
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    return run_mcp_door(sys.stdin, sys.stdout, bind=bind)
