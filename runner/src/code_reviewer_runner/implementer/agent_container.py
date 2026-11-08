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
connect to; the Docker daemon is the only thing that joins the two. Files go in through an exec that
writes its standard input to a path (`write_files`): the archive call of the Engine API (`docker
cp`) puts its files where a Sysbox container does not see them (measured, 2026-11-02: the call
answers 200 and the directory stays empty).

**How it ends.** Control kills the container (SIGKILL to its init, which takes every process of it,
the inner `dockerd` and anything the agent left running, with it) before it reads the repository,
and waits until the daemon says it is gone (`stop()`, at most `KILL_SECONDS + STOP_SECONDS`). It is
removed after the push (`remove()`). A container that died by itself (killed for its memory, a
crash) is seen by `wait` and named (`AgentEnd`).
"""

import contextlib
import logging
import socket
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, cast

from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_AGENT_ADDRESS,
    MODEL_DOOR_ADDRESS,
    MODEL_NETWORK_NAME,
    NETWORK_DOOR_ADDRESS,
    NETWORK_DOOR_PORT,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

from .agent import CommandOutcome
from .docker_api import AttachedStreams, DockerApi, DockerError
from .exec_run import exec_document, run_exec
from .host_rules import (
    INET_FAILED,
    HelperFailed,
    close_bridge_inet,
    close_bridge_ipv6,
    inet_failure_note,
)
from .netdoor.registries import rule_has_registries
from .network_rule import MODE_OFF, OFF, NetworkRule
from .reader import REPO_SUBPATH, work_volume_of
from .result_channel import AGENT_RESULT_DIRECTORY, result_mount
from .role_labels import role_labels
from .vm_memory import MEMINFO, REASON_VM_MEMORY, MemoryGuard

_log = logging.getLogger(__name__)

AGENT_CONTAINER_NAME: Final = "code-reviewer-agent"
AGENT_IMAGE_REFERENCE: Final = "code-reviewer-agent:golden"
AGENT_RUNTIME: Final = "sysbox-runc"
AGENT_REPO: Final = "/work/repo"
AGENT_CONFIG_DIRECTORY: Final = "/etc/code-reviewer"
AGENT_HOME: Final = "/root"
AGENT_TMP: Final = "/tmp"
# OpenCode's port, on the container's loopback.
ENGINE_PORT: Final = 4096
AGENT_PIDS_LIMIT: Final = 16384
# The most the kernel's OOM killer can be told to prefer (-1000..1000). Some memory the kernel
# spends on a process is not charged to its memory cgroup (about 260 bytes of the 720 of a timer
# or epoll object, measured on the VM's kernel 6.18), so a flood of them can take the whole VM's
# memory before the container's limit is reached. The VM's own OOM killer then picks its victim by
# this score: the agent's (and the Setup container's) processes first, never Control, the door,
# the readers or the daemons. It is a preference, not a bound: under Sysbox the agent's root can
# lower the score of its own processes to -999 (measured, 2026-11-03; -1000 is refused), so the
# VM's memory is held by `vm_memory.MemoryGuard`, which acts before the kernel has to and does
# not depend on the score.
AGENT_OOM_SCORE_ADJ: Final = 1000
AGENT_ENTRYPOINT: Final = ["/usr/bin/tini", "--", "/usr/local/bin/agent-init"]
# The file the image's init writes once the inner Docker answers.
READY_FILE: Final = "/run/agent-ready"
PYTHON: Final = "/usr/local/bin/python3"
OPENCODE: Final = "/usr/local/bin/opencode"
ENGINE_LOG: Final = "/tmp/opencode.log"
READY_SECONDS: Final = 60.0
# The end of the container, in two parts that cost time at the end of a turn (the grace of the
# session counts `KILL_SECONDS + STOP_SECONDS`): the kill call, and the wait until the daemon says
# the container is gone. The removal is a third, **after the push** (`remove()`), because a Sysbox
# container with its inner Docker can take long to remove and nothing has to wait for it: killed is
# enough to read the repository.
# The kill call took 0.4 s idle, 2.0 s with two inner containers of a 1.5 GB image and 2.0 to 3.9 s
# with eight to twenty (measured on VMs, 2 vCPU): it grows with what runs in the agent's own Docker,
# so its ceiling is well above what a stack of services costs. The wait after it took 0.02 s.
KILL_SECONDS: Final = 15.0
STOP_SECONDS: Final = 10.0
REMOVE_SECONDS: Final = 15.0
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


# The proxy variables of a container whose environment has a network door (#745, step 7). The
# image's init starts the inner `dockerd` from the container's environment, so `docker pull` goes
# through the door as well; every exec of the container (the engine, its tools, the agent's own
# shells) gets them too. The door is the one address with a route out; the model door, loopback and
# the names of the machine itself are not to be proxied. Node 24 reads the proxy variables for its
# own `fetch` only when told to (`NODE_USE_ENV_PROXY`), which is the standard way for it.
NETWORK_DOOR_URL: Final = f"http://{NETWORK_DOOR_ADDRESS}:{NETWORK_DOOR_PORT}"
NO_PROXY: Final = ",".join(
    ("localhost", "127.0.0.1", "::1", MODEL_DOOR_ADDRESS, NETWORK_DOOR_ADDRESS)
)


# The door's certificate authority in the agent's container (#784): when the rule names a package
# registry the door reads it as HTTP (GET and HEAD only) and shows the tools its own certificate for
# it. `Session` writes these two files, before the agent starts, from the public certificate the
# door sent: the CA alone (Node adds it to the roots it has) and the system's roots with the CA (the
# variables below replace the roots a tool has, so the bundle keeps every other host working).
TRUST_CA_NAME: Final = "network-door-ca.pem"
TRUST_BUNDLE_NAME: Final = "network-door-bundle.pem"
TRUST_CA_PATH: Final = f"{AGENT_CONFIG_DIRECTORY}/{TRUST_CA_NAME}"
TRUST_BUNDLE_PATH: Final = f"{AGENT_CONFIG_DIRECTORY}/{TRUST_BUNDLE_NAME}"
SYSTEM_ROOTS_PATH: Final = "/etc/ssl/certs/ca-certificates.crt"


def trust_environment(rule: NetworkRule) -> dict[str, str]:
    """The variables that make npm, pnpm, Yarn, pip, uv, cargo, gem, curl and Python's `requests`
    trust the door's certificate for the package registries; none unless the rule names one
    (`rule_has_registries`), where the two files are not written either."""
    if not rule_has_registries(rule):
        return {}
    return {
        "NODE_EXTRA_CA_CERTS": TRUST_CA_PATH,
        "SSL_CERT_FILE": TRUST_BUNDLE_PATH,
        "REQUESTS_CA_BUNDLE": TRUST_BUNDLE_PATH,
        "CURL_CA_BUNDLE": TRUST_BUNDLE_PATH,
        "PIP_CERT": TRUST_BUNDLE_PATH,
        "CARGO_HTTP_CAINFO": TRUST_BUNDLE_PATH,
    }


def proxy_environment(rule: NetworkRule) -> dict[str, str]:
    """The variables that point the agent's tools at the network door; none for `off`, where there
    is no door and the container has no variable of any kind."""
    if rule.mode == MODE_OFF:
        return {}
    return {
        **trust_environment(rule),
        "HTTP_PROXY": NETWORK_DOOR_URL,
        "HTTPS_PROXY": NETWORK_DOOR_URL,
        "http_proxy": NETWORK_DOOR_URL,
        "https_proxy": NETWORK_DOOR_URL,
        "NO_PROXY": NO_PROXY,
        "no_proxy": NO_PROXY,
        "NODE_USE_ENV_PROXY": "1",
    }


def agent_document(
    image: str,
    work_volume: str,
    memory_bytes: int,
    *,
    runtime: str = AGENT_RUNTIME,
    entrypoint: Sequence[str] | None = None,
    rule: NetworkRule = OFF,
    result: bool = False,
    nano_cpus: int = 0,
    no_new_privileges: bool = False,
) -> dict[str, Any]:
    """The agent's container. Constants, the image id and the volume name the daemon gave, and the
    memory limit the Dispatcher computed for the size of the VM. The runtime is Sysbox and the
    entrypoint the image's init; only the test lane without Sysbox names others (`AgentSeams`).
    A turn with a result schema (#843) has the result directory beside the repository."""
    mounts: list[dict[str, Any]] = [
        {
            "Type": "volume",
            "Source": work_volume,
            "Target": AGENT_REPO,
            "ReadOnly": False,
            "VolumeOptions": {"Subpath": REPO_SUBPATH, "NoCopy": True},
        }
    ]
    if result:
        mounts.append(result_mount(work_volume, AGENT_RESULT_DIRECTORY, read_only=False))
    limits: dict[str, Any] = {"NanoCpus": nano_cpus} if nano_cpus > 0 else {}
    # #856: the Claude Code agent runs as an unprivileged user with the device's login in its
    # environment; nothing it runs may gain privileges (a setuid program, a file capability). The
    # hosted OpenCode agent is root and free and keeps its container as it was.
    sealed: dict[str, Any] = {"SecurityOpt": ["no-new-privileges"]} if no_new_privileges else {}
    return {
        "Image": image,
        "Entrypoint": list(AGENT_ENTRYPOINT if entrypoint is None else entrypoint),
        "Cmd": [],
        "User": "0:0",
        "Env": [f"{name}={value}" for name, value in proxy_environment(rule).items()],
        "Hostname": "agent",
        "WorkingDir": AGENT_REPO,
        "Labels": role_labels("agent"),
        "NetworkingConfig": {
            "EndpointsConfig": {
                MODEL_NETWORK_NAME: {"IPAMConfig": {"IPv4Address": MODEL_AGENT_ADDRESS}}
            }
        },
        "HostConfig": {
            "Runtime": runtime,
            "NetworkMode": MODEL_NETWORK_NAME,
            "Privileged": False,
            "Memory": memory_bytes,
            "MemorySwap": memory_bytes,
            **limits,
            **sealed,
            "PidsLimit": AGENT_PIDS_LIMIT,
            "OomScoreAdj": AGENT_OOM_SCORE_ADJ,
            "RestartPolicy": {"Name": "no"},
            "PublishAllPorts": False,
            "Mounts": mounts,
        },
    }


@dataclass(frozen=True)
class AgentEnd:
    """How the agent's container ended: the exit code Docker reports (None: not read), whether the
    kernel killed it for its memory, and whether it went by itself (False: Control ended it)."""

    exit_code: int | None
    out_of_memory: bool
    unexpected: bool
    # Control killed it because the VM was running out of memory (`MemoryGuard`), which the
    # container's own limit does not always prevent.
    vm_memory: bool = False

    def sentence(self) -> str:
        if self.vm_memory:
            how = "the container was killed because the VM was running out of memory"
        elif self.out_of_memory:
            how = "the container was killed for its memory"
        elif self.exit_code == 137:
            how = "the container was killed (a signal: most likely the memory limit or a crash)"
        else:
            how = "the container stopped"
        code = "" if self.exit_code is None else f" (exit code {self.exit_code})"
        # The reason word first: the report carries it as the start of the detail, like the
        # engine's reasons.
        reason = f"{REASON_VM_MEMORY}: " if self.vm_memory else ""
        return f"{reason}the agent's container ended during the turn: {how}{code}"


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
    # The image the host helper runs from, for the `ip` it has: the golden agent image, never one
    # an environment's script made (it could have removed the tool).
    helper_image: str = AGENT_IMAGE_REFERENCE
    # The runtime of the container: Sysbox in production. The test lane on a machine without Sysbox
    # (CI) starts the real image under `runc` with an entrypoint that skips the inner Docker, which
    # has to write `READY_FILE` itself. Production never sets either.
    runtime: str = AGENT_RUNTIME
    entrypoint: Sequence[str] | None = None
    # A customer's runner (#854) limits the CPUs of the container (`NanoCpus`); 0: no limit.
    nano_cpus: int = 0
    # #856: the Claude Code agent's container is made with `no-new-privileges`.
    no_new_privileges: bool = False
    # The file the VM's available memory is read from (`MemoryGuard`).
    meminfo: str = MEMINFO


def unavailable(reason: str) -> JobError:
    """The agent's container could not be had: the turn never began, so it is the free code of a
    turn that did not start. The word is the reason; it never carries a value."""
    return JobError(ErrorCode.SETUP_FAILED, f"agent_container_unavailable: {reason}")


class AgentContainer:
    """The container of one turn, and the engine that runs in it. `create()` makes and starts it,
    `start_engine()` starts OpenCode and returns the address Control reaches it at, `stop()` ends
    everything, the container included."""

    def __init__(
        self,
        memory_mb: int,
        seams: AgentSeams = AgentSeams(),  # noqa: B008
        rule: NetworkRule = OFF,
        result: bool = False,
    ) -> None:
        self._api = seams.api()
        self._seams = seams
        self._rule = rule
        # #843: the result directory is mounted too (a turn with a result schema).
        self._result = result
        self._memory_bytes = memory_mb * 1024 * 1024
        self._container: str | None = None
        self._tunnel: Tunnel | None = None
        self._engine_exec: str | None = None
        self._end: AgentEnd | None = None
        self._guard: MemoryGuard | None = None
        self._ended = threading.Event()
        self._stopping = threading.Event()
        self._lock = threading.Lock()
        self._alive_checked = float("-inf")
        self._alive = False

    # -- the container -----------------------------------------------------------------------------

    def create(self) -> tuple[str, ...]:
        """Make the container under the Sysbox runtime, start it and wait for its Docker. Returns
        the notes for the report (a check that did not hold, never a failure). Raises `JobError`
        (`setup_failed`, free) when it cannot be had; whatever was made is removed."""
        api = self._api
        notes: list[str] = []
        try:
            if self._seams.runtime not in api.runtimes():
                raise unavailable(f"the daemon has no {self._seams.runtime} runtime")
            image = str(api.inspect_image(self._seams.image).get("Id", ""))
            own = api.inspect_container(self._seams.hostname())
            volume = work_volume_of(own)
            if not image:
                raise unavailable("the agent image is not in this VM")
            # The VM's side of the model network gets no IPv6 address before the agent exists:
            # root in the container can switch IPv6 on and would find the bridge's link-local
            # address and, behind it, the VM's control port (`host_rules.py`).
            try:
                close_bridge_ipv6(api, self._seams.helper_image, MODEL_NETWORK_NAME)
            except HelperFailed as failed:
                raise unavailable(
                    f"the model network could not be closed to IPv6 ({failed.reason})"
                ) from None
            # Beside it, for a kernel that has the `inet` family, a drop of IPv6 from that bridge
            # (`nft` is in the Worker's image, which is the image of this container). Not required.
            control_image = str(own.get("Image", ""))
            if control_image and (
                close_bridge_inet(api, control_image, MODEL_NETWORK_NAME, "agent") == INET_FAILED
            ):
                notes.append(inet_failure_note("model"))
            container = api.create_container(
                agent_document(
                    image,
                    volume,
                    self._memory_bytes,
                    runtime=self._seams.runtime,
                    entrypoint=self._seams.entrypoint,
                    rule=self._rule,
                    result=self._result,
                    nano_cpus=self._seams.nano_cpus,
                    no_new_privileges=self._seams.no_new_privileges,
                ),
                AGENT_CONTAINER_NAME,
            )
            self._container = container
            api.start_container(container)
            # Before the watch: `_watch_end` reads whether the guard killed the container.
            self._guard = MemoryGuard(
                self._vm_memory_low, path=self._seams.meminfo, ended=self._ended
            )
            threading.Thread(target=self._watch_end, args=(container,), daemon=True).start()
            self._guard.start()
            self._wait_ready(container)
            self._seal_check(container)
            return tuple(notes)
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
        if host.get("Runtime") != self._seams.runtime:
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
        allowed = {AGENT_REPO, AGENT_RESULT_DIRECTORY} if self._result else {AGENT_REPO}
        if destinations - allowed:
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
                self._end = AgentEnd(
                    code,
                    oom,
                    unexpected=not self._stopping.is_set(),
                    vm_memory=self._guard is not None and self._guard.tripped_at is not None,
                )
        self._ended.set()

    def _vm_memory_low(self, available: int) -> None:
        """The VM is about to run out of memory (`MemoryGuard`): the agent goes."""
        _ = available
        self._kill()

    @property
    def tripped_at(self) -> int | None:
        """What the VM had left when the guard fired (bytes); None while it did not."""
        return None if self._guard is None else self._guard.tripped_at

    @property
    def lowest_left(self) -> int | None:
        """The least memory the VM had (free memory and file cache, bytes) while the guard looked,
        also after it killed the container; None before the first look. For the attack test."""
        return None if self._guard is None else self._guard.lowest_left

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

    def run_command(
        self, argv: list[str], environment: Mapping[str, str], timeout: float
    ) -> CommandOutcome:
        """Run a command in the agent's repository with `environment` and wait for it (the import
        of a stored conversation, #840: the engine's own `import`, which reads the repository it is
        run in). The command is a constant of the runner; what it prints is read (clipped) and the
        answer is never raised on."""
        container = self._container
        if container is None:
            return CommandOutcome(255, "", unanswered=True)
        done = run_exec(
            self._api,
            container,
            argv,
            env=environment,
            workdir=AGENT_REPO,
            timeout=timeout,
            name="a command of the engine",
        )
        return CommandOutcome(done.returncode, done.stdout, unanswered=done.unanswered)

    def run_streaming(
        self,
        argv: list[str],
        environment: Mapping[str, str],
        *,
        user: str,
        stdin: bytes,
        timeout: float,
        consume: Callable[[bytes], None],
    ) -> CommandOutcome:
        """Run a command in the agent's repository as `user` (`uid:gid`), with `stdin` as its
        input, and hand its standard output to `consume` as it comes (Claude Code, #856: one
        process per message, one JSON line per event). The command is a constant of the runner;
        the prompt is the standard input and in no argument. The answer is never raised on."""
        container = self._container
        if container is None:
            return CommandOutcome(255, "", unanswered=True)
        done = run_exec(
            self._api,
            container,
            argv,
            env=environment,
            workdir=AGENT_REPO,
            user=user,
            stdin=stdin,
            timeout=timeout,
            consume=consume,
            name="the agent's process",
        )
        return CommandOutcome(done.returncode, done.stdout, unanswered=done.unanswered)

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
                self._api.kill_container(container, timeout=KILL_SECONDS)
            except DockerError as error:
                _log.warning("the agent's container could not be killed (%s)", error.status)

    def _remove(self) -> None:
        # Every failed start ends here: a guard left running would read /proc/meminfo ten times a
        # second for the VM's life and call a kill that has no container to find.
        if self._guard is not None:
            self._guard.close()
        container, self._container = self._container, None
        if container is None:
            return
        try:
            self._api.remove_container(container, timeout=REMOVE_SECONDS)
        except DockerError as error:
            _log.warning("the agent's container could not be removed (%s)", error.status)

    def stop(self) -> bool:
        """End the turn's engine and the container with everything in it, and wait until it is gone.
        True when the container is known to be gone: the repository can be read. The container is
        killed, not removed (`remove()` does that after the push). Safe to call twice."""
        self._stopping.set()
        if self._guard is not None:
            self._guard.close()
        if self._tunnel is not None:
            self._tunnel.close()
            self._tunnel = None
        self._kill()
        return self._ended.wait(STOP_SECONDS) if self._container is not None else True

    def remove(self) -> None:
        """Take the (killed) container away. After the push, when nothing waits for it any more;
        `stop()` has to have run. Safe to call twice."""
        self._remove()
