# SPDX-License-Identifier: LicenseRef-Proprietary

"""The stock-engine adapter of one Dynamic Review (#197).

One headless engine server per job, driven through the pinned local HTTP API (see the merged #85
write-up). The engine is stock: this module never patches it, never installs a plugin and never
reads its internals. The trusted configuration it writes (`config.py`), the model proxy it points
the engine at (`proxy.py`) and the ledger it shares with both (`budget.py`) are the whole boundary.

The order is deliberate and mirrors the epic's:

1. the model proxy is up and its destination proven capable **before** the engine starts;
2. the runner writes the trusted config (with the fixed core as the agent's prompt, so it reaches
   the model through the trusted channel, not through repository instructions) and starts the
   engine with a minimal, closed environment;
3. the adapter waits for a healthy pinned server, then opens one session;
4. the untrusted input is sent as one structured turn; the reviewed head comes from the validated
   claim (`base.head_sha`), never from repository content;
5. the tool, file and result-byte bounds are audited **at the proxy** from the model requests
   themselves (`audit.py`), not read back from the engine's session afterwards: the pinned server
   cannot even list a session that has a stored JSON-schema format (#85, a 400), and a count taken
   after the fact would not be preventive anyway. The adapter only reads the stable cause the proxy
   recorded in the ledger, and validates the structured answer with the typed findings parser
   against the files the export really contains;
6. any limit, any engine exit and any unusable answer ends the run with a stable code, at the moment
   it happens (the run does not wait for the engine to give up); the whole owned process group is
   stopped and its private scratch directory removed. No fallback, no partial success.

`steps`, SSE events and the engine's own counters are observation only; nothing here trusts them.

**The native path (#552).** With `plain_final` the engine runs without a `format`: no
`StructuredOutput` tool, no forced tool choice, and nothing rewritten on the wire. The review is the
text of the message that ends the turn, read, repaired once and wrapped up above the wire
(`plain_final.py`), and the tool, file and result-byte bounds are audited here from the engine's own
event stream (`tool_part_audit.py`, `engine_events.py`) because the passthrough proxy counts none of
them. `engine_config` is the trusted configuration of such a job
(`config.build_native_engine_config`); the legacy path, the default, is unchanged until #556
removes it.
"""

import contextlib
import http.client
import json
import logging
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request

from code_reviewer_runner.dynamic_findings import (
    DynamicFindings,
    EnvelopeError,
    FindingsError,
    parse_dynamic_findings,
)
from code_reviewer_runner.dynamic_review.budget import (
    TOTAL_DEADLINE_SECONDS,
    BudgetLedger,
    LimitError,
)
from code_reviewer_runner.dynamic_review.config import (
    PROXY_PROVIDER_ID,
    build_engine_config,
    engine_environment,
)
from code_reviewer_runner.dynamic_review.engine_events import EventReader, EventStream
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.final_messages import final_answer_line
from code_reviewer_runner.dynamic_review.finalization_log import FinalizationRecord
from code_reviewer_runner.dynamic_review.net import no_redirect_opener
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.plain_final import NoFinalAnswer, PlainFinalization
from code_reviewer_runner.dynamic_review.prompts import ReviewInputs, compose_user_prompt
from code_reviewer_runner.dynamic_review.schema import engine_schema
from code_reviewer_runner.dynamic_review.tool_part_audit import ToolPartAudit
from code_reviewer_runner.dynamic_review.wrap_up import recovery_prompt
from code_reviewer_runner.job import Job
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.process_group import end_group, has_exited
from code_reviewer_runner.result import ErrorCode

# The engine's own report of its version; the adapter refuses anything else.
PINNED_ENGINE_VERSION = "1.19.0"
# How long the engine may take to print its listening marker and answer a health check.
STARTUP_SECONDS = 20.0
# How often a start is attempted on a fresh port when the engine could not bind the one picked.
START_ATTEMPTS = 3
# The message call is one blocking POST that only returns when the whole agentic turn is done, and
# nothing travels on the socket meanwhile. Its socket timeout therefore must never be what ends a
# turn: it is the time left to the whole-job deadline plus this margin, so the run's own watch
# (the ledger's deadline and the wrap-up) always acts first. A fixed cap of 300 s once ended a
# normal review turn as "not reachable" (#293).
TURN_TIMEOUT_MARGIN_SECONDS = 5.0
# The longest a turn can be given: the whole job and the margin.
MAX_TURN_TIMEOUT_SECONDS = TOTAL_DEADLINE_SECONDS + TURN_TIMEOUT_MARGIN_SECONDS
# One health check or session request. Before the listening marker the pinned server can accept a
# connection and never answer, so a poll must give up quickly and try again.
SHORT_TIMEOUT_SECONDS = 2.0
SESSION_TIMEOUT_SECONDS = 30.0
# How often the run checks the ledger, the deadline and the engine process while a message runs.
WATCH_INTERVAL_SECONDS = 0.05
# A failed message call this close before the whole-job deadline is counted as the deadline.
DEADLINE_TOLERANCE_SECONDS = 0.25
# How long the engine's event stream may take to say it is connected (the audit of the native path
# runs on it, so no turn starts before it does).
EVENTS_CONNECT_SECONDS = 10.0
# How long opening the stream may take (the connection and the response head).
EVENTS_OPEN_SECONDS = 10.0
# How long an open stream may say nothing at all. The pinned engine beats every ten seconds
# (`server.heartbeat`), so a stream that is quiet for this long is not the engine's: the audit that
# runs on it has stopped. A version bump of the pinned engine must keep that beat.
EVENT_IDLE_SECONDS = 35.0
# The agent the runner defines and selects; the request may never name another.
REVIEW_AGENT = "review"
# The largest startup/answer body the adapter will read before the ledger refuses it.
CLIENT_MAX_BYTES = 8 * 1024 * 1024
SESSION_TITLE = "code-reviewer-read-only-review"

# The process groups of the engines this process started. An engine leads its own group (so ending
# one job's engine never ends the runner), but then it must be ended explicitly: this registry is
# what the entry point's watchdog kills when the job process itself has to exit (#197-T07).
# A group id is only in the registry while its leader is not reaped (process_group.py), so the id
# cannot have been given to an unrelated group; the lock keeps the watchdog thread from signalling
# an id while it is taken off the registry.
_RUNNING_ENGINES: set[int] = set()
# The dedicated users whose engines run, so the watchdog also ends what left the process group.
_RUNNING_LAUNCHES: list[EngineLaunch] = []
_ENGINES_LOCK = threading.Lock()
_log = logging.getLogger(__name__)
_SURVIVOR = (
    "a process of the engine's dedicated user could not be ended; its network rules stay and the "
    "next Dynamic job refuses to start until it is gone"
)


def shutdown_engines() -> None:
    """End every engine this process started, groups and users. Safe to call twice or with none."""
    with _ENGINES_LOCK:
        for pgid in list(_RUNNING_ENGINES):
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(pgid, signal.SIGKILL)
        _RUNNING_ENGINES.clear()
        launches = list(_RUNNING_LAUNCHES)
        _RUNNING_LAUNCHES.clear()
    # Whatever the dedicated user still runs (a helper in a session of its own) goes too, and its
    # network rules with it.
    for launch in launches:
        if not launch.close():
            _log.warning(_SURVIVOR)


def register_engine(pid: int, launch: EngineLaunch | None) -> None:
    """Put an engine this process started (its group leader and, with a dedicated user, the user's
    launch) on the registry `shutdown_engines` ends. The Implementer's engine (#764) joins the one
    the entry point's watchdog already kills."""
    with _ENGINES_LOCK:
        _RUNNING_ENGINES.add(pid)
        if launch is not None and launch not in _RUNNING_LAUNCHES:
            _RUNNING_LAUNCHES.append(launch)


def unregister_engine(pid: int | None, launch: EngineLaunch | None) -> None:
    """Take an engine off the registry: the caller ends it itself (see `register_engine`)."""
    with _ENGINES_LOCK:
        if pid is not None:
            _RUNNING_ENGINES.discard(pid)
        if launch is not None and launch in _RUNNING_LAUNCHES:
            _RUNNING_LAUNCHES.remove(launch)


class EngineError(Exception):
    """The engine could not run or did not answer. `code` is stable; `detail` names no value."""

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


# The stable reasons a failed engine call carries as the start of its detail, so a log tells them
# apart: the engine ended (`engine_exited`), could not be reached (`engine_unreachable`) or did not
# answer in time (`engine_timeout`, and `engine_turn_timeout` for the message call of the turn).
REASON_EXITED = "engine_exited"
REASON_UNREACHABLE = "engine_unreachable"
REASON_TIMEOUT = "engine_timeout"
REASON_TURN_TIMEOUT = "engine_turn_timeout"


class EngineTimeout(EngineError):
    """The engine accepted the call and did not answer within its socket timeout."""

    def __init__(
        self, detail: str = f"{REASON_TIMEOUT}: the engine did not answer in time"
    ) -> None:
        super().__init__(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, detail)


class EngineExited(EngineError):
    """The engine process ended while it was being waited for."""

    def __init__(self) -> None:
        super().__init__(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine exited during startup")


@dataclass(frozen=True)
class EngineAnswer:
    """What one run produced: findings on success, a stable error otherwise. Never both."""

    findings: DynamicFindings | None
    error: EngineError | None

    @property
    def ok(self) -> bool:
        return self.findings is not None and self.error is None


# The transport of the client: method, URL, body (bytes), headers, timeout -> (status, body bytes).
# A test replaces it to script answers; the real one talks to the engine on loopback.
Transport = Callable[[str, str, bytes | None, Mapping[str, str], float], tuple[int, bytes]]


def _http_request(
    method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
) -> tuple[int, bytes]:
    request = Request(url, data=body, method=method, headers=dict(headers))
    try:
        # Loopback only: never through a proxy of the environment, never through a redirect.
        opener = no_redirect_opener(direct=True)
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read(CLIENT_MAX_BYTES)
    except HTTPError as error:
        return error.code, error.read(CLIENT_MAX_BYTES)
    except TimeoutError:
        raise EngineTimeout() from None
    except URLError as error:
        if isinstance(error.reason, TimeoutError):
            raise EngineTimeout() from None
        raise _unreachable() from None
    except (ConnectionError, OSError):
        raise _unreachable() from None


def _unreachable() -> EngineError:
    return EngineError(
        ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, f"{REASON_UNREACHABLE}: the engine is not reachable"
    )


class EngineClient:
    """The verified HTTP surface of one engine server. Only the endpoints the run needs."""

    def __init__(
        self,
        base_url: str,
        directory: str,
        *,
        transport: Transport = _http_request,
        provider_id: str = PROXY_PROVIDER_ID,
        agent: str = REVIEW_AGENT,
        session_title: str = SESSION_TITLE,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.directory = directory
        self.last_message: bytes = b""
        self._transport = transport
        # The provider the message names: the legacy proxy provider, or the one of a native job.
        self._provider_id = provider_id
        # The agent the runner defined in the config and the title of the session: the Implementer
        # (#764) has its own; Dynamic keeps the defaults.
        self._agent = agent
        self._session_title = session_title

    def _call(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        scoped: bool = True,
        timeout: float = MAX_TURN_TIMEOUT_SECONDS,
    ) -> tuple[int, bytes]:
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        # Scope every session request to the prepared export. The engine may read nowhere else; a
        # directory the request names is ignored, this header is the runner's. The health check is
        # global and carries none.
        if scoped:
            headers["x-opencode-directory"] = self.directory
        return self._transport(method, f"{self.base_url}{path}", payload, headers, timeout)

    def health(self) -> bool:
        """True when the server answers a healthy pinned-version health check."""
        try:
            status, body = self._call(
                "GET", "/global/health", scoped=False, timeout=SHORT_TIMEOUT_SECONDS
            )
        except EngineError:
            return False
        if status != 200:
            return False
        try:
            value: Any = json.loads(body)
        except ValueError:
            return False
        document = as_object(value)
        if document is None:
            return False
        return document.get("healthy") is True and document.get("version") == PINNED_ENGINE_VERSION

    def wait_healthy(
        self, deadline_seconds: float, alive: Callable[[], bool] = lambda: True
    ) -> None:
        """Poll until healthy; a healthy server is the listening marker #85 verified.

        `alive` tells whether the engine process we started is still running. An answer only counts
        while it is: if our process died (for example it could not bind a port a stranger took in
        the meantime), whatever answers on that port is not our engine.
        """
        until = time.monotonic() + deadline_seconds
        while time.monotonic() < until:
            if not alive():
                raise EngineExited()
            if self.health() and alive():
                return
            time.sleep(0.2)
        raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine did not become healthy")

    def create_session(self) -> str:
        status, body = self._call(
            "POST", "/session", {"title": self._session_title}, timeout=SESSION_TIMEOUT_SECONDS
        )
        if status != 200:
            raise EngineError(ErrorCode.RUNNER_ERROR, "the engine refused a new session")
        session_id: Any = None
        try:
            value: Any = json.loads(body)
        except ValueError:
            session_id = None
        else:
            document = as_object(value)
            session_id = None if document is None else document.get("id")
        if not isinstance(session_id, str) or not session_id:
            raise EngineError(ErrorCode.RUNNER_ERROR, "the engine returned no session id")
        return session_id

    def send_message(
        self,
        session_id: str,
        *,
        model: str,
        parts: list[dict[str, str]],
        schema: Any | None,
        timeout: float = MAX_TURN_TIMEOUT_SECONDS,
    ) -> None:
        """Send one turn to the runner-defined review agent: structured when there is a `schema`,
        a plain one (the native path, #552) when there is none.

        The call returns when the turn is done, so `timeout` is the time the turn may take (the run
        gives it what is left of the whole job, plus a margin).
        """
        body: dict[str, Any] = {
            "agent": self._agent,
            "model": {"providerID": self._provider_id, "modelID": model},
            "parts": parts,
        }
        if schema is not None:
            body["format"] = {"type": "json_schema", "schema": schema}
        try:
            status, answer = self._call(
                "POST", f"/session/{session_id}/message", body, timeout=timeout
            )
        except EngineTimeout:
            raise EngineTimeout(
                f"{REASON_TURN_TIMEOUT}: the engine did not finish its turn within the time "
                "the call was given"
            ) from None
        if status != 200:
            raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine did not answer")
        self.last_message = answer

    def abort(self, session_id: str) -> None:
        try:
            self._call("POST", f"/session/{session_id}/abort", timeout=SHORT_TIMEOUT_SECONDS)
        except EngineError:
            return  # the process group is ended anyway

    def queue_message(
        self, session_id: str, *, model: str, text: str, timeout: float = SESSION_TIMEOUT_SECONDS
    ) -> bool:
        """Add a user message to the turn that is running (`prompt_async`, 204): the engine reads
        it before its next step. Nothing else about the turn changes (#552, spike #547). True when
        the engine accepted it."""
        body = {
            "agent": self._agent,
            "model": {"providerID": self._provider_id, "modelID": model},
            "parts": [{"type": "text", "text": text}],
        }
        status, _ = self._call("POST", f"/session/{session_id}/prompt_async", body, timeout=timeout)
        return status == 204

    def open_events(self) -> EventStream:
        """The engine's event stream (`GET /event`), scoped to the export like every request.

        Opening it has a short timeout of its own, and an open stream a read timeout of its own: the
        engine beats every ten seconds, so a quiet stream is a dead one (`EVENT_IDLE_SECONDS`). It
        is a direct connection to the engine's loopback port: no proxy from the environment, no
        redirect."""
        parts = urlsplit(self.base_url)
        connection = http.client.HTTPConnection(
            parts.hostname or "127.0.0.1", parts.port, timeout=EVENTS_OPEN_SECONDS
        )
        try:
            connection.request(
                "GET",
                "/event",
                headers={"x-opencode-directory": self.directory, "accept": "text/event-stream"},
            )
            response = connection.getresponse()
        except (OSError, http.client.HTTPException):
            connection.close()
            raise _unreachable() from None
        if response.status != 200 or connection.sock is None:
            connection.close()
            raise EngineError(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine refused its event stream"
            )
        connection.sock.settimeout(EVENT_IDLE_SECONDS)
        return _EventResponse(connection, response)


class _EventResponse:
    """The open event response. Closing it from another thread shuts the socket down first, so a
    reader that waits for the next line is released at once instead of at its timeout."""

    def __init__(
        self, connection: http.client.HTTPConnection, response: http.client.HTTPResponse
    ) -> None:
        self._connection = connection
        self._response = response

    def readline(self, limit: int = -1, /) -> bytes:
        return self._response.readline(limit)

    def close(self) -> None:
        sock = self._connection.sock
        if sock is not None:
            with contextlib.suppress(OSError):  # a socket that is gone is the point
                sock.shutdown(socket.SHUT_RDWR)
        with contextlib.suppress(OSError):
            self._response.close()
        self._connection.close()


# What a finish reason or an error name of the engine's answer may look like to be named in a log:
# a short identifier. Anything else is "other"; the engine's text is never copied.
_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,39}")


def turn_end_note(message: bytes) -> str:
    """How a turn ended, in words that only come from this function (#309): the finish reason of
    the engine's last step and the name of its error, each only when it is a plain identifier.

    This is what tells an operator whether a model answered in prose (`finish=stop`), was cut off
    (`finish=length`) or the engine raised its own error, without copying any model text.
    """
    try:
        value: Any = json.loads(message)
    except ValueError:
        return "unknown"
    document = as_object(value)
    info = as_object(document.get("info")) if document else None
    if info is None:
        return "unknown"
    notes: list[str] = []
    finish: Any = info.get("finish")
    if finish is not None:
        notes.append(f"finish={_identifier(finish)}")
    error = as_object(info.get("error"))
    if error is not None:
        notes.append(f"error={_identifier(error.get('name'))}")
    return ", ".join(notes) or "unknown"


def _identifier(value: object) -> str:
    return value if isinstance(value, str) and _IDENTIFIER.fullmatch(value) else "other"


# The name the pinned server gives the error of a turn that ended without the structured answer
# (`SessionV1.StructuredOutputError`, v1.19.0; the real-engine tests would go red if it changed).
MISSING_ANSWER_ERROR = "StructuredOutputError"


def missing_answer(message: bytes) -> bool:
    """True when a turn with no structured answer ended for exactly that reason (#309).

    The engine names its own errors (`APIError`, `UnknownError`, an abort, a content filter...);
    only its missing-answer error, or a turn that ended with no error at all, is worth another
    turn. Anything unreadable is not.
    """
    try:
        value: Any = json.loads(message)
    except ValueError:
        return False
    document = as_object(value)
    info = as_object(document.get("info")) if document else None
    if info is None:
        return False
    error: Any = info.get("error")
    if error is None:
        return True
    named = as_object(error)
    return named is not None and named.get("name") == MISSING_ANSWER_ERROR


# The engine's own message for its missing-answer error is a fixed sentence; it is copied into a
# note only while it still looks like one (plain words, short), so a different engine text can
# never carry anything through.
_ENGINE_SENTENCE = re.compile(r"[A-Za-z0-9 .,'-]{1,120}")
MAX_TOOLS_NAMED = 4


def _message_parts(message: bytes) -> list[dict[str, Any]]:
    """The parts of the assistant message that ended a turn, or none when it is unreadable."""
    try:
        value: Any = json.loads(message)
    except ValueError:
        return []
    document = as_object(value)
    parts: Any = document.get("parts") if document else None
    if not isinstance(parts, list):
        return []
    entries: list[Any] = parts  # pyright: ignore[reportUnknownVariableType]
    return [part for part in map(as_object, entries) if part is not None]


def _visible_texts(parts: list[dict[str, Any]], kind: str) -> list[str]:
    return [
        text
        for part in parts
        if part.get("type") == kind
        and part.get("ignored") is not True
        and part.get("synthetic") is not True
        and isinstance(text := part.get("text"), str)
    ]


def answer_text(message: bytes) -> str:
    """The text the model ended a turn with (#312): the visible text parts of the last step.

    The pinned engine leaves this message out of the next turn's history, so the adapter hands the
    text back in the recovery message (`wrap_up.recovery_prompt`). Reasoning is not part of it.
    """
    return "\n\n".join(_visible_texts(_message_parts(message), "text"))


def turn_end_detail(message: bytes) -> str:
    """`turn_end_note` plus what separates a model that wrote prose from one that wrote nothing
    (#312): the engine's own sentence for its missing-answer error, the size of the text and of
    the reasoning of the last step, and the tools it called. Sizes and plain identifiers only."""
    note = turn_end_note(message)
    if note == "unknown":
        return note
    document = as_object(json.loads(message))
    info = as_object(document.get("info")) if document else None
    error = as_object(info.get("error")) if info else None
    data = as_object(error.get("data")) if error else None
    sentence: Any = data.get("message") if data else None
    if (
        error is not None
        and error.get("name") == MISSING_ANSWER_ERROR
        and isinstance(sentence, str)
        and _ENGINE_SENTENCE.fullmatch(sentence)
    ):
        note += f" ({sentence})"
    parts = _message_parts(message)
    text = sum(len(part) for part in _visible_texts(parts, "text"))
    reasoning = sum(len(part) for part in _visible_texts(parts, "reasoning"))
    note += f", text={text} chars, reasoning={reasoning} chars"
    tools: list[str] = []
    for part in parts:
        if part.get("type") == "tool":
            name = _identifier(part.get("tool"))
            if name not in tools:
                tools.append(name)
    if tools:
        note += ", tools=" + "+".join(tools[:MAX_TOOLS_NAMED])
    return note


def structured_answer(message: bytes) -> Any:
    """The structured result out of a message POST answer, or None.

    The pinned server answers `{info, parts}`: a valid JSON-schema answer is stored in
    `info.structured` (the real shape, checked against the binary), and a model that answered in
    prose leaves its JSON in a `text` part. The runner-side codec accepts either and never trusts
    it without the typed validation that follows; `info.error` (for example a missing structured
    answer) is not an answer.
    """
    try:
        value: Any = json.loads(message)
    except ValueError:
        return None
    document = as_object(value)
    if document is None:
        return None
    info = as_object(document.get("info"))
    structured: Any = info.get("structured") if info else None
    if structured is not None:
        return structured
    if info is not None and info.get("error") is not None:
        return None
    parts: Any = document.get("parts")
    if not isinstance(parts, list):
        return None
    entries: list[Any] = parts  # pyright: ignore[reportUnknownVariableType]
    for part in entries:
        block = as_object(part)
        if block is None or block.get("type") != "text":
            continue
        text: Any = block.get("text")
        if isinstance(text, str):
            return text
    return None


class DynamicEngine:
    """One Dynamic Review: the proxy is running, the engine is started, everything is counted."""

    def __init__(
        self,
        job: Job,
        *,
        ledger: BudgetLedger,
        command: Sequence[str],
        directory: str,
        proxy_url: str,
        proxy_capability: str,
        agent_prompt: str,
        model_schema: dict[str, Any],
        inputs: ReviewInputs,
        exported_paths: Collection[str] | None,
        scratch_dir: str | None = None,
        launch: EngineLaunch | None = None,
        node_bin: str | None = None,
        ripgrep: Path | None = None,
        require_ripgrep: bool = True,
        startup_seconds: float = STARTUP_SECONDS,
        transport: Transport = _http_request,
        port_source: Callable[[], int] = lambda: _free_port(),
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
        superseded: Callable[[], bool] = lambda: False,
        plain_final: bool = False,
        engine_config: Mapping[str, Any] | None = None,
        provider_id: str = PROXY_PROVIDER_ID,
        provider_error: Callable[[], ErrorCode | None] = lambda: None,
        wait_idle: Callable[[float], bool] = lambda _timeout: True,
    ) -> None:
        if job.dynamic is None or job.base is None:
            raise EngineError(
                ErrorCode.DYNAMIC_CONFIG_INVALID, "the job carries no dynamic options"
            )
        self.job = job
        self.ledger = ledger
        self.command = tuple(command)
        self.directory = directory
        self.proxy_url = proxy_url
        self._proxy_capability = proxy_capability
        self.agent_prompt = agent_prompt
        self.model_schema = model_schema
        # What the model is given (the real title, body and diff of #196) and the files a finding
        # may point at (exactly the verified export). Both come from the trusted preparation.
        self.inputs = inputs
        self.exported_paths = exported_paths
        self.node_bin = node_bin
        self.ripgrep = ripgrep
        self.require_ripgrep = require_ripgrep
        self.startup_seconds = startup_seconds
        self._transport = transport
        self._port_source = port_source
        self._popen = popen
        # True once the host told the process that a newer push replaced this run: the watch ends
        # the turn at once instead of waiting for the proxy to see the next request.
        self._superseded = superseded
        # The native path (#552): the review is the text of the last message, read and wrapped up
        # above the wire. The ledger is told so from the start: from then on a call it refuses for
        # the cost or the clock is the signal to ask for the answer, and not the run's failure.
        self._plain_final = plain_final
        if plain_final:
            ledger.enable_final_above_wire()
        # The trusted configuration of a native job; None: the legacy proxy provider (`start`).
        self._engine_config = engine_config
        self._provider_id = provider_id
        # The stable code the proxy kept for a provider that failed (`PassthroughProxy`), named
        # when the engine gives up; the engine's own error text is never shown.
        self._provider_error = provider_error
        # Whether the proxy has answered every request it took (`PassthroughProxy.wait_idle`): the
        # final call is marked only when nothing of the aborted turn is in flight (#552).
        self._wait_idle = wait_idle
        self._events_connect_seconds = EVENTS_CONNECT_SECONDS
        # Set by the supervisor: the engine then runs as the dedicated user with its own network
        # rules, and its home, temporary files and config live where `export_isolation` prepared
        # them (removed with the job's lifetime). Without it (the unprivileged engine suite and
        # the scripted tests) the engine runs as the current user in a private scratch directory.
        self.launch = launch
        # The export is read-only and belongs to the engine user; the runner's own config, home and
        # cache live in a private directory outside it, removed when the run ends.
        self._scratch = (
            Path(scratch_dir)
            if scratch_dir
            else Path(launch.tmpdir)
            if launch
            else Path(tempfile.mkdtemp(prefix="cr-engine-"))
        )
        self._process: subprocess.Popen[bytes] | None = None
        self._worker: threading.Thread | None = None
        # How long each message call of the run took, in seconds on the ledger's clock (#293).
        self.turn_seconds: list[float] = []
        # Set when a turn ended without a structured answer and one more turn was started (#309):
        # how the first turn ended, for the result and the log.
        self.recovery: str | None = None
        # How the native finalization ended the review (#578); None on the legacy path.
        self.finalization: FinalizationRecord | None = None

    # -- process --------------------------------------------------------------

    def start(self) -> EngineClient:
        """Write the trusted config, start the engine and wait for it to become healthy."""
        dynamic = self.job.dynamic
        assert dynamic is not None  # narrowed in __init__
        config = (
            dict(self._engine_config)
            if self._engine_config is not None
            else build_engine_config(
                proxy_url=self.proxy_url,
                model=dynamic.model,
                system_prompt=self.agent_prompt,
                proxy_capability=self._proxy_capability,
            )
        )
        if self.launch is not None:
            # The dedicated user's own directories exist and are its own; the config is its file.
            config_path = self.launch.write_config(config)
            home = self.launch.home
        else:
            self._scratch.mkdir(parents=True, exist_ok=True)
            os.chmod(self._scratch, 0o700)
            (self._scratch / "home").mkdir(parents=True, exist_ok=True)
            config_path = self._scratch / "opencode.json"
            # The config carries the job's proxy capability: owner-only, in the private scratch.
            descriptor = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(config))
            home = str(self._scratch / "home")
        environment = engine_environment(
            proxy_url=self.proxy_url,
            home=home,
            scratch_dir=str(self._scratch),
            node_bin=self.node_bin,
            tools_dir=str(self.ripgrep.parent) if self.ripgrep is not None else None,
        )
        # The one file the engine reads its configuration from (confirmed against the pinned
        # release). `OPENCODE_CONFIG_DIR` is deliberately not set: a config directory makes the
        # engine install `@opencode-ai/plugin` into it from the package registry, a download and
        # an install the runner must never allow.
        environment["OPENCODE_CONFIG"] = str(config_path)
        # The engine's grep and glob run ripgrep. Without one on its PATH the pinned release
        # downloads a binary from GitHub on first use (seen against the real binary): a runtime
        # download the runner never allows, and one that fails anyway without network. The trusted
        # image supplies `rg` and the startup self-check verified exactly that file, so it is the
        # file that runs: its directory leads the engine's PATH and no lookup may find another. A
        # missing one is a refusal to start, not an attempt to fetch it.
        if self.require_ripgrep and not self._verified_ripgrep_leads(environment["PATH"]):
            raise EngineError(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE,
                "no verified ripgrep on the engine search path",
            )
        # Without a dedicated user the port is only probed free, not held: the engine binds it
        # itself a moment later. If a stranger took it in between, our engine exits instead of
        # serving and is started again on another port. With one, the port is the slot's fixed
        # one (the static network rules name it); a stranger holding it fails every attempt.
        # Either way an answer is only trusted while our own process is alive.
        for attempt in range(START_ATTEMPTS):
            port = self._port_source() if self.launch is None else self.launch.engine_port
            if self.launch is not None:
                # The user's network is closed to everything but this job's proxy (and the
                # engine's own server) before the engine exists, and proven once.
                self.launch.confine(_port_of(self.proxy_url), port)
            self._spawn(environment, port)
            client = EngineClient(
                f"http://127.0.0.1:{port}",
                self.directory,
                transport=self._transport,
                provider_id=self._provider_id,
            )
            try:
                client.wait_healthy(self.startup_seconds, self._is_running)
                self._require_own_listener(port)
            except EngineExited:
                self._end_process()
                if attempt + 1 == START_ATTEMPTS:
                    raise
                continue
            except EngineError:
                self.stop()
                raise
            return client
        raise EngineExited()  # unreachable: the last attempt raises

    def _verified_ripgrep_leads(self, search_path: str) -> bool:
        """The verified `rg` is an executable file and the first `rg` on the engine's PATH."""
        if self.ripgrep is None or not os.access(self.ripgrep, os.X_OK):
            return False
        return shutil.which("rg", path=search_path) == str(self.ripgrep)

    def _require_own_listener(self, port: int) -> None:
        """The answer came from our engine: its user, and nobody else, listens on that port."""
        if self.launch is None or self.launch.owns_listener(port):
            return
        raise EngineError(
            ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine port is not held by the engine user"
        )

    def _spawn(self, environment: dict[str, str], port: int) -> None:
        argv = [
            *self.command,
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            str(port),
            "--print-logs",
        ]
        options: dict[str, Any] = self.launch.spawn_options() if self.launch else {}
        try:
            process = self._popen(
                argv,
                env=environment,
                cwd=self.directory,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                **options,
            )
        except OSError:
            raise EngineError(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine could not be started"
            ) from None
        self._process = process
        with _ENGINES_LOCK:
            _RUNNING_ENGINES.add(process.pid)
            if self.launch is not None and self.launch not in _RUNNING_LAUNCHES:
                _RUNNING_LAUNCHES.append(self.launch)

    def _is_running(self) -> bool:
        # Looking must not reap the engine: while its group is alive its id has to stay ours.
        return self._process is not None and not has_exited(self._process)

    def stop(self) -> None:
        """End the whole owned process group, then the user's leftovers, and the private scratch.

        With a dedicated user the scratch belongs to the job's lifetime (`export_isolation`
        removes it); here only what the user still runs and its network rules end.
        """
        self._end_process()
        if self.launch is not None:
            with _ENGINES_LOCK:
                if self.launch in _RUNNING_LAUNCHES:
                    _RUNNING_LAUNCHES.remove(self.launch)
            if not self.launch.close():
                _log.warning(_SURVIVOR)
        else:
            shutil.rmtree(self._scratch, ignore_errors=True)

    def _end_process(self) -> None:
        process = self._process
        if process is not None:
            # The engine leads its own session, so its pid is its process group id. Off the registry
            # first (the watchdog then leaves it to us), then the group is ended and the leader
            # reaped last, so the id is never signalled after it could belong to somebody else.
            with _ENGINES_LOCK:
                _RUNNING_ENGINES.discard(process.pid)
            end_group(process)
            if self.launch is not None:
                # A helper that left the group is still the dedicated user's process.
                self.launch.sweep()
        self._process = None

    # -- run ------------------------------------------------------------------

    def run(self) -> EngineAnswer:
        """Run one review. Never raises; a failure is a stable code with no partial result."""
        try:
            self.ledger.check_deadline()
            client = self.start()
            session_id = client.create_session()
            try:
                return self._run_turns(client, session_id)
            finally:
                client.abort(session_id)
        except LimitError as error:
            return EngineAnswer(findings=None, error=EngineError(error.code, error.detail))
        except EngineError as error:
            return EngineAnswer(findings=None, error=error)
        except IsolationError as error:
            return EngineAnswer(findings=None, error=EngineError(error.code, error.detail))
        except FindingsError as error:
            return EngineAnswer(findings=None, error=EngineError(error.code, error.detail))
        except OSError:
            return EngineAnswer(
                findings=None,
                error=EngineError(ErrorCode.RUNNER_ERROR, "the engine could not be run"),
            )
        finally:
            self.stop()
            if self._worker is not None:
                self._worker.join(timeout=5.0)

    def _run_turns(self, client: EngineClient, session_id: str) -> EngineAnswer:
        """The review turn and, when it ended without an answer, the one recovery turn (#309).

        A turn the engine ended itself (a prose answer, an output cut off, a provider that called a
        tool step `stop`) leaves nothing to publish while the limits are not used up. If the ledger
        allows it, one more turn asks for the answer: its first call is the run's final call, which
        the proxy reduces to the return tool alone (`wrap_up.py`). One recovery at most, whatever
        it returns; a limit or provider refusal the proxy recorded always wins. Only the engine's
        missing-answer error is recovered (`missing_answer`): another error of the engine is its
        own failure. Whatever fails once the recovery has started says so.

        A turn that returned an answer whose envelope is not the review (a required field missing or
        mistyped) is recovered the same way, once (#530). An answer the runner's check refuses
        fails with how the last model calls ended, like a missing answer does.
        """
        try:
            if self._plain_final:
                return self._plain_turns(client, session_id)
            return self._turns(client, session_id)
        except FindingsError as error:
            raise self._with_call_outcomes(error) from None

    def _plain_turns(self, client: EngineClient, session_id: str) -> EngineAnswer:
        """The native path (#552): the audit of the engine's tool parts runs on its event stream
        beside the turns, and the turns are `PlainFinalization`'s."""
        dynamic = self.job.dynamic
        assert dynamic is not None  # narrowed in __init__
        audit = ToolPartAudit(self.ledger, session_id, export_root=self.directory)
        events = EventReader(client.open_events, audit, self.ledger)
        events.start(self._events_connect_seconds)
        try:
            final = PlainFinalization(
                client=client,
                session_id=session_id,
                ledger=self.ledger,
                send=lambda prompt: self._send(client, session_id, prompt=prompt),
                model=dynamic.model,
                max_findings=dynamic.limits.max_findings,
                parse=self._parse_plain,
                provider_error=self._provider_error,
                wait_idle=self._wait_idle,
            )
            self.finalization = final.record
            try:
                answer = EngineAnswer(findings=final.run(), error=None)
            except NoFinalAnswer as error:
                answer = self._no_answer(error.note)
        finally:
            events.stop()
        # The reader may have been working on a last event when it was stopped: what it recorded
        # then is the run's result as much as what it recorded before.
        self._raise_recorded_failure()
        return answer

    def _parse_plain(self, document: dict[str, Any]) -> DynamicFindings:
        """The envelope check of the model's JSON; the runner sets the constants itself (#530)."""
        base = self.job.base
        assert base is not None  # narrowed in __init__
        findings = parse_dynamic_findings(
            document, exported_paths=self.exported_paths, reviewed_sha=base.head_sha
        )
        self._note_overrides(findings)
        return findings

    @staticmethod
    def _note_overrides(findings: DynamicFindings) -> None:
        if findings.envelope_overrides:
            _log.warning(
                "the answer did not carry the envelope constants the runner owns: %s",
                ", ".join(findings.envelope_overrides),
            )

    def _turns(self, client: EngineClient, session_id: str) -> EngineAnswer:
        self._send(client, session_id)
        self._raise_recorded_failure()
        if structured_answer(client.last_message) is not None:
            try:
                return self._validate(client)
            except EnvelopeError as error:
                return self._recover_envelope(client, session_id, error)
        ended = turn_end_note(client.last_message)
        first = turn_end_detail(client.last_message)
        if not missing_answer(client.last_message):
            return self._no_answer(
                f"the first turn: {first}; the engine's own error, not recovered"
            )
        if not self.ledger.begin_recovery():
            return self._no_answer(f"the first turn: {first}; no recovery was possible")
        self.recovery = ended
        # The engine drops the answer that ended the turn from the history: hand it back.
        self._recovery_turn(
            client, session_id, recovery_prompt(answer_text(client.last_message)), ended
        )
        if structured_answer(client.last_message) is None:
            return self._no_answer(
                f"after one recovery; the first turn: {first}; "
                f"the recovery: {turn_end_detail(client.last_message)}"
            )
        return self._validate(client)

    def _recovery_turn(
        self, client: EngineClient, session_id: str, prompt: str, ended: str
    ) -> None:
        try:
            self._send(client, session_id, prompt=prompt)
            self._raise_recorded_failure()
        except LimitError as error:
            raise LimitError(error.code, self._during_recovery(error.detail, ended)) from None
        except EngineError as error:
            raise EngineError(error.code, self._during_recovery(error.detail, ended)) from None

    def _recover_envelope(
        self, client: EngineClient, session_id: str, problem: EnvelopeError
    ) -> EngineAnswer:
        """The turn returned a structured answer that is not the review as a whole (#530).

        The engine does not check the arguments of its return tool, so a missing or mistyped
        field of the envelope reaches the runner's own check here. It is asked for once more, the
        same way as a turn with no answer (#309) and inside the same limits, with the concrete
        problem (field names, never values). A second bad answer fails the run, naming the field
        and how the last model calls ended.
        """
        ended = f"the answer was not valid: {problem.detail}"
        if not self.ledger.begin_recovery():
            raise EnvelopeError(problem.code, f"no recovery was possible; {problem.detail}")
        self.recovery = ended
        self._recovery_turn(client, session_id, recovery_prompt(problem=problem.detail), ended)
        if structured_answer(client.last_message) is None:
            return self._no_answer(
                f"after one recovery; the first answer was not valid: {problem.detail}; "
                f"the recovery: {turn_end_detail(client.last_message)}"
            )
        try:
            return self._validate(client)
        except EnvelopeError as again:
            raise EnvelopeError(again.code, f"after one recovery; {again.detail}") from None

    def _with_call_outcomes(self, error: FindingsError) -> FindingsError:
        """The error with how the last model calls ended (sizes and names, no model text)."""
        calls = self.ledger.recent_call_outcomes
        if not calls:
            return error
        detail = f"{error.detail}; last model calls: " + "; ".join(calls)
        return type(error)(error.code, detail)

    @staticmethod
    def _during_recovery(detail: str, ended: str) -> str:
        return f"{detail} (during the recovery; the first turn: {ended})"

    def _no_answer(self, note: str) -> EngineAnswer:
        # What the provider returned for the last calls is what tells prose from silence from a
        # broken tool call (#312); the engine's own report of the turn cannot.
        calls = self.ledger.recent_call_outcomes
        if calls:
            note += "; last model calls: " + "; ".join(calls)
        answer = "valid review" if self._plain_final else "structured answer"
        return EngineAnswer(
            findings=None,
            error=EngineError(
                ErrorCode.LLM_OUTPUT_INVALID, f"the engine returned no {answer} ({note})"
            ),
        )

    def _raise_recorded_failure(self) -> None:
        """A limit or provider refusal the proxy recorded is the run's result."""
        failure = self.ledger.failure
        if failure is not None:
            raise failure

    def _send(self, client: EngineClient, session_id: str, *, prompt: str | None = None) -> None:
        dynamic = self.job.dynamic
        assert dynamic is not None
        # The fixed core, the verified head and the skill are the agent's prompt in the trusted
        # config; only the delimited untrusted input travels as a message part. The recovery turn
        # (#309) sends the runner's own short prompt instead and no input at all.
        if prompt is None:
            prompt = compose_user_prompt(self.inputs)
            if self._plain_final:
                # The schema that carried the job's finding bound is gone with the format: one
                # fixed runner line, outside every untrusted block, states it (#552).
                prompt += "\n" + final_answer_line(dynamic.limits.max_findings) + "\n"
            self.ledger.check_input_bytes(len(prompt.encode("utf-8")))
        schema = (
            None
            if self._plain_final
            else engine_schema(self.model_schema, dynamic.limits.max_findings)
        )
        outcome: list[Exception] = []
        finished = threading.Event()

        def post() -> None:
            try:
                client.send_message(
                    session_id,
                    model=dynamic.model,
                    parts=[{"type": "text", "text": prompt}],
                    schema=schema,
                    timeout=self.ledger.remaining_seconds() + TURN_TIMEOUT_MARGIN_SECONDS,
                )
            except Exception as error:  # re-raised below, in the caller's thread
                outcome.append(error)
            finally:
                finished.set()

        # The message call blocks until the engine is done. It runs beside a watch that ends the
        # run the moment the proxy records a limit or a provider refusal, the deadline passes or
        # the engine dies, instead of waiting for an engine that is retrying a refused call.
        started = self.ledger.elapsed_seconds()
        self._worker = threading.Thread(target=post, daemon=True)
        self._worker.start()
        try:
            while not finished.wait(WATCH_INTERVAL_SECONDS):
                self._raise_recorded_failure()
                if self._superseded():
                    raise EngineError(
                        ErrorCode.SUPERSEDED, "the run was superseded by a newer push"
                    )
                self.ledger.check_deadline()
                if not self._is_running():
                    raise EngineError(
                        ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE,
                        f"{REASON_EXITED}: the engine process ended during its turn",
                    )
            self._raise_recorded_failure()
            if outcome:
                # A call that ran into its timeout at the whole-job deadline is the deadline, not
                # an unreachable engine: both end at the same moment and the order must not
                # matter. The socket timeout and the ledger do not read the same clock to the
                # millisecond.
                self.ledger.check_deadline(tolerance=DEADLINE_TOLERANCE_SECONDS)
                failure = outcome[0]
                if isinstance(failure, EngineError) and not self._is_running():
                    # Whatever the call made of it, the engine process is gone.
                    raise EngineError(
                        ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE,
                        f"{REASON_EXITED}: the engine process ended during its turn",
                    )
                raise failure
        finally:
            self.turn_seconds.append(self.ledger.elapsed_seconds() - started)

    def _validate(self, client: EngineClient) -> EngineAnswer:
        base = self.job.base
        dynamic = self.job.dynamic
        assert base is not None and dynamic is not None
        raw = structured_answer(client.last_message)
        if raw is None:
            return EngineAnswer(
                findings=None,
                error=EngineError(
                    ErrorCode.LLM_OUTPUT_INVALID, "the engine returned no structured answer"
                ),
            )
        # A finding may only point at a file the verified export really contains.
        # The runner sets the constants of the envelope itself (#530): the head is its own claim,
        # never the model's echo of it.
        findings = parse_dynamic_findings(
            raw, exported_paths=self.exported_paths, reviewed_sha=base.head_sha
        )
        self._note_overrides(findings)
        if len(findings.findings) > dynamic.limits.max_findings:
            raise LimitError(
                ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
                "the answer has more findings than the job allows",
            )
        return EngineAnswer(findings=findings, error=None)


def _port_of(url: str) -> int:
    """The port of an `http://127.0.0.1:<port>` address the runner itself built."""
    return int(url.rsplit(":", 1)[-1].split("/", 1)[0])


def _free_port() -> int:
    """A free loopback port for one job's engine. Private to the job; never a fixed port."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])
