# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Setup container (#818, step 5 of `plans/implementer-sandbox.md`): the environment's script
runs here, once, before the model is called, and what it leaves behind becomes the agent's image.

Control starts a throwaway container from the agent's own image, under `sysbox-runc`, as root, with
its own `dockerd` and the repository (the same Subpath of the work volume the agent will get). The
script from the environment runs in it as an exec: `bash -e` (or the interpreter of its `#!` line),
working directory the repository, root, all of the image's tools. When it ends with status 0 the
container's own Docker is stopped, the container is stopped, and its file system, with whatever the
script installed and whatever images its inner Docker pulled, is committed (`docker commit`) as the
image the Agent container starts from. Then the Setup container is removed.

**What it has: nothing of ours.** No git token, no model key, no job token, no environment variable
of its own, no mount but the repository, no socket, no device. Its definition is made of constants
and of identifiers the daemon gave (as the agent's is), and Control reads the container back from
the daemon before it runs the script, as it does for the agent. The script is free inside it: it has
root, the internet and Docker. The script's text is data written by a member of the workspace, and
the only place it is ever put is a file in this container.

**How it reaches the internet and nothing of ours.** The container is alone on a network of its own
(`SETUP_NETWORK_NAME`, a bridge named `SETUP_BRIDGE`, not internal, so Docker masquerades its
traffic to the internet). Its way to Control, the model door, the VM's services (the control port
`23456` among them), the platform's own addresses and every private range is closed **in the VM's
own network namespace**, by a table of `nft` rules that a one-shot container with `NET_ADMIN` in
the host's namespace installs before the Setup container exists (`EGRESS_RULES`). The rules are on
the VM's side of the bridge, not in the container: the container is root of a user namespace of its
own and owns its network namespace, so anything installed inside it, the script could remove; the
host's rules, it cannot reach. Packets from its bridge to the VM itself (input) are dropped; packets
that would be routed anywhere private, or into another bridge (the default bridge Control is on,
the model network), are dropped (IPv6 is not forwarded by the VM at all); the rest of the internet
is open on every port,
which includes the inner containers of its own Docker (their traffic is routed through the
container's address). DNS goes to public resolvers named in the container's definition, because the
VM's own resolver is on a private address. A Setup whose rules did not go in is never started.

**On a customer's machine** (#994, a VM with no direct internet whose only way out is the host's
outer-wall proxy, `outer_proxy.py`) the container gets the usual proxy variables (`HTTP_PROXY`,
`HTTPS_PROXY` and their lower-case twins, `NO_PROXY` for loopback) from the host's address, so the
script's package managers, `git`, `curl` and the Docker daemon inside it (which reads them for
image pulls) go through the proxy, which does the name lookup and applies the wide rule of the
setup. The VM's own table then lets the bridge reach that proxy's address and port and nothing
else (`egress_rules`): no DNS, no other port, no other address. A tool that ignores the variables
finds no way out, and says so; none falls back to a direct connection. This container's one
variable that is not the image's own is those, and the seal check knows them.

**The result.** The end of the script's output (stdout and stderr together, bounded to the last
`OUTPUT_KEEP_BYTES`), its exit status, whether it ran out of time and the image id. A script that
exits non-zero, runs past its time limit, or leaves a disk that cannot hold the commit, ends the
turn before the model is used (`environment_setup.py`).
"""

import contextlib
import logging
import socket
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final, cast

from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.outer_proxy import OuterProxy

from .agent_container import (
    AGENT_ENTRYPOINT,
    AGENT_IMAGE_REFERENCE,
    AGENT_OOM_SCORE_ADJ,
    AGENT_PIDS_LIMIT,
    AGENT_REPO,
    AGENT_RUNTIME,
    READY_FILE,
    WRITE_FILE_SCRIPT,
)
from .docker_api import DockerApi, DockerError
from .door_launcher import PRIVATE_RANGES
from .exec_run import run_exec
from .host_rules import (
    INET_FAILED,
    NFT,
    HelperFailed,
    close_bridge_inet,
    close_bridge_ipv6,
    inet_failure_note,
    run_helper,
)
from .reader import REPO_SUBPATH, work_volume_of
from .role_labels import role_labels
from .vm_memory import MEMINFO, REASON_VM_MEMORY, MemoryGuard

_log = logging.getLogger(__name__)

SETUP_CONTAINER_NAME: Final = "code-reviewer-setup"
SETUP_NETWORK_NAME: Final = "code-reviewer-setup"
# The bridge's own name, so that the rules can name it before it exists (a name is matched when a
# packet comes in).
SETUP_BRIDGE: Final = "crsetup0"
SETUP_NETWORK_SUBNET: Final = "10.213.78.0/29"
SETUP_NETWORK_GATEWAY: Final = "10.213.78.1"
SETUP_ADDRESS: Final = "10.213.78.2"
# Public resolvers: the VM's resolver is on a private address the rules close.
SETUP_DNS: Final = ("1.1.1.1", "8.8.8.8")
# The image the committed result gets: the agent's repository name and a tag of its own.
SETUP_IMAGE_REPOSITORY: Final = "code-reviewer-agent"
SETUP_IMAGE_TAG: Final = "environment"
SETUP_HOSTNAME: Final = "setup"

SCRIPT_PATH: Final = "/tmp/code-reviewer-setup.sh"
BASH: Final = "/bin/bash"
SH: Final = "/bin/sh"
# The environment of the script: the image's own, and these two (no terminal, no prompt, a home).
SCRIPT_ENVIRONMENT: Final = {"HOME": "/root", "DEBIAN_FRONTEND": "noninteractive"}
# The script runs through this (the script path is the one argument); a script that starts with a
# `#!` line is executed as itself.
RUN_SCRIPT: Final = (
    'if head -c 2 "$1" | grep -q "^#!"; then chmod 700 "$1"; exec "$1" 2>&1; '
    'else exec /bin/bash -e "$1" 2>&1; fi'
)

# What happens after a script that ended well: remove the script's file, then ask the container's
# Docker to stop the way a daemon is stopped (SIGTERM), so that its images are on disk in one piece.
# The container's init ends with the daemon and the container stops by itself, which also ends this
# exec: its exit status says nothing, so Control waits for the container, not for the exec. A
# container with no daemon (the test lane under runc) has no pid file and says so.
NO_DOCKER: Final = "no-docker"
FINISH_SCRIPT: Final = f"""
rm -f "$1"
pid=$(cat /var/run/docker.pid 2>/dev/null) || {{ echo {NO_DOCKER}; exit 0; }}
kill -TERM "$pid" 2>/dev/null || {{ echo {NO_DOCKER}; exit 0; }}
echo stopping
"""

# The VM's firewall for the Setup container's bridge (see the module text). An `ip` table in the
# host's namespace, hooked before Docker's own rules (priority -10), whose only verdicts are drops:
# whatever it does not drop goes on to Docker's rules as before. Rules for a bridge that does not
# exist yet are fine, a name is matched when a packet arrives. (An `inet` table is what one would
# write; the kernel of the platform's VM does not support the family, nor `ip6`: measured
# 2026-11-03,
# `Operation not supported`. Its IPv6 forwarding is off, `net.ipv6.conf.all.forwarding = 0`, and the
# bridge has no IPv6 address.)
EGRESS_TABLE: Final = "setup_egress"
EGRESS_RULES: Final = "; ".join(
    [
        f"add table ip {EGRESS_TABLE}",
        # To the VM itself (its control port, its services, the bridge's gateway): nothing.
        f"add chain ip {EGRESS_TABLE} input "
        "{ type filter hook input priority -10 ; policy accept ; }",
        f'add rule ip {EGRESS_TABLE} input iifname "{SETUP_BRIDGE}" drop',
        # Through the VM: no private range (the platform, the neighbours, the other containers), no
        # other bridge (Control's, the door's, the model network), nowhere but out.
        f"add chain ip {EGRESS_TABLE} forward "
        "{ type filter hook forward priority -10 ; policy accept ; }",
        f'add rule ip {EGRESS_TABLE} forward iifname "{SETUP_BRIDGE}" '
        f"ip daddr {{ {', '.join(PRIVATE_RANGES)} }} drop",
        f'add rule ip {EGRESS_TABLE} forward iifname "{SETUP_BRIDGE}" oifname "docker0" drop',
        f'add rule ip {EGRESS_TABLE} forward iifname "{SETUP_BRIDGE}" oifname "br-*" drop',
        f'add rule ip {EGRESS_TABLE} forward iifname "{SETUP_BRIDGE}" oifname "veth*" drop',
        f'add rule ip {EGRESS_TABLE} forward oifname "{SETUP_BRIDGE}" iifname "docker0" drop',
        f'add rule ip {EGRESS_TABLE} forward oifname "{SETUP_BRIDGE}" iifname "br-*" drop',
    ]
)


def egress_rules(outer_proxy: OuterProxy | None = None) -> str:
    """The VM's firewall for the Setup bridge. With the host's outer-wall proxy (#994) the bridge
    may open a connection to that proxy's address and port (let through before the drop; the table's
    only `accept`) and nothing else leaves it: every other packet from the bridge is dropped, the
    private ranges and the internet alike, since the proxy is the one way to the internet and does
    the lookup. Without a proxy it is `EGRESS_RULES`, as hosted."""
    if outer_proxy is None:
        return EGRESS_RULES
    bridge = f'iifname "{SETUP_BRIDGE}"'
    return "; ".join(
        [
            f"add table ip {EGRESS_TABLE}",
            f"add chain ip {EGRESS_TABLE} input "
            "{ type filter hook input priority -10 ; policy accept ; }",
            f'add rule ip {EGRESS_TABLE} input iifname "{SETUP_BRIDGE}" drop',
            f"add chain ip {EGRESS_TABLE} forward "
            "{ type filter hook forward priority -10 ; policy accept ; }",
            f"add rule ip {EGRESS_TABLE} forward {bridge} ip daddr {outer_proxy.host} "
            f"tcp dport {outer_proxy.port} accept",
            f"add rule ip {EGRESS_TABLE} forward {bridge} drop",
            f'add rule ip {EGRESS_TABLE} forward oifname "{SETUP_BRIDGE}" iifname "docker0" drop',
            f'add rule ip {EGRESS_TABLE} forward oifname "{SETUP_BRIDGE}" iifname "br-*" drop',
        ]
    )


CHECK_RULES: Final = f"list table ip {EGRESS_TABLE}"
RULES_SECONDS: Final = 20.0

# How long each part may take. The script's own limit comes from the caller (it is counted in the
# turn's time budget); these are the parts around it, and `SETUP_OVERHEAD_SECONDS` is their sum:
# what the caller must leave besides the script.
READY_SECONDS: Final = 60.0
FINISH_EXEC_SECONDS: Final = 30.0
# How long the container's Docker has to stop and end the container by itself.
DOCKER_STOP_SECONDS: Final = 120.0
STOP_GRACE_SECONDS: Final = 20
STOP_WAIT_SECONDS: Final = 40.0
# The commit. Measured on a platform VM (2 vCPU, 2026-11-03): 3.9 GB of image in 61 s, which is
# 64 MB/s. The budget is a commit of 4 GB (`COMMIT_REFERENCE_BYTES`) on a disk four times slower
# than that (a VM whose disk is busy with the agent's Docker): 250 s, rounded up to 300 s.
COMMIT_MEASURED_BYTES_PER_SECOND: Final = 64 * 1000**2
COMMIT_REFERENCE_BYTES: Final = 4 * 1000**3
COMMIT_SLOWDOWN: Final = 4
COMMIT_SECONDS: Final = 300.0
# What a commit needs on the VM's disk besides the container's writable layer, which it writes
# twice (the layer as a tar and the copy the daemon unpacks), and the question about that size.
COMMIT_ROOM_FACTOR: Final = 2
COMMIT_HEADROOM_BYTES: Final = 1024**3
ROOM_SECONDS: Final = 30.0
REMOVE_SECONDS: Final = 120.0
SCRIPT_WRITE_SECONDS: Final = 30.0
KILL_SECONDS: Final = 15.0
# After a script that did not end by itself the container is killed, the exec that ran it is
# joined, and the clean-up kills it once more before it removes it (each call to the daemon has
# `KILL_SECONDS`).
KILL_STEPS_SECONDS: Final = KILL_SECONDS * 3
# The host helpers of the Setup network (`_close_the_network`): the bridge's IPv6, the `ip` table,
# its read back and the `inet` table. Each has `RULES_SECONDS`.
HOST_HELPERS: Final = 4
SETUP_OVERHEAD_SECONDS: Final = (
    RULES_SECONDS * HOST_HELPERS
    + READY_SECONDS
    + SCRIPT_WRITE_SECONDS
    + KILL_STEPS_SECONDS
    + FINISH_EXEC_SECONDS
    + DOCKER_STOP_SECONDS
    + STOP_WAIT_SECONDS
    + ROOM_SECONDS
    + COMMIT_SECONDS
    + REMOVE_SECONDS
)
# The most of the script's output that is kept: its end.
OUTPUT_KEEP_BYTES: Final = 64 * 1024
WATCH_SECONDS: Final = 0.25

OUTCOME_OK: Final = "ok"
OUTCOME_SCRIPT_FAILED: Final = "script_failed"
OUTCOME_TIMED_OUT: Final = "timed_out"
OUTCOME_STOPPED: Final = "stopped"
OUTCOME_UNAVAILABLE: Final = "unavailable"
OUTCOME_NOT_SAVED: Final = "not_saved"
# The script ended well and the VM's disk has too little room for the commit of its result.
OUTCOME_NO_ROOM: Final = "no_room"


def network_document() -> dict[str, Any]:
    """The Setup container's network: a bridge of its own that reaches the internet (Docker
    masquerades it) and that the VM's rules close towards everything of ours."""
    return {
        "Name": SETUP_NETWORK_NAME,
        "Driver": "bridge",
        "Internal": False,
        "Attachable": False,
        "EnableIPv6": False,
        "IPAM": {
            "Driver": "default",
            "Config": [{"Subnet": SETUP_NETWORK_SUBNET, "Gateway": SETUP_NETWORK_GATEWAY}],
        },
        "Options": {"com.docker.network.bridge.name": SETUP_BRIDGE},
        "Labels": role_labels("setup-network"),
    }


def setup_document(
    image: str,
    work_volume: str,
    memory_bytes: int,
    *,
    runtime: str = AGENT_RUNTIME,
    entrypoint: Sequence[str] | None = None,
    nano_cpus: int = 0,
    outer_proxy: OuterProxy | None = None,
) -> dict[str, Any]:
    """The Setup container: the agent's image, the agent's limits, the repository and nothing else.
    Constants, the image id, the volume name the daemon gave and the memory the Dispatcher computed.
    No secret, no job, and no environment variable of its own but the proxy's (#994, only on a
    customer's machine: the host's address, never a job's)."""
    return {
        "Image": image,
        "Entrypoint": list(AGENT_ENTRYPOINT if entrypoint is None else entrypoint),
        "Cmd": [],
        "User": "0:0",
        "Env": [] if outer_proxy is None else outer_proxy.tool_environment(),
        "Hostname": SETUP_HOSTNAME,
        "WorkingDir": AGENT_REPO,
        "Labels": role_labels("setup"),
        "NetworkingConfig": {
            "EndpointsConfig": {SETUP_NETWORK_NAME: {"IPAMConfig": {"IPv4Address": SETUP_ADDRESS}}}
        },
        "HostConfig": {
            "Runtime": runtime,
            "NetworkMode": SETUP_NETWORK_NAME,
            "Dns": list(SETUP_DNS),
            "Privileged": False,
            "Memory": memory_bytes,
            "MemorySwap": memory_bytes,
            # A customer's runner (#855) limits the CPUs of this container as it does the agent's.
            **({"NanoCpus": nano_cpus} if nano_cpus > 0 else {}),
            "PidsLimit": AGENT_PIDS_LIMIT,
            "OomScoreAdj": AGENT_OOM_SCORE_ADJ,
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


class Tail:
    """The last `limit` bytes of a stream and how many came in all. Memory is bounded whatever the
    script prints."""

    def __init__(self, limit: int = OUTPUT_KEEP_BYTES) -> None:
        self._limit = limit
        self._data = bytearray()
        self.total = 0

    def add(self, chunk: bytes) -> None:
        self.total += len(chunk)
        self._data += chunk
        if len(self._data) > 2 * self._limit:
            del self._data[: -self._limit]

    def value(self) -> bytes:
        return bytes(self._data[-self._limit :])


@dataclass(frozen=True)
class SetupRun:
    """How a run of the Setup container went. `outcome` is one of the `OUTCOME_*` words; `detail` is
    a sentence of ours (never a value of the job) for the outcomes that have no script output;
    `image` is the committed image's id after `OUTCOME_OK`."""

    outcome: str
    exit_code: int | None
    output: bytes
    output_bytes: int
    image: str | None
    detail: str
    start_seconds: float
    script_seconds: float
    save_seconds: float
    # The size of the committed image in bytes (None when it was not asked for or not made).
    image_bytes: int | None = None
    # Facts for the log: a check that could not be made (the room for the commit), never a failure.
    notes: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return self.outcome == OUTCOME_OK


@dataclass(frozen=True)
class SetupSeams:
    """What the tests replace; production leaves the defaults. The image is the agent's; the test
    lane without Sysbox names the runtime and the entry point the agent's lane names."""

    api: Callable[[], DockerApi] = DockerApi
    hostname: Callable[[], str] = socket.gethostname
    clock: Callable[[], float] = time.monotonic
    image: str = AGENT_IMAGE_REFERENCE
    # The image the host helpers run from, for the `ip` it has: the agent's golden one.
    helper_image: str = AGENT_IMAGE_REFERENCE
    runtime: str = AGENT_RUNTIME
    entrypoint: Sequence[str] | None = None
    # A customer's runner (#855) limits the CPUs of the container (`NanoCpus`); 0: no limit.
    nano_cpus: int = 0
    ready_seconds: float = READY_SECONDS
    commit_seconds: float = COMMIT_SECONDS
    finish_seconds: float = FINISH_EXEC_SECONDS
    docker_stop_seconds: float = DOCKER_STOP_SECONDS
    # False only in a test that has no host namespace to put rules in (never in production).
    install_rules: bool = True
    # The host's outer-wall proxy (#994): the Setup's way to the internet on a customer's machine,
    # handed to Control by the host. None: as hosted.
    outer_proxy: OuterProxy | None = None
    # The file the VM's memory is read from (`MemoryGuard`).
    meminfo: str = MEMINFO


def _variables(listed: object) -> set[str]:
    """The `NAME=value` entries of a container's or an image's `Env`."""
    if not isinstance(listed, list):
        return set()
    return {entry for entry in cast("list[Any]", listed) if isinstance(entry, str)}


class _Unavailable(Exception):
    """A step before the script that could not be done; the word is the reason."""


class _NoRoom(Exception):
    """The VM's disk has too little room for the commit; the message says how much and how much is
    needed."""


class SetupContainer:
    """One run of the Setup container. `run` does everything and always ends with the container and
    the network removed; it does not raise for a script that failed."""

    def __init__(self, memory_mb: int, seams: SetupSeams = SetupSeams()) -> None:  # noqa: B008
        self._api = seams.api()
        self._seams = seams
        self._memory_bytes = memory_mb * 1024 * 1024
        self._container: str | None = None
        self._network: str | None = None
        self._ended = threading.Event()
        self._guard: MemoryGuard | None = None
        self._notes: list[str] = []

    # -- the whole run -----------------------------------------------------------------------------

    def run(
        self,
        script: str,
        *,
        script_seconds: float,
        should_stop: Callable[[], bool] = lambda: False,
        free_bytes: Callable[[], int | None] = lambda: None,
    ) -> SetupRun:
        """`free_bytes` is what the VM's disk has left (None: it cannot be asked, and the commit is
        tried all the same)."""
        clock = self._seams.clock
        begun = clock()
        tail = Tail()
        try:
            container = self._start()
        except _Unavailable as reason:
            self._clean()
            return self._ended_run(OUTCOME_UNAVAILABLE, str(reason), tail, begun, begun, begun)
        except DockerError as error:
            self._clean()
            detail = f"the daemon refused a step ({error.status}: {error.message[:160]})"
            return self._ended_run(OUTCOME_UNAVAILABLE, detail, tail, begun, begun, begun)
        except BaseException:
            self._clean()
            raise
        started = clock()
        try:
            outcome, code, why = self._script(container, script, script_seconds, should_stop, tail)
            finished = clock()
            if outcome != OUTCOME_OK:
                self._clean()
                return self._ended_run(outcome, why, tail, begun, started, finished, code=code)
            try:
                image = self._save(container, free_bytes)
            except _NoRoom as reason:
                self._clean()
                return self._ended_run(
                    OUTCOME_NO_ROOM, str(reason), tail, begun, started, finished, code=code
                )
            except _Unavailable as reason:
                self._clean()
                return self._ended_run(
                    OUTCOME_NOT_SAVED, str(reason), tail, begun, started, finished, code=code
                )
            except DockerError as error:
                self._clean()
                detail = f"the image could not be saved ({error.status}: {error.message[:160]})"
                return self._ended_run(
                    OUTCOME_NOT_SAVED, detail, tail, begun, started, finished, code=code
                )
            saved = clock()
            size = self._image_bytes(image)
            self._clean()
            return SetupRun(
                outcome=OUTCOME_OK,
                exit_code=code,
                output=tail.value(),
                output_bytes=tail.total,
                image=image,
                detail="",
                start_seconds=started - begun,
                script_seconds=finished - started,
                save_seconds=saved - finished,
                image_bytes=size,
                notes=tuple(self._notes),
            )
        except BaseException:
            self._clean()
            raise

    def _ended_run(
        self,
        outcome: str,
        detail: str,
        tail: Tail,
        begun: float,
        started: float,
        finished: float,
        *,
        code: int | None = None,
    ) -> SetupRun:
        return SetupRun(
            outcome=outcome,
            exit_code=code,
            output=tail.value(),
            output_bytes=tail.total,
            image=None,
            detail=detail,
            start_seconds=started - begun,
            script_seconds=finished - started,
            save_seconds=0.0,
            notes=tuple(self._notes),
        )

    # -- the start ---------------------------------------------------------------------------------

    def _start(self) -> str:
        api = self._api
        own = api.inspect_container(self._seams.hostname())
        worker_image = str(own.get("Image", ""))
        volume = work_volume_of(own)
        image = str(api.inspect_image(self._seams.image).get("Id", ""))
        if not worker_image or not image:
            raise _Unavailable("setup_unavailable: an image of the VM is missing")
        if self._seams.runtime not in api.runtimes():
            raise _Unavailable(
                f"setup_unavailable: the daemon has no {self._seams.runtime} runtime"
            )
        # A network of an earlier run (a VM runs one turn, but a retry of the step must not trip).
        api.remove_network(SETUP_NETWORK_NAME)
        self._network = api.create_network(network_document())
        if self._seams.install_rules:
            self._close_the_network(worker_image)
        container = api.create_container(
            setup_document(
                image,
                volume,
                self._memory_bytes,
                runtime=self._seams.runtime,
                entrypoint=self._seams.entrypoint,
                nano_cpus=self._seams.nano_cpus,
                outer_proxy=self._seams.outer_proxy,
            ),
            SETUP_CONTAINER_NAME,
        )
        self._container = container
        api.start_container(container)
        threading.Thread(target=self._watch_end, args=(container,), daemon=True).start()
        # The script is as free as the agent is and can take the VM's memory the same way:
        # the container goes (the script ends as one whose container went away) before the VM
        # is out of it.
        self._guard = MemoryGuard(
            lambda _: self._kill(), path=self._seams.meminfo, ended=self._ended
        )
        self._guard.start()
        self._wait_ready(container)
        self._seal_check(container, image)
        return container

    def _close_the_network(self, worker_image: str) -> None:
        """The VM's side of the Setup bridge, before the Setup container exists: no IPv6 address
        on it, and the `nft` table that closes everything of ours (`EGRESS_RULES`), read back once.
        Raises `_Unavailable` unless all of it is in place: a Setup whose network is not closed is
        never started."""
        api = self._api
        try:
            close_bridge_ipv6(api, self._seams.helper_image, SETUP_NETWORK_NAME)
            run_helper(
                api,
                worker_image,
                [NFT],
                [egress_rules(self._seams.outer_proxy)],
                "setup-rules",
                seconds=RULES_SECONDS,
            )
            run_helper(
                api, worker_image, [NFT], [CHECK_RULES], "setup-rules-check", seconds=RULES_SECONDS
            )
            # The `inet` table beside the `ip` one: IPv6 from the bridge, for a kernel that has the
            # family. Not required (`close_bridge_inet`), but a kernel that has the family and
            # refused the table is a note.
            if close_bridge_inet(api, worker_image, SETUP_NETWORK_NAME, "setup") == INET_FAILED:
                self._notes.append(inet_failure_note("Setup"))
        except HelperFailed as failed:
            raise _Unavailable(
                f"setup_unavailable: the network rules could not be installed ({failed.reason})"
            ) from None

    def _wait_ready(self, container: str) -> None:
        end = self._seams.clock() + self._seams.ready_seconds
        while True:
            if self._ended.is_set():
                raise _Unavailable(
                    "setup_unavailable: the container ended before its Docker was ready"
                )
            done = run_exec(self._api, container, ["/usr/bin/test", "-e", READY_FILE], timeout=10.0)
            if done.returncode == 0 and not done.unanswered:
                return
            if self._seams.clock() >= end:
                raise _Unavailable("setup_unavailable: the container's Docker did not become ready")
            time.sleep(0.2)

    def _seal_check(self, container: str, image: str) -> None:
        """Read the container back from the daemon: exactly what was asked, nothing of ours in it.
        Anything that would put the VM or a secret within the script's reach stops the run before
        the script is written."""
        document = self._api.inspect_container(container)
        host = as_object(document.get("HostConfig")) or {}
        config = as_object(document.get("Config")) or {}
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
        if set(networks) != {SETUP_NETWORK_NAME}:
            problems.append("networks")
        destinations: set[object] = set()
        for mount in cast("list[Any]", mounts) if isinstance(mounts, list) else []:
            given = as_object(mount)
            destinations.add(None if given is None else given.get("Destination"))
        if destinations - {AGENT_REPO}:
            problems.append("mounts")
        # Not one variable besides the image's own (and the host's proxy on a customer's machine).
        image_config = as_object(self._api.inspect_image(image).get("Config")) or {}
        proxy = self._seams.outer_proxy
        expected: set[str] = _variables(image_config.get("Env"))
        if proxy is not None:
            expected |= set(proxy.tool_environment())
        if _variables(config.get("Env")) != expected:
            problems.append("environment")
        if problems:
            self._kill()
            raise _Unavailable(
                "setup_unavailable: the container is not what was asked for ("
                + ", ".join(problems)
                + ")"
            )

    def _watch_end(self, container: str) -> None:
        with contextlib.suppress(DockerError):
            self._api.request(
                "POST", f"/containers/{container}/wait", timeout=3 * 3600.0, ok=(200,)
            )
        self._ended.set()

    # -- the script --------------------------------------------------------------------------------

    def _script(
        self,
        container: str,
        script: str,
        seconds: float,
        should_stop: Callable[[], bool],
        tail: Tail,
    ) -> tuple[str, int | None, str]:
        """Write the script to a file in the container and run it. The outcome word, the exit
        status (None when it did not end by itself) and a sentence of ours when there is one to say
        (the container went away under the script)."""
        written = run_exec(
            self._api,
            container,
            [SH, "-c", WRITE_FILE_SCRIPT, "write", SCRIPT_PATH, "700"],
            stdin=script.encode("utf-8"),
            timeout=30.0,
            name="write the script",
        )
        if written.returncode != 0 or written.unanswered:
            return OUTCOME_UNAVAILABLE, None, "setup_unavailable: the script could not be written"
        done: list[Any] = []

        def work() -> None:
            done.append(
                run_exec(
                    self._api,
                    container,
                    [SH, "-c", RUN_SCRIPT, "run", SCRIPT_PATH],
                    env=SCRIPT_ENVIRONMENT,
                    workdir=AGENT_REPO,
                    timeout=seconds + 60.0,
                    consume=tail.add,
                    name="the setup script",
                )
            )

        worker = threading.Thread(target=work, daemon=True)
        worker.start()
        clock = self._seams.clock
        end = clock() + seconds
        why: str | None = None
        while worker.is_alive():
            worker.join(WATCH_SECONDS)
            if not worker.is_alive():
                break
            if self._ended.is_set():
                why = OUTCOME_SCRIPT_FAILED
                break
            if should_stop():
                why = OUTCOME_STOPPED
                break
            if clock() >= end:
                why = OUTCOME_TIMED_OUT
                break
        if why is not None:
            self._kill()
            worker.join(KILL_SECONDS)
            return why, None, self._lost() if why == OUTCOME_SCRIPT_FAILED else ""
        outcome = done[0]
        if outcome.unanswered:
            # The exec ended without a status: the container went away under it, or the daemon
            # stopped answering. The first is the script's doing (its memory), the second is ours.
            lost = self._lost() if self._ended.wait(2.0) else ""
            if lost:
                return OUTCOME_SCRIPT_FAILED, None, lost
            return OUTCOME_UNAVAILABLE, None, "setup_unavailable: the script's status is unknown"
        if outcome.returncode != 0:
            # A status of a script that was killed along with its container (137) comes with the
            # container's own account of how it ended.
            lost = self._lost() if self._ended.wait(0.5) else ""
            return OUTCOME_SCRIPT_FAILED, outcome.returncode, lost
        return OUTCOME_OK, 0, ""

    def _lost(self) -> str:
        """How the container went away during the script, in words: the kernel's memory kill is the
        usual way, and it is the script's (it ran past the agent's memory)."""
        container = self._container
        if container is None:
            return "the container ended during the script"
        try:
            state = as_object(self._api.inspect_container(container).get("State")) or {}
        except DockerError:
            return "the container ended during the script"
        code = state.get("ExitCode")
        reason = ""
        if self._guard is not None and self._guard.tripped_at is not None:
            # The reason word first, as in the agent's report (`AgentEnd.sentence`).
            reason = f"{REASON_VM_MEMORY}: "
            how = "was killed because the VM was running out of memory"
        elif state.get("OOMKilled") is True or code == 137:
            how = "was killed for its memory"
        else:
            how = "stopped"
        return f"{reason}the container ended during the script: it {how}" + (
            f" (exit code {code})" if isinstance(code, int) and not isinstance(code, bool) else ""
        )

    def _image_bytes(self, image: str) -> int | None:
        try:
            size = self._api.inspect_image(image).get("Size")
        except DockerError:
            return None
        return size if isinstance(size, int) and not isinstance(size, bool) else None

    # -- the result --------------------------------------------------------------------------------

    def _save(self, container: str, free_bytes: Callable[[], int | None]) -> str:
        """Stop the container's Docker, then the container, and commit its file system. Under
        Sysbox the stop of the inner Docker is what ends the container, and the end of the
        container is what writes the inner Docker's images into the file system the commit reads.
        Raises `_NoRoom` before the commit when the VM's disk could not hold it."""
        api = self._api
        finished = run_exec(
            api,
            container,
            [SH, "-c", FINISH_SCRIPT, "finish", SCRIPT_PATH],
            timeout=self._seams.finish_seconds,
            name="the end of the setup",
        )
        if NO_DOCKER in finished.stdout or self._ended.is_set():
            # Nothing runs in the container but its init: stop it.
            api.stop_container(
                container, grace=STOP_GRACE_SECONDS, timeout=STOP_WAIT_SECONDS + 30.0
            )
        elif not self._ended.wait(self._seams.docker_stop_seconds):
            # A guard that tripped is why it did not stop in time (its kill may have failed).
            self._refuse_if_the_vm_ran_out_of_memory()
            raise _Unavailable(
                "the container's Docker did not stop in time, so its images are not kept"
            )
        if not self._ended.wait(STOP_WAIT_SECONDS):
            self._refuse_if_the_vm_ran_out_of_memory()
            raise _Unavailable("the container did not stop, so its file system is not kept")
        # The container is gone and the memory it could take is back: the guard must not kill
        # anything under `docker commit`, which reads its layer and needs memory of its own. Until
        # now it watched, because a process the script left behind runs until the container stops.
        if self._guard is not None:
            self._guard.close()
        self._refuse_if_the_vm_ran_out_of_memory()
        self._check_room(container, free_bytes)
        return api.commit_container(
            container, SETUP_IMAGE_REPOSITORY, SETUP_IMAGE_TAG, timeout=self._seams.commit_seconds
        )

    def _refuse_if_the_vm_ran_out_of_memory(self) -> None:
        """The guard's kill came while the setup was being finished: what the image would hold is
        not what the script left, whatever else went wrong after it."""
        if self._guard is not None and self._guard.tripped_at is not None:
            raise _Unavailable(
                f"{REASON_VM_MEMORY}: the VM was running out of memory while the setup was "
                "being finished, so its result is not kept"
            )

    def _check_room(self, container: str, free_bytes: Callable[[], int | None]) -> None:
        """The commit writes the container's file system into the VM's disk; a disk the script
        filled would fail it half way, after minutes, with the daemon's own words. Asked once the
        container has stopped (the inner Docker's data is in its layer by then): the layer's size,
        twice, and a headroom. A size or a free space that cannot be had is not a reason to
        refuse, but it is a note in the report."""
        free = free_bytes()
        if free is None:
            self._notes.append(
                "the free space of the VM's disk could not be read, so the room for the commit "
                "was not checked"
            )
            return
        try:
            layer = self._api.container_rw_bytes(container, timeout=ROOM_SECONDS)
        except DockerError as error:
            self._notes.append(
                f"the size of the container's file system could not be had ({error.status}), so "
                "the room for the commit was not checked"
            )
            return
        if layer is None:
            self._notes.append(
                "the daemon did not say how big the container's file system is, so the room for "
                "the commit was checked against its headroom only"
            )
        needed = COMMIT_ROOM_FACTOR * (layer or 0) + COMMIT_HEADROOM_BYTES
        if free >= needed:
            return
        mb = 1024 * 1024
        raise _NoRoom(
            f"the VM's disk has {free // mb} MB left and the result of the script needs about "
            f"{needed // mb} MB (the container's file system is {(layer or 0) // mb} MB)"
        )

    # -- the end -----------------------------------------------------------------------------------

    def _kill(self) -> None:
        container = self._container
        if container is not None:
            try:
                self._api.kill_container(container, timeout=KILL_SECONDS)
            except DockerError as error:
                _log.warning("the setup container could not be killed (%s)", error.status)

    def _clean(self) -> None:
        """Take the container, with everything in it, and the network away. Each step on its own:
        a step that fails costs nothing and stops nothing (the VM goes with the turn)."""
        container, self._container = self._container, None
        network, self._network = self._network, None
        if self._guard is not None:
            self._guard.close()
        if container is not None:
            self._kill()
            try:
                self._api.remove_container(container, timeout=REMOVE_SECONDS)
            except DockerError as error:
                _log.warning("the setup container could not be removed (%s)", error.status)
        if network is not None:
            try:
                self._api.remove_network(network)
            except DockerError as error:
                _log.warning("the setup network could not be removed (%s)", error.status)


__all__ = ["SETUP_OVERHEAD_SECONDS", "SetupContainer", "SetupRun", "SetupSeams"]
