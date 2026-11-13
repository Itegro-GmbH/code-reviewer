# SPDX-License-Identifier: LicenseRef-Proprietary

"""The host's static nft table of the Incus outer wall (#1008): what it says, held to what the
launcher names and the slots say and to the page of docs/runner.md that prints it; `apply` and
`check` (root) against a fake nft; the gate the dispatcher asks; and the launcher's refusal to take
a job without the table. Real nft is the Incus lane (`tests/incus/test_host_wall.py`): it loads the
table, probes from real instances and proves each blocked probe with a control that reached."""

import asyncio
import fnmatch
import ipaddress
import json
import os
import pwd
import re
import shutil
import subprocess
from collections.abc import Callable, Sequence
from io import StringIO
from pathlib import Path
from typing import Any

import pytest
from incus_support import Rig, short_directory, start_for

from code_reviewer_runner.factory_runner.base import EXIT_CONFIG, EXIT_FAILED, EXIT_OK
from code_reviewer_runner.factory_runner.cli import build_parser, main
from code_reviewer_runner.factory_runner.incus import host_wall
from code_reviewer_runner.factory_runner.incus.host_wall import (
    HostWallError,
    HostWallGate,
    HostWallSpec,
    NftResult,
    WallVerdict,
    apply,
    check,
    default_status_path,
    read_status,
    spec_for,
)
from code_reviewer_runner.factory_runner.incus.host_wall_cli import run
from code_reviewer_runner.factory_runner.incus.launcher import IncusNotReady, StartFailed
from code_reviewer_runner.factory_runner.incus.provision import PROXY_PORT
from code_reviewer_runner.factory_runner.incus.settings import (
    IncusSettings,
    owner_id,
    settings_from_environment,
)
from code_reviewer_runner.factory_runner.incus.slots import IncusSlot

pytestmark = pytest.mark.unit

REPOSITORY = Path(__file__).resolve().parents[3]
NETWORK = ipaddress.IPv4Network("10.99.0.0/27")
SPEC = HostWallSpec("cr", "a1b2", NETWORK)
BRIDGES = f'"{SPEC.name_prefix}-*"'
NOW = 1_800_000_000.0


def go(scenario: Callable[[], Any]) -> Any:
    return asyncio.run(scenario())


def rules(spec: HostWallSpec = SPEC) -> list[str]:
    """The statements of the table, without comments and the structure lines."""
    return [
        line.strip()
        for line in spec.ruleset().splitlines()
        if line.strip()
        and not line.strip().startswith(("#", "table ", "delete ", "chain ", "type ", "}"))
    ]


def chain_rules(name: str, spec: HostWallSpec = SPEC) -> list[str]:
    inside = False
    found: list[str] = []
    for line in spec.ruleset().splitlines():
        text = line.strip()
        if text == f"chain {name} {{":
            inside = True
        elif inside and text == "}":
            break
        elif inside and not text.startswith("type "):
            found.append(text)
    return found


# -- the table ---


# #1008-T01
def test_the_table_is_one_table_per_owner_that_can_be_loaded_again_and_again() -> None:
    text = SPEC.ruleset()

    # Declared, deleted, declared with its content: `nft -f` replaces what an earlier load made and
    # works the first time too, in one transaction.
    assert [line for line in text.splitlines() if line.startswith(("table ", "delete "))] == [
        "table inet code_reviewer_wall_a1b2",
        "delete table inet code_reviewer_wall_a1b2",
        "table inet code_reviewer_wall_a1b2 {",
    ]
    assert "flush ruleset" not in text
    assert SPEC.table == "code_reviewer_wall_a1b2"


# #1008-T02
def test_it_never_names_dockers_or_incuss_tables_or_any_other_tool_of_the_host() -> None:
    statements = "\n".join(rules()).lower()

    for word in (
        "docker",
        "incus",
        "iptables",
        "ip filter",
        "ip nat",
        "masquerade",
        "dnat",
        "snat",
    ):
        assert word not in statements, word
    assert "flush" not in SPEC.ruleset()


# #1008-T01
def test_every_rule_names_only_this_dispatchers_instance_bridges() -> None:
    for name in ("input", "forward", "output"):
        found = chain_rules(name)
        assert found, name
        assert all(line.startswith(("iifname ", "oifname ")) for line in found), found
        assert all(f'"{SPEC.name_prefix}-' in line for line in found), found
    # The chains accept what is not ours: nothing of the machine's own traffic is touched.
    for name in ("input", "forward", "output"):
        assert any("policy accept;" in line for line in SPEC.ruleset().splitlines()), name
    assert SPEC.ruleset().count("policy accept;") == 3
    # Before the filter hooks of Docker's and Incus's tables (priority 0): a drop here is final.
    assert SPEC.ruleset().count("priority -150;") == 3


# #1008-T01
def test_from_a_bridge_only_the_proxy_of_its_own_slot_on_the_hosts_address_is_accepted() -> None:
    accepted = [line for line in chain_rules("input") if " accept " in f"{line} "]

    assert len(accepted) == SPEC.slot_count == 4
    for slot, line in zip(SPEC.slots(), accepted, strict=True):
        assert line.startswith(f'iifname "{SPEC.outer_bridge(slot.index)}" ')
        assert f"ip saddr {{ {slot.guest_address}, {slot.b_address} }}" in line
        assert f"ip daddr {slot.host_address} " in line
        assert f"tcp dport {PROXY_PORT} " in line
    # Not UDP, not ICMP, not DNS, not another port, anywhere.
    assert set(re.findall(r"dport (\d+)", SPEC.ruleset())) == {PROXY_PORT}
    assert not re.search(r"\b(udp|icmp|icmpv6)\b", SPEC.ruleset())


# #1008-T01
def test_everything_else_addressed_to_the_host_is_dropped_dns_and_ipv6_included() -> None:
    found = chain_rules("input")

    # Last: a missing rule never opens anything, the last rule of the chain drops what is ours.
    assert found[-1].startswith(f"iifname {BRIDGES} counter drop")
    assert found[-2].startswith(f"iifname {BRIDGES} meta nfproto ipv6 counter drop")
    # No accept comes after a drop.
    first_drop = next(i for i, line in enumerate(found) if " drop " in f"{line} ")
    assert all(" accept " not in f"{line} " for line in found[first_drop:])
    assert ":53" not in SPEC.ruleset() and " 53 " not in SPEC.ruleset()


# #1008-T01
def test_nothing_is_forwarded_to_or_from_an_instance_bridge_and_the_host_only_answers() -> None:
    forward = chain_rules("forward")
    assert [line.split()[0] for line in forward] == ["iifname", "oifname"]
    assert all(" drop " in f"{line} " for line in forward)

    output = chain_rules("output")
    assert "ct state established,related" in output[0] and " accept " in f"{output[0]} "
    assert output[-1].startswith(f"oifname {BRIDGES} counter drop")
    assert len(output) == 2


# #1008-T01
def test_the_bridges_are_the_ones_the_launcher_makes_inner_ones_and_other_owners_apart() -> None:
    settings = IncusSettings(pool="p", image_id="i", slots=4, slot_network=NETWORK)
    spec = spec_for(settings)

    assert spec.owner == settings.owner and spec.table.endswith(settings.owner)
    for index in range(settings.slots):
        # The outer bridge of a slot has its accept rule; both bridges of a slot match the drops.
        assert f'iifname "{settings.outer_network(index)}" ' in spec.ruleset()
        pattern = f"{spec.name_prefix}-*"
        assert fnmatch.fnmatchcase(settings.outer_network(index), pattern)
        assert fnmatch.fnmatchcase(settings.inner_network(index), pattern)
    # Another owner's bridges, another prefix's, `incusbr0` and `docker0` match nothing of ours.
    other = IncusSettings(pool="p", image_id="i", prefix="cr", state_dir=Path("/var/lib/other"))
    assert other.owner != settings.owner
    for name in (other.outer_network(0), "incusbr0", "docker0", "eth0", f"cr{settings.owner}-o0"):
        assert not fnmatch.fnmatchcase(name, f"{spec.name_prefix}-*"), name


# #1008-T01
def test_two_owners_have_two_tables_that_do_not_name_each_others_bridges() -> None:
    mine = HostWallSpec("cr", "a1b2", NETWORK)
    theirs = HostWallSpec("cr", "c3d4", ipaddress.IPv4Network("10.98.8.0/27"))

    assert mine.table != theirs.table
    assert theirs.name_prefix not in mine.ruleset() and mine.name_prefix not in theirs.ruleset()
    assert "10.99.0." not in theirs.ruleset()


# #1008-T01
@pytest.mark.parametrize(
    ("network", "slots"),
    [("10.99.0.0/24", 32), ("10.99.0.0/27", 4), ("10.99.0.0/29", 1), ("10.99.0.0/16", 32)],
)
def test_the_table_has_a_rule_for_every_slot_the_network_has_room_for(
    network: str, slots: int
) -> None:
    spec = HostWallSpec("cr", "a1b2", ipaddress.IPv4Network(network))

    assert spec.slot_count == slots
    assert len([line for line in chain_rules("input", spec) if " accept " in f"{line} "]) == slots
    last = IncusSlot(slots - 1, spec.slot_network)
    assert f"ip daddr {last.host_address} " in spec.ruleset()


# #1008-T01
def test_a_prefix_or_owner_that_would_put_something_odd_into_the_table_is_refused() -> None:
    for prefix, owner in (("C R", "a1b2"), ('c"r', "a1b2"), ("cr", "zzzz"), ("cr", "a1b2 {")):
        with pytest.raises(HostWallError):
            HostWallSpec(prefix, owner, NETWORK)


# #1008-T01
def test_the_docs_print_the_table_in_full() -> None:
    docs = (REPOSITORY / "docs" / "runner.md").read_text(encoding="utf-8")

    # The page prints the table for the example above as it is rendered, comment lines included: a
    # change to the generator without the page fails here.
    assert SPEC.ruleset().strip() in docs


# #1008-T01
@pytest.mark.skipif(shutil.which("nft") is None, reason="nft is not installed")
def test_nft_reads_the_table_it_is_the_lane_that_loads_it() -> None:
    # As a user nft parses the whole file and then fails on the kernel's cache ("Operation not
    # permitted"); as root `-c` is the full check. Either way a syntax or a semantic error of the
    # text is an `Error:` line that is not about netlink.
    done = subprocess.run(
        ["nft", "-c", "-f", "-"],
        input=HostWallSpec("cr", "a1b2", ipaddress.IPv4Network("10.99.0.0/24")).ruleset(),
        capture_output=True,
        text=True,
        check=False,
    )

    errors = [
        line for line in done.stderr.splitlines() if "Error:" in line and "netlink:" not in line
    ]
    assert errors == []
    assert done.returncode == 0 or "Operation not permitted" in done.stderr


# -- apply and check, against a fake nft ---


class FakeNft:
    """What `nft` does with the table: `-f -` replaces the table of the file's name, `list table`
    prints it with counters that grow with every listing (so a comparison must not count them)."""

    def __init__(self) -> None:
        self.tables: dict[str, str] = {}
        self.loaded: list[str] = []
        self.refuse: str | None = None
        self.silent = False
        self._packets = 0

    def __call__(self, arguments: Sequence[str], stdin: str | None) -> NftResult:
        if list(arguments) == ["-f", "-"]:
            assert stdin is not None
            if self.refuse:
                return NftResult(1, "", f"{self.refuse}\n")
            self.loaded.append(stdin)
            if not self.silent:
                (name,) = re.findall(r"^table inet (\S+) \{", stdin, re.MULTILINE)
                self.tables[name] = "\n".join(
                    line
                    for line in stdin.splitlines()
                    if not line.startswith(("#", "delete "))
                    and not re.fullmatch(r"table inet \S+", line)
                )
            return NftResult(0)
        assert list(arguments[:3]) == ["list", "table", "inet"]
        text = self.tables.get(arguments[3])
        if text is None:
            return NftResult(1, "", "Error: No such file or directory\n")
        self._packets += 7
        return NftResult(
            0,
            text.replace("counter", f"counter packets {self._packets} bytes {self._packets * 60}"),
        )


def status_file(root: Path) -> Path:
    return root / "run" / "host-wall-a1b2.json"


# #1008-T03
def test_apply_loads_the_table_in_one_transaction_reads_it_back_and_records_it() -> None:
    with short_directory() as root:
        nft, path = FakeNft(), status_file(root)

        apply(SPEC, path, run=nft, now=lambda: NOW)

        assert nft.loaded == [SPEC.ruleset()]
        record = read_status(path)
        assert record is not None and record["ok"] is True and record["checkedAt"] == NOW
        assert record["source"] == SPEC.source_digest and record["table"] == SPEC.table
        assert path.stat().st_mode & 0o777 == 0o644
        assert HostWallGate(SPEC, path, clock=lambda: NOW + 1).verify() == WallVerdict(True)


# #1008-T03
def test_a_table_that_nft_refuses_or_that_is_not_there_afterwards_is_an_error_and_not_ok() -> None:
    with short_directory() as root:
        path = status_file(root)
        refusing = FakeNft()
        refusing.refuse = "Error: Could not process rule: Operation not permitted"

        with pytest.raises(HostWallError, match=r"refused the table.*Operation not permitted"):
            apply(SPEC, path, run=refusing, now=lambda: NOW)
        silent = FakeNft()
        silent.silent = True
        with pytest.raises(HostWallError, match="read back"):
            apply(SPEC, path, run=silent, now=lambda: NOW)

        record = read_status(path)
        assert record is not None and record["ok"] is False
        assert HostWallGate(SPEC, path, clock=lambda: NOW).verify().ok is False


# #1008-T03
def test_check_finds_the_table_as_it_was_loaded_whatever_the_counters_say() -> None:
    with short_directory() as root:
        nft, path = FakeNft(), status_file(root)
        apply(SPEC, path, run=nft, now=lambda: NOW)

        first = check(SPEC, path, run=nft, now=lambda: NOW + 10)
        second = check(SPEC, path, run=nft, now=lambda: NOW + 20)

        assert first.ok and second.ok and not first.reapplied
        record = read_status(path)
        assert record is not None and record["checkedAt"] == NOW + 20 and record["ok"] is True


# #1008-T03
def test_a_table_that_is_gone_is_found_the_gate_refuses_and_reapply_loads_it_and_says_so() -> None:
    with short_directory() as root:
        nft, path = FakeNft(), status_file(root)
        apply(SPEC, path, run=nft, now=lambda: NOW)
        nft.tables.clear()

        found = check(SPEC, path, run=nft, now=lambda: NOW + 10)
        gate = HostWallGate(SPEC, path, clock=lambda: NOW + 11)

        assert not found.ok and "is not loaded" in found.reason
        assert gate.verify().ok is False and "is not loaded" in gate.verify().reason
        repaired = check(SPEC, path, reapply=True, run=nft, now=lambda: NOW + 12)
        assert repaired.ok and repaired.reapplied and "is not loaded" in repaired.reason
        assert nft.loaded[-1] == SPEC.ruleset()
        assert HostWallGate(SPEC, path, clock=lambda: NOW + 13).verify().ok is True


# #1008-T03
def test_a_table_that_lost_a_rule_differs_and_is_loaded_again() -> None:
    with short_directory() as root:
        nft, path = FakeNft(), status_file(root)
        apply(SPEC, path, run=nft, now=lambda: NOW)
        nft.tables[SPEC.table] = nft.tables[SPEC.table].replace(
            f'    iifname {BRIDGES} counter drop comment "all else to the host, DNS included"\n', ""
        )

        found = check(SPEC, path, run=nft, now=lambda: NOW + 10)
        assert not found.ok and "differs" in found.reason
        assert HostWallGate(SPEC, path, clock=lambda: NOW + 11).verify().ok is False
        repaired = check(SPEC, path, reapply=True, run=nft, now=lambda: NOW + 12)

        assert repaired.ok and repaired.reapplied and "differs" in repaired.reason
        assert "all else to the host" in nft.tables[SPEC.table]


# #1008-T03
def test_a_failed_check_forgets_nothing_so_a_table_put_back_by_hand_passes_the_next_one() -> None:
    with short_directory() as root:
        nft, path = FakeNft(), status_file(root)
        apply(SPEC, path, run=nft, now=lambda: NOW)
        loaded = nft.tables[SPEC.table]
        nft.tables[SPEC.table] = loaded.replace("policy accept;", "policy drop;", 1)

        assert not check(SPEC, path, run=nft, now=lambda: NOW + 1).ok
        assert "differs" in check(SPEC, path, run=nft, now=lambda: NOW + 2).reason
        nft.tables[SPEC.table] = loaded

        assert check(SPEC, path, run=nft, now=lambda: NOW + 3).ok
        assert HostWallGate(SPEC, path, clock=lambda: NOW + 4).verify().ok


# #1008-T03
def test_a_table_loaded_for_other_settings_or_by_hand_is_not_the_one_the_gate_wants() -> None:
    with short_directory() as root:
        nft, path = FakeNft(), status_file(root)
        other = HostWallSpec("cr", "a1b2", ipaddress.IPv4Network("10.77.0.0/27"))
        apply(other, path, run=nft, now=lambda: NOW)
        # Same table name, other network: what the kernel holds is not this program's table.
        found = check(SPEC, path, run=nft, now=lambda: NOW + 1)
        assert not found.ok and "not loaded by this program with these settings" in found.reason
        assert HostWallGate(SPEC, path, clock=lambda: NOW + 2).verify().ok is False

        by_hand = status_file(root).with_name("none.json")
        nft.tables[SPEC.table] = nft.tables[other.table]
        assert not check(SPEC, by_hand, run=nft, now=lambda: NOW).ok


# -- the gate ---


def record(**changes: object) -> dict[str, object]:
    document: dict[str, object] = {
        "version": 1,
        "table": SPEC.table,
        "source": SPEC.source_digest,
        "ok": True,
        "reason": "",
        "checkedAt": NOW,
        "listing": "x",
    }
    document.update(changes)
    return document


@pytest.mark.parametrize(
    ("document", "clock", "fragment"),
    [
        (None, NOW, "no record of the table"),
        ("not json", NOW, "no record of the table"),
        (record(version=2), NOW, "no record of the table"),
        (record(source="0" * 64), NOW, "for other settings"),
        (record(checkedAt=None), NOW, "has no time"),
        (record(checkedAt=True), NOW, "has no time"),
        (record(), NOW + 61, "61 s old"),
        (record(), NOW - 10, "in the future"),
        (record(ok=False, reason="table x is not loaded"), NOW, "the last check failed: table x"),
        (record(ok=False, reason=""), NOW, "the last check failed: unknown"),
        (record(ok="yes"), NOW, "the last check failed"),
    ],
)
# #1008-T03
def test_the_gate_refuses_a_record_that_is_missing_foreign_stale_future_or_failed(
    document: object, clock: float, fragment: str
) -> None:
    with short_directory() as root:
        path = root / "record.json"
        if isinstance(document, dict):
            path.write_text(json.dumps(document), encoding="utf-8")
        elif isinstance(document, str):
            path.write_text(document, encoding="utf-8")

        verdict = HostWallGate(SPEC, path, clock=lambda: clock).verify()

        assert not verdict.ok and fragment in verdict.reason


# #1008-T03
def test_the_gate_accepts_a_fresh_record_for_these_settings_and_nothing_older_than_the_limit() -> (
    None
):
    with short_directory() as root:
        path = root / "record.json"
        path.write_text(json.dumps(record()), encoding="utf-8")

        assert HostWallGate(SPEC, path, clock=lambda: NOW + 60).verify() == WallVerdict(True)
        assert not HostWallGate(SPEC, path, max_age_seconds=5, clock=lambda: NOW + 6).verify().ok


# #1008-T03
def test_the_gate_says_what_changed_once_not_at_every_claim(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with short_directory() as root:
        path = root / "record.json"
        gate = HostWallGate(SPEC, path, clock=lambda: NOW)
        with caplog.at_level("INFO"):
            gate.verify()
            gate.verify()
            path.write_text(json.dumps(record()), encoding="utf-8")
            gate.verify()

        assert [r.levelname for r in caplog.records] == ["ERROR", "INFO"]


# -- the launcher refuses without the table ---


class StubGate(HostWallGate):
    """A gate whose verdict a test sets."""

    def __init__(self, verdict: WallVerdict) -> None:
        super().__init__(SPEC, Path("/nonexistent"))
        self.answer = verdict

    def verify(self) -> WallVerdict:
        return self.answer


# #1008-T03
def test_setup_refuses_a_machine_whose_table_is_missing_and_touches_nothing() -> None:
    with short_directory() as root:
        rig = Rig(root)
        sandbox = rig.sandbox(host_wall=StubGate(WallVerdict(False, "table x is not loaded")))

        async def scenario() -> None:
            with pytest.raises(IncusNotReady, match="host's outer wall: table x is not loaded"):
                await sandbox.setup()
            await sandbox.close()

        go(scenario)

        assert not [c for c in rig.incus.calls if c[0] in ("create", "delete", "start")]


# #1008-T03
def test_no_job_is_taken_while_the_table_is_missing_and_one_is_when_it_is_back() -> None:
    with short_directory() as root:
        rig = Rig(root)
        gate = StubGate(WallVerdict(True))
        sandbox = rig.sandbox(host_wall=gate)

        async def scenario() -> None:
            await sandbox.setup()
            assert sandbox.free == 1
            gate.answer = WallVerdict(False, "the record of the table is 90 s old")
            assert sandbox.free == 0
            with pytest.raises(StartFailed, match="the host's outer wall: the record"):
                await sandbox.start(start_for())
            assert not [c for c in rig.incus.calls if c[0] == "create"]
            gate.answer = WallVerdict(True)
            assert sandbox.free == 1
            worker = await sandbox.start(start_for())
            await worker.stop()
            await worker.wait()
            await sandbox.close()

        go(scenario)


# -- the commands ---


def namespace(*arguments: str) -> Any:
    return build_parser().parse_args(["host-wall", *arguments])


def run_command(
    *arguments: str,
    nft: FakeNft | None = None,
    root: bool = True,
    env: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    out, err = StringIO(), StringIO()
    code = run(
        namespace(*arguments),
        env or {},
        out,
        err,
        nft=nft or FakeNft(),
        is_root=lambda: root,
        clock=lambda: NOW,
    )
    return code, out.getvalue(), err.getvalue()


# #1008-T03
def test_print_needs_no_root_and_prints_the_table_of_the_owner() -> None:
    code, out, err = run_command(
        "print", "--owner", "a1b2", "--slot-network", "10.99.0.0/27", root=False
    )

    assert (code, err) == (EXIT_OK, "")
    assert out == SPEC.ruleset()


# #1008-T03
def test_the_owner_is_the_one_the_dispatcher_computes_from_its_user_and_state_directory() -> None:
    me = pwd.getpwuid(os.getuid()).pw_name
    code, out, _ = run_command(
        "print", "--user", me, "--state-dir", "/var/lib/code-reviewer", root=False
    )

    assert code == EXIT_OK
    assert f"table inet code_reviewer_wall_{owner_id(Path('/var/lib/code-reviewer'))}" in out
    code, out, _ = run_command("print", "--user", me, "--state-dir", "/srv/elsewhere", root=False)
    assert f"code_reviewer_wall_{owner_id(Path('/srv/elsewhere'))} " in out


# #1008-T03
def test_apply_and_check_need_root_a_user_and_a_network_that_exist() -> None:
    assert run_command("apply", "--owner", "a1b2", root=False)[0] == EXIT_CONFIG
    assert run_command("check", "--owner", "a1b2", root=False)[0] == EXIT_CONFIG
    assert run_command("apply")[0] == EXIT_CONFIG
    assert run_command("apply", "--user", "no-such-user-1008")[0] == EXIT_CONFIG
    assert run_command("apply", "--owner", "a1b2", "--slot-network", "not-a-network")[0] == (
        EXIT_CONFIG
    )
    assert run_command("apply", "--owner", "zz")[0] == EXIT_CONFIG


# #1008-T03
def test_apply_then_check_then_a_lost_table_is_exit_1_and_reapply_is_exit_0_and_says_so() -> None:
    with short_directory() as root:
        nft = FakeNft()
        common = ["--owner", "a1b2", "--slot-network", "10.99.0.0/27", "--status-file"]
        path = str(status_file(root))

        assert run_command("apply", *common, path, nft=nft)[0] == EXIT_OK
        assert run_command("check", *common, path, nft=nft)[:2] == (EXIT_OK, f"ok: {SPEC.table}\n")
        assert run_command("status", *common, path, nft=nft)[0] == EXIT_OK
        nft.tables.clear()
        code, _, err = run_command("check", *common, path, nft=nft)
        assert code == EXIT_FAILED and "is not loaded" in err
        assert run_command("status", *common, path, nft=nft)[0] == EXIT_FAILED
        code, out, _ = run_command("check", *common, path, "--reapply", nft=nft)
        assert code == EXIT_OK and out.startswith("reapplied: ")
        assert run_command("status", *common, path, nft=nft)[0] == EXIT_OK


# #1008-T03
def test_a_table_nft_refuses_is_exit_1_and_named() -> None:
    with short_directory() as root:
        nft = FakeNft()
        nft.refuse = "Error: no nft_fib"

        code, _, err = run_command(
            "apply", "--owner", "a1b2", "--status-file", str(status_file(root)), nft=nft
        )

        assert code == EXIT_FAILED and "no nft_fib" in err


# #1008-T03
def test_the_command_is_part_of_factory_runner_and_asks_for_no_registration() -> None:
    out, err = StringIO(), StringIO()

    code = main(
        ["host-wall", "print", "--owner", "a1b2", "--slot-network", "10.99.0.0/27"],
        environment={},
        out=out,
        err=err,
    )

    assert (code, err.getvalue()) == (EXIT_OK, "")
    assert out.getvalue() == SPEC.ruleset()


# -- the settings ---


# #1008-T03
def test_the_record_and_its_age_are_settings_with_defaults_next_to_the_owner() -> None:
    environment = {
        "FACTORY_RUNNER_INCUS_POOL": "pool",
        "FACTORY_RUNNER_VM_IMAGE_ID": "sha256:" + "ab" * 32,
    }
    default = settings_from_environment(environment, parallel_runs=1)
    assert default.host_wall_status is None and default.host_wall_max_age_seconds == 60.0
    assert host_wall.status_path_for(default) == default_status_path(default.owner)

    changed = settings_from_environment(
        {
            **environment,
            "FACTORY_RUNNER_HOST_WALL_STATUS": "/run/x/wall.json",
            "FACTORY_RUNNER_HOST_WALL_MAX_AGE_SECONDS": "30",
        },
        parallel_runs=1,
    )
    assert changed.host_wall_status == Path("/run/x/wall.json")
    assert changed.host_wall_max_age_seconds == 30.0
    assert str(default_status_path("a1b2")) == "/run/code-reviewer/host-wall-a1b2.json"


# #1008-T03
def test_the_service_builds_its_sandbox_with_a_gate_for_its_own_settings() -> None:
    from code_reviewer_runner.factory_runner.config import Limits, RunnerConfig
    from code_reviewer_runner.factory_runner.incus.factory import incus_sandbox_factory

    environment = {
        "FACTORY_RUNNER_INCUS_POOL": "pool",
        "FACTORY_RUNNER_VM_IMAGE_ID": "sha256:" + "ab" * 32,
        "FACTORY_RUNNER_VM_STATE_DIR": "/var/lib/code-reviewer",
    }
    config = RunnerConfig(
        url="https://app.example.com", credential="crr_" + "x" * 40, limits=Limits(parallel_runs=2)
    )

    sandbox = incus_sandbox_factory(config, environment)({}, 5.0)

    # No record exists on this machine: the service would take no job.
    assert sandbox.free == 0
