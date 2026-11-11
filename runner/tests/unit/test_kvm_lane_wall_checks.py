# SPDX-License-Identifier: LicenseRef-Proprietary

"""The two checks the KVM lane makes around the nft tables (#999; the review of #994): the three
rulesets that the guest loads (the model door's, the network door's, the Setup bridge's, with the
proxy) are rendered as files for `nft -c -f`, and the drop counters of the outer wall's table are
compared before and after a job, so that a client that went round the proxy shows up. The lane runs
`nft`; here the programs that feed and read it run against the table's own text and an `nft -j`
document of the shape the tool prints."""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.implementer import door_launcher, netdoor_launcher, setup_container
from code_reviewer_runner.outer_proxy import OuterProxy

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kvm"))
import render_rulesets
import wall_counters

pytestmark = pytest.mark.unit

TABLE = Path(__file__).resolve().parents[3] / "docker" / "vm" / "host" / "outer-wall.nft"
PROXY = OuterProxy(Slot(0).host_address, 3128)


def document(rules: list[tuple[str, str, int, int, str]]) -> dict[str, Any]:
    """`nft -j list table inet code_reviewer_wall` as the tool prints it: one object for each
    rule, with its comment, a counter expression and a verdict. The tuples are (chain, comment,
    packets, bytes, verdict)."""
    objects: list[dict[str, Any]] = [
        {"metainfo": {"version": "1.0.9", "release_name": "x", "json_schema_version": 1}},
        {"table": {"family": "inet", "name": "code_reviewer_wall", "handle": 1}},
    ]
    for number, (chain, comment, packets, size, verdict) in enumerate(rules, start=2):
        objects.append(
            {
                "rule": {
                    "family": "inet",
                    "table": "code_reviewer_wall",
                    "chain": chain,
                    "handle": number,
                    "comment": comment,
                    "expr": [
                        {
                            "match": {
                                "op": "==",
                                "left": {"meta": {"key": "iifname"}},
                                "right": "fctap*",
                            }
                        },
                        {"counter": {"packets": packets, "bytes": size}},
                        {verdict: None},
                    ],
                }
            }
        )
    return {"nftables": objects}


QUIET = [
    ("input", "no IPv6", 0, 0, "drop"),
    ("input", "answers", 40, 4000, "accept"),
    ("input", "everything else addressed to the host", 0, 0, "drop"),
    ("forward", "a VM forwards to nothing", 0, 0, "drop"),
    ("output", "the host opens no connection to a VM", 0, 0, "drop"),
]


# #999-T05 (the three rulesets of the guest are checked as files)
def test_the_rendering_holds_the_three_rulesets_the_guest_loads_with_the_proxy(
    tmp_path: Path,
) -> None:
    written = render_rulesets.render(tmp_path, PROXY)

    assert sorted(written) == ["model-door.nft", "network-door.nft", "setup-bridge.nft"]
    assert (tmp_path / "model-door.nft").read_text() == door_launcher.egress_rules(PROXY) + "\n"
    assert (tmp_path / "network-door.nft").read_text() == (
        netdoor_launcher.egress_rules(None, PROXY) + "\n"
    )
    assert (tmp_path / "setup-bridge.nft").read_text() == setup_container.egress_rules(PROXY) + "\n"
    for name in written:
        text = (tmp_path / name).read_text()
        # A script `nft -f` takes: commands separated by `;`, each an `add`.
        assert text.startswith("add table ip "), name
        # With the proxy each of the three lets the proxy's own address and port through, and the
        # table the guest loads holds no hosted rule that would open the internet.
        assert f"ip daddr {PROXY.host} tcp dport {PROXY.port} accept" in text, name
        assert "tcp dport 443 accept" not in text and "dport 53" not in text, name


def test_the_rendering_is_a_program_that_writes_the_files_it_is_asked_to(tmp_path: Path) -> None:
    done = subprocess.run(
        [sys.executable, str(Path(render_rulesets.__file__)), str(tmp_path / "out")],
        capture_output=True,
        text=True,
        check=False,
    )

    assert done.returncode == 0, done.stderr
    assert sorted(path.name for path in (tmp_path / "out").iterdir()) == [
        "model-door.nft",
        "network-door.nft",
        "setup-bridge.nft",
    ]
    assert done.stdout.split() == [
        str(tmp_path / "out" / name)
        for name in ("model-door.nft", "network-door.nft", "setup-bridge.nft")
    ]


# #999-T06 (the drop counters)
NOISE_OUTPUT = "the host opens no connection to a VM (vsock is the channel)"
QUIET_WITH_OUTPUT = [
    (chain, NOISE_OUTPUT if chain == "output" else comment, packets, size, verdict)
    for chain, comment, packets, size, verdict in QUIET
]


def test_a_quiet_table_has_no_drop_counter_that_moved() -> None:
    before = wall_counters.drop_counters(document(QUIET))

    assert len(before) == 4 and all(count == (0, 0) for count in before.values())
    assert wall_counters.moved(before, before) == {}


def test_an_accept_counter_is_not_a_drop_and_its_movement_is_no_alarm() -> None:
    later = [
        (chain, comment, packets + (5 if verdict == "accept" else 0), size, verdict)
        for chain, comment, packets, size, verdict in QUIET
    ]

    assert (
        wall_counters.moved(
            wall_counters.drop_counters(document(QUIET)),
            wall_counters.drop_counters(document(later)),
        )
        == {}
    )


def test_a_packet_that_went_round_the_proxy_shows_in_the_rule_that_dropped_it() -> None:
    direct = [
        (chain, comment, 3 if comment.startswith("everything else") else packets, size, verdict)
        for chain, comment, packets, size, verdict in QUIET
    ]

    moved = wall_counters.moved(
        wall_counters.drop_counters(document(QUIET)), wall_counters.drop_counters(document(direct))
    )

    assert moved == {"input: everything else addressed to the host": 3}


def test_the_lists_of_a_table_that_was_reloaded_between_two_snapshots_are_not_trusted() -> None:
    reloaded = [(chain, comment, 0, 0, verdict) for chain, comment, *_, verdict in QUIET]
    busy = [("forward", "a VM forwards to nothing", 9, 900, "drop")]

    # A counter that is lower than before is a reload: nothing is claimed, and it is said.
    with pytest.raises(wall_counters.TableReloaded):
        wall_counters.moved(
            wall_counters.drop_counters(document(QUIET[:3] + busy)),
            wall_counters.drop_counters(document(reloaded)),
        )


def test_the_noise_of_ipv6_is_the_two_rules_that_may_move_and_no_vm_traffic_is_among_it() -> None:
    noisy = [
        (chain, comment, 2 if comment in ("no IPv6", NOISE_OUTPUT) else packets, size, verdict)
        for chain, comment, packets, size, verdict in QUIET_WITH_OUTPUT
    ]
    after = wall_counters.drop_counters(document(noisy))
    before = wall_counters.drop_counters(document(QUIET_WITH_OUTPUT))

    assert wall_counters.moved(before, after) == {
        "input: no IPv6": 2,
        f"output: {NOISE_OUTPUT}": 2,
    }
    assert wall_counters.unexpected(wall_counters.moved(before, after)) == {}
    direct = {**wall_counters.moved(before, after), "forward: a VM forwards to nothing": 1}
    assert wall_counters.unexpected(direct) == {"forward: a VM forwards to nothing": 1}
    # What the VM sends to the host is in the input chain and never allowed (but the IPv6 rule).
    from_the_vm = {"input: everything else addressed to the host": 1}
    assert wall_counters.unexpected(from_the_vm) == from_the_vm


def test_the_program_exits_nonzero_and_names_the_rule_when_a_direct_connection_was_dropped(
    tmp_path: Path,
) -> None:
    first, second = tmp_path / "before.json", tmp_path / "after.json"
    first.write_text(json.dumps(document(QUIET)))
    second.write_text(
        json.dumps(document([(c, k, 7 if c == "forward" else p, b, v) for c, k, p, b, v in QUIET]))
    )
    program = Path(wall_counters.__file__)

    quiet = subprocess.run(
        [sys.executable, str(program), "none", str(first), str(first)],
        capture_output=True,
        text=True,
        check=False,
    )
    loud = subprocess.run(
        [sys.executable, str(program), "none", str(first), str(second)],
        capture_output=True,
        text=True,
        check=False,
    )
    expected = subprocess.run(
        [sys.executable, str(program), "some", str(first), str(second)],
        capture_output=True,
        text=True,
        check=False,
    )
    nothing_moved = subprocess.run(
        [sys.executable, str(program), "some", str(first), str(first)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert quiet.returncode == 0, quiet.stdout + quiet.stderr
    assert loud.returncode == 1 and "forward: a VM forwards to nothing" in loud.stdout
    # The control: a table whose counters never move would make the quiet one worth nothing.
    assert expected.returncode == 0, expected.stdout + expected.stderr
    assert nothing_moved.returncode == 1 and "no drop counter moved" in nothing_moved.stdout


def test_the_table_the_counters_belong_to_is_the_one_the_install_loads() -> None:
    lines = TABLE.read_text().splitlines()

    assert f"table inet {wall_counters.TABLE}" in "\n".join(lines)
    # Every drop of the table has a counter and a comment: that is what the check reads and names.
    drops = [line for line in lines if " drop" in line and not line.lstrip().startswith("#")]
    assert len(drops) >= 7
    for line in drops:
        assert " counter drop comment " in line or "policy" in line, line
