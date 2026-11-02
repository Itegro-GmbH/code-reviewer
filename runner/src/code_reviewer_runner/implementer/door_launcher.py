# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control starts the model door through the VM's Docker (#745, step 3).

The Worker container of an Implementer turn is the Control container: it keeps the git token and the
push and supervises. It does not keep the model key beyond handing it over. This module is how it
hands it over:

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
        for raw in self._streams.lines():
            try:
                line: Any = json.loads(raw)
            except ValueError:
                continue
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
        self.state.ended(self._how_it_ended())

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
        streams.write(
            start_document(
                model_access=model_access,
                capability=capability,
                deadline_seconds=deadline_seconds,
                port=port,
                environment=environment,
            )
        )
    except DockerError as error:
        _cleanup(api, container, network, own, streams)
        raise _unavailable(f"the daemon refused a step ({error.status})") from None
    except JobError:
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
