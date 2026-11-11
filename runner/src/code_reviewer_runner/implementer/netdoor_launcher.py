# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control starts the network door through the VM's Docker (#745, step 7).

The environment's rule for the agent's network (`network_rule.py`) is enforced in a container of its
own, on the model network at a fixed address, next to the model door and the agent. The agent and
the containers it starts reach it by that address and use it as their HTTP and HTTPS proxy
(`agent_container.proxy_environment`); the door decides on the host name of every request
(`netdoor/proxy.py`). `off` has no door: nothing is started and the agent has no way out at all.

The pattern is the model door's (`door_launcher.py`), and so are its walls:

* the container is made from constants (`door_document`): non-root, read-only root file system,
  every capability dropped, `no-new-privileges`, a small memory and process limit, no mount, no
  published port, IPv6 off, and **no environment variable of its own**. It holds no secret of any
  kind: the rule is the owner's text, there is no key and no token. A test of the definition fails
  when any of that is weakened;
* its own egress is closed in its network namespace by a one-shot container with `NET_ADMIN`
  (`EGRESS_RULES`) before it is told anything: loopback, replies and DNS are open, a new
  connection into the model network is dropped, every private, link-local, shared and special range
  is dropped, the rest of the internet is open on ports 80 and 443 only, and everything else is
  dropped. A door whose rules did not go in is taken away and the agent never gets its address;
* the rule goes to the door's stdin, once, and the door answers on stdout (`netdoor/protocol.py`):
  `ready`, the log of its connections whenever it changes, and a last one when it stops. **The door
  never calls Control**, and Control reads the log of the turn from the pipe.

**What differs from the model door.** The door's work can fail without a cost: a door that dies
during the turn leaves the agent with no network, which the turn goes on without (a note in the
report says so); nothing here is a key or money. A door that cannot be started ends the turn
`setup_failed`, free, before the agent exists: an environment that asked for a network does not run
without one.

**The CI seam.** `NetDoorSeams.ci_network` is for the lane in CI, which has no internet: it
joins the door to a second Docker network, names the hosts that "resolve" there, and tells the
door and its rules that this network is public (`NETDOOR_TEST_PUBLIC_CIDR`, honoured only inside
`10.213.99.0/24`). Production never sets it, `door_document` has no environment without it, and a
test holds both.
"""

import contextlib
import json
import logging
import socket
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Final

from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_NETWORK_NAME,
    MODEL_NETWORK_SUBNET,
    NETWORK_DOOR_ADDRESS,
    NETWORK_DOOR_PORT,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.outer_proxy import OuterProxy
from code_reviewer_runner.result import ErrorCode

from .docker_api import AttachedStreams, DockerApi, DockerError
from .door_launcher import (
    BRIDGE_NETWORK,
    DOOR_TMPFS,
    DOOR_USER,
    PRIVATE_RANGES,
    READY_SECONDS,
    RULES_ENTRYPOINT,
    RULES_SECONDS,
    STOP_SECONDS,
    network_document,
)
from .door_state import DoorEnd
from .netdoor.addresses import TEST_PUBLIC_VARIABLE
from .netdoor.protocol import (
    MESSAGE_READY,
    MESSAGE_REFUSED,
    MESSAGE_STATUS,
    OP_STOP,
    VERSION,
)
from .network_rule import NetworkRule
from .role_labels import role_labels

_log = logging.getLogger(__name__)

NETDOOR_CONTAINER_NAME: Final = "code-reviewer-network-door"
RULES_CONTAINER_NAME: Final = "code-reviewer-network-door-rules"
# The proxy is a Python process with a thread or two for each connection. Measured RSS of the idle
# process is 17 to 35 MB and with 120 tunnels open it stays under 70 MB (`docs/implementer.md`); the
# rest is for the connections it relays. The Dispatcher takes the same figure off the agent's memory
# (`NETWORK_DOOR_MEMORY_MB`; both are held to `contracts/environment-sizes.v1.json`).
NETDOOR_MEMORY_MB: Final = 96
NETDOOR_MEMORY_BYTES: Final = NETDOOR_MEMORY_MB * 1024 * 1024
# 128 connections (`proxy.MAX_CONNECTIONS`), two threads each, and the process's own.
NETDOOR_PIDS_LIMIT: Final = 400
# The public certificate the door may send in `ready` (#784): one PEM certificate, a few hundred
# bytes; anything that is not one is ignored.
CA_PEM_START: Final = "-----BEGIN CERTIFICATE-----"
MAX_CA_CHARS: Final = 8192
# The doors outlive the agent's processes: under memory pressure the VM's OOM killer takes the
# agent first (it has 1000), and the doors, which hold nothing the agent can use, last.
NETDOOR_OOM_SCORE_ADJ: Final = -500
NETDOOR_ENTRYPOINT: Final = [
    "/usr/bin/tini",
    "--",
    "/opt/venv/bin/python",
    "-m",
    "code_reviewer_runner.implementer.netdoor",
]
EGRESS_TABLE: Final = "netdoor_egress"
# The only ports the door dials; the proxy refuses the rest, and the table says it again where the
# process cannot get round it.
EGRESS_PORTS: Final = (80, 443)


def egress_rules(test_cidr: str | None = None, outer_proxy: OuterProxy | None = None) -> str:
    """The door's table. `test_cidr` is the seam's network, accepted before the private ranges are
    dropped; production passes none. With the host's outer-wall proxy (#994, a VM on a customer's
    machine) the door has **one** way out, a connection to that proxy's address and port: no DNS
    (the proxy resolves), no ports 80 and 443 of the internet, no list of private ranges (the
    proxy's own address is in one, so nothing is dropped by range: the last rule drops all that is
    not accepted), and the seam's network is not accepted. The order is: loopback, replies to what
    the door started, a drop of the model network, then the proxy's accept, then the drop of
    everything else; the proxy's accept is not first, and it does not need to be, since the model
    network is not the proxy's range. A door whose proxy refuses it fails; no rule lets it dial a
    host directly."""
    if outer_proxy is not None:
        return "; ".join(
            [
                f"add table ip {EGRESS_TABLE}",
                f"add chain ip {EGRESS_TABLE} output "
                "{ type filter hook output priority 0 ; policy accept ; }",
                f'add rule ip {EGRESS_TABLE} output oifname "lo" accept',
                f"add rule ip {EGRESS_TABLE} output ct state established,related accept",
                f"add rule ip {EGRESS_TABLE} output ip daddr {MODEL_NETWORK_SUBNET} drop",
                f"add rule ip {EGRESS_TABLE} output ip daddr {outer_proxy.host} "
                f"tcp dport {outer_proxy.port} accept",
                f"add rule ip {EGRESS_TABLE} output drop",
            ]
        )
    ports = ", ".join(str(port) for port in EGRESS_PORTS)
    rules = [
        f"add table ip {EGRESS_TABLE}",
        f"add chain ip {EGRESS_TABLE} output "
        "{ type filter hook output priority 0 ; policy accept ; }",
        f'add rule ip {EGRESS_TABLE} output oifname "lo" accept',
        f"add rule ip {EGRESS_TABLE} output ct state established,related accept",
        f"add rule ip {EGRESS_TABLE} output ip daddr {MODEL_NETWORK_SUBNET} drop",
        f"add rule ip {EGRESS_TABLE} output meta l4proto {{ tcp, udp }} th dport 53 accept",
    ]
    if test_cidr is not None:
        rules.append(
            f"add rule ip {EGRESS_TABLE} output ip daddr {test_cidr} tcp dport {{ {ports} }} accept"
        )
    rules += [
        f"add rule ip {EGRESS_TABLE} output ip daddr {{ {', '.join(PRIVATE_RANGES)} }} drop",
        f"add rule ip {EGRESS_TABLE} output tcp dport {{ {ports} }} accept",
        f"add rule ip {EGRESS_TABLE} output drop",
    ]
    return "; ".join(rules)


@dataclass(frozen=True)
class CiNetwork:
    """What the lane in CI adds to the door (`NetDoorSeams.ci_network`): a Docker network the door
    joins, the CIDR the door treats as public, and `host:address` entries for `/etc/hosts`."""

    network: str
    cidr: str
    hosts: tuple[str, ...] = ()


def door_document(image: str, test: CiNetwork | None = None) -> dict[str, Any]:
    """The door's container. Constants and the image id the daemon gave: nothing from a job."""
    host_config: dict[str, Any] = {
        "NetworkMode": BRIDGE_NETWORK,
        "Privileged": False,
        "ReadonlyRootfs": True,
        "CapDrop": ["ALL"],
        "SecurityOpt": ["no-new-privileges:true"],
        "Memory": NETDOOR_MEMORY_BYTES,
        "MemorySwap": NETDOOR_MEMORY_BYTES,
        "PidsLimit": NETDOOR_PIDS_LIMIT,
        "OomScoreAdj": NETDOOR_OOM_SCORE_ADJ,
        "Tmpfs": {"/tmp": DOOR_TMPFS},
        "RestartPolicy": {"Name": "no"},
        "PublishAllPorts": False,
        # The rules are an `ip` table: it does not see IPv6, so the door has none.
        "Sysctls": {
            "net.ipv6.conf.all.disable_ipv6": "1",
            "net.ipv6.conf.default.disable_ipv6": "1",
        },
    }
    environment: list[str] = []
    if test is not None:
        environment.append(f"{TEST_PUBLIC_VARIABLE}={test.cidr}")
        host_config["ExtraHosts"] = list(test.hosts)
    return {
        "Image": image,
        "Entrypoint": NETDOOR_ENTRYPOINT,
        "Cmd": [],
        "User": DOOR_USER,
        "Env": environment,
        "Hostname": "network-door",
        "Labels": role_labels("network-door"),
        "OpenStdin": True,
        "StdinOnce": True,
        "AttachStdin": True,
        "AttachStdout": True,
        "AttachStderr": True,
        "Tty": False,
        "HostConfig": host_config,
    }


def rules_document(
    image: str,
    door: str,
    test_cidr: str | None = None,
    outer_proxy: OuterProxy | None = None,
) -> dict[str, Any]:
    """The one-shot container that installs the door's egress rules: it shares the door's network
    namespace and nothing else, holds `NET_ADMIN` and no other capability, and runs one command that
    is a constant (or, in the lane, that constant with one more rule)."""
    return {
        "Image": image,
        "Entrypoint": RULES_ENTRYPOINT,
        "Cmd": [egress_rules(test_cidr, outer_proxy)],
        "User": "0:0",
        "Env": [],
        "Labels": role_labels("network-door-rules"),
        "HostConfig": {
            "NetworkMode": f"container:{door}",
            "Privileged": False,
            "ReadonlyRootfs": True,
            "CapDrop": ["ALL"],
            "CapAdd": ["NET_ADMIN"],
            "SecurityOpt": ["no-new-privileges:true"],
            "Memory": 64 * 1024 * 1024,
            "MemorySwap": 64 * 1024 * 1024,
            "PidsLimit": 16,
            "RestartPolicy": {"Name": "no"},
        },
    }


def start_document(
    rule: NetworkRule, deadline_seconds: float, outer_proxy: OuterProxy | None = None
) -> bytes:
    """The line written to the door's stdin (`netdoor/protocol.py`). Holds no secret. `outerProxy`
    is the host's proxy (#994), there only when the host has one."""
    document: dict[str, Any] = {
        "version": VERSION,
        "rule": rule.to_json(),
        "listenPort": NETWORK_DOOR_PORT,
        "deadlineSeconds": deadline_seconds,
    }
    if outer_proxy is not None:
        document["outerProxy"] = outer_proxy.to_json()
    return json.dumps(document, separators=(",", ":")).encode() + b"\n"


def _unavailable(reason: str) -> JobError:
    return JobError(ErrorCode.SETUP_FAILED, f"network_door_unavailable: {reason}")


@dataclass(frozen=True)
class NetDoorSeams:
    """What the tests replace; production leaves the defaults."""

    api: Callable[[], DockerApi] = DockerApi
    hostname: Callable[[], str] = socket.gethostname
    ready_seconds: float = READY_SECONDS
    stop_seconds: float = STOP_SECONDS
    ci_network: CiNetwork | None = None
    # The host's outer-wall proxy (#994): the network door is chained to it on a customer's
    # machine (agent, network door, outer-wall proxy). None: as hosted.
    outer_proxy: OuterProxy | None = None


@dataclass
class NetDoorState:
    """What the reader thread learned from the door's output."""

    ready: threading.Event = field(default_factory=threading.Event)
    ca: bytes | None = None
    refusal: str | None = None
    status: dict[str, Any] | None = None
    end: DoorEnd | None = None


class RunningNetDoor:
    """A started door. `url` is where the agent reaches it; `snapshot()` is the log as the door last
    said it."""

    def __init__(
        self,
        api: DockerApi,
        streams: AttachedStreams,
        *,
        container: str,
        seams: NetDoorSeams,
        network: str | None = None,
    ) -> None:
        self._api = api
        self._streams = streams
        self._container = container
        # The model network when this door made it (a turn with no model door), else None: the
        # model door that made it takes it away.
        self._network = network
        self._seams = seams
        self._lock = threading.Lock()
        self._state = NetDoorState()
        self._stopping = threading.Event()
        self._closed = False
        self.url = f"http://{NETWORK_DOOR_ADDRESS}:{NETWORK_DOOR_PORT}"
        self._reader = threading.Thread(target=self._read, daemon=True)

    def begin(self) -> None:
        self._reader.start()

    def _read(self) -> None:
        try:
            for raw in self._streams.lines():
                self._take(raw)
        except Exception:
            _log.warning("the network door's output could not be read to its end")
        finally:
            ended = self._how_it_ended()
            with self._lock:
                self._state.end = ended
            self._state.ready.set()

    def _take(self, raw: bytes) -> None:
        try:
            line: Any = json.loads(raw)
        except (ValueError, RecursionError):
            return
        given = as_object(line)
        kind = None if given is None else given.get("t")
        if given is None:
            return
        if kind == MESSAGE_READY:
            ca = given.get("ca")
            if isinstance(ca, str) and ca.startswith(CA_PEM_START) and len(ca) <= MAX_CA_CHARS:
                with self._lock:
                    self._state.ca = ca.encode("ascii", "replace")
            self._state.ready.set()
        elif kind == MESSAGE_REFUSED:
            reason = given.get("reason")
            with self._lock:
                self._state.refusal = reason if isinstance(reason, str) else "unknown"
            self._state.ready.set()
        elif kind == MESSAGE_STATUS:
            document = {key: value for key, value in given.items() if key not in ("t", "seq")}
            with self._lock:
                self._state.status = document

    def _how_it_ended(self) -> DoorEnd:
        code: int | None = None
        oom = False
        try:
            document = self._api.inspect_container(self._container)
            container_state = as_object(document.get("State")) or {}
            raw_code = container_state.get("ExitCode")
            code = (
                raw_code if isinstance(raw_code, int) and not isinstance(raw_code, bool) else None
            )
            oom = container_state.get("OOMKilled") is True
        except DockerError:
            pass
        return DoorEnd(exit_code=code, out_of_memory=oom, unexpected=not self._stopping.is_set())

    def wait_ready(self, seconds: float) -> None:
        self._state.ready.wait(seconds)

    @property
    def registry_ca(self) -> bytes | None:
        """The public certificate of the door's authority (#784), when the rule names a package
        registry: the agent's tools are told to trust it (`agent_container.trust_environment`)."""
        with self._lock:
            return self._state.ca

    @property
    def refusal(self) -> str | None:
        with self._lock:
            return self._state.refusal

    @property
    def is_ready(self) -> bool:
        with self._lock:
            return (
                self._state.ready.is_set() and self._state.end is None and not self._state.refusal
            )

    @property
    def end(self) -> DoorEnd | None:
        with self._lock:
            return self._state.end

    def snapshot(self) -> dict[str, Any] | None:
        """The log as the door last said it (`connections.ConnectionLog.snapshot`, plus `final`);
        None before it said anything."""
        with self._lock:
            return None if self._state.status is None else dict(self._state.status)

    def stop(self) -> dict[str, Any] | None:
        """End the door: ask it to stop (it prints its final log), wait a little, then remove its
        container. Returns the log. Safe to call twice."""
        if not self._closed:
            self._closed = True
            self._stopping.set()
            with contextlib.suppress(OSError):
                self._streams.write(json.dumps({"op": OP_STOP}).encode() + b"\n")
            self._streams.close_write()
            self._reader.join(timeout=self._seams.stop_seconds)
            _remove_quietly(self._api, self._container, self._network)
            self._streams.close()
        return self.snapshot()


def _remove_quietly(api: DockerApi, container: str | None, network: str | None = None) -> None:
    """The door's container and, when the door made it, the model network (each on its own; a
    network with a member is not removed, and the sweep of the runner's housekeeping finds what is
    left by its label)."""
    steps: list[Callable[[], None]] = []
    if container is not None:
        steps.append(lambda: api.remove_container(container))
    if network is not None:
        steps.append(lambda: api.remove_network(network))
    for step in steps:
        try:
            step()
        except DockerError as error:
            _log.warning("the network door could not be cleaned up (%s)", error.status)


def _ensure_network(api: DockerApi) -> str | None:
    """Make the model network when it is not there: a turn with no model door (Claude Code on a
    subscription) has nothing else to make it. The id of the network when this call made it, None
    when it was there (the model door's, which takes it away)."""
    try:
        api.inspect_network(MODEL_NETWORK_NAME)
    except DockerError as error:
        if error.status != 404:
            raise
        return api.create_network(network_document())
    return None


def start_network_door(
    rule: NetworkRule,
    *,
    deadline_seconds: float,
    seams: NetDoorSeams = NetDoorSeams(),  # noqa: B008 - frozen, shared on purpose
) -> RunningNetDoor:
    """Make the container on the model network (which the model door made), install its egress
    rules, hand it the rule and wait for `ready`. Raises `JobError` (`setup_failed`, free) for a
    door that cannot be started; whatever was made is removed first."""
    api = seams.api()
    container: str | None = None
    network: str | None = None
    streams: AttachedStreams | None = None
    test = seams.ci_network
    try:
        me = api.inspect_container(seams.hostname())
        image = str(me.get("Image", ""))
        if not image or not me.get("Id"):
            raise _unavailable("the daemon does not know this container")
        network = _ensure_network(api)
        container = api.create_container(door_document(image, test), NETDOOR_CONTAINER_NAME)
        api.connect_network(
            MODEL_NETWORK_NAME,
            {
                "Container": container,
                "EndpointConfig": {"IPAMConfig": {"IPv4Address": NETWORK_DOOR_ADDRESS}},
            },
        )
        if test is not None:
            api.connect_network(test.network, {"Container": container})
        streams = api.attach(container)
        running = RunningNetDoor(api, streams, container=container, seams=seams, network=network)
        running.begin()
        api.start_container(container)
        _close_the_doors_network(
            api, image, container, None if test is None else test.cidr, seams.outer_proxy
        )
        # A door that is already gone cannot be written to: the reader says how it ended.
        with contextlib.suppress(OSError):
            streams.write(start_document(rule, deadline_seconds, seams.outer_proxy))
    except DockerError as error:
        _cleanup(api, container, streams, network)
        raise _unavailable(f"the daemon refused a step ({error.status})") from None
    except JobError:
        _cleanup(api, container, streams, network)
        raise
    except Exception:
        _cleanup(api, container, streams, network)
        raise _unavailable(
            "a step of the start failed in a way the daemon did not explain"
        ) from None
    except BaseException:
        _cleanup(api, container, streams, network)
        raise
    running.wait_ready(seams.ready_seconds)
    refusal = running.refusal
    if refusal is not None:
        running.stop()
        raise _unavailable(f"the door refused to start ({refusal})")
    end = running.end
    if end is not None:
        running.stop()
        raise _unavailable(
            "the door ended before it was ready"
            + ("" if end.exit_code is None else f" (exit code {end.exit_code})")
        )
    if not running.is_ready:
        running.stop()
        raise _unavailable("the door did not become ready in time")
    return running


def _close_the_doors_network(
    api: DockerApi,
    image: str,
    door: str,
    test_cidr: str | None,
    outer_proxy: OuterProxy | None = None,
) -> None:
    """Install the door's egress rules before it is told anything. A door whose rules are not in
    place is not used: this raises, and the caller takes the door away."""
    helper = api.create_container(
        rules_document(image, door, test_cidr, outer_proxy), RULES_CONTAINER_NAME
    )
    try:
        api.start_container(helper)
        code = api.wait_container(helper, timeout=RULES_SECONDS)
    finally:
        try:
            api.remove_container(helper)
        except DockerError as error:
            _log.warning("the rules container could not be removed (%s)", error.status)
    if code != 0:
        raise _unavailable(f"the door's network rules could not be installed (exit code {code})")


def _cleanup(
    api: DockerApi,
    container: str | None,
    streams: AttachedStreams | None,
    network: str | None = None,
) -> None:
    if streams is not None:
        streams.close()
    _remove_quietly(api, container, network)
