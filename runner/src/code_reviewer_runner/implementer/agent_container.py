# SPDX-License-Identifier: LicenseRef-Proprietary

"""The agent's container (#745, step 4): OpenCode, root, with its own Docker, and nothing else.

Control starts it through the VM's Docker over the Engine API, under the Sysbox runtime (root of the
container is an unprivileged user of the VM, and the container runs its own `dockerd`). Every body
is made from constants and from identifiers the daemon itself gave; nothing of a job, of the agent's
output or of the repository is in a request.

What the container is:

* the image `code-reviewer-agent:golden` of the golden snapshot (`runner/Dockerfile`, target
  `agent`): OpenCode, Docker and the usual tools, no secret, no credential, no key;
* root, free: no capability dropped, no `no-new-privileges`, no read-only root. The agent may run
  `apt`, `docker`, `sudo`-less everything. What guards money, key and exits is outside of it;
* on the **model network** only, at a fixed address: `--internal` with
  `gateway_mode_ipv4=isolated`, so it has no exit and no route to the VM; the model door is the one
  other member. Control is not on that network, and the container has no socket, no device and no
  mount but the repository (the Subpath `repo` of the work volume, which is also all it sees of
  it: the mirror is out of its reach);
* limited in memory (no swap) and processes.

**How Control drives it: only outward.** OpenCode serves on the container's loopback. Control starts
it with an exec and reaches its HTTP port through a loopback listener of its own that opens one exec
per connection, running a relay that copies the bytes between the exec's standard streams and the
engine's port (`Tunnel`). The agent has no address of Control's, no route to it and no port of it to
connect to; the Docker daemon is the only thing that joins the two. Files go in through an exec that writes its
standard input to a path (`write_files`): the archive call of the Engine API (`docker cp`) puts its
files where a Sysbox container does not see them (measured, 2026-11-02: the call answers 200 and the
directory stays empty).

**How it ends.** Control kills the container (SIGKILL to its init, which takes every process of it,
the inner `dockerd` and anything the agent left running, with it) before it reads the repository.
A container that died by itself (killed for its memory, a crash) is seen by `wait` and named
(`AgentEnd`).
"""

import contextlib
import logging
import socket
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final, cast

from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_AGENT_ADDRESS,
    MODEL_NETWORK_NAME,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

from .docker_api import AttachedStreams, DockerApi, DockerError
from .exec_run import exec_document, run_exec
from .reader import REPO_SUBPATH, work_volume_of

_log = logging.getLogger(__name__)

AGENT_CONTAINER_NAME: Final = "code-reviewer-agent"
AGENT_ROLE_LABEL: Final = "code-reviewer.role"
AGENT_IMAGE_REFERENCE: Final = "code-reviewer-agent:golden"
AGENT_RUNTIME: Final = "sysbox-runc"
AGENT_REPO: Final = "/work/repo"
AGENT_CONFIG_DIRECTORY: Final = "/etc/code-reviewer"
AGENT_HOME: Final = "/root"
AGENT_TMP: Final = "/tmp"
# OpenCode's port, on the container's loopback.
ENGINE_PORT: Final = 4096
AGENT_PIDS_LIMIT: Final = 16384
AGENT_ENTRYPOINT: Final = ["/usr/bin/tini", "--", "/usr/local/bin/agent-init"]
# The file the image's init writes once the inner Docker answers.
READY_FILE: Final = "/run/agent-ready"
PYTHON: Final = "/usr/local/bin/python3"
OPENCODE: Final = "/usr/local/bin/opencode"
ENGINE_LOG: Final = "/tmp/opencode.log"
READY_SECONDS: Final = 60.0
STOP_SECONDS: Final = 15.0
# How long an answer about the engine's process is trusted, so that the watch (every 50 ms) does
# not put a call to the daemon behind every look.
LIVENESS_SECONDS: Final = 0.5

# What `write_files` runs: the standard input to a path, then its mode.
WRITE_FILE_SCRIPT: Final = 'umask 077 && cat > "$1" && chmod "$2" "$1"'

# The relay a connection of the tunnel runs in the container: bytes in on stdin go to the engine's
# port, bytes from it go out on stdout. A constant (the port is the only argument).
RELAY: Final = r"""
import os, socket, sys, threading
engine = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
def up():
    try:
        while True:
            data = os.read(0, 65536)
            if not data:
                break
            engine.sendall(data)
    except OSError:
        pass
    finally:
        try:
            engine.shutdown(socket.SHUT_WR)
        except OSError:
            pass
threading.Thread(target=up, daemon=True).start()
while True:
    data = engine.recv(65536)
    if not data:
        break
    os.write(1, data)
"""


def agent_document(image: str, work_volume: str, memory_bytes: int) -> dict[str, Any]:
    """The agent's container. Constants, the image id and the volume name the daemon gave, and the
    memory limit the Dispatcher computed for the size of the VM."""
    return {
        "Image": image,
        "Entrypoint": AGENT_ENTRYPOINT,
        "Cmd": [],
        "User": "0:0",
        "Env": [],
        "Hostname": "agent",
        "WorkingDir": AGENT_REPO,
        "Labels": {AGENT_ROLE_LABEL: "agent"},
        "NetworkingConfig": {
            "EndpointsConfig": {
                MODEL_NETWORK_NAME: {"IPAMConfig": {"IPv4Address": MODEL_AGENT_ADDRESS}}
            }
        },
        "HostConfig": {
            "Runtime": AGENT_RUNTIME,
            "NetworkMode": MODEL_NETWORK_NAME,
            "Privileged": False,
            "Memory": memory_bytes,
            "MemorySwap": memory_bytes,
            "PidsLimit": AGENT_PIDS_LIMIT,
            "RestartPolicy": {"Name": "no"},
            "PublishAllPorts": False,
            "Mounts": [
                {
                    "Type": "volume",
                    "Source": work_volume,
                    "Target": AGENT_REPO,
                    "ReadOnly": False,
                    "VolumeOptions": {"Subpath": REPO_SUBPATH, "NoCopy": True},
                }
            ],
        },
    }


@dataclass(frozen=True)
class AgentEnd:
    """How the agent's container ended: the exit code Docker reports (None: not read), whether the
    kernel killed it for its memory, and whether it went by itself (False: Control ended it)."""

    exit_code: int | None
    out_of_memory: bool
    unexpected: bool

    def sentence(self) -> str:
        if self.out_of_memory:
            how = "the container was killed for its memory"
        elif self.exit_code == 137:
            how = "the container was killed (a signal: most likely the memory limit or a crash)"
        else:
            how = "the container stopped"
        code = "" if self.exit_code is None else f" (exit code {self.exit_code})"
        return f"the agent's container ended during the turn: {how}{code}"


class Tunnel:
    """A loopback listener in Control. Every connection opens an exec in the agent's container that
    runs the relay to the engine's port; the connection's bytes and the exec's streams are copied
    both ways. Control opens everything; nothing in the container is given an address of Control."""

    def __init__(self, api: DockerApi, container: str, port: int) -> None:
        self._api = api
        self._container = container
        self._port = port
        self._listener = socket.socket()
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(32)
        self._closed = threading.Event()
        self._lock = threading.Lock()
        self._open: list[tuple[socket.socket, AttachedStreams]] = []
        threading.Thread(target=self._accept, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._listener.getsockname()[1]}"

    def _accept(self) -> None:
        while not self._closed.is_set():
            try:
                client, _ = self._listener.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(client,), daemon=True).start()

    def _serve(self, client: socket.socket) -> None:
        try:
            exec_id = self._api.create_exec(
                self._container, exec_document([PYTHON, "-I", "-c", RELAY, str(self._port)])
            )
            streams = self._api.attach_exec(exec_id)
        except DockerError:
            client.close()
            return
        with self._lock:
            if self._closed.is_set():
                streams.close()
                client.close()
                return
            self._open.append((client, streams))

        def up() -> None:
            try:
                while data := client.recv(65536):
                    streams.write(data)
            except OSError:
                pass
            finally:
                streams.close_write()

        threading.Thread(target=up, daemon=True).start()
        try:
            for chunk in streams.chunks():
                client.sendall(chunk)
        except OSError:
            pass
        finally:
            with contextlib.suppress(OSError):
                client.shutdown(socket.SHUT_WR)
            streams.close()
            client.close()
            with self._lock, contextlib.suppress(ValueError):
                self._open.remove((client, streams))

    def close(self) -> None:
        self._closed.set()
        with contextlib.suppress(OSError):
            self._listener.close()
        with self._lock:
            held, self._open = self._open, []
        for client, streams in held:
            streams.close()
            with contextlib.suppress(OSError):
                client.close()


@dataclass(frozen=True)
class AgentSeams:
    """What the tests replace; production leaves the defaults."""

    api: Callable[[], DockerApi] = DockerApi
    hostname: Callable[[], str] = socket.gethostname
    clock: Callable[[], float] = time.monotonic
    ready_seconds: float = READY_SECONDS
    image: str = AGENT_IMAGE_REFERENCE


def unavailable(reason: str) -> JobError:
    """The agent's container could not be had: the turn never began, so it is the free code of a
    turn that did not start. The word is the reason; it never carries a value."""
    return JobError(ErrorCode.SETUP_FAILED, f"agent_container_unavailable: {reason}")


class AgentContainer:
    """The container of one turn, and the engine that runs in it. `create()` makes and starts it,
    `start_engine()` starts OpenCode and returns the address Control reaches it at, `stop()` ends
    everything, the container included."""

    def __init__(self, memory_mb: int, seams: AgentSeams = AgentSeams()) -> None:  # noqa: B008
        self._api = seams.api()
        self._seams = seams
        self._memory_bytes = memory_mb * 1024 * 1024
        self._container: str | None = None
        self._tunnel: Tunnel | None = None
        self._engine_exec: str | None = None
        self._end: AgentEnd | None = None
        self._ended = threading.Event()
        self._stopping = threading.Event()
        self._lock = threading.Lock()
        self._alive_checked = float("-inf")
        self._alive = False

    # -- the container -----------------------------------------------------------------------------

    def create(self) -> None:
        """Make the container under the Sysbox runtime, start it and wait for its Docker. Raises
        `JobError` (`setup_failed`, free) when it cannot be had; whatever was made is removed."""
        api = self._api
        try:
            if "sysbox-runc" not in api.runtimes():
                raise unavailable("the daemon has no sysbox-runc runtime")
            image = str(api.inspect_image(self._seams.image).get("Id", ""))
            own = api.inspect_container(self._seams.hostname())
            volume = work_volume_of(own)
            if not image:
                raise unavailable("the agent image is not in this VM")
            container = api.create_container(
                agent_document(image, volume, self._memory_bytes), AGENT_CONTAINER_NAME
            )
            self._container = container
            api.start_container(container)
            threading.Thread(target=self._watch_end, args=(container,), daemon=True).start()
            self._wait_ready(container)
            self._seal_check(container)
        except DockerError as error:
            self._remove()
            raise unavailable(
                f"the daemon refused a step ({error.status}: {error.message[:160]})"
            ) from None
        except JobError:
            self._remove()
            raise
        except BaseException:
            self._remove()
            raise

    def _wait_ready(self, container: str) -> None:
        end = self._seams.clock() + self._seams.ready_seconds
        while True:
            if self._ended.is_set():
                raise unavailable("the container ended before its Docker was ready")
            done = run_exec(self._api, container, ["/usr/bin/test", "-e", READY_FILE], timeout=10.0)
            if done.returncode == 0 and not done.unanswered:
                return
            if self._seams.clock() >= end:
                raise unavailable("the container's Docker did not become ready in time")
            time.sleep(0.2)

    def _seal_check(self, container: str) -> None:
        """Read the container back from the daemon: it must be exactly what was asked. Anything that
        would put the VM within its reach (a socket, a bind, a device, a privileged container,
        another network) stops the turn before the engine starts."""
        document = self._api.inspect_container(container)
        host = as_object(document.get("HostConfig")) or {}
        settings = as_object(document.get("NetworkSettings")) or {}
        networks = as_object(settings.get("Networks")) or {}
        mounts = document.get("Mounts")
        problems: list[str] = []
        if host.get("Privileged"):
            problems.append("privileged")
        if host.get("Runtime") != AGENT_RUNTIME:
            problems.append("runtime")
        if (
            host.get("Binds")
            or host.get("Devices")
            or host.get("PidMode")
            or host.get("IpcMode") == "host"
        ):
            problems.append("host access")
        if set(networks) != {MODEL_NETWORK_NAME}:
            problems.append("networks")
        destinations: set[object] = set()
        for mount in cast("list[Any]", mounts) if isinstance(mounts, list) else []:
            given = as_object(mount)
            destinations.add(None if given is None else given.get("Destination"))
        if destinations - {AGENT_REPO}:
            problems.append("mounts")
        if problems:
            self._kill()
            raise unavailable(
                "the container is not what was asked for (" + ", ".join(problems) + ")"
            )

    def _watch_end(self, container: str) -> None:
        """`wait` returns when the container is gone: killed, out of memory, crashed, or stopped by
        us."""
        with contextlib.suppress(DockerError):
            self._api.request(
                "POST", f"/containers/{container}/wait", timeout=3 * 3600.0, ok=(200,)
            )
        code: int | None = None
        oom = False
        try:
            state = as_object(self._api.inspect_container(container).get("State")) or {}
            raw = state.get("ExitCode")
            code = raw if isinstance(raw, int) and not isinstance(raw, bool) else None
            oom = state.get("OOMKilled") is True
        except DockerError:
            pass
        with self._lock:
            if self._end is None:
                self._end = AgentEnd(code, oom, unexpected=not self._stopping.is_set())
        self._ended.set()

    @property
    def end(self) -> AgentEnd | None:
        with self._lock:
            return self._end

    @property
    def lost(self) -> AgentEnd | None:
        """The end of a container that went away by itself, else None."""
        end = self.end
        return end if end is not None and end.unexpected else None

    # -- files and the engine ----------------------------------------------------------------------

    def write_files(self, files: Mapping[str, tuple[bytes, int]]) -> None:
        """Put files into the engine's configuration directory (made by the image). Each is the
        standard input of an exec that runs a constant script; the name and the mode are constants
        of the runner, the content goes in no argument."""
        container = self._container
        if container is None:
            raise unavailable("there is no container")
        for name, (data, mode) in files.items():
            path = f"{AGENT_CONFIG_DIRECTORY}/{name}"
            done = run_exec(
                self._api,
                container,
                ["/bin/sh", "-c", WRITE_FILE_SCRIPT, "write", path, f"{mode:o}"],
                stdin=data,
                timeout=15.0,
                name="write a file",
            )
            if done.returncode != 0 or done.unanswered:
                raise unavailable("a file of the engine's configuration could not be written")

    def start_engine(self, argv: list[str], environment: Mapping[str, str]) -> str:
        """Start the engine as a detached exec and open the tunnel to its port. Returns the address
        Control reaches it at."""
        container = self._container
        if container is None:
            raise unavailable("there is no container")
        command = ["/bin/sh", "-c", f'exec "$@" >{ENGINE_LOG} 2>&1', "engine", *argv]
        try:
            exec_id = self._api.create_exec(
                container,
                {
                    **exec_document(command, env=environment, workdir=AGENT_REPO),
                    "AttachStdin": False,
                    "AttachStdout": False,
                    "AttachStderr": False,
                },
            )
            self._api.start_exec_detached(exec_id)
        except DockerError as error:
            raise unavailable(f"the engine could not be started ({error.status})") from None
        self._engine_exec = exec_id
        self._tunnel = Tunnel(self._api, container, ENGINE_PORT)
        return self._tunnel.url

    def engine_running(self) -> bool:
        """Whether the container is up and the engine's process runs in it. A look at the daemon
        is reused for `LIVENESS_SECONDS`."""
        if self._ended.is_set() or self._engine_exec is None:
            return False
        now = self._seams.clock()
        if now - self._alive_checked < LIVENESS_SECONDS:
            return self._alive
        try:
            state = self._api.inspect_exec(self._engine_exec)
            self._alive = state.get("Running") is True
        except DockerError:
            self._alive = False
        self._alive_checked = now
        return self._alive

    def settle(self, seconds: float) -> None:
        self._ended.wait(seconds)

    def engine_end_note(self) -> str | None:
        """How the container ended by itself, in words for the outcome; None while it did not."""
        lost = self.lost
        return None if lost is None else lost.sentence()

    # -- the end -----------------------------------------------------------------------------------

    def _kill(self) -> None:
        container = self._container
        if container is not None:
            try:
                self._api.kill_container(container)
            except DockerError as error:
                _log.warning("the agent's container could not be killed (%s)", error.status)

    def _remove(self) -> None:
        container, self._container = self._container, None
        if container is None:
            return
        try:
            self._api.remove_container(container)
        except DockerError as error:
            _log.warning("the agent's container could not be removed (%s)", error.status)

    def stop(self) -> bool:
        """End the turn's engine and the container with everything in it, and wait until it is gone.
        True when the container is known to be gone: the repository can be read. Safe to call
        twice."""
        self._stopping.set()
        if self._tunnel is not None:
            self._tunnel.close()
            self._tunnel = None
        self._kill()
        gone = self._ended.wait(STOP_SECONDS) if self._container is not None else True
        self._remove()
        return gone
