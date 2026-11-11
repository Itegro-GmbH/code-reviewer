# SPDX-License-Identifier: LicenseRef-Proprietary

"""The slots' network is a setting of the machine, chosen by the installer (#982, fix round): the
launcher, the proxy and the settings read it, and no address of 172.31.0.0/16 is built in."""

import ipaddress
from pathlib import Path

import pytest

from code_reviewer_runner.factory_runner.firecracker import vmm
from code_reviewer_runner.factory_runner.firecracker.outer_wall import (
    OuterWallMode,
    outer_wall_for,
)
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import ProxyOuterWall
from code_reviewer_runner.factory_runner.firecracker.settings import (
    FirecrackerSettings,
    SettingsError,
    settings_from_environment,
)
from code_reviewer_runner.factory_runner.firecracker.slots import (
    MAX_SLOTS,
    Slot,
    SlotPool,
    parse_slot_network,
)
from code_reviewer_runner.outer_proxy import OuterProxy

pytestmark = pytest.mark.unit

NETWORK = ipaddress.IPv4Network("10.250.0.0/24")
IMAGE_ID = "sha256:" + "ab" * 32


# #982-T40
def test_a_slot_owns_a_slash_thirty_of_the_network_it_is_given() -> None:
    first, last = Slot(0, NETWORK), Slot(MAX_SLOTS - 1, NETWORK)

    assert (first.host_address, first.guest_address) == ("10.250.0.1", "10.250.0.2")
    assert (last.host_address, last.guest_address) == ("10.250.0.253", "10.250.0.254")
    assert Slot(1, NETWORK).guest_mac == "06:00:0a:fa:00:06"


# #982-T40
def test_the_pool_hands_out_slots_of_its_network_and_refuses_a_network_too_small() -> None:
    pool = SlotPool(3, NETWORK)

    assert [pool.acquire().host_address for _ in range(3)] == [  # type: ignore[union-attr]
        "10.250.0.1",
        "10.250.0.5",
        "10.250.0.9",
    ]
    with pytest.raises(ValueError, match="too small"):
        SlotPool(3, ipaddress.IPv4Network("10.250.0.0/29"))


# #982-T40
def test_the_kernel_command_line_carries_the_address_of_the_chosen_network() -> None:
    settings = FirecrackerSettings(Path("k"), Path("r"), Path("d"), IMAGE_ID, slot_network=NETWORK)

    line = vmm.kernel_command_line(settings, Slot(2, NETWORK))

    assert " vm.ip=10.250.0.10/30 vm.gw=10.250.0.9 " in line
    assert "172.31" not in line


# #982-T40
def test_the_settings_read_the_network_from_the_environment_and_default_to_the_lanes_one() -> None:
    chosen = settings_from_environment(
        {"FACTORY_RUNNER_VM_IMAGE_ID": IMAGE_ID, "FACTORY_RUNNER_SLOT_NETWORK": "10.250.0.0/24"},
        parallel_runs=4,
    )
    default = settings_from_environment({"FACTORY_RUNNER_VM_IMAGE_ID": IMAGE_ID}, parallel_runs=4)

    assert chosen.slot_network == NETWORK
    assert default.slot_network == ipaddress.IPv4Network("172.31.0.0/16")


# #982-T40
@pytest.mark.parametrize(
    "value",
    ["8.8.8.0/24", "10.250.0.1/24", "10.250.0.0/33", "fd00::/64", "not a network", "100.64.0.0/24"],
)
def test_a_network_that_is_not_a_private_network_is_refused_naming_the_setting(value: str) -> None:
    with pytest.raises(SettingsError, match="FACTORY_RUNNER_SLOT_NETWORK"):
        settings_from_environment(
            {"FACTORY_RUNNER_VM_IMAGE_ID": IMAGE_ID, "FACTORY_RUNNER_SLOT_NETWORK": value},
            parallel_runs=1,
        )


# #982-T40
def test_a_network_without_room_for_the_slots_is_refused() -> None:
    with pytest.raises(SettingsError, match="room for 5 slots"):
        settings_from_environment(
            {
                "FACTORY_RUNNER_VM_IMAGE_ID": IMAGE_ID,
                "FACTORY_RUNNER_SLOT_NETWORK": "10.250.0.0/28",
            },
            parallel_runs=5,
        )
    assert parse_slot_network("10.250.0.0/28", 4).num_addresses == 16


# #982-T40
def test_the_proxy_listens_on_the_addresses_of_the_chosen_network() -> None:
    wall = outer_wall_for(OuterWallMode.PROXY, 2, NETWORK)

    assert isinstance(wall, ProxyOuterWall)
    assert wall.addresses_of(Slot(1, NETWORK)).host == "10.250.0.5"
    assert wall.addresses_of(Slot(1, NETWORK)).guest == "10.250.0.6"
    assert OuterProxy("10.250.0.5", 3128).url == "http://10.250.0.5:3128"
