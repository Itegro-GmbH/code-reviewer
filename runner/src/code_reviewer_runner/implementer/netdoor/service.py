# SPDX-License-Identifier: LicenseRef-Proprietary

"""The network door process (#745, step 7): the proxy of `proxy.py` behind one port, started with
the environment's rule, reporting what it saw on stdout.

It holds no secret, no repository and no job text beyond the rule. It reads the start document from
stdin, binds the model network's fixed address for the door, says `ready`, tells the log whenever
it changed (once a second at most), and ends on `{"op": "stop"}`, on the end of stdin (Control is
gone) and by itself a while after the turn's deadline.
"""

import json
import logging
import threading
import time
from collections.abc import Callable
from typing import Any, TextIO

from code_reviewer_runner.dynamic_review.model_door_route import (
    NETWORK_DOOR_ADDRESS,
)
from code_reviewer_runner.job_loop.jsonvalues import as_object

from ..network_rule import MODE_OFF, NetworkRule, RuleError, parse_rule
from .addresses import Resolver, ci_public_network, system_resolver
from .connections import ConnectionLog
from .protocol import (
    MAX_COMMAND_BYTES,
    MAX_START_BYTES,
    MESSAGE_READY,
    MESSAGE_REFUSED,
    MESSAGE_STATUS,
    OP_STOP,
    REFUSED_LISTEN_FAILED,
    REFUSED_RULE_INVALID,
    REFUSED_START_INVALID,
    VERSION,
)
from .proxy import Connector, Decider, ProxyServer, tcp_connector

_log = logging.getLogger(__name__)

POLL_SECONDS = 0.2
# A status is said again at most this often, so that a download of many small files does not make
# the pipe the busiest thing on the VM.
REPORT_EVERY_SECONDS = 1.0
LINGER_SECONDS = 600.0
_MIN_PORT = 1024
_MAX_PORT = 32767
_MAX_DEADLINE_SECONDS = 24 * 60 * 60


class StartRefused(Exception):
    """The door cannot start. Carries a word, never a value."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class NetStart:
    def __init__(self, rule: NetworkRule, port: int, deadline_seconds: float) -> None:
        self.rule = rule
        self.port = port
        self.deadline_seconds = deadline_seconds


def parse_start(text: str) -> NetStart:
    if len(text) > MAX_START_BYTES:
        raise StartRefused(REFUSED_START_INVALID)
    try:
        document: Any = json.loads(text)
    except (ValueError, RecursionError):
        raise StartRefused(REFUSED_START_INVALID) from None
    given = as_object(document)
    if (
        given is None
        or given.keys() != {"version", "rule", "listenPort", "deadlineSeconds"}
        or given["version"] != VERSION
    ):
        raise StartRefused(REFUSED_START_INVALID)
    port: Any = given["listenPort"]
    deadline: Any = given["deadlineSeconds"]
    if (
        isinstance(port, bool)
        or not isinstance(port, int)
        or not _MIN_PORT <= port <= _MAX_PORT
        or isinstance(deadline, bool)
        or not isinstance(deadline, int | float)
        or not 0 < deadline <= _MAX_DEADLINE_SECONDS
    ):
        raise StartRefused(REFUSED_START_INVALID)
    try:
        rule = parse_rule(given["rule"], "rule")
    except RuleError:
        raise StartRefused(REFUSED_RULE_INVALID) from None
    if rule.mode == MODE_OFF:
        # `off` has no door: Control does not start one, and one that was asked for is a mistake.
        raise StartRefused(REFUSED_RULE_INVALID)
    return NetStart(rule, port, float(deadline))


def _emit(stdout: TextIO, document: dict[str, Any]) -> None:
    stdout.write(json.dumps(document, separators=(",", ":")) + "\n")
    stdout.flush()


class _Reporter:
    def __init__(self, log: ConnectionLog, stdout: TextIO, clock: Callable[[], float]) -> None:
        self._log = log
        self._stdout = stdout
        self._clock = clock
        self._seq = 0
        self._said = -1
        self._last = float("-inf")

    def ready(self) -> None:
        _emit(self._stdout, {"t": MESSAGE_READY})

    def report(self, *, final: bool = False) -> None:
        version = self._log.version
        now = self._clock()
        if not final and (version == self._said or now - self._last < REPORT_EVERY_SECONDS):
            return
        self._said, self._last = version, now
        self._seq += 1
        try:
            _emit(
                self._stdout,
                {"t": MESSAGE_STATUS, "seq": self._seq, "final": final, **self._log.snapshot()},
            )
        except (OSError, ValueError):
            _log.warning("the network door could not write its status")


def _read_stop(stdin: TextIO, stop: threading.Event) -> None:
    """Sets `stop` on `{"op": "stop"}`, on the end of stdin and on anything unreadable: whatever
    ends this thread ends the door."""
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


def run_netdoor(
    stdin: TextIO,
    stdout: TextIO,
    *,
    bind: tuple[str, int] | None = None,
    resolver: Resolver = system_resolver,
    connector: Connector = tcp_connector,
    clock: Callable[[], float] = time.monotonic,
    poll_seconds: float = POLL_SECONDS,
) -> int:
    """Read the start document, serve, report, end. 0 for an end that was asked for (a stop, or
    Control gone), 2 for a door that could not start (`refused` was printed)."""
    began = clock()
    log = ConnectionLog()
    try:
        start = parse_start(stdin.readline(MAX_START_BYTES + 1))
        decider = Decider(start.rule, log, resolver=resolver, test_network=ci_public_network())
        try:
            server = ProxyServer(
                bind or (NETWORK_DOOR_ADDRESS, start.port), decider, connector=connector
            ).start()
        except OSError:
            raise StartRefused(REFUSED_LISTEN_FAILED) from None
    except StartRefused as refusal:
        _log.error("the network door cannot start: %s", refusal.reason)
        _emit(stdout, {"t": MESSAGE_REFUSED, "reason": refusal.reason})
        return 2
    reporter = _Reporter(log, stdout, clock)
    stop = threading.Event()
    threading.Thread(target=_read_stop, args=(stdin, stop), daemon=True).start()
    reporter.ready()
    try:
        while not stop.wait(poll_seconds):
            if clock() - began > start.deadline_seconds + LINGER_SECONDS:
                break
            reporter.report()
    finally:
        server.stop()
        reporter.report(final=True)
    return 0
