# SPDX-License-Identifier: LicenseRef-Proprietary

"""Fixtures of the Incus lane (#1007): a real Incus, the launcher's own objects made for the lane
and removed after it. The lane runs only with `-m incus` and the variables of `incus_lane.py`."""

import asyncio
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from incus_lane import (
    IMAGE_ID,
    Machine,
    StandInClient,
    have_nft_to_push,
    incus_available,
    load_machine,
)

from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode
from code_reviewer_runner.factory_runner.incus.provision import ensure_objects, remove_objects
from code_reviewer_runner.factory_runner.incus.settings import IncusSettings
from code_reviewer_runner.factory_runner.incus.slots import parse_slot_network


@pytest.fixture(scope="session")
def machine() -> Machine:
    found = load_machine()
    if found is None:
        pytest.skip("CR_INCUS_LANE_POOL, _IMAGE and _STATE are not set")
    if not incus_available():
        pytest.skip("`incus` does not answer for this user (the group incus-admin?)")
    if not have_nft_to_push():
        pytest.skip("the host's nft and its libraries are not where the lane copies them from")
    return found


@pytest.fixture(scope="session")
def settings(machine: Machine) -> IncusSettings:
    machine.state.mkdir(parents=True, exist_ok=True)
    return IncusSettings(
        pool=machine.pool,
        image=machine.image,
        image_id=IMAGE_ID,
        prefix=machine.prefix,
        state_dir=machine.state,
        slots=2,
        slot_network=parse_slot_network(machine.network, 2),
        vcpus=2,
        memory_mib_override=2048,
        a_memory_mib=2048,
        disk_gib=3,
        a_disk_gib=3,
        outer_wall=OuterWallMode.PROXY,
        ready_seconds=90.0,
        job_timeout_seconds=300,
        call_seconds=120.0,
    )


@pytest.fixture(scope="session")
def client(settings: IncusSettings) -> Iterator[StandInClient]:
    """The lane's client, with the bridges and ACLs of its slots made for the session and removed
    after it (only the lane's own prefix)."""
    incus = StandInClient(call_seconds=settings.call_seconds)
    asyncio.run(ensure_objects(incus, settings))
    try:
        yield incus
    finally:
        asyncio.run(remove_objects(incus, settings))
