# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a crashed or restarted service left behind (#1007): instances of earlier jobs.

A service that ends cleanly leaves nothing (both instances are deleted when a job ends). One that is
killed, or whose machine loses power, leaves running instances (`boot.autostart` is off, so a reboot
does not bring them back, but a service crash does not stop them). At every start of the service,
before the first claim, this deletes them. **The mark is the identity**: an instance is ours when it
carries the config key `user.cr.job`, its `user.cr.owner` is this dispatcher's owner id **and** its
name is `<prefix>-<owner>-a-...` or `<prefix>-<owner>-b-...`. An instance of the machine's owner,
of another prefix or of another dispatcher on the same daemon (another user or state directory:
another owner) is never touched."""

import logging
import re
from dataclasses import dataclass

from .client import IncusClient, IncusError, InstanceInfo

_log = logging.getLogger(__name__)

MARK: str = "user.cr.job"
SLOT_MARK: str = "user.cr.slot"
ROLE_MARK: str = "user.cr.role"
OWNER_MARK: str = "user.cr.owner"


@dataclass(frozen=True)
class Reaped:
    """What was removed, for the log and the tests."""

    instances: tuple[str, ...] = ()
    failed: tuple[str, ...] = ()


def is_ours(instance: InstanceInfo, prefix: str, owner: str) -> bool:
    return (
        MARK in instance.config
        and instance.config.get(OWNER_MARK) == owner
        and re.fullmatch(rf"{re.escape(prefix)}-{re.escape(owner)}-[ab]-[0-9a-z-]+", instance.name)
        is not None
    )


async def reap_leftovers(client: IncusClient, prefix: str, owner: str) -> Reaped:
    removed: list[str] = []
    failed: list[str] = []
    for instance in await client.list_instances():
        if not is_ours(instance, prefix, owner):
            continue
        try:
            await client.delete(instance.name)
        except IncusError as error:
            _log.error("an instance of an earlier service could not be deleted (%s)", error.detail)
            failed.append(instance.name)
            continue
        removed.append(instance.name)
    if removed:
        _log.warning("%d instance(s) of an earlier service were deleted", len(removed))
    return Reaped(tuple(removed), tuple(failed))
