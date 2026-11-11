# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control's `docker run` and the start of a job, for the local Dispatcher (#978).

The arguments are rendered by the TypeScript renderer the hosted launcher uses
(`dispatcher/src/launchers/local-control.ts`, `renderLocalControl`) and checked in as
`control-run.template.json` with four markers (`{jobId}`, `{image}`, `{timeoutSeconds}`,
`{agentMemoryMb}`); a test of the Dispatcher holds the file equal to what the renderer generates and
proves that filling it gives what the renderer renders, and the tests of this module feed the filled
arguments to the same golden file (`docker-run.local-control.golden.json`). So "the same flags as
hosted" is one renderer and a golden test, never a second implementation kept in step by hand.

The start is the one of `contracts/vm-init.v1.json`: the job document `{appUrl, jobId, credential}`
(vm-init writes it to Control's stdin and nowhere else), the VM's token, the image check, the
arguments and the work volume. The one local credential the job needs (the Claude Code login, the
allow-list of `LOCAL_CREDENTIAL_NAMES`) travels as `localCredential`. No credential, local one or
token may be in an argument."""

import json
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from typing import Any, Final

from code_reviewer_runner.job_loop.local_credential import (
    LOCAL_CREDENTIAL_NAMES,
    LOCAL_CREDENTIAL_VALUE,
    LocalCredential,
)

TEMPLATE_RESOURCE: Final = "control-run.template.json"
# The hosted size table: 2 GB of memory per vCPU (`SANDBOX_MEMORY_PER_VCPU_MB`).
MEMORY_MIB_PER_VCPU: Final = 2048
# The sizes that leave an Implementer's agent room to start (1 vCPU does not).
VCPU_SIZES: Final = (2, 4, 6, 8)
# `--stop-timeout` of Control's container: what its stop may take after the job's own timeout.
STOP_TIMEOUT_FLAG: Final = "--stop-timeout"


class ControlRunError(Exception):
    """The start of a job cannot be built. The message never holds a value of the job."""


@dataclass(frozen=True)
class ControlTemplate:
    arguments: tuple[str, ...]
    image_reference: str
    work_volume_name: str
    agent_memory_mb: Mapping[int, int]

    @property
    def stop_timeout_seconds(self) -> int:
        """The container's own stop timeout, read from the rendered flags (the host's wall clock
        adds it to the job's timeout)."""
        index = self.arguments.index(STOP_TIMEOUT_FLAG)
        return int(self.arguments[index + 1])

    def fill(self, *, job_id: str, image: str, timeout_seconds: int, vcpus: int) -> list[str]:
        """The arguments of one job: the markers replaced."""
        memory = self.agent_memory_mb.get(vcpus)
        if memory is None:
            raise ControlRunError("no such VM size")
        return [
            argument.replace("{jobId}", job_id)
            .replace("{image}", image)
            .replace("{timeoutSeconds}", str(timeout_seconds))
            .replace("{agentMemoryMb}", str(memory))
            for argument in self.arguments
        ]

    def volume_name(self, job_id: str) -> str:
        return self.work_volume_name.replace("{jobId}", job_id)


def load_template() -> ControlTemplate:
    text = (
        resources.files("code_reviewer_runner.factory_runner.firecracker")
        .joinpath(TEMPLATE_RESOURCE)
        .read_text(encoding="utf-8")
    )
    document = json.loads(text)
    return ControlTemplate(
        arguments=tuple(document["arguments"]),
        image_reference=document["imageReference"],
        work_volume_name=document["workVolumeName"],
        agent_memory_mb={int(size): int(mb) for size, mb in document["agentMemoryMb"].items()},
    )


def local_credential_document(local: LocalCredential | None) -> dict[str, str] | None:
    """The `localCredential` of the start for the credential a job needs from this device, or None.
    Only a name of the allow-list (`LOCAL_CREDENTIAL_NAMES`, which Control checks again) and a value
    of the shape of a token: anything else is a bug of the caller, never passed on."""
    if local is None:
        return None
    if local.name not in LOCAL_CREDENTIAL_NAMES:
        raise ControlRunError("that variable is not a credential a VM may be given")
    if not LOCAL_CREDENTIAL_VALUE.fullmatch(local.value):
        raise ControlRunError("the local credential is not one token")
    return {"name": local.name, "value": local.value}


def build_start(
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
    local: LocalCredential | None = None,
) -> dict[str, Any]:
    """The `StartRequest` of vm-init for a job."""
    arguments = template.fill(
        job_id=job_id, image=image_id, timeout_seconds=timeout_seconds, vcpus=vcpus
    )
    extra = local_credential_document(local)
    secrets = [credential, token] + ([extra["value"]] if extra else [])
    if any(secret in argument for argument in arguments for secret in secrets):
        raise ControlRunError("an argument would hold a credential")
    start: dict[str, Any] = {
        "version": 1,
        "type": "start",
        "job": {"appUrl": app_url, "jobId": job_id, "credential": credential},
        "controlToken": token,
        "image": {"reference": template.image_reference, "id": image_id},
        "control": {"args": arguments},
        "workVolume": {"name": template.volume_name(job_id), "reserveGib": reserve_gib},
    }
    if extra is not None:
        start["localCredential"] = extra
    return start
