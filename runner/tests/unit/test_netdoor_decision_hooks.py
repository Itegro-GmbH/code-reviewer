# SPDX-License-Identifier: LicenseRef-Proprietary

"""The two hooks the network door's decision gained for the outer wall (#979): an address the caller
excludes (the host's own) and the generation a decision carries. Both are off by default, so the
door inside a VM and the hosted door decide exactly as before; the tests of those are
`test_netdoor_proxy.py` and `test_network_rule.py`, which did not change."""

import pytest

from code_reviewer_runner.implementer.netdoor.addresses import (
    REASON_PRIVATE,
    Resolver,
    resolve_public,
)
from code_reviewer_runner.implementer.netdoor.connections import ConnectionLog
from code_reviewer_runner.implementer.netdoor.proxy import Decider, Decision, ProxyServer
from code_reviewer_runner.implementer.network_rule import MODE_OPEN, NetworkRule

pytestmark = pytest.mark.unit

PUBLIC = "93.184.216.34"
OTHER = "151.101.1.1"


def lookup(*addresses: str) -> Resolver:
    return lambda _name, _port: list(addresses)


def test_nothing_is_excluded_by_default() -> None:
    assert resolve_public("a.example.com", 443, lookup(PUBLIC, OTHER)).addresses == (PUBLIC, OTHER)


def test_an_excluded_address_makes_the_whole_name_refused() -> None:
    found = resolve_public(
        "a.example.com", 443, lookup(PUBLIC, OTHER), excluded=lambda address: address == OTHER
    )

    assert found.addresses == () and found.reason == REASON_PRIVATE


def test_the_exclusion_is_asked_about_addresses_that_are_public_only_once_each() -> None:
    asked: list[str] = []

    def excluded(address: str) -> bool:
        asked.append(address)
        return False

    resolve_public("a.example.com", 443, lookup(PUBLIC, OTHER), excluded=excluded)

    assert asked == [PUBLIC, OTHER]


def test_a_decider_passes_the_exclusion_to_the_check() -> None:
    decider = Decider(
        NetworkRule(MODE_OPEN),
        ConnectionLog(),
        resolver=lookup(PUBLIC),
        excluded=lambda address: address == PUBLIC,
    )

    assert decider.decide("a.example.com", 443).reason == REASON_PRIVATE


def test_a_decision_made_by_the_door_has_the_generation_zero_and_is_always_current() -> None:
    decision = Decider(NetworkRule(MODE_OPEN), ConnectionLog(), resolver=lookup(PUBLIC)).decide(
        "a.example.com", 443
    )

    assert decision.allowed and decision.generation == 0
    assert Decision(reason="x").generation == 0
    assert ProxyServer.is_current(None, decision)  # type: ignore[arg-type]
