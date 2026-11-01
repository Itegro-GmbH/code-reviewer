# SPDX-License-Identifier: LicenseRef-Proprietary

"""The engine of one Implementer turn (#764): the pinned OpenCode server, driven over its local
HTTP API, with the write tools.

It has the skeleton of the Dynamic Review's adapter (`dynamic_review/adapter.py`) and reuses its
parts: the engine user and its network rules (`EngineLaunch`), a private home, `opencode serve` on
the slot's loopback port, the HTTP client, the event stream that feeds the tool audit, and the
ledger behind the model proxy. What it does not have is anything review-shaped: no structured
answer, no findings, no wrap-up above the wire. The agent works until it ends its turn; the ledger
refuses the next model call when the cost limit or the clock is reached, and that is what ends it.

Nothing here steers the agent: no step limit, no plan. The cost limit and the clock are the brakes.
Prompt caching is whatever the stock engine and the passthrough proxy do for Dynamic; nothing here
sets, removes or rewrites a cache marker.
"""

import json
import logging
import os
import shutil
import socket
import subprocess
import tempfile
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from code_reviewer_runner.dynamic_review.adapter import (
    DEADLINE_TOLERANCE_SECONDS,
    EVENTS_CONNECT_SECONDS,
    REASON_EXITED,
    START_ATTEMPTS,
    STARTUP_SECONDS,
    TURN_TIMEOUT_MARGIN_SECONDS,
    WATCH_INTERVAL_SECONDS,
    EngineClient,
    EngineError,
    EngineExited,
    Transport,
    _http_request,  # pyright: ignore[reportPrivateUsage]
    answer_text,
    register_engine,
    turn_end_note,
    unregister_engine,
)
from code_reviewer_runner.dynamic_review.budget import BudgetLedger
from code_reviewer_runner.dynamic_review.engine_events import EventReader
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.tool_part_audit import ToolPartAudit
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.process_group import end_group, has_exited
from code_reviewer_runner.result import ErrorCode

from .config import IMPLEMENTER_AGENT, SESSION_TITLE

_log = logging.getLogger(__name__)
_SURVIVOR = (
    "a process of the engine's dedicated user could not be ended; its network rules stay and the "
    "next job on this container refuses to start until it is gone"
)


def _free_port() -> int:
    """A free loopback port for an engine that has no slot (the unprivileged tests)."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _port_of(url: str) -> int:
    """The port of an `http://127.0.0.1:<port>` address the runner itself built."""
    return int(url.rsplit(":", 1)[-1].split("/", 1)[0])


@dataclass(frozen=True)
class AgentTurn:
    """How a turn ended: the text the model closed it with (the agent's own words, untrusted)."""

    text: str
    note: str


class ImplementerAgent:
    """One engine, one session. `start()`, any number of `turn()`s, `stop()`.

    `check` of a turn is called every watch interval and may raise: the caller's own reasons to end
    the turn at once (a push the provider refused, a branch the agent rewrote).
    """

    def __init__(
        self,
        *,
        ledger: BudgetLedger,
        command: Sequence[str],
        directory: str,
        make_config: Callable[[str], Mapping[str, Any]],
        instructions: tuple[str, str],
        environment: Mapping[str, str],
        model: str,
        provider_id: str,
        proxy_url: str,
        scratch_dir: str | None = None,
        launch: EngineLaunch | None = None,
        ripgrep: Path | None = None,
        require_ripgrep: bool = True,
        startup_seconds: float = STARTUP_SECONDS,
        events_connect_seconds: float = EVENTS_CONNECT_SECONDS,
        transport: Transport = _http_request,
        port_source: Callable[[], int] = _free_port,
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
    ) -> None:
        self.ledger = ledger
        self.command = tuple(command)
        self.directory = directory
        self.model = model
        self.session_id: str | None = None
        # The configuration the engine was given (set by `start`).
        self.config: dict[str, Any] = {}
        self.launch = launch
        # The configuration as a function of the path of the instruction file, which is only known
        # where the file is written (the engine user's directory, or the scratch directory).
        self._make_config = make_config
        # (file name, text): the runner's addition to the stock prompt, written next to the config.
        self._instructions = instructions
        self._environment = dict(environment)
        self._provider_id = provider_id
        self._proxy_url = proxy_url
        self._ripgrep = ripgrep
        self._require_ripgrep = require_ripgrep
        self._startup_seconds = startup_seconds
        self._events_connect_seconds = events_connect_seconds
        self._transport = transport
        self._port_source = port_source
        self._popen = popen
        # The engine's own private directory: its config, and where its temporary files live when
        # there is no dedicated user (the unprivileged tests). With a user, the scratch directory is
        # the job's and the supervisor removes it with the job's lifetime.
        self._scratch = (
            Path(scratch_dir)
            if scratch_dir
            else Path(launch.tmpdir)
            if launch
            else Path(tempfile.mkdtemp(prefix="cr-implementer-"))
        )
        self._owns_scratch = launch is None and scratch_dir is None
        self._process: subprocess.Popen[bytes] | None = None
        self._client: EngineClient | None = None
        self._events: EventReader | None = None
        # How long each message call took, in seconds on the ledger's clock.
        self.turn_seconds: list[float] = []

    # -- process --------------------------------------------------------------

    def start(self) -> None:
        """Write the trusted config, start the engine, wait for it to be healthy and open the one
        session. Raises `EngineError`, `LimitError` or `IsolationError`; the caller calls
        `stop()`."""
        self.ledger.check_deadline()
        name, text = self._instructions
        if self.launch is not None:
            written = self.launch.write_file(name, text)
            config = dict(self._make_config(str(written)))
            config_path = self.launch.write_config(config)
        else:
            self._scratch.mkdir(parents=True, exist_ok=True)
            os.chmod(self._scratch, 0o700)
            written = self._scratch / name
            written.write_text(text, encoding="utf-8")
            os.chmod(written, 0o600)
            config = dict(self._make_config(str(written)))
            config_path = self._scratch / "opencode.json"
            # The config carries the job's proxy capability: owner-only.
            descriptor = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(config))
        self.config = config
        environment = dict(self._environment)
        # The one file the engine reads its configuration from; `OPENCODE_CONFIG_DIR` is never set
        # (it makes the engine install a plugin package from the registry).
        environment["OPENCODE_CONFIG"] = str(config_path)
        if self._require_ripgrep and not self._verified_ripgrep_leads(environment["PATH"]):
            raise EngineError(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE,
                "no verified ripgrep on the engine search path",
            )
        client = self._start_engine(environment)
        self._client = client
        self.session_id = client.create_session()
        self._open_audit(client, self.session_id)

    def _start_engine(self, environment: dict[str, str]) -> EngineClient:
        # With a dedicated user the port is the slot's fixed one (the static network rules name
        # it); without, a free port is picked and a stranger taking it makes the engine exit, which
        # is tried again. An answer is only trusted while our own process is alive.
        for attempt in range(START_ATTEMPTS):
            port = self._port_source() if self.launch is None else self.launch.engine_port
            if self.launch is not None:
                self.launch.confine(_port_of(self._proxy_url), port)
            self._spawn(environment, port)
            client = EngineClient(
                f"http://127.0.0.1:{port}",
                self.directory,
                transport=self._transport,
                provider_id=self._provider_id,
                agent=IMPLEMENTER_AGENT,
                session_title=SESSION_TITLE,
            )
            try:
                client.wait_healthy(self._startup_seconds, self._is_running)
                self._require_own_listener(port)
            except EngineExited:
                self._end_process()
                if attempt + 1 == START_ATTEMPTS:
                    raise
                continue
            return client
        raise EngineExited()  # unreachable: the last attempt raises

    def _open_audit(self, client: EngineClient, session_id: str) -> None:
        """The audit of the engine's tool parts runs on its event stream beside the turns: it
        counts tool calls and result bytes into the ledger (the call trace, the per-result and
        the cumulative bound)."""
        audit = ToolPartAudit(self.ledger, session_id, export_root=self.directory)
        events = EventReader(client.open_events, audit, self.ledger)
        events.start(self._events_connect_seconds)
        self._events = events

    def _verified_ripgrep_leads(self, search_path: str) -> bool:
        """The verified `rg` is an executable file and the first `rg` on the engine's PATH."""
        if self._ripgrep is None or not os.access(self._ripgrep, os.X_OK):
            return False
        return shutil.which("rg", path=search_path) == str(self._ripgrep)

    def _require_own_listener(self, port: int) -> None:
        if self.launch is None or self.launch.owns_listener(port):
            return
        raise EngineError(
            ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine port is not held by the engine user"
        )

    def _spawn(self, environment: dict[str, str], port: int) -> None:
        argv = [*self.command, "serve", "--hostname", "127.0.0.1", "--port", str(port)]
        options: dict[str, Any] = self.launch.spawn_options() if self.launch else {}
        try:
            process = self._popen(
                [*argv, "--print-logs"],
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
        register_engine(process.pid, self.launch)

    def _is_running(self) -> bool:
        # Looking must not reap the engine: while its group is alive its id has to stay ours.
        return self._process is not None and not has_exited(self._process)

    def stop(self) -> bool:
        """End the audit, the whole process group and everything the engine user still runs. True
        when nothing of that user is left (always True without a dedicated user). Safe to call
        twice. The commit of leftovers and the push come after this: no process of the agent can
        change the working tree from here on."""
        if self._events is not None:
            self._events.stop()
            self._events = None
        self._end_process()
        clean = True
        if self.launch is not None:
            unregister_engine(None, self.launch)
            clean = self.launch.close()
            if not clean:
                _log.warning(_SURVIVOR)
        elif self._owns_scratch:
            shutil.rmtree(self._scratch, ignore_errors=True)
        return clean

    def _end_process(self) -> None:
        process = self._process
        if process is not None:
            # The engine leads its own session, so its pid is its process group id. Off the
            # registry first, then the group is ended and the leader reaped last.
            unregister_engine(process.pid, None)
            end_group(process)
            if self.launch is not None:
                self.launch.sweep()  # a helper that left the group is still the user's process
        self._process = None

    @property
    def running(self) -> bool:
        return self._is_running()

    # -- a turn ---------------------------------------------------------------

    def abort(self) -> None:
        if self._client is not None and self.session_id is not None:
            self._client.abort(self.session_id)

    def turn(self, text: str, *, check: Callable[[], None] = lambda: None) -> AgentTurn:
        """Send `text` as one user message and wait for the end of the turn.

        The message call blocks until the engine is done, so it runs beside a watch that ends the
        turn the moment the proxy records a limit or a provider refusal, the clock runs out, the
        caller's `check` raises or the engine dies. Raises `LimitError`, `EngineError` or whatever
        `check` raises; the caller decides what a stop means.
        """
        client, session_id = self._client, self.session_id
        if client is None or session_id is None:
            raise EngineError(ErrorCode.RUNNER_ERROR, "the engine is not started")
        outcome: list[Exception] = []
        finished = threading.Event()

        def post() -> None:
            try:
                client.send_message(
                    session_id,
                    model=self.model,
                    parts=[{"type": "text", "text": text}],
                    schema=None,
                    timeout=self.ledger.remaining_seconds() + TURN_TIMEOUT_MARGIN_SECONDS,
                )
            except Exception as error:  # re-raised below, in the caller's thread
                outcome.append(error)
            finally:
                finished.set()

        started = self.ledger.elapsed_seconds()
        worker = threading.Thread(target=post, daemon=True)
        worker.start()
        try:
            while not finished.wait(WATCH_INTERVAL_SECONDS):
                self._watch(check)
            self._raise_recorded_failure()
            if outcome:
                # A call that ran into its timeout at the deadline is the deadline, not an
                # unreachable engine: both end at the same moment and the order must not matter.
                self.ledger.check_deadline(tolerance=DEADLINE_TOLERANCE_SECONDS)
                failure = outcome[0]
                if isinstance(failure, EngineError) and not self._is_running():
                    raise self._exited()
                raise failure
        finally:
            self.turn_seconds.append(self.ledger.elapsed_seconds() - started)
            worker.join(timeout=5.0)
        return self._ended(client.last_message)

    def _watch(self, check: Callable[[], None]) -> None:
        self._raise_recorded_failure()
        check()
        self.ledger.check_deadline()
        if not self._is_running():
            raise self._exited()

    def _raise_recorded_failure(self) -> None:
        """A limit or provider refusal the proxy recorded is the turn's result."""
        failure = self.ledger.failure
        if failure is not None:
            raise failure

    @staticmethod
    def _exited() -> EngineError:
        return EngineError(
            ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE,
            f"{REASON_EXITED}: the engine process ended during its turn",
        )

    @staticmethod
    def _ended(message: bytes) -> AgentTurn:
        """The turn's end. An error of the engine itself that the ledger did not record (the proxy
        records every refusal) is the engine's own failure: it names an identifier, never text."""
        try:
            document = as_object(json.loads(message))
        except ValueError:
            document = None
        info = as_object(document.get("info")) if document else None
        if info is not None and info.get("error") is not None:
            raise EngineError(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE,
                f"the engine ended its turn with an error ({turn_end_note(message)})",
            )
        return AgentTurn(text=answer_text(message), note=turn_end_note(message))
