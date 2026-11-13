# SPDX-License-Identifier: LicenseRef-Proprietary

"""Where Control's containers live (#1017, Runner v2 on Incus).

Hosted, and on every VM of the Firecracker backend, Control, the two doors, the readers and the
setup/agent container all run in **one** Docker (the VM's). On the Incus backend a job has two
instances (`factory_runner/incus/`): **A** (Control, the doors, the inner wall) and **B** (the setup
and then the agent, the same environment). The placement says which Docker each of them is made in.

* **Control and the two doors: A's Docker.** The doors run with the host network of A, bound to A's
  address on the inner bridge (ports `MODEL_DOOR_PORT` and `NETWORK_DOOR_PORT_SPLIT`): the inner
  wall's input chain matches traffic delivered to A itself.
* **The setup/agent container and the readers: B's Docker.** Control reaches it through a unix
  socket (`docker_socket`) that the launcher makes in A from B's own with two `proxy` devices: A
  dials B, and B has no connection of any kind to A but the two door ports. The runtime is `runc`
  and the container privileged (it runs its own Docker): there is no Sysbox in an Incus instance,
  and what confines it is B's user namespace, B's cgroup and the inner wall. The readers run from
  the agent's golden image (the Worker image is in A).
* **The work volume.** The mirror and Control's checkout stay in A's volume. B has a volume of its
  own (`B_WORK_VOLUME`) with the agent's repository and the result directory, made by an explicit
  copy (`ReaderAccess._seed`: a tar of the checkout, once, before the agent exists). The way back
  is the fetch at the end, `git upload-pack` in a reader whose objects Control's git checks.

Everything B's daemon says is **data from the untrusted side**: Control parses it with bounds and
puts none of it in a request to A's Docker. Nothing of A (a secret, the token, A's Docker, the
control endpoint) is reachable from B: the doors' two ports are all that the inner wall lets
through.

`RUNNER_ENVIRONMENT_DOCKER=split` and its two companions are set by the launcher in Control's own
`docker run` (`factory_runner/incus/control_run.py`), never by a job. Unset, everything is as
hosted."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_DOOR_ADDRESS,
    MODEL_NETWORK_GATEWAY,
    MODEL_NETWORK_NAME,
    MODEL_NETWORK_SUBNET,
    NETWORK_DOOR_ADDRESS,
    NETWORK_DOOR_PORT,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode

from .docker_api import DockerApi
from .role_labels import role_labels

PLACEMENT_VARIABLE: Final = "RUNNER_ENVIRONMENT_DOCKER"
SOCKET_VARIABLE: Final = "RUNNER_ENVIRONMENT_DOCKER_SOCKET"
DOOR_ADDRESS_VARIABLE: Final = "RUNNER_ENVIRONMENT_DOOR_ADDRESS"
PLACEMENT_NAMES: Final[tuple[str, ...]] = (
    PLACEMENT_VARIABLE,
    SOCKET_VARIABLE,
    DOOR_ADDRESS_VARIABLE,
)
SPLIT: Final = "split"
# Where Control finds B's Docker: a socket the launcher's proxy device makes in A (not under `/run`,
# which A's init hides under a tmpfs) and bind-mounts into Control's container.
B_DOCKER_SOCKET: Final = "/b-docker.sock"
# The ports the inner wall lets B reach on A: the model door and the network door.
MODEL_DOOR_PORT: Final = 8080
NETWORK_DOOR_PORT_SPLIT: Final = 8081
# What the runtime of the setup, the agent and the readers is in B: there is no Sysbox in an Incus
# instance.
SPLIT_RUNTIME: Final = "runc"
# The name of B's work volume: the agent's repository (`repo`) and the result directory (`result`).
B_WORK_VOLUME: Final = "code-reviewer-work"


@dataclass(frozen=True)
class Placement:
    """Which Docker holds what. The default is hosted."""

    split: bool = False
    docker_socket: str = B_DOCKER_SOCKET
    # A's address on the inner bridge: where the doors listen and B reaches them (split only).
    door_address: str = ""

    @property
    def model_door_address(self) -> str:
        return self.door_address if self.split else MODEL_DOOR_ADDRESS

    @property
    def network_door_address(self) -> str:
        return self.door_address if self.split else NETWORK_DOOR_ADDRESS

    @property
    def network_door_port(self) -> int:
        return NETWORK_DOOR_PORT_SPLIT if self.split else NETWORK_DOOR_PORT

    def model_door_port(self, default: int) -> int:
        """The model door's port: `default` (the slot's) hosted, the wall's own on Incus."""
        return MODEL_DOOR_PORT if self.split else default

    @property
    def network_door_url(self) -> str:
        return f"http://{self.network_door_address}:{self.network_door_port}"

    @property
    def no_proxy(self) -> str:
        """The names the agent's tools do not send to the network door."""
        return ",".join(
            ("localhost", "127.0.0.1", "::1", self.model_door_address, self.network_door_address)
        )

    def environment_api(self) -> DockerApi:
        """The Docker of the setup/agent container and the readers: B's when split, else the VM's
        (the default socket). B's is reached through two `proxy` devices, which end a connection
        that is half-closed: see `DockerApi.half_close`."""
        return DockerApi(self.docker_socket, half_close=False) if self.split else DockerApi()


HOSTED: Final = Placement()


def placement_of(environment: Mapping[str, str]) -> Placement:
    """The placement the launcher told this job process. A value that is not `split` or an address
    that is missing ends the turn `setup_failed`, free, before anything is started."""
    mode = environment.get(PLACEMENT_VARIABLE, "").strip()
    if not mode:
        return HOSTED
    if mode != SPLIT:
        raise JobError(
            ErrorCode.SETUP_FAILED, f"placement_invalid: {PLACEMENT_VARIABLE} must be {SPLIT}"
        )
    address = environment.get(DOOR_ADDRESS_VARIABLE, "").strip()
    if not _is_ipv4(address):
        raise JobError(
            ErrorCode.SETUP_FAILED,
            f"placement_invalid: {DOOR_ADDRESS_VARIABLE} must be an IPv4 address",
        )
    socket_path = environment.get(SOCKET_VARIABLE, "").strip() or B_DOCKER_SOCKET
    if not socket_path.startswith("/"):
        raise JobError(
            ErrorCode.SETUP_FAILED, f"placement_invalid: {SOCKET_VARIABLE} must be an absolute path"
        )
    return Placement(split=True, docker_socket=socket_path, door_address=address)


def _is_ipv4(text: str) -> bool:
    parts = text.split(".")
    return len(parts) == 4 and all(
        part.isascii() and part.isdigit() and part == str(int(part)) and int(part) < 256
        for part in parts
    )


def split_model_network_document() -> dict[str, Any]:
    """The model network in B's Docker: the same name and range as hosted (the agent's address is
    fixed in its definition), but an ordinary bridge. Hosted it is `--internal` with an isolated
    gateway because the door and the agent are its only members; here the doors are in instance A
    and the agent reaches them through B's NIC, so the bridge must route (and masquerade). What
    keeps the agent from anything else is the inner wall in A, and the unplugged outer NIC."""
    return {
        "Name": MODEL_NETWORK_NAME,
        "Driver": "bridge",
        "Internal": False,
        "Attachable": False,
        "EnableIPv6": False,
        "IPAM": {
            "Driver": "default",
            "Config": [{"Subnet": MODEL_NETWORK_SUBNET, "Gateway": MODEL_NETWORK_GATEWAY}],
        },
        "Labels": role_labels("model-network"),
    }
