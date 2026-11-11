# SPDX-License-Identifier: LicenseRef-Proprietary

"""The first phase of the agent's container (#818, #1009): the environment's script runs in it,
once, before the model is called, and the agent then runs in the very same container.

Control starts the container from the agent's own image under `sysbox-runc`, as root, with its own
`dockerd` and the repository (the same Subpath of the work volume the agent gets) and puts it on the
setup network. The script from the environment runs in it as an exec: `bash -e` (or the interpreter
of its `#!` line), working directory the repository, root, all of the image's tools. When it ends
with status 0 the container is **not** stopped and nothing is saved: Control takes it off the setup
network (the one change of the hand-over that stops something: a process of the script that still
holds a connection to the internet loses it; the network itself is removed by whoever connects the
container to the model network next) and freezes it (`docker pause`, and asks the daemon whether it
is frozen) while it reads the repository: a root process the script left would otherwise go on
writing the repository, a link into the work volume among it, while Control resets and cleans it.
Both steps must hold: a container that cannot leave the network or be confirmed frozen is killed
and removed and the turn ends. The agent's container object (`AgentContainer`, `adopted=`) takes it
over: it puts it on the model network, which is what `narrow` is for the container, and starts the
agent in it. What the script left is what the agent has: files, the images, containers and
volumes of the container's own Docker, and the processes that are still running (a Postgres the
script started keeps serving). The agent can use them and stop them. Nothing is reset at the
narrowing. (Before #1009 the container was stopped and committed as an image, which kept the files
and images and lost every process.)

**What it has: nothing of ours.** No git token, no model key, no job token, no environment variable
of its own, no mount but the repository (and the result directory of a turn with a result schema),
no socket, no device. Its definition is made of constants and of identifiers the daemon gave (as it
is for an agent with no script), and Control reads the container back from the daemon before it runs
the script, as it does for the agent. The script is free inside it: it has root, the internet and
Docker. The script's text is data written by a member of the workspace, and the only place it is
ever put is a file in this container.

**How it reaches the internet and nothing of ours.** The container is alone on a network of its own
(`SETUP_NETWORK_NAME`, a bridge named `SETUP_BRIDGE`, not internal, so Docker masquerades its
traffic to the internet). Its way to Control, the model door, the VM's services (the control port
`23456` among them), the platform's own addresses and every private range is closed **in the VM's
own network namespace**, by a table of `nft` rules that a one-shot container with `NET_ADMIN` in
the host's namespace installs before the container exists (`EGRESS_RULES`). The rules are on
the VM's side of the bridge, not in the container: the container is root of a user namespace of its
own and owns its network namespace, so anything installed inside it, the script could remove; the
host's rules, it cannot reach. Packets from its bridge to the VM itself (input) are dropped; packets
that would be routed anywhere private, or into another bridge (the default bridge Control is on,
the model network), are dropped (IPv6 is not forwarded by the VM at all); the rest of the internet
is open on every port,
which includes the inner containers of its own Docker (their traffic is routed through the
container's address). DNS goes to public resolvers named in the container's definition, because the
VM's own resolver is on a private address. A container whose rules did not go in is never started.

**On a customer's machine** (#994, a VM with no direct internet whose only way out is the host's
outer-wall proxy, `outer_proxy.py`) the container gets the usual proxy variables (`HTTP_PROXY`,
`HTTPS_PROXY` and their lower-case twins, `NO_PROXY` for loopback) from the host's address, so the
script's package managers, `git`, `curl` and the Docker daemon inside it (which reads them for
image pulls) go through the proxy, which does the name lookup and applies the wide rule of the
setup. The VM's own table then lets the bridge reach that proxy's address and port and nothing
else (`egress_rules`): no DNS, no other port, no other address. A tool that ignores the variables
finds no way out, and says so; none falls back to a direct connection. This container's one
variable that is not the image's own is those, and the seal check knows them. The agent's tools get
them emptied and the door's instead (`AgentContainer`), and the inner daemon is started again with
the door's (`AgentContainer.restart_docker`).

**The script's output** goes to a file in the container (`SCRIPT_OUTPUT`), which the shell around
the script sends on as it grows and until the script's own process has exited (`RUN_SCRIPT`), never
the exec's stream itself: a daemon the script leaves behind (`nohup postgres &`) inherits the
script's standard output, and one that held the exec's pipe kept the stream open after the script
had exited and got SIGPIPE when it was closed.

**The result.** The end of the script's output (stdout and stderr together, bounded to the last
`OUTPUT_KEEP_BYTES`), its exit status, whether it ran out of time and the container's id. A script
that exits non-zero or runs past its time limit ends the turn before the model is used
(`environment_setup.py`), and the container is removed.
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
    AGENT_CONTAINER_NAME,
    AGENT_IMAGE_REFERENCE,
    AGENT_REPO,
    AGENT_RUNTIME,
    READY_FILE,
    WRITE_FILE_SCRIPT,
    Adopted,
    agent_document,
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
from .reader import work_volume_of
from .result_channel import AGENT_RESULT_DIRECTORY
from .role_labels import role_labels
from .vm_memory import MEMINFO, REASON_VM_MEMORY, MemoryGuard

_log = logging.getLogger(__name__)

SETUP_NETWORK_NAME: Final = "code-reviewer-setup"
# The bridge's own name, so that the rules can name it before it exists (a name is matched when a
# packet comes in).
SETUP_BRIDGE: Final = "crsetup0"
SETUP_NETWORK_SUBNET: Final = "10.213.78.0/29"
SETUP_NETWORK_GATEWAY: Final = "10.213.78.1"
SETUP_ADDRESS: Final = "10.213.78.2"
# Public resolvers: the VM's resolver is on a private address the rules close.
SETUP_DNS: Final = ("1.1.1.1", "8.8.8.8")

SCRIPT_PATH: Final = "/tmp/code-reviewer-setup.sh"
BASH: Final = "/bin/bash"
SH: Final = "/bin/sh"
# The environment of the script: the image's own, and these two (no terminal, no prompt, a home).
SCRIPT_ENVIRONMENT: Final = {"HOME": "/root", "DEBIAN_FRONTEND": "noninteractive"}
SCRIPT_OUTPUT: Final = "/tmp/code-reviewer-setup.out"
# The script runs through this (`$1` is the script's path, `$2` the file its output goes to); a
# script that starts with a `#!` line is executed as itself. The script's standard output and error
# are that **file**, never the exec's stream: a daemon the script leaves behind (`nohup postgres
# &`, `pg_ctl start`, `./server &`) inherits them, and a daemon that held the exec's pipe kept the
# stream open after the script had exited 0 (the step then waited for its time limit) and got
# SIGPIPE when the stream was closed. The shell sends the file's new bytes on its own standard
# output while the script's own process runs, and the rest once it has exited (`$2.done` tells the
# reader), so that the output reaches Control as it is written and the exec ends with the script.
# Its status is the script's. The script has no input.
RUN_SCRIPT: Final = r"""
rm -f "$2.done"
: > "$2"
(
  if head -c 2 "$1" | grep -q "^#!"; then chmod 700 "$1"; exec "$1"
  else exec /bin/bash -e "$1"; fi
) < /dev/null > "$2" 2>&1 &
script=$!
(
  sent=0
  while :; do
    [ -e "$2.done" ] && last=1 || last=0
    size=$(wc -c < "$2")
    if [ "$size" -gt "$sent" ]; then
      tail -c +$((sent + 1)) "$2" | head -c $((size - sent))
      sent=$size
    fi
    [ "$last" = 1 ] && break
    sleep 0.1
  done
) &
reader=$!
wait "$script"
status=$?
: > "$2.done"
wait "$reader"
exit "$status"
"""

# What happens after a script that ended well: its file and its output are removed (the hand-over
# keeps the container, and the agent must not find the script lying around in it).
CLEAN_SCRIPT: Final = 'rm -f "$1" "$2" "$2.done"'

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
# The hand-over: the script's file removed, the container taken off the setup network, the network
# removed and the container frozen. Each call to the daemon has this.
HANDOVER_SECONDS: Final = 30.0
SCRIPT_WRITE_SECONDS: Final = 30.0
REMOVE_SECONDS: Final = 120.0
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
    + HANDOVER_SECONDS * 4
)
# The most of the script's output that is kept: its end.
OUTPUT_KEEP_BYTES: Final = 64 * 1024
WATCH_SECONDS: Final = 0.25

OUTCOME_OK: Final = "ok"
OUTCOME_SCRIPT_FAILED: Final = "script_failed"
OUTCOME_TIMED_OUT: Final = "timed_out"
OUTCOME_STOPPED: Final = "stopped"
OUTCOME_UNAVAILABLE: Final = "unavailable"
# The script ended well and the container could not be handed to the agent.
OUTCOME_NOT_HANDED_OVER: Final = "not_handed_over"


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
    result: bool = False,
    no_new_privileges: bool = False,
) -> dict[str, Any]:
    """The container of the setup, which is the agent's: the agent's definition (its image, limits,
    name, labels and mounts, so that nothing has to change when it takes over) on the setup network
    instead of the model network, with the public resolvers, and no environment variable of its own
    but the proxy's (#994, only on a customer's machine: the host's address, never a job's).
    Constants, the image id, the volume name the daemon gave and the memory the Dispatcher
    computed. No secret, no job."""
    document = agent_document(
        image,
        work_volume,
        memory_bytes,
        runtime=runtime,
        entrypoint=entrypoint,
        result=result,
        nano_cpus=nano_cpus,
        no_new_privileges=no_new_privileges,
    )
    document["Env"] = [] if outer_proxy is None else outer_proxy.tool_environment()
    document["NetworkingConfig"] = {
        "EndpointsConfig": {SETUP_NETWORK_NAME: {"IPAMConfig": {"IPv4Address": SETUP_ADDRESS}}}
    }
    host: dict[str, Any] = document["HostConfig"]
    host["NetworkMode"] = SETUP_NETWORK_NAME
    host["Dns"] = list(SETUP_DNS)
    return document


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
    `container` is the container's id after `OUTCOME_OK`: alive, off the setup network, handed to
    the agent (`adopted`)."""

    outcome: str
    exit_code: int | None
    output: bytes
    output_bytes: int
    container: str | None
    detail: str
    start_seconds: float
    script_seconds: float
    # The seconds the hand-over took (off the network, frozen and confirmed).
    handover_seconds: float
    # What the agent's container object takes over (None unless the script ended well).
    adopted: Adopted | None = None
    # Facts for the log: a step that could not be done and is no failure (the script's file that
    # could not be removed, a freeze the daemon answered late).
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
    # #843: a turn with a result schema has the result directory in the container (it is the
    # agent's container).
    result: bool = False
    # The container's name: the agent's, which it is. Only the VM's boundary check, which keeps an
    # agent beside a script's container to probe between them, names another.
    container_name: str = AGENT_CONTAINER_NAME
    # The image the host helpers run from, for the `ip` it has: the agent's golden one.
    helper_image: str = AGENT_IMAGE_REFERENCE
    runtime: str = AGENT_RUNTIME
    entrypoint: Sequence[str] | None = None
    # A customer's runner (#855) limits the CPUs of the container (`NanoCpus`); 0: no limit.
    nano_cpus: int = 0
    ready_seconds: float = READY_SECONDS
    # False only in a test that has no host namespace to put rules in (never in production).
    install_rules: bool = True
    # The host's outer-wall proxy (#994): the Setup's way to the internet on a customer's machine,
    # handed to Control by the host. None: as hosted.
    outer_proxy: OuterProxy | None = None
    # The file the VM's memory is read from (`MemoryGuard`).
    meminfo: str = MEMINFO
    # The agent's container of a turn on Claude Code is made with `no-new-privileges` (#856); the
    # setup's is the agent's container, so it takes the same seam (`subscription_setup_script`
    # refuses that harness with a script today).
    no_new_privileges: bool = False


def _variables(listed: object) -> set[str]:
    """The `NAME=value` entries of a container's or an image's `Env`."""
    if not isinstance(listed, list):
        return set()
    return {entry for entry in cast("list[Any]", listed) if isinstance(entry, str)}


class _Unavailable(Exception):
    """A step before the script that could not be done; the word is the reason."""


class SetupContainer:
    """One run of the container the script runs in. `run` does everything. A script that failed
    ends with the container and the network removed (it does not raise); one that ended well ends
    with the container alive, off the setup network, frozen when that could be done, and the
    network still there (the agent's container object removes it): the caller reads the repository
    and the agent takes the container over.
    `discard` removes it when nothing takes it."""

    def __init__(self, memory_mb: int, seams: SetupSeams = SetupSeams()) -> None:  # noqa: B008
        self._api = seams.api()
        self._seams = seams
        self._memory_bytes = memory_mb * 1024 * 1024
        self._container: str | None = None
        self._network: str | None = None
        self._ended = threading.Event()
        self._guard: MemoryGuard | None = None
        self._notes: list[str] = []
        # Set when a freeze was asked for: the container may be frozen, and is thawed to be removed.
        self._pause_sent = False

    # -- the whole run -----------------------------------------------------------------------------

    def run(
        self,
        script: str,
        *,
        script_seconds: float,
        should_stop: Callable[[], bool] = lambda: False,
    ) -> SetupRun:
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
                self._hand_over(container)
            except _Unavailable as reason:
                self._clean()
                return self._ended_run(
                    OUTCOME_NOT_HANDED_OVER, str(reason), tail, begun, started, finished, code=code
                )
            except DockerError as error:
                self._clean()
                detail = (
                    "the container could not be handed to the agent "
                    f"({error.status}: {error.message[:160]})"
                )
                return self._ended_run(
                    OUTCOME_NOT_HANDED_OVER, detail, tail, begun, started, finished, code=code
                )
            handed = clock()
            proxy = self._seams.outer_proxy
            return SetupRun(
                outcome=OUTCOME_OK,
                exit_code=code,
                output=tail.value(),
                output_bytes=tail.total,
                container=container,
                detail="",
                start_seconds=started - begun,
                script_seconds=finished - started,
                handover_seconds=handed - finished,
                adopted=Adopted(
                    container,
                    setup_environment=() if proxy is None else tuple(proxy.tool_environment()),
                    paused=True,
                    setup_network=SETUP_NETWORK_NAME,
                    dns=SETUP_DNS,
                ),
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
            container=None,
            detail=detail,
            start_seconds=started - begun,
            script_seconds=finished - started,
            handover_seconds=0.0,
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
                result=self._seams.result,
                no_new_privileges=self._seams.no_new_privileges,
            ),
            self._seams.container_name,
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
        if host.get("NetworkMode") != SETUP_NETWORK_NAME:
            problems.append("network mode")
        if tuple(cast("list[Any]", host.get("Dns") or [])) != SETUP_DNS:
            problems.append("resolvers")
        if ("no-new-privileges" in cast("list[Any]", host.get("SecurityOpt") or [])) != (
            self._seams.no_new_privileges
        ):
            problems.append("no-new-privileges")
        destinations: set[object] = set()
        for mount in cast("list[Any]", mounts) if isinstance(mounts, list) else []:
            given = as_object(mount)
            destinations.add(None if given is None else given.get("Destination"))
        allowed = {AGENT_REPO, AGENT_RESULT_DIRECTORY} if self._seams.result else {AGENT_REPO}
        if destinations - allowed:
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
                    [SH, "-c", RUN_SCRIPT, "run", SCRIPT_PATH, SCRIPT_OUTPUT],
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

    # -- the hand-over -----------------------------------------------------------------------------

    def _hand_over(self, container: str) -> None:
        """The script ended well; the container goes on. The script's file and output are removed.
        The container leaves the setup network (which stays until the agent's container object has
        joined the model network): from here on nothing of it has the internet, and a process of the
        script that held a connection loses it before the outer wall narrows and before any door
        exists. Then the container is frozen (`docker pause`) and the daemon is asked whether it
        is: Control reads the repository next (`settle_after_setup`), and a root process the
        script left would go on writing it while it does (a link into the work volume). The
        memory guard watches until the freeze is confirmed. Raises `_Unavailable` or `DockerError`
        when the container could not be taken off the network or frozen: the two steps that must
        hold."""
        api = self._api
        removed = run_exec(
            api,
            container,
            [SH, "-c", CLEAN_SCRIPT, "clean", SCRIPT_PATH, SCRIPT_OUTPUT],
            timeout=HANDOVER_SECONDS,
            name="the end of the setup",
        )
        if removed.returncode != 0 or removed.unanswered:
            self._notes.append("the script's file could not be removed from the container")
        api.disconnect_network(SETUP_NETWORK_NAME, container)
        # The network stays until the agent's container object has put the container on the model
        # network: the daemon refuses a `connect` of a container whose network mode names a
        # network that is gone ("could not find a network matching network mode", measured on the
        # KVM lane), so the one who connects removes it (`Adopted.setup_network`).
        self._freeze(container)
        if self._guard is not None:
            self._guard.close()

    def _freeze(self, container: str) -> None:
        """Freeze the container and see that it is. Any refusal (a status, a conflict), an answer
        the daemon does not back up (`State.Paused`) and a client timeout the daemon did not
        complete is `_Unavailable`: a container that is not known to be frozen is never handed
        over. After a timeout the daemon is asked what it did, nothing is guessed."""
        self._pause_sent = True
        try:
            self._api.pause_container(container, timeout=HANDOVER_SECONDS)
        except DockerError as error:
            if error.status != 0:
                raise _Unavailable(
                    f"the container could not be frozen ({error.status}: {error.message[:160]})"
                ) from None
            if not self._is_frozen(container):
                raise _Unavailable(
                    "the container could not be frozen (the daemon did not answer in time and "
                    "does not report it frozen)"
                ) from None
            self._notes.append(
                "the daemon answered the freeze late; it reports the container frozen"
            )
            return
        if not self._is_frozen(container):
            raise _Unavailable("the daemon did not report the container frozen after the freeze")

    def _is_frozen(self, container: str) -> bool:
        """What the daemon says: running, and paused. A daemon that cannot say is no."""
        try:
            state = as_object(self._api.inspect_container(container).get("State")) or {}
        except DockerError:
            return False
        return state.get("Running") is True and state.get("Paused") is True

    def discard(self) -> None:
        """Remove the container and what is left of the network, for a container nothing took over
        (the repository could not be read after the script)."""
        self._clean()

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
            if self._pause_sent:
                # A frozen container is not killed or removed by every daemon: thaw it first (the
                # turn ends here, nothing reads the repository again).
                with contextlib.suppress(DockerError):
                    self._api.unpause_container(container, timeout=KILL_SECONDS)
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
