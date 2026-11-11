# SPDX-License-Identifier: LicenseRef-Proprietary

"""The model door (#745, step 3): the key, the model pin, the cost limit and the output cap in a
container of their own, with the passthrough proxy of Dynamic Review behind a port.

The process of the `door` mode of the image. It holds what the Worker's own proxy held and nothing
else: no git token, no job text beyond the model access, no repository. It reads the start
document from stdin (the key travels there and nowhere else), builds the ledger and the proxy by
the same code the in-process proxy is built by (`native_job.build_native`, so the checks are the
same ones: the destination of the key, the cost policy, the model pin, the admission of every
request, the output cap), serves them on one port, and reports the ledger on stdout
(`protocol.py`). It talks to the provider and to nobody else; it never calls Control.

It ends on `{"op": "stop"}`, on the end of stdin (Control is gone, and with it the reason for the
key to be here), and by itself a while after the turn's deadline.
"""

import json
import logging
import threading
import time
from collections.abc import Callable, Mapping
from decimal import Decimal
from typing import Any, TextIO

from code_reviewer_runner.dynamic_review.budget import DynamicLimits, LimitError
from code_reviewer_runner.dynamic_review.model_door_route import MODEL_DOOR_ADDRESS
from code_reviewer_runner.dynamic_review.native_job import NativeJob, UpstreamFactory, build_native
from code_reviewer_runner.dynamic_review.passthrough.server import PassthroughServer
from code_reviewer_runner.dynamic_review.passthrough.upstream import HttpsUpstream
from code_reviewer_runner.job import JobError, parse_model_access
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.outer_proxy import OuterProxy, OuterProxyError

from ..limits import agent_limits
from .ledger import AnnouncingLedger
from .protocol import (
    MAX_COMMAND_BYTES,
    MAX_START_BYTES,
    MESSAGE_READY,
    MESSAGE_REFUSED,
    OP_STOP,
    REFUSED_ACCESS_INVALID,
    REFUSED_CONFIG_INVALID,
    REFUSED_LISTEN_FAILED,
    REFUSED_START_INVALID,
    VERSION,
    DoorFailure,
    DoorRefused,
    DoorStatus,
)
from .status import status_line

_log = logging.getLogger(__name__)

# How often the door looks at its ledger and says so when it changed.
POLL_SECONDS = 0.1
# The door ends itself this long after the turn's deadline if nobody stopped it.
LINGER_SECONDS = 600.0
# A stop waits this long for a call that is still being settled, so that the final status holds it.
DRAIN_SECONDS = 2.0
_MIN_PORT = 1024
_MAX_PORT = 32767
_MAX_DEADLINE_SECONDS = 24 * 60 * 60
_PERMITTED_ENVIRONMENT = frozenset({"RUNNER_DYNAMIC_MAX_COST_USD"})


class DoorStart:
    """The start document, read and checked. Holds the key (in `model_access`); never printed."""

    def __init__(
        self,
        *,
        model_access: dict[str, Any],
        capability: str,
        deadline_seconds: float,
        listen_port: int,
        environment: Mapping[str, str],
        outer_proxy: OuterProxy | None = None,
    ) -> None:
        self.model_access = model_access
        self.capability = capability
        self.deadline_seconds = deadline_seconds
        self.listen_port = listen_port
        self.environment = environment
        # The host's outer-wall proxy (#994): the door's one way to the provider on a customer's
        # machine. None: the door dials the provider itself, as hosted.
        self.outer_proxy = outer_proxy

    def __repr__(self) -> str:
        return "DoorStart(...)"


def parse_start(text: str) -> DoorStart:
    """The start document of a line. Raises `DoorRefused` with a word; the text of the document is
    never part of an error."""
    if len(text) > MAX_START_BYTES:
        raise DoorRefused(REFUSED_START_INVALID)
    try:
        document: Any = json.loads(text)
    except (ValueError, RecursionError):
        raise DoorRefused(REFUSED_START_INVALID) from None
    given = as_object(document)
    keys = {"version", "modelAccess", "capability", "deadlineSeconds", "listenPort", "environment"}
    if given is None or not keys <= given.keys() <= keys | {"outerProxy"}:
        raise DoorRefused(REFUSED_START_INVALID)
    if given["version"] != VERSION:
        raise DoorRefused(REFUSED_START_INVALID)
    outer_proxy: OuterProxy | None = None
    if "outerProxy" in given:
        try:
            outer_proxy = OuterProxy.from_json(given["outerProxy"])
        except OuterProxyError:
            raise DoorRefused(REFUSED_START_INVALID) from None
    access = as_object(given["modelAccess"])
    capability: Any = given["capability"]
    deadline: Any = given["deadlineSeconds"]
    port: Any = given["listenPort"]
    environment = as_object(given["environment"])
    if (
        access is None
        or not isinstance(capability, str)
        or len(capability) < 32
        or isinstance(deadline, bool)
        or not isinstance(deadline, int | float)
        or not 0 < deadline <= _MAX_DEADLINE_SECONDS
        or isinstance(port, bool)
        or not isinstance(port, int)
        or not _MIN_PORT <= port <= _MAX_PORT
        or environment is None
        or not environment.keys() <= _PERMITTED_ENVIRONMENT
        or not all(isinstance(value, str) for value in environment.values())
    ):
        raise DoorRefused(REFUSED_START_INVALID)
    return DoorStart(
        model_access=access,
        capability=capability,
        deadline_seconds=float(deadline),
        listen_port=port,
        environment={name: str(value) for name, value in environment.items()},
        outer_proxy=outer_proxy,
    )


class ModelDoor:
    """The ledger, the proxy and the server of one turn. `start()` serves, `status()` reads the
    ledger, `stop()` ends the server."""

    def __init__(
        self,
        start: DoorStart,
        *,
        bind: tuple[str, int] | None = None,
        upstream_for: UpstreamFactory | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._start = start
        self._bind = bind or (MODEL_DOOR_ADDRESS, start.listen_port)
        # The provider's connection: the host's outer-wall proxy when the start names one, else the
        # door's own (hosted). A test brings a double.
        proxy = start.outer_proxy
        self._upstream_for: UpstreamFactory = upstream_for or (
            HttpsUpstream
            if proxy is None
            else (lambda base_url: HttpsUpstream(base_url, proxy=proxy))
        )
        self._clock = clock
        self._native: NativeJob | None = None
        self._server: PassthroughServer | None = None
        self._announce: Callable[[], None] | None = None
        self._model = ""
        self._seq = 0
        self._began = clock()

    @property
    def url(self) -> str:
        assert self._server is not None
        return self._server.url

    def announce_changes_to(self, announce: Callable[[], None]) -> None:
        """`announce` is called whenever a call changes the ledger (`AnnouncingLedger`)."""
        self._announce = announce

    def _changed(self) -> None:
        if self._announce is not None:
            self._announce()

    def start(self) -> None:
        start = self._start
        try:
            llm, entry, cost = parse_model_access(start.model_access)
        except JobError:
            raise DoorRefused(REFUSED_ACCESS_INVALID) from None
        deadline = start.deadline_seconds

        def limits(max_cost: Decimal, reason: str) -> DynamicLimits:
            return agent_limits(deadline, max_cost, reason)

        try:
            self._native = build_native(
                entry,
                cost,
                llm,
                deadline=deadline,
                environment=start.environment,
                upstream_for=self._upstream_for,
                clock=self._clock,
                limits=limits,
                capability=start.capability,
                ledger_type=AnnouncingLedger,
            )
        except LimitError:
            raise DoorRefused(REFUSED_CONFIG_INVALID) from None
        self._model = llm.model
        assert isinstance(self._native.ledger, AnnouncingLedger)
        self._native.ledger.announce = self._changed
        try:
            self._server = PassthroughServer(self._native.run.proxy, *self._bind).start()
        except OSError:
            raise DoorRefused(REFUSED_LISTEN_FAILED) from None

    def status(self, *, final: bool = False) -> DoorStatus:
        """The ledger as it stands. The model calls of the trace go with the final status only."""
        native = self._native
        assert native is not None
        ledger = native.ledger
        failure = ledger.failure
        usage = ledger.usage(self._model)
        document = usage.to_json()
        document.pop("callTrace", None)
        trace = ledger.trace.to_json() if final else None
        upstream = native.run.proxy.last_upstream_error
        self._seq += 1
        return DoorStatus(
            seq=self._seq,
            final=final,
            model_used=ledger.model_used,
            open_calls=ledger.open_calls,
            failure=None if failure is None else DoorFailure(failure.code.value, failure.detail),
            upstream_error=None if upstream is None else upstream.value,
            usage=document,
            model_calls=[] if trace is None else list(trace["modelCalls"]),
            truncated=False if trace is None else bool(trace["truncated"]),
        )

    def overdue(self) -> bool:
        return self._clock() - self._began > self._start.deadline_seconds + LINGER_SECONDS

    def stop(self) -> None:
        if self._server is not None:
            self._server.stop(drain_seconds=DRAIN_SECONDS)
            self._server = None


def _emit(stdout: TextIO, document: dict[str, Any]) -> None:
    stdout.write(json.dumps(document, separators=(",", ":")) + "\n")
    stdout.flush()


def _significant(status: DoorStatus) -> tuple[object, ...]:
    """What makes a status worth saying again: everything but its serial number."""
    return (
        status.final,
        status.model_used,
        status.open_calls,
        status.failure,
        status.upstream_error,
        json.dumps(status.usage, sort_keys=True),
    )


class _Reporter:
    """Says `ready` and then the ledger on stdout, from any thread: the poll of `run_door` and the
    request threads of the proxy (through `AnnouncingLedger`). One lock orders the lines and their
    serial numbers; nothing is said before `ready`."""

    def __init__(self, door: ModelDoor, stdout: TextIO) -> None:
        self._door = door
        self._stdout = stdout
        self._lock = threading.Lock()
        self._open = False
        # Set by the final status: a call that is still being answered cannot speak after it (its
        # serial number would be higher, and Control would take it for the last word).
        self._closed = False
        self._last: tuple[object, ...] | None = None

    def ready(self) -> None:
        with self._lock:
            _emit(self._stdout, {"t": MESSAGE_READY})
            self._open = True

    def report(self, *, final: bool = False) -> None:
        with self._lock:
            if not self._open or self._closed:
                return
            status = self._door.status(final=final)
            marker = _significant(status)
            if not final and marker == self._last:
                return
            self._last = marker
            self._closed = final
            try:
                _emit(self._stdout, status_line(status))
            except (OSError, ValueError):
                # Control is gone (a broken pipe, a closed stream): the door ends with its stdin,
                # and a failed line must not change what the caller of the ledger sees.
                _log.warning("the model door could not write its status")


def _read_stop(stdin: TextIO, stop: threading.Event) -> None:
    """Sets `stop` on `{"op": "stop"}`, on the end of stdin and on anything unreadable: whatever
    ends this thread ends the door, so that a reader that died never leaves the key served."""
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


def run_door(
    stdin: TextIO,
    stdout: TextIO,
    *,
    bind: tuple[str, int] | None = None,
    upstream_for: UpstreamFactory | None = None,
    clock: Callable[[], float] = time.monotonic,
    poll_seconds: float = POLL_SECONDS,
) -> int:
    """The door process: read the start document, serve, report the ledger, end. Returns the exit
    code: 0 for an end that was asked for (a stop, or Control gone), 2 for a door that could not
    start (`refused` was printed).

    The ledger is reported when a call changes it (reserve, settle) and, as a safety net, when the
    poll finds it changed."""
    first = stdin.readline(MAX_START_BYTES + 1)
    door: ModelDoor | None = None
    try:
        door = ModelDoor(parse_start(first), bind=bind, upstream_for=upstream_for, clock=clock)
        door.start()
    except DoorRefused as refusal:
        _log.error("the model door cannot start: %s", refusal.reason)
        _emit(stdout, {"t": MESSAGE_REFUSED, "reason": refusal.reason})
        return 2
    finally:
        # The start document held the key; nothing here needs the text again.
        first = ""
    reporter = _Reporter(door, stdout)
    door.announce_changes_to(reporter.report)
    stop = threading.Event()
    threading.Thread(target=_read_stop, args=(stdin, stop), daemon=True).start()
    reporter.ready()
    try:
        while not stop.wait(poll_seconds):
            if door.overdue():
                break
            reporter.report()
    finally:
        door.stop()
        reporter.report(final=True)
    return 0
