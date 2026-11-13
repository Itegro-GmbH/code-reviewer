# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control's `docker run` and the document on its stdin, for an Incus instance (#1007).

The arguments are the Firecracker backend's, rendered by the same TypeScript renderer
(`dispatcher/src/launchers/local-control.ts`, `control-run.template.json`), with **three** changes
that the unix transport of the environment control needs, made here and held by a test (the test
fails when the renderer's output no longer has the shape this expects):

* `RUNNER_ENVIRONMENT_CONTROL=vsock` becomes `unix`;
* the seccomp profile that allows AF_VSOCK goes (a unix socket needs no profile: Docker's default
  one stays);
* the socket the launcher's `proxy` device makes in A (`/ctl.sock`) is bind-mounted at the same
path.

and, since #1017, **three more** that tell Control that the setup and the agent live in **B's**
Docker (`implementer/placement.py`): the socket the launcher makes in A from B's own
(`/b-docker.sock`, one more `proxy` device, A dials B and B has no connection to A) is bind-mounted
at the same path, and `RUNNER_ENVIRONMENT_DOCKER=split`, `RUNNER_ENVIRONMENT_DOCKER_SOCKET`
and `RUNNER_ENVIRONMENT_DOOR_ADDRESS` (A's address on the inner bridge: where the doors listen and B
reaches them) are set. The Docker socket of A that the renderer mounts stays: the doors and
Control's own image are A's.

The stdin document is the one vm-init wrote (`StartRequest.stdin_document`): the job, the host's
token, the one local credential if the job needs it, the outer proxy. It is made by the parser of
vm-init itself, so a start the guest would have refused is refused here, before an instance exists,
and no credential is ever in an argument.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from code_reviewer_runner.factory_runner.firecracker.control_run import (
    ControlRunError,
    ControlTemplate,
    build_start,
)
from code_reviewer_runner.implementer.environment_control import (
    ENVIRONMENT_CONTROL_VARIABLE,
    TRANSPORT_UNIX,
    TRANSPORT_VSOCK,
    UNIX_SOCKET_PATH,
)
from code_reviewer_runner.implementer.placement import (
    B_DOCKER_SOCKET,
    DOOR_ADDRESS_VARIABLE,
    PLACEMENT_VARIABLE,
    SOCKET_VARIABLE,
    SPLIT,
)
from code_reviewer_runner.job_loop.local_credential import LocalCredential
from code_reviewer_runner.vm_init.wire import InvalidStart, parse_start

__all__ = ["ControlLaunch", "ControlRunError", "build_control", "unix_arguments"]

_SECCOMP_PREFIX: Final = "seccomp=/"
_DOCKER_SOCKET_TARGET: Final = "target=/run/docker.sock"


@dataclass(frozen=True)
class ControlLaunch:
    """What the launcher runs in instance A: `docker <arguments>` with `stdin` and nothing else."""

    arguments: tuple[str, ...]
    stdin: bytes = field(repr=False)
    volume_name: str
    image_reference: str


def unix_arguments(arguments: Sequence[str], *, door_address: str) -> list[str]:
    """The Firecracker backend's arguments for the unix transport and the split Docker of the
    Incus backend. `door_address` is A's address on the inner bridge. Raises `ControlRunError` when
    they do not have the shape the changes expect."""
    changed: list[str] = []
    seccomp = False
    vsock = False
    mounted = False
    placed = False
    items = list(arguments)
    index = 0
    while index < len(items):
        argument = items[index]
        if argument == "--env" and not placed:
            changed += [
                "--env",
                f"{PLACEMENT_VARIABLE}={SPLIT}",
                "--env",
                f"{SOCKET_VARIABLE}={B_DOCKER_SOCKET}",
                "--env",
                f"{DOOR_ADDRESS_VARIABLE}={door_address}",
            ]
            placed = True
        if (
            argument == "--security-opt"
            and index + 1 < len(items)
            and items[index + 1].startswith(_SECCOMP_PREFIX)
        ):
            seccomp = True
            index += 2
            continue
        if argument == f"{ENVIRONMENT_CONTROL_VARIABLE}={TRANSPORT_VSOCK}":
            changed.append(f"{ENVIRONMENT_CONTROL_VARIABLE}={TRANSPORT_UNIX}")
            vsock = True
            index += 1
            continue
        changed.append(argument)
        if (
            argument.startswith("type=bind,")
            and _DOCKER_SOCKET_TARGET in argument
            and changed[-2:-1] == ["--mount"]
        ):
            changed += [
                "--mount",
                f"type=bind,source={UNIX_SOCKET_PATH},target={UNIX_SOCKET_PATH}",
                "--mount",
                f"type=bind,source={B_DOCKER_SOCKET},target={B_DOCKER_SOCKET}",
            ]
            mounted = True
        index += 1
    if not (seccomp and vsock and mounted and placed):
        raise ControlRunError("the rendered Control arguments do not have the expected shape")
    return changed


def build_control(
    template: ControlTemplate,
    *,
    app_url: str,
    job_id: str,
    credential: str,
    token: str,
    image_id: str,
    timeout_seconds: int,
    vcpus: int,
    reserve_gib: int,
    door_address: str,
    local: LocalCredential | None = None,
    outer_proxy: Mapping[str, Any] | None = None,
) -> ControlLaunch:
    """Control's launch for a job. Raises `ControlRunError` for anything the start would refuse."""
    document = build_start(
        template,
        app_url=app_url,
        job_id=job_id,
        credential=credential,
        token=token,
        image_id=image_id,
        timeout_seconds=timeout_seconds,
        vcpus=vcpus,
        reserve_gib=reserve_gib,
        local=local,
        outer_proxy=outer_proxy,
    )
    try:
        request = parse_start(document)
    except InvalidStart as error:
        raise ControlRunError(str(error)) from None
    return ControlLaunch(
        arguments=tuple(unix_arguments(request.args, door_address=door_address)),
        stdin=request.stdin_document(),
        volume_name=request.volume_name,
        image_reference=request.image.reference,
    )
