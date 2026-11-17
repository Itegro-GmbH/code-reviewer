# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control starts the MCP door through the VM's Docker (#1067, epic #1049).

An agent step with MCP servers calls their tools through **one local endpoint per server** at a
container of its own on the model network, at a fixed address next to the model door and the network
door (`MCP_DOOR_ADDRESS`). The door forwards each call to the app with the job's credential
(`mcpdoor/relay.py`); the app adds the server's credential. The agent's harness has the endpoint and
nothing else (`mcp_config.py`).

The pattern is the other doors' (`door_launcher.py`, `netdoor_launcher.py`), and so are its walls:

* the container is made from constants (`door_document`): non-root, read-only root file system,
every
  capability dropped, `no-new-privileges`, a small memory and process limit, no mount, no published
  port, IPv6 off, and **no environment variable of its own**. A test of the definition fails when
  any
  of that is weakened;
* its egress is closed in its network namespace by a one-shot container with `NET_ADMIN` before it
is
  told anything (`door_launcher.egress_rules`: DNS, port 443 of public addresses, nothing private,
  nothing of the model network; with the host's outer-wall proxy, that proxy and nothing else). The
  app is the one known destination; the MCP servers are not dialled from here at all. A door whose
  rules did not go in is taken away and the credential never sent;
* **the job's credential is handed to the door's stdin** and to nothing else: not an argument, not
an
  environment variable, not a file, not a mount. `docker inspect` of the container shows none of it,
  its process list shows none, and the agent, which has no connection to the door but the endpoint's
  port, reaches none of its memory. Control's own copy stays in the job object it was parsed into
  (`Job.mcp_access`, hidden from `repr`) until the run ends; it is in no file, no argument and no
  environment, and the agent's container never gets it;
* at the end of the step Control asks the door to stop: it sends a `DELETE` for every MCP session
  still open, says how many it ended, and exits (`mcpdoor/service.py`).

The sandbox's network rule is **not changed**: the agent reaches the door (a member of the model
network, like the other two) and never an MCP host.

**On the Incus backend (#1068)** the door is the third door of instance A (`placement.py`): a
container of A's Docker on A's host network, bound to A's address on the inner bridge at its own
port (`MCP_DOOR_PORT_SPLIT`, 8082), which the inner wall opens for B next to the model and network
doors. The credential is handed to its stdin in A exactly as above, so it is held by a process in A,
outside B (the agent's instance), which has no connection to A but the three door ports: it is in no
environment, file, argument or process list of B, nor in B's Docker. The door reaches the app
through the host's outer proxy (`outerProxy` of the start document) like the other doors; there is
no model network and no table of the door's own, because A has no default route.

A door that cannot be started is not the turn's failure: the step runs without its MCP servers and
says so in a note (`ImplementerSession`). Nothing here is money or a key of the model.
"""

import contextlib
import json
import logging
import socket
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from code_reviewer_runner.dynamic_review.model_door_route import (
    MCP_DOOR_ADDRESS,
    MODEL_NETWORK_NAME,
)
from code_reviewer_runner.job import JobError, McpAccess
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.outer_proxy import OuterProxy
from code_reviewer_runner.result import ErrorCode

from .docker_api import AttachedStreams, DockerApi, DockerError
from .door_launcher import (
    BRIDGE_NETWORK,
    DOOR_TMPFS,
    DOOR_USER,
    HOST_NETWORK,
    READY_SECONDS,
    RULES_ENTRYPOINT,
    RULES_SECONDS,
    egress_rules,
)
from .door_state import DoorEnd
from .mcpdoor.protocol import MESSAGE_READY, MESSAGE_REFUSED, MESSAGE_STATUS, OP_STOP, VERSION
from .netdoor_launcher import _ensure_network  # pyright: ignore[reportPrivateUsage]
from .placement import HOSTED, Placement
from .role_labels import role_labels

_log = logging.getLogger(__name__)

MCPDOOR_CONTAINER_NAME: Final = "code-reviewer-mcp-door"
RULES_CONTAINER_NAME: Final = "code-reviewer-mcp-door-rules"
# A relay with a few threads: a call is a request body of at most 256 KiB and an answer of at most
# 4 MiB, 16 calls at a time at the most.
MCPDOOR_MEMORY_BYTES: Final = 192 * 1024 * 1024
MCPDOOR_PIDS_LIMIT: Final = 128
# The doors outlive the agent's processes under memory pressure (see the network door).
MCPDOOR_OOM_SCORE_ADJ: Final = -500
MCPDOOR_ENTRYPOINT: Final = [
    "/usr/bin/tini",
    "--",
    "/opt/venv/bin/python",
    "-m",
    "code_reviewer_runner.implementer.mcpdoor",
]
# The door sends a DELETE for each open session before it says its last word: each has 5 s, all of
# them 8 s (`relay.CLOSE_SECONDS`), and the exit.
STOP_SECONDS: Final = 12.0


def door_document(image: str, placement: Placement = HOSTED) -> dict[str, Any]:
    """The door's container. Constants and the image id the daemon gave: nothing from a job, and no
    environment variable, so that the credential, which goes to its stdin, is nowhere in it.

    On the Incus backend (#1068) the door is a container of **A's Docker** with A's host network,
    bound to A's address on the inner bridge only (`--bind`), as the model and network doors are: B
    reaches it through the one port the inner wall opens. A has no default route and its outer NIC
    leads to the host's proxy and nothing else, so there is no model network and no table of the
    door's own; the credential is in this process in A, never in B."""
    split = placement.split
    host_config: dict[str, Any] = {
        "NetworkMode": HOST_NETWORK if split else BRIDGE_NETWORK,
        "Privileged": False,
        "ReadonlyRootfs": True,
        "CapDrop": ["ALL"],
        "SecurityOpt": ["no-new-privileges:true"],
        "Memory": MCPDOOR_MEMORY_BYTES,
        "MemorySwap": MCPDOOR_MEMORY_BYTES,
        "PidsLimit": MCPDOOR_PIDS_LIMIT,
        "OomScoreAdj": MCPDOOR_OOM_SCORE_ADJ,
        "Tmpfs": {"/tmp": DOOR_TMPFS},
        "RestartPolicy": {"Name": "no"},
        "PublishAllPorts": False,
    }
    if not split:
        # The egress table is an `ip` table: it does not see IPv6, so the door has none. (Docker
        # refuses network sysctls on the host network.)
        host_config["Sysctls"] = {
            "net.ipv6.conf.all.disable_ipv6": "1",
            "net.ipv6.conf.default.disable_ipv6": "1",
        }
    return {
        "Image": image,
        "Entrypoint": MCPDOOR_ENTRYPOINT,
        "Cmd": ["--bind", f"{placement.mcp_door_address}:{placement.mcp_door_port}"]
        if split
        else [],
        "User": DOOR_USER,
        "Env": [],
        "Hostname": "mcp-door",
        "Labels": role_labels("mcp-door"),
        "OpenStdin": True,
        "StdinOnce": True,
        "AttachStdin": True,
        "AttachStdout": True,
        "AttachStderr": True,
        "Tty": False,
        "HostConfig": host_config,
    }


def rules_document(image: str, door: str, outer_proxy: OuterProxy | None = None) -> dict[str, Any]:
    """The one-shot container that installs the door's egress rules: it shares the door's network
    namespace and nothing else, holds `NET_ADMIN` and no other capability, and runs one command that
    is a constant (of the host's proxy address when there is one)."""
    return {
        "Image": image,
        "Entrypoint": RULES_ENTRYPOINT,
        "Cmd": [egress_rules(outer_proxy)],
        "User": "0:0",
        "Env": [],
        "Labels": role_labels("mcp-door-rules"),
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
    access: McpAccess,
    server_ids: Sequence[str],
    *,
    port: int,
    deadline_seconds: float,
    outer_proxy: OuterProxy | None = None,
) -> bytes:
    """The line written to the door's stdin (`mcpdoor/protocol.py`). **Holds the job
    credential.**"""
    document: dict[str, Any] = {
        "version": VERSION,
        "appUrl": access.app_url,
        "jobId": access.job_id,
        "credential": access.credential,
        "servers": list(server_ids),
        "listenPort": port,
        "deadlineSeconds": deadline_seconds,
    }
    if outer_proxy is not None:
        document["outerProxy"] = outer_proxy.to_json()
    return json.dumps(document, separators=(",", ":")).encode() + b"\n"


def _unavailable(reason: str) -> JobError:
    """A door that could not be started. The caller (`ImplementerSession`) does not end the turn
    for it: the step runs without MCP tools. The word is the reason; it never carries a value."""
    return JobError(ErrorCode.SETUP_FAILED, f"mcp_door_unavailable: {reason}")


@dataclass(frozen=True)
class McpDoorSeams:
    """What the tests replace; production leaves the defaults."""

    api: Callable[[], DockerApi] = DockerApi
    hostname: Callable[[], str] = socket.gethostname
    ready_seconds: float = READY_SECONDS
    stop_seconds: float = STOP_SECONDS
    # The host's outer-wall proxy (#994): the door's only way to the app on a customer's machine.
    outer_proxy: OuterProxy | None = None
    placement: Placement = HOSTED


@dataclass
class _State:
    ready: threading.Event = field(default_factory=threading.Event)
    refusal: str | None = None
    status: dict[str, Any] | None = None
    end: DoorEnd | None = None


class RunningMcpDoor:
    """A started door. `url` is where the agent reaches the endpoints (`<url>/mcp/<server id>`)."""

    def __init__(
        self,
        api: DockerApi,
        streams: AttachedStreams,
        *,
        container: str,
        seams: McpDoorSeams,
        network: str | None = None,
    ) -> None:
        self._api = api
        self._streams = streams
        self._container = container
        self._network = network
        self._seams = seams
        self._lock = threading.Lock()
        self._state = _State()
        self._stopping = threading.Event()
        self._closed = False
        self.url = seams.placement.mcp_door_url
        self._reader = threading.Thread(target=self._read, daemon=True)

    def begin(self) -> None:
        self._reader.start()

    def _read(self) -> None:
        try:
            for raw in self._streams.lines():
                self._take(raw)
        except Exception:
            _log.warning("the MCP door's output could not be read to its end")
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
        if given is None:
            return
        kind = given.get("t")
        if kind == MESSAGE_READY:
            self._state.ready.set()
        elif kind == MESSAGE_REFUSED:
            reason = given.get("reason")
            with self._lock:
                self._state.refusal = reason if isinstance(reason, str) else "unknown"
            self._state.ready.set()
        elif kind == MESSAGE_STATUS:
            counts = {
                name: value
                for name, value in given.items()
                if name in ("calls", "sessionsOpened", "sessionsClosed", "sessionsLeft")
                and isinstance(value, int)
                and not isinstance(value, bool)
            }
            with self._lock:
                self._state.status = {"final": given.get("final") is True, **counts}

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

    def final_status(self) -> dict[str, Any] | None:
        """The door's last word (`calls`, `sessionsOpened`, `sessionsClosed`, `sessionsLeft`), or
        None when it did not say one."""
        with self._lock:
            status = self._state.status
            return status if status is not None and status.get("final") is True else None

    def stop(self) -> dict[str, Any] | None:
        """End the door: ask it to stop (it ends the open MCP sessions and says how many), wait for
        that, then remove its container. Returns its last word. Safe to call twice."""
        if not self._closed:
            self._closed = True
            self._stopping.set()
            with contextlib.suppress(OSError):
                self._streams.write(json.dumps({"op": OP_STOP}).encode() + b"\n")
            self._streams.close_write()
            self._reader.join(timeout=self._seams.stop_seconds)
            _remove_quietly(self._api, self._container, self._network)
            self._streams.close()
        return self.final_status()


def _remove_quietly(api: DockerApi, container: str | None, network: str | None = None) -> None:
    steps: list[Callable[[], None]] = []
    if container is not None:
        steps.append(lambda: api.remove_container(container))
    if network is not None:
        steps.append(lambda: api.remove_network(network))
    for step in steps:
        try:
            step()
        except DockerError as error:
            _log.warning("the MCP door could not be cleaned up (%s)", error.status)


def start_mcp_door(
    access: McpAccess,
    server_ids: Sequence[str],
    *,
    deadline_seconds: float,
    seams: McpDoorSeams = McpDoorSeams(),  # noqa: B008 - frozen, shared on purpose
) -> RunningMcpDoor:
    """Make the container on the model network, install its egress rules, hand it the start document
    (the job credential) and wait for `ready`. Raises `JobError` (`setup_failed`) for a door that
    cannot be started; whatever was made is removed first and the credential was never sent."""
    if not seams.placement.mcp_supported:
        raise _unavailable("this runner's placement has no MCP door")
    api = seams.api()
    container: str | None = None
    network: str | None = None
    streams: AttachedStreams | None = None
    try:
        me = api.inspect_container(seams.hostname())
        image = str(me.get("Image", ""))
        if not image or not me.get("Id"):
            raise _unavailable("the daemon does not know this container")
        split = seams.placement.split
        if not split:
            network = _ensure_network(api)
        container = api.create_container(
            door_document(image, seams.placement), MCPDOOR_CONTAINER_NAME
        )
        if not split:
            api.connect_network(
                MODEL_NETWORK_NAME,
                {
                    "Container": container,
                    "EndpointConfig": {"IPAMConfig": {"IPv4Address": MCP_DOOR_ADDRESS}},
                },
            )
        streams = api.attach(container)
        running = RunningMcpDoor(api, streams, container=container, seams=seams, network=network)
        running.begin()
        api.start_container(container)
        if not split:
            _close_the_doors_network(api, image, container, seams.outer_proxy)
        # A door that is already gone cannot be written to: the reader says how it ended.
        with contextlib.suppress(OSError):
            streams.write(
                start_document(
                    access,
                    server_ids,
                    port=seams.placement.mcp_door_port,
                    deadline_seconds=deadline_seconds,
                    outer_proxy=seams.outer_proxy,
                )
            )
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
    api: DockerApi, image: str, door: str, outer_proxy: OuterProxy | None = None
) -> None:
    """Install the door's egress rules before it is told anything. A door whose rules are not in
    place is not used: this raises, and the caller takes the door away with the credential never
    sent."""
    helper = api.create_container(rules_document(image, door, outer_proxy), RULES_CONTAINER_NAME)
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
