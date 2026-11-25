# SPDX-License-Identifier: LicenseRef-Proprietary

"""What an instance of the Incus backend is made as (#1007), in one place so that the launcher's two
instances and the self-test's probe instance (`probe.py`, #1136) share one configuration (the same
image, limits and user namespace; the probe's instance has no NICs and no slot bridges, it needs no
network): a probe that was made with another configuration would prove nothing about a job."""

from .client import InstanceSpec
from .reaper import MARK, OWNER_MARK, ROLE_MARK, SLOT_MARK
from .settings import IncusSettings


def instance_spec(
    settings: IncusSettings, *, name: str, role: str, job: str, slot: int | None
) -> InstanceSpec:
    """Instance A (`role` "a", Control) or B ("b", setup and agent): unprivileged, nested, an
    isolated id range, the limits of the settings, the job mark and no profile."""
    a = role == "a"
    config = {
        "security.privileged": "false",
        "security.nesting": "true",
        "security.idmap.isolated": "true",
        "limits.cpu": str(settings.a_cpus if a else settings.vcpus),
        "limits.memory": f"{settings.a_memory_mib if a else settings.memory_mib}MiB",
        "limits.memory.swap": "false",
        "limits.processes": str(settings.processes),
        "boot.autostart": "false",
        # The guest API (`/dev/incus`, formerly devlxd: the host's API for an instance) is
        # nothing the launcher or the jobs use: not offered to the setup or the agent.
        "security.guestapi": "false",
        MARK: job,
        ROLE_MARK: role,
        OWNER_MARK: settings.owner,
    }
    if slot is not None:
        config[SLOT_MARK] = str(slot)
    return InstanceSpec(
        name=name,
        image=settings.image,
        pool=settings.pool,
        config=config,
        disk_gib=settings.a_disk_gib if a else settings.disk_gib,
    )
