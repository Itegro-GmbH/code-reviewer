# SPDX-License-Identifier: LicenseRef-Proprietary

"""The static nft table of the outer wall (#979) as a file: what it says is held to what the proxy
and the slots say, and to the page of docs/runner.md that prints it. nft is not here: the KVM lane
checks the file with `nft -c -f` and loads it (the syntax and the behaviour are the lane's); these
tests keep the file and the code that depends on it from drifting apart, and keep it to its own
table, our TAP devices and nothing else."""

import re
from pathlib import Path

import pytest

from code_reviewer_runner.factory_runner.firecracker.proxy_wall import PROXY_PORT
from code_reviewer_runner.factory_runner.firecracker.slots import (
    MAX_SLOTS,
    NETWORK_PREFIX,
    TAP_PREFIX,
    Slot,
)

pytestmark = pytest.mark.unit

REPOSITORY = Path(__file__).resolve().parents[3]
TABLE = REPOSITORY / "docker" / "vm" / "host" / "outer-wall.nft"
TEXT = TABLE.read_text(encoding="utf-8")
RULES = [
    line.strip() for line in TEXT.splitlines() if line.strip() and not line.strip().startswith("#")
]
TAPS = f'"{TAP_PREFIX}*"'
NETWORK = f"{NETWORK_PREFIX}.0.0/16"


def chain(name: str) -> list[str]:
    """The rules of one chain in order: the lines between its `chain` line and its closing brace."""
    lines = TEXT.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == f"chain {name} {{")
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line.strip() == "}":
            break
        if line.strip() and not line.strip().startswith("#"):
            body.append(line.strip())
    return body


def rules_of(name: str) -> list[str]:
    return [line for line in chain(name) if not line.startswith("type ")]


# #979
def test_the_file_is_one_table_of_its_own_that_can_be_loaded_again_and_again() -> None:
    # Declared, deleted, declared with its content: `nft -f` replaces what an earlier load made and
    # works the first time too.
    assert RULES[:3] == [
        "table inet code_reviewer_wall",
        "delete table inet code_reviewer_wall",
        "table inet code_reviewer_wall {",
    ]
    assert [line for line in RULES if line.startswith(("table ", "delete table "))] == [
        "table inet code_reviewer_wall",
        "delete table inet code_reviewer_wall",
        "table inet code_reviewer_wall {",
    ]
    assert "flush ruleset" not in TEXT


# #979
def test_it_never_names_dockers_tables_or_any_other_tool_of_the_host() -> None:
    lowered = "\n".join(RULES).lower()
    for word in ("docker", "iptables", "ip filter", "ip nat", "masquerade", "dnat", "snat"):
        assert word not in lowered, word


# #979
def test_every_rule_is_about_our_tap_devices_and_nothing_else_of_the_host() -> None:
    for name in ("input", "forward", "output"):
        rules = rules_of(name)
        assert rules, name
        assert all(line.startswith((f"iifname {TAPS}", f"oifname {TAPS}")) for line in rules), (
            f"a rule of {name} is not scoped to the TAP devices: {rules}"
        )
    # The chains accept what is not ours: nothing of the host's own traffic is touched.
    assert all("policy accept;" in " ".join(chain(name)) for name in ("input", "forward", "output"))


# #979
def test_the_pattern_of_the_taps_is_the_one_the_launcher_names() -> None:
    assert Slot(0).tap.startswith(TAP_PREFIX)
    assert Slot(MAX_SLOTS - 1).tap.startswith(TAP_PREFIX)
    assert f"iifname {TAPS}" in TEXT


# #979
def test_the_one_thing_a_vm_may_open_is_a_connection_to_the_proxy_on_a_slots_address() -> None:
    accepted = [line for line in rules_of("input") if " accept " in f"{line} "]

    assert len(accepted) == 2
    answers, proxy = accepted
    assert "ct state established,related" in answers
    assert f"tcp dport {PROXY_PORT}" in proxy
    assert f"ip daddr {NETWORK}" in proxy and "fib daddr type local" in proxy
    # Not UDP, not ICMP, not another port, anywhere.
    assert not re.search(r"\b(udp|icmp|icmpv6)\b", " ".join(rules_of("input")))
    assert str(PROXY_PORT) == re.findall(r"dport (\d+)", TEXT)[0]
    assert set(re.findall(r"dport (\d+)", TEXT)) == {str(PROXY_PORT)}


# #979
def test_the_source_of_a_vm_is_a_slot_address_and_ipv6_is_dropped_before_anything() -> None:
    rules = rules_of("input")

    assert rules[0].startswith(f"iifname {TAPS} meta nfproto ipv6") and " drop " in f"{rules[0]} "
    assert f"ip saddr != {NETWORK}" in rules[1] and " drop " in f"{rules[1]} "
    assert f"{NETWORK_PREFIX}.0.0/16" == NETWORK


# #979
def test_everything_else_addressed_to_the_host_or_forwarded_is_dropped() -> None:
    assert rules_of("input")[-1].startswith(f"iifname {TAPS} counter drop")
    assert rules_of("forward") == [line for line in rules_of("forward") if " drop" in line], (
        "a VM forwards to nothing and nothing forwards to a VM"
    )
    assert any(line.startswith(f"iifname {TAPS}") for line in rules_of("forward"))
    assert any(line.startswith(f"oifname {TAPS}") for line in rules_of("forward"))
    # The host opens no connection to a VM (vsock is the channel): only answers go out.
    output = rules_of("output")
    assert " accept " in f"{output[0]} " and "ct state established,related" in output[0]
    assert output[-1].startswith(f"oifname {TAPS} counter drop")


# #979
def test_the_chains_run_before_dockers_and_say_so() -> None:
    for name in ("input", "forward", "output"):
        assert any("priority -150;" in line for line in chain(name)), name


# #979
def test_docs_print_the_file_in_full() -> None:
    docs = (REPOSITORY / "docs" / "runner.md").read_text(encoding="utf-8")
    # The page prints the file as it is, comment lines included: a change to one without the other
    # fails here.
    assert TEXT.strip() in docs
