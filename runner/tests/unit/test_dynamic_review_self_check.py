# SPDX-License-Identifier: LicenseRef-Proprietary

"""The startup self-check that decides whether a runner advertises `opencode` (#202).

It runs once, in the root supervisor, after the one-time network setup. Every property the
advertisement rests on has its own stable reason, and a failing property never advertises. The real
binary, nft rules and users are proven as root in CI (`tests/privileged/test_self_check.py` and the
image smoke test); here the decisions, their order and their reasons are pinned with the facts
injected.
"""

import hashlib
import json
import os
import shutil
import stat
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.capabilities import (
    ALL_ENGINES,
    ENGINE_DIFF,
    ENGINE_DYNAMIC,
    IsolationSelfCheckError,
    self_check_outcome,
)
from code_reviewer_runner.dynamic_review.netguard import EgressMode, IsolationError
from code_reviewer_runner.dynamic_review.self_check import (
    DEFAULT_TOOLS,
    SelfCheckReason,
    SelfCheckResult,
    ToolPaths,
    check_dynamic_runner,
)
from code_reviewer_runner.dynamic_review.static_isolation import SlotPorts
from code_reviewer_runner.result import ErrorCode

PORTS = SlotPorts(10180, 10181)
USER = (10101, 10101)
PLATFORM = "linux-x64"
VERSION = "1.19.0"
OPENCODE = b"#!/bin/sh\necho 1.19.0\n"
RIPGREP = b"#!/bin/sh\necho ripgrep\n"


def pin_file(path: Path, executable: bytes, *, version: str = VERSION) -> None:
    path.write_text(
        json.dumps(
            {
                "version": version,
                "platforms": {
                    PLATFORM: {
                        "executableBytes": len(executable),
                        "executableSha256": hashlib.sha256(executable).hexdigest(),
                    }
                },
            }
        ),
        encoding="utf-8",
    )


def install(path: Path, content: bytes, mode: int = 0o755) -> None:
    path.write_bytes(content)
    path.chmod(mode)


def as_root() -> int:
    return 0


def as_user() -> int:
    return 1000


def group_of_the_same_number(uid: int) -> int | None:
    return uid


def no_such_user(uid: int) -> int | None:
    return None


def a_foreign_group(uid: int) -> int | None:
    return 4711


def group_zero(uid: int) -> int | None:
    return 0


def reports_the_pinned_version(path: Path, uid: int, gid: int) -> str:
    return VERSION


def reports_another_version(path: Path, uid: int, gid: int) -> str:
    return "1.20.0"


@dataclass
class World:
    """Everything the check reads, as files in a temporary directory and recorded calls."""

    tools: ToolPaths
    calls: list[str]
    anchor: Path

    def capabilities_gone(self) -> None:
        self.calls.append("capabilities")

    def probe(self, uid: int, gid: int, port: int) -> None:
        self.calls.append(f"probe:{uid}:{gid}:{port}")

    def ipv6_proof(self, uid: int, gid: int) -> None:
        self.calls.append(f"ipv6:{uid}:{gid}")

    def run(self, **changes: Any) -> SelfCheckResult:
        arguments: dict[str, Any] = {
            "user": USER,
            "ports": PORTS,
            "rules_installed": True,
            "tools": self.tools,
            "platform": PLATFORM,
            "trusted_owner": os.getuid(),
            "chain_root": self.anchor,
            "euid": as_root,
            "capabilities_gone": self.capabilities_gone,
            "user_group": group_of_the_same_number,
            "probe": self.probe,
            "ipv6_proof": self.ipv6_proof,
            "version_as_user": reports_the_pinned_version,
            **changes,
        }
        return check_dynamic_runner(**arguments)


@pytest.fixture
def world(tmp_path: Path) -> World:
    # The layout of the image: the tools in /usr/local/bin, the pins in /opt/code-reviewer/pins.
    # tmp_path stands for "/": the chain of directories above each file is judged up to it.
    bin_directory = tmp_path / "usr" / "local" / "bin"
    pin_directory = tmp_path / "opt" / "code-reviewer" / "pins"
    bin_directory.mkdir(parents=True)
    pin_directory.mkdir(parents=True)
    tools = ToolPaths(
        opencode=bin_directory / "opencode",
        ripgrep=bin_directory / "rg",
        opencode_pin=pin_directory / "opencode-pin.json",
        ripgrep_pin=pin_directory / "ripgrep-pin.json",
    )
    install(tools.opencode, OPENCODE)
    install(tools.ripgrep, RIPGREP)
    pin_file(tools.opencode_pin, OPENCODE)
    pin_file(tools.ripgrep_pin, RIPGREP, version="14.1.1")
    return World(tools, [], tmp_path)


def refused(world: World, **changes: Any) -> IsolationSelfCheckError:
    with pytest.raises(IsolationSelfCheckError) as caught:
        world.run(**changes)
    return caught.value


# #202-T01: every property holds, in the order the production startup establishes them.
def test_a_runner_with_every_property_passes_and_probes_as_the_engine_user(world: World) -> None:
    world.run()

    assert world.calls == ["capabilities", "probe:10101:10101:10180"]


# #763-T06
def test_an_implementer_runner_probes_the_egress_port_with_the_model_proxy_port(
    world: World,
) -> None:
    def probe(uid: int, gid: int, *ports: int) -> None:
        world.calls.append(f"probe:{uid}:{gid}:{'+'.join(str(port) for port in ports)}")

    world.run(ports=SlotPorts(10180, 10181, 10182), probe=probe)

    assert world.calls == ["capabilities", "probe:10101:10101:10180+10182"]


# #345-T10
@pytest.mark.parametrize("mode", list(EgressMode))
def test_the_result_names_the_egress_mode_the_check_passed_with(
    world: World, mode: EgressMode
) -> None:
    result = world.run(egress_mode=mode)

    assert result == SelfCheckResult(egress_mode=mode)


# #345-T19: no mode given is the full one, and nothing about IPv6 is asked of such a host.
def test_a_host_with_the_full_ruleset_is_checked_exactly_as_before(world: World) -> None:
    result = world.run()

    assert result.egress_mode is EgressMode.FULL
    assert world.calls == ["capabilities", "probe:10101:10101:10180"]
    world.calls.clear()
    world.run(egress_mode=EgressMode.FULL)
    assert not any(call.startswith("ipv6") for call in world.calls)


# #345-T10
def test_in_fallback_mode_the_ipv6_proof_runs_for_the_engine_user_before_the_network_probe(
    world: World,
) -> None:
    world.run(egress_mode=EgressMode.FALLBACK)

    assert world.calls == ["capabilities", "ipv6:10101:10101", "probe:10101:10101:10180"]


# #345-T09
def test_in_fallback_mode_ipv6_that_is_not_proven_off_is_refused_with_its_own_reason(
    world: World,
) -> None:
    def ipv6_on(uid: int, gid: int) -> None:
        raise IsolationError("IPv6 is not switched off on every interface")

    error = refused(world, egress_mode=EgressMode.FALLBACK, ipv6_proof=ipv6_on)

    assert error.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
    assert getattr(error, "reason", None) is SelfCheckReason.IPV6_NOT_DISABLED
    assert SelfCheckReason.IPV6_NOT_DISABLED.value == "ipv6_not_disabled"
    assert not any(call.startswith("probe") for call in world.calls)
    assert "10101" not in str(error)


# #345-T09: and a runner in that state never advertises `opencode`.
def test_a_fallback_runner_whose_ipv6_is_on_serves_diff_only(world: World) -> None:
    def ipv6_on(uid: int, gid: int) -> None:
        raise IsolationError("an IPv6 address exists")

    engines, error = self_check_outcome(
        lambda: world.run(egress_mode=EgressMode.FALLBACK, ipv6_proof=ipv6_on)
    )

    assert engines == (ENGINE_DIFF,)
    assert error is not None and getattr(error, "reason", None) is SelfCheckReason.IPV6_NOT_DISABLED
    engines, error = self_check_outcome(lambda: world.run(egress_mode=EgressMode.FALLBACK))
    assert engines == ALL_ENGINES and error is None


# #202-T09
@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"user": None}, SelfCheckReason.NOT_A_DYNAMIC_RUNNER),
        ({"ports": None}, SelfCheckReason.NOT_A_DYNAMIC_RUNNER),
        ({"euid": as_user}, SelfCheckReason.NOT_ROOT_SUPERVISOR),
        ({"rules_installed": False}, SelfCheckReason.NETWORK_RULES_NOT_INSTALLED),
        ({"user_group": no_such_user}, SelfCheckReason.ENGINE_USER_INVALID),
        ({"user_group": a_foreign_group}, SelfCheckReason.ENGINE_USER_INVALID),
        ({"user": (0, 0), "user_group": group_zero}, SelfCheckReason.ENGINE_USER_INVALID),
    ],
)
def test_a_missing_precondition_is_refused_with_its_own_stable_reason(
    world: World, changes: dict[str, Any], reason: SelfCheckReason
) -> None:
    error = refused(world, **changes)

    assert error.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
    assert getattr(error, "reason", None) is reason
    assert not any(call.startswith("probe") for call in world.calls)


# #202-T09
def test_capabilities_that_are_still_held_are_refused(world: World) -> None:
    def still_held() -> None:
        raise IsolationError("the supervisor still holds a capability only startup may hold")

    error = refused(world, capabilities_gone=still_held)

    assert getattr(error, "reason", None) is SelfCheckReason.CAPABILITIES_NOT_DROPPED
    assert world.calls == []


# #202-T09
def test_a_network_probe_that_fails_is_refused_and_names_no_value(world: World) -> None:
    def failing(uid: int, gid: int, port: int) -> None:
        raise IsolationError("the engine user can reach a service other than its model proxy")

    error = refused(world, probe=failing)

    assert getattr(error, "reason", None) is SelfCheckReason.NETWORK_PROBE_FAILED
    assert "10101" not in str(error)


def tamper(path: Path) -> None:
    path.chmod(0o755)
    path.write_bytes(b"#!/bin/sh\necho evil\n")


def replace_by_link(path: Path) -> None:
    target = path.with_name(path.name + ".real")
    target.write_bytes(path.read_bytes())
    target.chmod(0o755)
    path.unlink()
    path.symlink_to(target)


def group_writable(path: Path) -> None:
    path.chmod(0o775)


def not_executable(path: Path) -> None:
    path.chmod(0o644)


BINARY_DEFECTS: list[tuple[str, Callable[[Path], None], SelfCheckReason, SelfCheckReason]] = [
    (
        "removed",
        lambda path: path.unlink(),
        SelfCheckReason.ENGINE_BINARY_MISSING,
        SelfCheckReason.RIPGREP_MISSING,
    ),
    (
        "tampered",
        tamper,
        SelfCheckReason.ENGINE_BINARY_CHECKSUM_MISMATCH,
        SelfCheckReason.RIPGREP_CHECKSUM_MISMATCH,
    ),
    (
        "a symbolic link",
        replace_by_link,
        SelfCheckReason.ENGINE_BINARY_MISSING,
        SelfCheckReason.RIPGREP_MISSING,
    ),
    (
        "writable by its group",
        group_writable,
        SelfCheckReason.ENGINE_BINARY_UNTRUSTED,
        SelfCheckReason.RIPGREP_UNTRUSTED,
    ),
    (
        "not executable",
        not_executable,
        SelfCheckReason.ENGINE_BINARY_MISSING,
        SelfCheckReason.RIPGREP_MISSING,
    ),
]


# #202-T09: the binary is the pinned one, and nobody but its owner can change it.
@pytest.mark.parametrize(
    ("label", "defect", "engine_reason", "_ripgrep_reason"),
    BINARY_DEFECTS,
    ids=[defect[0] for defect in BINARY_DEFECTS],
)
def test_an_engine_binary_that_is_not_the_pinned_trusted_file_is_refused(
    world: World,
    label: str,
    defect: Callable[[Path], None],
    engine_reason: SelfCheckReason,
    _ripgrep_reason: SelfCheckReason,
) -> None:
    defect(world.tools.opencode)

    error = refused(world)

    assert getattr(error, "reason", None) is engine_reason
    assert not any(call.startswith("probe") for call in world.calls)


# #202-T09
@pytest.mark.parametrize(
    ("label", "defect", "_engine_reason", "ripgrep_reason"),
    BINARY_DEFECTS,
    ids=[defect[0] for defect in BINARY_DEFECTS],
)
def test_a_ripgrep_that_is_not_the_pinned_trusted_file_is_refused(
    world: World,
    label: str,
    defect: Callable[[Path], None],
    _engine_reason: SelfCheckReason,
    ripgrep_reason: SelfCheckReason,
) -> None:
    defect(world.tools.ripgrep)

    error = refused(world)

    assert getattr(error, "reason", None) is ripgrep_reason


# #202-T09: a binary owned by anybody but the trusted owner could have been changed by them.
def test_a_binary_owned_by_another_user_is_refused(world: World) -> None:
    error = refused(world, trusted_owner=os.getuid() + 1)

    assert getattr(error, "reason", None) is SelfCheckReason.ENGINE_BINARY_UNTRUSTED


# #250 (nit 4) / #249-T04: a file is only as trusted as every directory above it. Somebody who can
# write into one of them can swap the whole subtree, however the file itself is owned.
UNTRUSTED_REASON = {
    "opencode": SelfCheckReason.ENGINE_BINARY_UNTRUSTED,
    "ripgrep": SelfCheckReason.RIPGREP_UNTRUSTED,
    "opencode_pin": SelfCheckReason.PIN_UNTRUSTED,
    "ripgrep_pin": SelfCheckReason.PIN_UNTRUSTED,
}
# How many directories above the file: its own, then the ones up to the root the chain is judged to
# (the tools and pins sit three directories below it).
LEVELS = [0, 1, 2, 3]


def first_to_notice_subject(world: World, directory: Path) -> str:
    """The first file whose chain holds `directory`, in the order of the check."""
    for subject in UNTRUSTED_REASON:
        if directory in getattr(world.tools, subject).parents:
            return subject
    raise AssertionError(directory)


def first_to_notice(world: World, directory: Path) -> SelfCheckReason:
    return UNTRUSTED_REASON[first_to_notice_subject(world, directory)]


def directory_above(world: World, subject: str, level: int) -> Path:
    path: Path = getattr(world.tools, subject)
    directory = path.parents[level]
    assert directory == world.anchor or world.anchor in directory.parents
    return directory


@pytest.mark.parametrize("subject", UNTRUSTED_REASON)
@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize("mode", [0o775, 0o757, 0o777, 0o1777], ids=oct)
def test_a_directory_above_a_pinned_file_that_others_can_write_is_refused(
    world: World, subject: str, level: int, mode: int
) -> None:
    directory = directory_above(world, subject, level)
    directory.chmod(mode)

    error = refused(world)

    assert getattr(error, "reason", None) is first_to_notice(world, directory)
    assert not any(call.startswith("probe") for call in world.calls)


@pytest.mark.parametrize("subject", UNTRUSTED_REASON)
@pytest.mark.parametrize("level", LEVELS)
def test_a_directory_above_a_pinned_file_owned_by_somebody_else_is_refused(
    world: World, subject: str, level: int
) -> None:
    foreign = directory_above(world, subject, level)

    def lstat(path: Path) -> os.stat_result:
        facts = os.lstat(path)
        if path != foreign:
            return facts
        fields = list(facts)
        fields[stat.ST_UID] = os.getuid() + 1
        return os.stat_result(tuple(fields))

    error = refused(world, lstat=lstat)

    assert getattr(error, "reason", None) is first_to_notice(world, foreign)


@pytest.mark.parametrize("subject", UNTRUSTED_REASON)
@pytest.mark.parametrize("level", [0, 1, 2])
def test_a_directory_above_a_pinned_file_that_is_a_link_is_refused(
    world: World, subject: str, level: int
) -> None:
    directory = directory_above(world, subject, level)
    real = directory.with_name(directory.name + ".real")
    directory.rename(real)
    directory.symlink_to(real, target_is_directory=True)

    error = refused(world)

    assert getattr(error, "reason", None) is first_to_notice(world, directory)


# #249-T04: a directory that is not there is a missing tool or pin, not an untrusted one: the
# documented reasons (docs/dynamic-review.md) are what an operator searches the log for.
MISSING_REASON = {
    "opencode": SelfCheckReason.ENGINE_BINARY_MISSING,
    "ripgrep": SelfCheckReason.RIPGREP_MISSING,
    "opencode_pin": SelfCheckReason.PIN_UNREADABLE,
    "ripgrep_pin": SelfCheckReason.PIN_UNREADABLE,
}


@pytest.mark.parametrize("subject", MISSING_REASON)
@pytest.mark.parametrize("level", [0, 1, 2])
def test_a_directory_above_a_pinned_file_that_does_not_exist_is_a_missing_file_not_an_untrusted_one(
    world: World, subject: str, level: int
) -> None:
    directory = directory_above(world, subject, level)
    shutil.rmtree(directory)

    error = refused(world)

    expected = MISSING_REASON[first_to_notice_subject(world, directory)]
    assert getattr(error, "reason", None) is expected


def test_a_directory_above_a_pinned_file_under_a_plain_file_is_a_missing_file(
    world: World,
) -> None:
    directory = directory_above(world, "opencode", 2)
    shutil.rmtree(directory)
    directory.write_text("not a directory", encoding="utf-8")

    error = refused(world)

    assert getattr(error, "reason", None) is SelfCheckReason.ENGINE_BINARY_MISSING


# #249-T04: the chain ends at the root it is given ("/" in the image), not above it.
def test_the_chain_of_directories_is_judged_up_to_its_root_and_no_further(world: World) -> None:
    world.anchor.parent.chmod(0o777)
    try:
        world.run()
    finally:
        world.anchor.parent.chmod(0o755)


@pytest.mark.parametrize("subject", ["opencode_pin", "ripgrep_pin"])
@pytest.mark.parametrize("mode", [0o664, 0o646, 0o666])
def test_a_pin_file_that_others_can_write_is_refused(world: World, subject: str, mode: int) -> None:
    getattr(world.tools, subject).chmod(mode)

    error = refused(world)

    assert getattr(error, "reason", None) is SelfCheckReason.PIN_UNTRUSTED


def test_a_pin_file_that_is_a_link_is_refused(world: World) -> None:
    replace_by_link(world.tools.opencode_pin)

    error = refused(world)

    assert getattr(error, "reason", None) is SelfCheckReason.PIN_UNTRUSTED


# #202-T09
def test_an_engine_that_reports_another_version_is_refused(world: World) -> None:
    error = refused(world, version_as_user=reports_another_version)

    assert getattr(error, "reason", None) is SelfCheckReason.ENGINE_VERSION_MISMATCH


# #202-T09: the version is asked as the engine user, so a binary it cannot execute is refused.
def test_the_version_is_asked_as_the_engine_user(world: World) -> None:
    asked: list[tuple[Path, int, int]] = []

    def version(path: Path, uid: int, gid: int) -> str:
        asked.append((path, uid, gid))
        return VERSION

    world.run(version_as_user=version)

    assert asked == [(world.tools.opencode, 10101, 10101)]


# #202-T09
@pytest.mark.parametrize("pin", ["opencode_pin", "ripgrep_pin"])
@pytest.mark.parametrize("content", [None, "not json", "[]", '{"version": "1.19.0"}'])
def test_a_pin_that_cannot_be_read_is_refused(world: World, pin: str, content: str | None) -> None:
    path: Path = getattr(world.tools, pin)
    if content is None:
        path.unlink()
    else:
        path.write_text(content, encoding="utf-8")

    error = refused(world)

    assert getattr(error, "reason", None) is SelfCheckReason.PIN_UNREADABLE


# #202-T09: a platform without a pinned artifact is not a platform the engine may run on.
def test_a_platform_without_a_pinned_artifact_is_refused(world: World) -> None:
    error = refused(world, platform="linux-arm64")

    assert getattr(error, "reason", None) is SelfCheckReason.PIN_UNREADABLE


# #264-T10: an image without the engine files (no pin for its platform) reports the documented
# missing-engine reason and serves Diff only.
def test_an_image_built_without_the_engine_on_an_unpinned_platform_reports_the_missing_engine(
    world: World,
) -> None:
    world.tools.opencode.unlink()
    world.tools.ripgrep.unlink()

    error = refused(world, platform="linux-arm64")
    engines, outcome = self_check_outcome(lambda: world.run(platform="linux-arm64"))

    assert getattr(error, "reason", None) is SelfCheckReason.ENGINE_BINARY_MISSING
    assert engines == (ENGINE_DIFF,)
    assert outcome is not None and outcome.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED


# #202-T09: the stat of a file must not follow a link planted in the way.
def test_the_binary_file_is_a_regular_file_with_no_write_bit_for_others(world: World) -> None:
    mode = stat.S_IMODE(world.tools.opencode.stat().st_mode)
    assert mode & 0o022 == 0

    world.run()


# #202-T01 / #195-T09: a failing check never advertises; a passing check advertises both engines.
def test_a_failed_check_never_advertises_opencode_and_a_passing_one_does(world: World) -> None:
    engines, error = self_check_outcome(lambda: world.run())
    assert engines == ALL_ENGINES and error is None

    engines, error = self_check_outcome(lambda: world.run(rules_installed=False))
    assert engines == (ENGINE_DIFF,)
    assert ENGINE_DYNAMIC not in engines
    assert error is not None and error.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED


# #202-T09: whatever raises, the capability is not advertised and the runner still serves Diff.
def test_an_unexpected_error_in_the_check_never_advertises(world: World) -> None:
    def broken(uid: int) -> int | None:
        raise OSError("passwd database unreachable")

    engines, error = self_check_outcome(lambda: world.run(user_group=broken))

    assert engines == (ENGINE_DIFF,)
    assert error is not None and error.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED


# #202-T01: where the image puts the tools is where the self-check looks.
def test_the_default_tool_locations_are_the_ones_the_image_installs() -> None:
    dockerfile = (Path(__file__).parents[2] / "Dockerfile").read_text(encoding="utf-8")

    # The executables are copied into their directory (the whole fetch directory, so the build also
    # works where nothing was fetched, #264) under the names the fetch scripts give them; the pins
    # are copied into their directory.
    assert DEFAULT_TOOLS.opencode.parent == DEFAULT_TOOLS.ripgrep.parent
    assert f" /engine-tools/ {DEFAULT_TOOLS.opencode.parent}/" in dockerfile
    assert (DEFAULT_TOOLS.opencode.name, DEFAULT_TOOLS.ripgrep.name) == ("opencode", "rg")
    assert DEFAULT_TOOLS.opencode_pin.parent == DEFAULT_TOOLS.ripgrep_pin.parent
    assert f"{DEFAULT_TOOLS.opencode_pin.parent}/" in dockerfile
    for pin in (DEFAULT_TOOLS.opencode_pin, DEFAULT_TOOLS.ripgrep_pin):
        assert f"runner/{pin.name}" in dockerfile


# #324-T02: a root filesystem that is writable is no hardened container; the entry modes of the
# Worker image ask for the check, the legacy loop does not (it never had it).
def test_a_writable_root_filesystem_fails_the_check_when_it_is_asked_for(world: World) -> None:
    error = refused(world, root_read_only=lambda: False)

    assert isinstance(error, IsolationSelfCheckError)
    assert getattr(error, "reason", None) is SelfCheckReason.ROOT_FILESYSTEM_WRITABLE
    assert world.calls == ["capabilities"]  # before the tools are read and before the probe


# #324-T01
def test_a_read_only_root_filesystem_passes_the_check_when_it_is_asked_for(world: World) -> None:
    world.run(root_read_only=lambda: True)

    assert world.calls == ["capabilities", "probe:10101:10101:10180"]


# #324-T08: not asked for, not judged: the legacy loop behaves as it always did.
def test_the_root_filesystem_is_not_judged_unless_it_is_asked_for(world: World) -> None:
    world.run()  # no root_read_only: a writable test machine passes


def test_the_real_root_check_reads_the_mount_flag(tmp_path: Path) -> None:
    from code_reviewer_runner.dynamic_review.self_check import root_filesystem_read_only

    # The test machine's root is writable; a directory that does not exist is not read-only.
    assert root_filesystem_read_only(tmp_path) is False
    assert root_filesystem_read_only(tmp_path / "missing") is False
