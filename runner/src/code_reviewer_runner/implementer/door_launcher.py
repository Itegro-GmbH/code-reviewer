# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control starts the model door through the VM's Docker (#745, step 3).

The Worker container of an Implementer turn is the Control container: it keeps the git token and the
push and supervises. The model key is the door's: Control hands it over and then drops its own copy
of the hand-off (`session.forget_model_access`: the job's `model_access` and the `llm` section it
shares). What Control still holds is `job.llm.api_key`, kept on purpose so that the key is scrubbed
from every output of the turn, the text the job was read from, and whatever Python's memory has not
yet reused: strings are not wiped. Nothing the agent can reach reads that memory (the engine is
another user, from step 4 another container). This module is how Control hands the key over:

1. It reads its own container from the daemon (the image to start the door from: the door is the
   Worker image with another entry point, so there is one image in the snapshot and one to
   verify) and makes the **model network**: `--internal` with `gateway_mode_ipv4=isolated`, so
   that it has no exit and no route to the VM. Control joins it at a fixed address.
2. It makes the door's container from constants (`door_document`): non-root, read-only root file
   system, every capability dropped, `no-new-privileges`, a small memory and process limit, no
   mount, no published port, no environment, no secret of any kind in its definition. Its network
   is the VM's default bridge (the way to the provider) and the model network at the fixed address
   (the way for the agent).
3. It attaches to the standard streams, starts the door and writes **the start document to its
   stdin**: the key and the cost policy travel there and in no argument, no environment variable and
   no file, and `docker inspect` shows none of them. The door answers on stdout (`protocol.py`).
4. When the stream ends the door is gone: Control reads how it ended (the exit code, a kill for its
   memory) and the turn fails with a name of its own (`DoorState.failure`).

Nothing of a job, of the agent or of the repository is in a request to the daemon: every body is
made from the constants below and from identifiers the daemon itself answered with. The one thing
that varies with the job, the start document, goes to the door's stdin and is parsed there.
"""

import contextlib
import json
import logging
import socket
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final

from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_CONTROL_ADDRESS,
    MODEL_DOOR_ADDRESS,
    MODEL_NETWORK_GATEWAY,
    MODEL_NETWORK_NAME,
    MODEL_NETWORK_SUBNET,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

from .docker_api import AttachedStreams, DockerApi, DockerError
from .door.protocol import (
    MESSAGE_READY,
    MESSAGE_REFUSED,
    MESSAGE_STATUS,
    OP_STOP,
    REFUSED_ACCESS_INVALID,
    REFUSED_CONFIG_INVALID,
    VERSION,
)
from .door.status import parse_status
from .door_state import DoorEnd, DoorState

_log = logging.getLogger(__name__)

# What the daemon names the door's container and its network. One turn has one VM, so one door.
DOOR_CONTAINER_NAME: Final = "code-reviewer-model-door"
DOOR_ROLE_LABEL: Final = "code-reviewer.role"
# The `runner` user of the image: not root, not the engine user, no home of its own to write to.
DOOR_USER: Final = "10001:10001"
DOOR_MEMORY_BYTES: Final = 256 * 1024 * 1024
DOOR_PIDS_LIMIT: Final = 128
DOOR_TMPFS: Final = "rw,noexec,nosuid,nodev,size=16m,mode=1777"
# The door runs the module, not `code-reviewer-runner`: it imports the proxy and nothing else.
DOOR_ENTRYPOINT: Final = [
    "/usr/bin/tini",
    "--",
    "/opt/venv/bin/python",
    "-m",
    "code_reviewer_runner.implementer.door",
]
# How long the door may take to say `ready` (the Python start and the bind), and how long the whole
# start may take with the daemon's own answers.
READY_SECONDS: Final = 30.0
STOP_SECONDS: Final = 5.0
BRIDGE_NETWORK: Final = "bridge"

# The door's own network rules (#745, step 3). The door is on the VM's default bridge, which has a
# route to the internet and to the VM itself (its Docker gateway, its control port). A one-shot
# container that shares the door's network namespace and holds `NET_ADMIN` (the door itself holds
# no capability) installs these rules before the door is told the key:
#
# * the model network (the agent's side) and loopback (the embedded DNS) are open;
# * replies are open, and DNS (port 53, the resolver of the VM is on a private address);
# * every private, link-local, shared and special range is dropped: the VM, its neighbours, the
#   other containers, the platform's services;
# * what is left of the internet, port 443 only: the provider (`HttpsUpstream` dials port 443 of
#   public addresses only, this says it again where the door cannot get round it);
# * everything else is dropped.
#
# The provider's own address is not named (a name behind a CDN has no stable address): narrowing
# 443 to the provider is the second wall of the plan, the VM's network policy (step 7).
EGRESS_TABLE: Final = "door_egress"
PRIVATE_RANGES: Final = (
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "224.0.0.0/3",
)
EGRESS_RULES: Final = "; ".join(
    [
        f"add table ip {EGRESS_TABLE}",
        f"add chain ip {EGRESS_TABLE} output "
        "{ type filter hook output priority 0 ; policy accept ; }",
        f'add rule ip {EGRESS_TABLE} output oifname "lo" accept',
        f"add rule ip {EGRESS_TABLE} output ip daddr {MODEL_NETWORK_SUBNET} accept",
        f"add rule ip {EGRESS_TABLE} output ct state established,related accept",
        f"add rule ip {EGRESS_TABLE} output meta l4proto {{ tcp, udp }} th dport 53 accept",
        f"add rule ip {EGRESS_TABLE} output ip daddr {{ {', '.join(PRIVATE_RANGES)} }} drop",
        f"add rule ip {EGRESS_TABLE} output tcp dport 443 accept",
        f"add rule ip {EGRESS_TABLE} output drop",
    ]
)
RULES_ENTRYPOINT: Final = ["/usr/sbin/nft"]
RULES_SECONDS: Final = 20.0
RULES_CONTAINER_NAME: Final = "code-reviewer-model-door-rules"


def network_document() -> dict[str, Any]:
    """The model network: no exit, no route to the VM, a fixed range."""
    return {
        "Name": MODEL_NETWORK_NAME,
        "Driver": "bridge",
        "Internal": True,
        "Attachable": False,
        "EnableIPv6": False,
        "IPAM": {
            "Driver": "default",
            "Config": [{"Subnet": MODEL_NETWORK_SUBNET, "Gateway": MODEL_NETWORK_GATEWAY}],
        },
        "Options": {"com.docker.network.bridge.gateway_mode_ipv4": "isolated"},
        "Labels": {DOOR_ROLE_LABEL: "model-network"},
    }


def door_document(image: str) -> dict[str, Any]:
    """The door's container. Constants and the image id the daemon gave: nothing from a job."""
    return {
        "Image": image,
        "Entrypoint": DOOR_ENTRYPOINT,
        "Cmd": [],
        "User": DOOR_USER,
        "Env": [],
        "Hostname": "model-door",
        "Labels": {DOOR_ROLE_LABEL: "model-door"},
        "OpenStdin": True,
        "StdinOnce": True,
        "AttachStdin": True,
        "AttachStdout": True,
        "AttachStderr": True,
        "Tty": False,
        "HostConfig": {
            "NetworkMode": BRIDGE_NETWORK,
            "Privileged": False,
            "ReadonlyRootfs": True,
            "CapDrop": ["ALL"],
            "SecurityOpt": ["no-new-privileges:true"],
            "Memory": DOOR_MEMORY_BYTES,
            "MemorySwap": DOOR_MEMORY_BYTES,
            "PidsLimit": DOOR_PIDS_LIMIT,
            "Tmpfs": {"/tmp": DOOR_TMPFS},
            "RestartPolicy": {"Name": "no"},
            "PublishAllPorts": False,
            # The rules below are an `ip` table: it does not see IPv6, so the door has none.
            "Sysctls": {
                "net.ipv6.conf.all.disable_ipv6": "1",
                "net.ipv6.conf.default.disable_ipv6": "1",
            },
        },
    }


def rules_document(image: str, door: str) -> dict[str, Any]:
    """The one-shot container that installs the door's network rules: it shares the door's network
    namespace and nothing else, holds `NET_ADMIN` and no other capability, and runs one command that
    is a constant."""
    return {
        "Image": image,
        "Entrypoint": RULES_ENTRYPOINT,
        "Cmd": [EGRESS_RULES],
        "User": "0:0",
        "Env": [],
        "Labels": {DOOR_ROLE_LABEL: "model-door-rules"},
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
    *,
    model_access: Mapping[str, Any],
    capability: str,
    deadline_seconds: float,
    port: int,
    environment: Mapping[str, str],
) -> bytes:
    """The line written to the door's stdin (`protocol.py`). Holds the key."""
    return (
        json.dumps(
            {
                "version": VERSION,
                "modelAccess": model_access,
                "capability": capability,
                "deadlineSeconds": deadline_seconds,
                "listenPort": port,
                "environment": dict(environment),
            },
            separators=(",", ":"),
        ).encode()
        + b"\n"
    )


def _unavailable(reason: str) -> JobError:
    """A door that could not be started: the turn never began, so it is the free code of a turn
    that did not start. The word is the reason; it never carries a value."""
    return JobError(ErrorCode.SETUP_FAILED, f"model_door_unavailable: {reason}")


@dataclass(frozen=True)
class DoorSeams:
    """What the tests replace; production leaves the defaults."""

    api: Callable[[], DockerApi] = DockerApi
    hostname: Callable[[], str] = socket.gethostname
    clock: Callable[[], float] = time.monotonic
    ready_seconds: float = READY_SECONDS
    stop_seconds: float = STOP_SECONDS


class RunningDoor:
    """A started door. `state` is what Control knows of it; `url` is where the agent reaches it."""

    def __init__(
        self,
        api: DockerApi,
        streams: AttachedStreams,
        state: DoorState,
        *,
        container: str,
        network: str | None,
        own: str,
        port: int,
        seams: DoorSeams,
    ) -> None:
        self._api = api
        self._streams = streams
        self.state = state
        self._container = container
        self._network = network
        self._own = own
        self._seams = seams
        self._stopping = threading.Event()
        self._closed = False
        self.url = f"http://{MODEL_DOOR_ADDRESS}:{port}"
        self._reader = threading.Thread(target=self._read, daemon=True)

    def begin(self) -> None:
        self._reader.start()

    def _read(self) -> None:
        """Whatever ends this thread says the door ended: a reader that died without it would leave
        the turn waiting on a door nobody reads (a line nested too deep for the parser is a
        `RecursionError`, not a `ValueError`)."""
        try:
            for raw in self._streams.lines():
                self._take(raw)
        except Exception:
            _log.warning("the model door's output could not be read to its end")
        finally:
            self.state.ended(self._how_it_ended())

    def _take(self, raw: bytes) -> None:
        try:
            line: Any = json.loads(raw)
        except (ValueError, RecursionError):
            return
        given = as_object(line)
        kind = None if given is None else given.get("t")
        if kind == MESSAGE_READY:
            self.state.ready()
        elif kind == MESSAGE_REFUSED:
            reason = given.get("reason") if given is not None else None
            self.state.refused(reason if isinstance(reason, str) else "unknown")
        elif kind == MESSAGE_STATUS:
            status = parse_status(line)
            if status is not None:
                self.state.update(status)

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

    def stop(self) -> None:
        """End the door: ask it to stop (it prints its final status), wait a little, then remove
        its container and the network, whatever it answered. Safe to call twice."""
        if self._closed:
            return
        self._closed = True
        self._stopping.set()
        with contextlib.suppress(OSError):
            self._streams.write(json.dumps({"op": OP_STOP}).encode() + b"\n")
        self._streams.close_write()
        self._reader.join(timeout=self._seams.stop_seconds)
        self._remove()
        self._streams.close()

    def _remove(self) -> None:
        _remove_quietly(self._api, self._container, self._network, self._own)


def _remove_quietly(api: DockerApi, container: str | None, network: str | None, own: str) -> None:
    """Remove the door's container, leave the network and remove it, each on its own: the VM is
    thrown away after the turn, so a step that fails costs nothing and stops nothing."""
    steps: list[Callable[[], None]] = []
    if container is not None:
        steps.append(lambda: api.remove_container(container))
    if network is not None:
        if own:
            steps.append(lambda: api.disconnect_network(network, own))
        steps.append(lambda: api.remove_network(network))
    for step in steps:
        try:
            step()
        except DockerError as error:
            _log.warning("the model door could not be cleaned up (%s)", error.status)


def start_door(
    *,
    model_access: Mapping[str, Any],
    capability: str,
    deadline_seconds: float,
    port: int,
    environment: Mapping[str, str],
    seams: DoorSeams = DoorSeams(),  # noqa: B008 - frozen, shared on purpose
) -> RunningDoor:
    """Make the network and the container, hand the door its start document and wait for `ready`.
    Raises `JobError` (`setup_failed`, free) for a door that cannot be started; whatever was made is
    removed first."""
    api = seams.api()
    network: str | None = None
    container: str | None = None
    streams: AttachedStreams | None = None
    own = ""
    try:
        me = api.inspect_container(seams.hostname())
        image, own = str(me.get("Image", "")), str(me.get("Id", ""))
        if not image or not own:
            raise _unavailable("the daemon does not know this container")
        network = api.create_network(network_document())
        api.connect_network(
            network,
            {
                "Container": own,
                "EndpointConfig": {"IPAMConfig": {"IPv4Address": MODEL_CONTROL_ADDRESS}},
            },
        )
        container = api.create_container(door_document(image), DOOR_CONTAINER_NAME)
        api.connect_network(
            network,
            {
                "Container": container,
                "EndpointConfig": {"IPAMConfig": {"IPv4Address": MODEL_DOOR_ADDRESS}},
            },
        )
        streams = api.attach(container)
        state = DoorState()
        running = RunningDoor(
            api, streams, state, container=container, network=network, own=own, port=port,
            seams=seams,
        )  # fmt: skip
        running.begin()
        api.start_container(container)
        _close_the_doors_network(api, image, container)
        document = start_document(
            model_access=model_access,
            capability=capability,
            deadline_seconds=deadline_seconds,
            port=port,
            environment=environment,
        )
        # A door that is already gone cannot be written to: the reader says how it ended.
        with contextlib.suppress(OSError):
            streams.write(document)
    except DockerError as error:
        _cleanup(api, container, network, own, streams)
        raise _unavailable(f"the daemon refused a step ({error.status})") from None
    except JobError:
        _cleanup(api, container, network, own, streams)
        raise
    except Exception:
        # Anything else (an answer the client cannot read is a `ValueError`) leaves the same
        # things behind and ends the same way: nothing is kept for a door that was not started.
        _cleanup(api, container, network, own, streams)
        raise _unavailable(
            "a step of the start failed in a way the daemon did not explain"
        ) from None
    except BaseException:
        _cleanup(api, container, network, own, streams)
        raise
    state.wait_ready(seams.ready_seconds)
    refusal = state.refusal
    if refusal is not None:
        running.stop()
        if refusal in (REFUSED_ACCESS_INVALID, REFUSED_CONFIG_INVALID):
            # The model entry or the policy of the job is one the door will not serve: the job's
            # settings, as they were when the proxy was in the Worker (free, nothing started).
            raise JobError(
                ErrorCode.IMPLEMENTER_CONFIG_INVALID,
                f"model_door_refused: the door cannot serve the job's model ({refusal})",
            )
        raise _unavailable(f"the door refused to start ({refusal})")
    end = state.end
    if end is not None:
        running.stop()
        raise _unavailable(
            "the door ended before it was ready"
            + ("" if end.exit_code is None else f" (exit code {end.exit_code})")
        )
    if not state.is_ready:
        running.stop()
        raise _unavailable("the door did not become ready in time")
    return running


def _close_the_doors_network(api: DockerApi, image: str, door: str) -> None:
    """Install the door's network rules before it is told anything. A door whose rules are not in
    place is not used: this raises, and the caller takes the door away with the key never sent."""
    helper = api.create_container(rules_document(image, door), RULES_CONTAINER_NAME)
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
    network: str | None,
    own: str,
    streams: AttachedStreams | None,
) -> None:
    if streams is not None:
        streams.close()
    _remove_quietly(api, container, network, own)
