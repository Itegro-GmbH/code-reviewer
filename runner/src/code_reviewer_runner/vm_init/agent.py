# SPDX-License-Identifier: LicenseRef-Proprietary

"""What vm-init does, in order (#977, `contracts/vm-init.v1.json`):

1. listen for the start on vsock (so the host can connect as soon as the VM is up);
2. prepare the VM as the hosted launcher does (`steps.py`), the host's connection waiting meanwhile;
3. accept it, read the start (a frame), answer `ack` or `refused`;
4. check the image against the manifest's id, make the work volume, run Control with the start's
   `docker run` arguments and the job document on its stdin;
5. report how it ended to the host and power the VM off.

Everything that can end the VM before Control ran is one `Outcome` with a stable reason and the exit
status 2 (the Worker's "setup error"), so the host never has to read a text. The credential is
held in
memory by the `StartRequest` and goes to the pipe of Control's stdin; the logs of this module name
steps, reasons and exit statuses, never an argument or a value.
"""

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

from .control import Spawn
from .power import power_off as real_power_off
from .steps import (
    CommandRunner,
    StepFailed,
    docker_answers_step,
    image_step,
    pre_daemon_steps,
    run_steps,
    sysbox_step,
    work_volume_steps,
)
from .transport import Listener, Vsock
from .wire import (
    REPORT_PORT,
    REPORT_RETRY_SECONDS,
    REPORT_SECONDS,
    REQUEST_EXIT,
    REQUEST_START,
    SETUP_ERROR_EXIT,
    START_PORT,
    START_READ_SECONDS,
    START_WAIT_SECONDS,
    ExitReason,
    ProtocolError,
    StartRequest,
    StreamSocket,
    ack_reply,
    encode_frame,
    exit_report,
    parse_start,
    read_ack,
    read_frame,
    refused_start_reply,
)

_log = logging.getLogger(__name__)

# Ends the VM; returns only when it did not (False).
PowerOff = Callable[[], bool]

# The statuses of `docker run` that are docker's own, not the container's.
_DOCKER_OWN_STATUSES: Final = frozenset({125, 126, 127})


@dataclass(frozen=True)
class Timing:
    """The contract's times; a test shortens them."""

    start_wait_seconds: float = START_WAIT_SECONDS
    start_read_seconds: float = START_READ_SECONDS
    report_seconds: float = REPORT_SECONDS
    report_retry_seconds: float = REPORT_RETRY_SECONDS


@dataclass(frozen=True)
class Environment:
    """Everything vm-init touches outside itself, so that a test brings its own."""

    vsock: Vsock
    runner: CommandRunner
    spawn: Spawn
    power_off: PowerOff = real_power_off
    timing: Timing = Timing()


@dataclass(frozen=True)
class Outcome:
    exit_code: int
    reason: ExitReason


def _setup_error(reason: ExitReason) -> Outcome:
    return Outcome(SETUP_ERROR_EXIT, reason)


def _control_outcome(status: int) -> Outcome:
    code = min(max(status, 0), 255)
    if code in _DOCKER_OWN_STATUSES:
        return Outcome(code, ExitReason.DOCKER_FAILED)
    return Outcome(code, ExitReason.WORKER_EXITED)


def _has_trailing_bytes(connection: StreamSocket) -> bool:
    """Whether the host sent anything after the one frame of its request (a protocol error)."""
    try:
        connection.settimeout(0.0)
        return len(connection.recv(1)) > 0
    except (BlockingIOError, TimeoutError):
        return False
    except OSError:
        return False


class VmInit:
    def __init__(self, environment: Environment) -> None:
        self._env = environment

    def run(self) -> bool:
        """The whole life of the VM's job. Returns what the power off returned: False when the VM
        did not end (the caller says so and exits non-zero); a VM that ended never returns."""
        started = time.monotonic()
        try:
            listener = self._env.vsock.listen(START_PORT)
        except OSError:
            _log.error("vm-init: cannot listen for the start")
            outcome = _setup_error(ExitReason.PREPARE_FAILED)
        else:
            try:
                outcome = self._serve(listener, started)
            except Exception as error:
                # A bug of ours must still end the VM with a report: the host would
                # otherwise wait for a VM that sits there. Only the class is logged;
                # the text of an unknown error could hold a value.
                _log.error("vm-init: unexpected %s", type(error).__name__)
                outcome = _setup_error(ExitReason.PREPARE_FAILED)
            finally:
                listener.close()
        _log.info("vm-init: ending: %s, status %d", outcome.reason.value, outcome.exit_code)
        self._report(outcome)
        return self._env.power_off()

    # -- the start ---

    def _serve(self, listener: Listener, started: float) -> Outcome:
        try:
            self._prepare()
        except StepFailed as failure:
            _log.error("vm-init: prepare failed at %s", failure.label)
            return _setup_error(ExitReason.PREPARE_FAILED)
        waited = time.monotonic() - started
        connection = listener.accept(max(self._env.timing.start_wait_seconds - waited, 0.0))
        if connection is None:
            _log.error("vm-init: no start in time")
            return _setup_error(ExitReason.START_TIMEOUT)
        # One start per VM: nothing else is accepted from here on.
        listener.close()
        try:
            request = self._read_start(connection)
        except (ProtocolError, TimeoutError, OSError):
            self._answer(connection, refused_start_reply())
            connection.close()
            _log.error("vm-init: the start was refused")
            return _setup_error(ExitReason.START_INVALID)
        self._answer(connection, ack_reply(REQUEST_START))
        connection.close()
        return self._job(request)

    def _prepare(self) -> None:
        env = self._env
        if (
            env.runner.run(
                docker_answers_step().argv, timeout=docker_answers_step().timeout, capture=False
            ).exit_code
            == 0
        ):
            # The guest's init started a daemon already: the directories of a running daemon
            # cannot be
            # moved to memory under it, and the init's own order is the one that holds.
            _log.info("vm-init: a daemon already answers, the steps before it are skipped")
        else:
            run_steps(env.runner, pre_daemon_steps())
        run_steps(env.runner, (sysbox_step(),))

    def _read_start(self, connection: StreamSocket) -> StartRequest:
        document = read_frame(connection, deadline_seconds=self._env.timing.start_read_seconds)
        if _has_trailing_bytes(connection):
            raise ProtocolError("a byte follows the frame of the start")
        return parse_start(document)

    def _answer(self, connection: StreamSocket, reply: dict[str, object]) -> None:
        try:
            connection.settimeout(self._env.timing.start_read_seconds)
            connection.sendall(encode_frame(reply))
        except (OSError, ProtocolError):
            _log.warning("vm-init: the host did not take the answer")

    # -- the job ---

    def _job(self, request: StartRequest) -> Outcome:
        env = self._env
        image = image_step(request.image.reference)
        found = env.runner.run(image.argv, timeout=image.timeout, capture=True)
        if found.exit_code != 0:
            _log.error("vm-init: the image is not in the VM")
            return _setup_error(ExitReason.IMAGE_MISSING)
        if found.stdout.strip() != request.image.image_id:
            _log.error("vm-init: the image is not the manifest's")
            return _setup_error(ExitReason.IMAGE_MISMATCH)
        try:
            run_steps(env.runner, work_volume_steps(request.volume_name, request.reserve_gib))
        except StepFailed as failure:
            _log.error("vm-init: the work volume failed at %s", failure.label)
            return _setup_error(ExitReason.PREPARE_FAILED)
        _log.info("vm-init: starting Control")
        status = env.spawn(request.args, request.stdin_document())
        return _control_outcome(status)

    # -- the end ---

    def _report(self, outcome: Outcome) -> None:
        """Tells the host how the VM ended. Tries again for at most the contract's time; a host that
        never answers is left with a VM that ends without having been told."""
        timing = self._env.timing
        frame = encode_frame(exit_report(outcome.exit_code, outcome.reason))
        deadline = time.monotonic() + timing.report_seconds
        while (remaining := deadline - time.monotonic()) > 0:
            try:
                connection = self._env.vsock.connect_host(REPORT_PORT, remaining)
            except OSError:
                time.sleep(min(timing.report_retry_seconds, max(remaining, 0.0)))
                continue
            try:
                connection.settimeout(remaining)
                connection.sendall(frame)
                read_ack(
                    read_frame(
                        connection, deadline_seconds=max(deadline - time.monotonic(), 0.001)
                    ),
                    REQUEST_EXIT,
                )
                return
            except (OSError, ProtocolError, TimeoutError):
                time.sleep(min(timing.report_retry_seconds, max(deadline - time.monotonic(), 0.0)))
            finally:
                connection.close()
        _log.warning("vm-init: the host did not take the exit report")
