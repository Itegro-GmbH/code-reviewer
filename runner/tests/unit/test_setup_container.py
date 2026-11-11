# SPDX-License-Identifier: LicenseRef-Proprietary

"""The container an environment's script runs in (#818, #1009), against the fake Docker Engine of
`fakes/docker_engine`.

The questions: what the daemon is asked for (the agent's container, a Sysbox container from the
agent's image with the repository and nothing else, no secret and no variable in any body), that the
VM's rules for its bridge go in first and are only drops, that the script runs as a file in the
container with the streams merged, that a script that fails or runs out of time or a container that
goes away is told apart, that a script that ended well leaves the container alive, off the setup
network and frozen, for the agent to take over (nothing is stopped, committed or reset), and that
a container that is not handed over is always taken away."""

import contextlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, BinaryIO

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.docker_engine.server import (
    AGENT_IMAGE_ID,
    HOSTNAME,
    IMAGE_ID,
    FakeDockerEngine,
    FakeExec,
)

from code_reviewer_runner.implementer import host_rules
from code_reviewer_runner.implementer import setup_container as sc
from code_reviewer_runner.implementer.agent_container import (
    AGENT_CONTAINER_NAME,
    READY_FILE,
    WRITE_FILE_SCRIPT,
    agent_document,
)
from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError
from code_reviewer_runner.implementer.door_launcher import PRIVATE_RANGES
from code_reviewer_runner.implementer.setup_container import (
    OUTCOME_NOT_HANDED_OVER,
    OUTCOME_OK,
    OUTCOME_SCRIPT_FAILED,
    OUTCOME_STOPPED,
    OUTCOME_TIMED_OUT,
    OUTCOME_UNAVAILABLE,
    SetupContainer,
    SetupSeams,
    Tail,
    setup_document,
)

TOKEN = "ghs_dummy-token-0123456789"
KEY = "sk-real-key-0123456789abcdef"


class Rig:
    def __init__(self, directory: Path) -> None:
        self.socket = directory / "docker.sock"
        self.engine = FakeDockerEngine(self.socket).start()
        self.engine.exec_behaviour = self.behave
        self.script_exit = 0
        self.script_text = ""
        self.script_output = "installing\n"
        self.script_waits = False
        # Set when the script's exec begins: tests that stop the run or the container while the
        # script runs wait for this, not for a time (a slow host starts the container later than
        # any timer).
        self.script_started = threading.Event()
        self.execs: list[tuple[list[str], dict[str, str], str | None]] = []
        # The VM's memory as `MemoryGuard` reads it: plenty, until a test says otherwise.
        self.meminfo = directory / "meminfo"
        self.set_left(6_000_000)

    def set_left(self, kib: int) -> None:
        self.meminfo.write_text(
            f"MemTotal: 8000000 kB\nMemFree: {kib} kB\nActive(file): 1 kB\nInactive(file): 1 kB\n"
        )

    def api(self) -> DockerApi:
        return DockerApi(str(self.socket), timeout=5.0)

    def seams(self, **options: Any) -> SetupSeams:
        base: dict[str, Any] = {
            "api": self.api,
            "hostname": lambda: HOSTNAME,
            "ready_seconds": 5.0,
            "meminfo": str(self.meminfo),
        }
        base.update(options)
        return SetupSeams(**base)

    def behave(self, made: FakeExec, stdin: BinaryIO, stdout: Any) -> int:
        argv: list[str] = made.document["Cmd"]
        env = dict(item.split("=", 1) for item in made.document.get("Env", []))
        self.execs.append((argv, env, made.document.get("WorkingDir")))
        if argv[:2] == ["/usr/bin/test", "-e"]:
            return 0
        if argv[:3] == ["/bin/sh", "-c", WRITE_FILE_SCRIPT]:
            self.script_text = stdin.read().decode()
            return 0
        if argv[:3] == ["/bin/sh", "-c", sc.RUN_SCRIPT]:
            self.script_started.set()
            stdout.write(self.script_output)
            if self.script_waits:
                made.killed.wait(30)
                return 137
            return self.script_exit
        return 0

    def stop(self) -> None:
        self.engine.stop()


@pytest.fixture
def rig() -> Iterator[Rig]:
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="setup-") as directory:
        made = Rig(Path(directory))
        yield made
        made.stop()


def run(made: Rig, script: str = "echo hi\n", seconds: float = 5.0, **options: Any) -> sc.SetupRun:
    stop = options.pop("should_stop", lambda: False)
    return SetupContainer(2048, made.seams(**options)).run(
        script, script_seconds=seconds, should_stop=stop
    )


def calls_text(engine: FakeDockerEngine) -> str:
    return json.dumps([[method, target, body] for method, target, body in engine.calls])


def made_containers(engine: FakeDockerEngine) -> list[str]:
    return [c.name for c in engine.containers.values()]


# -- the definition -------------------------------------------------------------------------------


# #818-T01
def test_the_setup_container_is_the_agent_image_under_sysbox_with_the_repository_and_nothing_else(
    rig: Rig,
) -> None:
    done = run(rig)
    assert done.outcome == OUTCOME_OK
    setup = next(c for c in rig.engine.containers.values() if c.name == AGENT_CONTAINER_NAME)
    document = setup.document
    host = document["HostConfig"]
    assert document["Image"] == AGENT_IMAGE_ID
    assert document["User"] == "0:0"
    assert document["Env"] == []
    assert document["Hostname"] == "agent", "it is the agent's container"
    assert host["Runtime"] == "sysbox-runc"
    assert host["Privileged"] is False
    assert host["NetworkMode"] == sc.SETUP_NETWORK_NAME
    assert host["Memory"] == host["MemorySwap"] == 2048 * 1024 * 1024
    assert host["OomScoreAdj"] == 1000, "the VM's OOM killer takes the container before Control"
    assert host["Dns"] == list(sc.SETUP_DNS)
    assert [m["Target"] for m in host["Mounts"]] == ["/work/repo"]
    assert host["Mounts"][0]["VolumeOptions"]["Subpath"] == "repo"
    # No socket, device, bind, capability change, published port or host namespace.
    for key in ("Binds", "Devices", "CapAdd", "PidMode", "IpcMode", "PortBindings"):
        assert key not in host


# #818-T02
def test_nothing_secret_is_in_any_request_to_the_daemon(rig: Rig) -> None:
    run(rig, script="echo hi\n")
    text = calls_text(rig.engine)
    for secret in (TOKEN, KEY, "api_key", "apiKey", "token"):
        assert secret not in text.replace("accessToken", "")
    # The container's definition has no environment, no label of a job, no argument of a job.
    setup = next(c for c in rig.engine.containers.values() if c.name == AGENT_CONTAINER_NAME)
    assert setup.document["Cmd"] == []
    assert setup.document["Labels"] == {"code-reviewer.role": "agent"}


# #818-T03
def test_the_document_is_made_of_constants_and_the_given_names_only() -> None:
    first = setup_document("sha256:aa", "volume-1", 1_000_000)
    second = setup_document("sha256:aa", "volume-1", 1_000_000)
    assert first == second
    # The agent's container but for its network: the same image, limits, labels and mounts, so that
    # nothing about it changes when the agent takes it over.
    agent = agent_document("sha256:aa", "volume-1", 1_000_000)
    for key in ("Image", "Entrypoint", "User", "Hostname", "WorkingDir", "Labels"):
        assert first[key] == agent[key]
    assert first["HostConfig"]["Mounts"] == agent["HostConfig"]["Mounts"]
    assert (
        first["HostConfig"]["NetworkMode"]
        == sc.SETUP_NETWORK_NAME
        != agent["HostConfig"]["NetworkMode"]
    )
    assert set(first) == {
        "Image", "Entrypoint", "Cmd", "User", "Env", "Hostname", "WorkingDir", "Labels",
        "NetworkingConfig", "HostConfig",
    }  # fmt: skip


# -- the network -----------------------------------------------------------------------------------


# #818-T04
def test_the_rules_close_everything_of_ours_and_only_drop() -> None:
    rules = sc.EGRESS_RULES.split("; ")
    # An ip table of the host namespace, before Docker's own rules, that never accepts anything
    # but what it does not mention (policy accept) and whose rules are all drops.
    assert rules[0] == f"add table ip {sc.EGRESS_TABLE}"
    rule_lines = [r for r in rules if " rule " in r]
    assert rule_lines and all(r.endswith(" drop") for r in rule_lines)
    assert all("priority -10" in r for r in rules if " chain " in r)
    # The VM itself (input) from the bridge.
    assert f'input iifname "{sc.SETUP_BRIDGE}" drop' in sc.EGRESS_RULES
    # Every private, link-local, shared and special range, through the VM.
    joined = " ".join(rule_lines)
    for private in PRIVATE_RANGES:
        assert private in joined
    # The other bridges in both directions. (No IPv6 rule: the VM's kernel has no `ip6` or `inet`
    # netfilter and does not forward IPv6; measured, `docs/implementer.md`.)
    assert "inet" not in sc.EGRESS_RULES and "ipv6" not in sc.EGRESS_RULES
    for other in ("docker0", "br-*", "veth*"):
        assert f'oifname "{other}" drop' in joined
    # The 23456 control port needs no rule of its own: it is on the VM, which input drops entirely.
    assert "23456" not in sc.EGRESS_RULES
    # The bridge is named, so the rules can name it before it exists.
    assert sc.network_document()["Options"]["com.docker.network.bridge.name"] == sc.SETUP_BRIDGE
    assert sc.network_document()["Internal"] is False


# #818-T05
def test_the_vms_side_of_the_bridge_is_closed_before_the_setup_container_exists(rig: Rig) -> None:
    done = run(rig)
    assert done.outcome == OUTCOME_OK
    helpers = [c for c in rig.engine.containers.values() if c.name == host_rules.HELPER_NAME]
    roles = [c.document["Labels"]["code-reviewer.role"] for c in helpers]
    assert roles == ["bridge-ipv6", "setup-rules", "setup-rules-check", "setup-ipv6-rules"]
    ipv6, rules, check, inet = helpers
    assert ipv6.document["Cmd"] == [
        f"ip link set dev {sc.SETUP_BRIDGE} addrgenmode none "
        f"&& ip -6 addr flush dev {sc.SETUP_BRIDGE}"
    ]
    assert rules.document["Cmd"] == [sc.EGRESS_RULES] and check.document["Cmd"] == [sc.CHECK_RULES]
    # The IPv6 helper runs from the agent image (it has `ip`), the rules from the Worker's (it has
    # `nft`).
    assert (
        ipv6.document["Image"] == sc.AGENT_IMAGE_REFERENCE and rules.document["Image"] == IMAGE_ID
    )
    # The `inet` table beside the `ip` one: only drops, from the Setup bridge, in the Worker's
    # image.
    assert inet.document["Cmd"] == [host_rules.inet_rules("setup", sc.SETUP_BRIDGE)]
    assert inet.document["Image"] == IMAGE_ID
    assert inet.document["Entrypoint"] == ["/bin/sh", "-c", host_rules.INET_SCRIPT, "inet-rules"]
    assert host_rules.NFT in host_rules.INET_SCRIPT
    for helper in helpers:
        host = helper.document["HostConfig"]
        assert host["NetworkMode"] == "host"
        assert host["CapAdd"] == ["NET_ADMIN"] and host["CapDrop"] == ["ALL"]
        assert host["Privileged"] is False and "Mounts" not in host and "Binds" not in host
        assert helper.document["Env"] == [] and host["ReadonlyRootfs"] is True
    # All of it before the Setup container was made.
    created = [
        target
        for method, target, _ in rig.engine.calls
        if method == "POST" and "containers/create" in target
    ]
    assert created[-1].endswith(AGENT_CONTAINER_NAME)
    assert all(t.endswith(host_rules.HELPER_NAME) for t in created[:-1])


# #818-T06
def test_a_setup_whose_rules_did_not_go_in_is_never_started(rig: Rig) -> None:
    rig.engine.rules_exit = 1
    done = run(rig)
    assert done.outcome == OUTCOME_UNAVAILABLE
    assert "network rules" in done.detail
    assert not any(
        t == "/containers/create?name=" + AGENT_CONTAINER_NAME for _, t, _ in rig.engine.calls
    )
    assert rig.engine.networks == {}, "the network is taken away again"


# #818-T06b
def test_a_setup_whose_bridge_could_not_be_closed_to_ipv6_is_never_started(rig: Rig) -> None:
    rig.engine.ipv6_exit = 1
    done = run(rig)
    assert done.outcome == OUTCOME_UNAVAILABLE and "network rules" in done.detail
    assert not any(
        t == "/containers/create?name=" + AGENT_CONTAINER_NAME for _, t, _ in rig.engine.calls
    )


# #818-IPV6-01
def test_a_kernel_without_the_inet_family_does_not_stop_the_setup_and_needs_no_note(
    rig: Rig,
) -> None:
    """The platform's kernel has no `inet` netfilter (measured): the table is tried, its absence is
    not a failure, and the container starts behind the `ip` table and the missing bridge address."""
    rig.engine.inet_exit = host_rules.INET_NO_FAMILY_EXIT
    done = run(rig)
    assert done.outcome == OUTCOME_OK
    assert not any("inet table" in note for note in done.notes)


# #818-IPV6-01b
def test_a_kernel_with_the_inet_family_that_refuses_the_table_is_a_note_of_the_run(
    rig: Rig,
) -> None:
    rig.engine.inet_exit = 1
    done = run(rig)
    assert done.outcome == OUTCOME_OK
    assert host_rules.inet_failure_note("Setup") in done.notes


# #818-IPV6-02
def test_the_inet_table_drops_ipv6_from_the_bridge_to_the_vm_and_to_private_ranges() -> None:
    rules = host_rules.inet_rules("setup", sc.SETUP_BRIDGE)
    assert "add table inet implementer_ipv6_setup" in rules
    assert rules.count("flush table inet") == 1, "a second install is the same as the first"
    # Nothing but drops, and every rule is about the one bridge.
    assert "accept" not in rules.replace("policy accept", "")
    assert f'input iifname "{sc.SETUP_BRIDGE}" meta nfproto ipv6 drop' in rules
    assert f'forward iifname "{sc.SETUP_BRIDGE}" ip6 daddr' in rules
    for private in ("::1/128", "::ffff:0:0/96", "fc00::/7", "fe80::/10", "ff00::/8"):
        assert private in rules
    # A role and a bridge are words, never values.
    with pytest.raises(host_rules.HelperFailed):
        host_rules.inet_rules("setup; flush ruleset", sc.SETUP_BRIDGE)
    with pytest.raises(host_rules.HelperFailed):
        host_rules.inet_rules("setup", 'br0" drop; add rule')


# -- the script ------------------------------------------------------------------------------------


# #818-T07
def test_the_script_is_a_file_in_the_container_run_as_root_in_the_repository(rig: Rig) -> None:
    done = run(rig, script="#!/bin/bash\napt-get update\n")
    assert done.outcome == OUTCOME_OK and done.exit_code == 0
    assert rig.script_text == "#!/bin/bash\napt-get update\n"
    ran = next(e for e in rig.execs if e[0][:3] == ["/bin/sh", "-c", sc.RUN_SCRIPT])
    assert ran[0][3:] == ["run", sc.SCRIPT_PATH, sc.SCRIPT_OUTPUT]
    assert ran[1] == sc.SCRIPT_ENVIRONMENT
    assert ran[2] == "/work/repo"
    # The script is never in an argument of a call: it is the standard input of one exec.
    assert "apt-get" not in calls_text(rig.engine)
    # Both streams in one, in order, in a file and not the exec's stream: the shell around the
    # script does it (`> "$2" 2>&1`, run for real by the `Shell` tests below).
    assert '> "$2" 2>&1' in sc.RUN_SCRIPT


# #818-T08
def test_the_end_of_the_output_is_kept_and_bounded(rig: Rig) -> None:
    rig.script_output = "x" * 200_000 + "THE END\n"
    done = run(rig)
    assert done.output.endswith(b"THE END\n")
    assert len(done.output) <= sc.OUTPUT_KEEP_BYTES
    assert done.output_bytes == 200_008


def test_the_tail_keeps_the_last_bytes_whatever_the_chunks() -> None:
    tail = Tail(10)
    for chunk in (b"abcdef", b"ghijkl", b"mnopqrstuvwxyz"):
        tail.add(chunk)
    assert tail.value() == b"qrstuvwxyz" and tail.total == 26


# #818-T09
def test_a_script_that_exits_non_zero_is_its_own_outcome_and_nothing_is_handed_over(
    rig: Rig,
) -> None:
    rig.script_exit = 3
    done = run(rig)
    assert done.outcome == OUTCOME_SCRIPT_FAILED and done.exit_code == 3
    assert done.container is None and done.adopted is None
    # The container and the network are gone.
    assert all(c.removed for c in rig.engine.containers.values())
    assert rig.engine.networks == {}


# #818-T10
def test_a_script_that_runs_out_of_time_is_killed_and_its_output_is_kept(rig: Rig) -> None:
    rig.script_waits = True
    rig.script_output = "still going\n"
    done = run(rig, seconds=0.5)
    assert done.outcome == OUTCOME_TIMED_OUT and done.exit_code is None
    assert done.output == b"still going\n"
    assert done.container is None
    assert all(c.removed for c in rig.engine.containers.values())


# #818-T11
def test_a_stop_of_the_runner_ends_the_script_and_removes_the_container(rig: Rig) -> None:
    rig.script_waits = True
    # The stop is asked for exactly when the script is running, however long the start took.
    done = run(rig, seconds=30, should_stop=rig.script_started.is_set)
    assert rig.script_started.is_set()
    assert done.outcome == OUTCOME_STOPPED
    assert all(c.removed for c in rig.engine.containers.values())


# #818-T12
def test_a_container_killed_under_the_script_is_the_scripts_and_says_why(rig: Rig) -> None:
    rig.script_waits = True

    def oom() -> None:
        rig.script_started.wait(30)
        setup = next(c for c in rig.engine.containers.values() if c.name == AGENT_CONTAINER_NAME)
        rig.engine.kill(setup.name, exit_code=137, oom=True)

    threading.Thread(target=oom, daemon=True).start()
    done = run(rig, seconds=30)
    assert done.outcome == OUTCOME_SCRIPT_FAILED
    assert "killed for its memory" in done.detail


# #745-S6-07
def test_a_vm_running_out_of_memory_ends_the_script_and_says_so(rig: Rig) -> None:
    rig.script_waits = True

    def squeeze() -> None:
        rig.script_started.wait(30)
        rig.set_left(300_000)  # 293 MiB of 7.6 GiB: below the floor

    threading.Thread(target=squeeze, daemon=True).start()
    done = run(rig, seconds=30)
    assert done.outcome == OUTCOME_SCRIPT_FAILED
    assert "because the VM was running out of memory" in done.detail
    assert done.detail.startswith("vm_memory: ")
    assert all(c.removed for c in rig.engine.containers.values())


# -- the hand-over ---------------------------------------------------------------------------------


def posted(engine: FakeDockerEngine) -> list[str]:
    """The requests of the run as `METHOD kind[/verb]`, in order, for the order of the hand-over."""
    seen: list[str] = []
    for method, target, _ in engine.calls:
        parts = target.split("?")[0].strip("/").split("/")
        seen.append(f"{method} {parts[0]}{'/' + parts[-1] if len(parts) > 2 else ''}")
    return seen


# #1009-S01
def test_a_script_that_ended_well_leaves_the_container_alive_and_nothing_is_committed_or_stopped(
    rig: Rig,
) -> None:
    done = run(rig)
    assert done.outcome == OUTCOME_OK and done.exit_code == 0
    setup = rig.engine.container(AGENT_CONTAINER_NAME)
    assert done.container == setup.identifier
    assert setup.running and not setup.removed, "the processes of the script keep running"
    names = posted(rig.engine)
    assert "POST commit" not in names
    assert not any(n.endswith("/stop") or n.endswith("/kill") for n in names)
    # Nothing of the script is reset: it is the same container, frozen while Control reads the
    # repository (the agent's container object unfreezes it).
    assert setup.paused
    assert done.adopted is not None and done.adopted.container == setup.identifier
    assert done.adopted.paused is True and done.adopted.setup_environment == ()


# #1009-S02
def test_the_container_leaves_the_setup_network_before_it_is_frozen_and_the_network_stays(
    rig: Rig,
) -> None:
    """The daemon refuses to connect a container whose network mode names a removed network (KVM
    lane, #1009), so whoever connects the model network removes the setup network afterwards."""
    done = run(rig)
    assert done.outcome == OUTCOME_OK
    names = posted(rig.engine)
    left = names.index("POST networks/disconnect")
    assert left < names.index("POST containers/pause")
    assert len(names) - 1 - names[::-1].index("DELETE networks") < left, "only the early clean-up"
    assert len(rig.engine.networks) == 1, "the setup network is left for the agent's step"
    assert done.adopted is not None and done.adopted.setup_network == sc.SETUP_NETWORK_NAME
    setup = rig.engine.container(AGENT_CONTAINER_NAME)
    assert set(setup.networks) == set(), "it has no network at all until the agent takes it over"
    # The one thing the agent's tools must not find: the script's file.
    assert any(e[0][:3] == ["/bin/sh", "-c", sc.CLEAN_SCRIPT] for e in rig.execs)
    assert 'rm -f "$1" "$2"' in sc.CLEAN_SCRIPT


# #1009-S03
def test_a_container_that_cannot_be_frozen_is_not_handed_over_and_is_removed(rig: Rig) -> None:
    """A refused freeze is a failure, not a note: the script's root processes would go on writing
    the repository (a link into the work volume) while Control reads it."""
    rig.engine.pause_refused = 500
    done = run(rig)
    assert done.outcome == OUTCOME_NOT_HANDED_OVER and done.container is None
    assert done.adopted is None
    assert "could not be frozen" in done.detail
    assert all(c.removed for c in rig.engine.containers.values())


# #1009-S03b
def test_a_freeze_the_daemon_answers_with_a_conflict_is_not_handed_over_either(rig: Rig) -> None:
    rig.engine.pause_refused = 409
    done = run(rig)
    assert done.outcome == OUTCOME_NOT_HANDED_OVER and done.adopted is None
    assert all(c.removed for c in rig.engine.containers.values())


# #1009-S03c
def test_a_freeze_that_was_answered_but_that_the_daemon_does_not_report_is_not_trusted(
    rig: Rig,
) -> None:
    """After a 204 the daemon is asked: `State.Paused` is what says the container is frozen."""
    rig.engine.pause_has_no_effect = True
    done = run(rig)
    assert done.outcome == OUTCOME_NOT_HANDED_OVER and done.adopted is None
    assert "not report" in done.detail
    assert all(c.removed for c in rig.engine.containers.values())


# #1009-S03d
def test_a_freeze_the_client_gave_up_on_is_looked_at_and_taken_when_the_daemon_did_it(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A client timeout is no answer: the daemon is asked what it did, never guessed about."""
    monkeypatch.setattr(sc, "HANDOVER_SECONDS", 0.5)
    rig.engine.pause_answers_after = 2.0
    done = run(rig)
    assert done.outcome == OUTCOME_OK and done.adopted is not None
    assert done.adopted.paused is True
    assert rig.engine.container(AGENT_CONTAINER_NAME).paused


# #1009-S03e
def test_a_freeze_the_client_gave_up_on_and_the_daemon_did_not_do_is_not_handed_over(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sc, "HANDOVER_SECONDS", 0.5)
    rig.engine.pause_answers_after = 2.0
    rig.engine.pause_has_no_effect = True
    done = run(rig)
    assert done.outcome == OUTCOME_NOT_HANDED_OVER and done.adopted is None
    assert all(c.removed for c in rig.engine.containers.values())


# #1009-S03f
def test_the_memory_guard_keeps_watching_until_the_freeze_is_confirmed(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The container is still running while the freeze is asked for: a VM that runs out of memory
    meanwhile still loses the container (it is no longer in the agent's or Control's hands)."""
    monkeypatch.setattr(sc, "HANDOVER_SECONDS", 5.0)
    rig.engine.pause_answers_after = 1.5

    def low_once_the_freeze_is_asked_for() -> None:
        for _ in range(200):
            if any(target.endswith("/pause") for _, target, _ in list(rig.engine.calls)):
                break
            threading.Event().wait(0.02)
        rig.set_left(300_000)

    threading.Thread(target=low_once_the_freeze_is_asked_for, daemon=True).start()
    done = run(rig)
    assert done.outcome == OUTCOME_NOT_HANDED_OVER and done.adopted is None
    assert any(n.endswith("/kill") for n in posted(rig.engine))


# #1009-S03g
def test_a_container_the_script_left_frozen_is_not_one_the_turn_can_exec_into(rig: Rig) -> None:
    """The fake daemon refuses an exec in a frozen container as the real one does, so a step that
    ran a command after the freeze would fail here and not only on a VM."""
    done = run(rig)
    assert done.outcome == OUTCOME_OK
    api = rig.api()
    with pytest.raises(DockerError) as refused:
        api.create_exec(done.container or "", {"Cmd": ["/bin/true"]})
    assert refused.value.status == 409


# #1009-S04
def test_a_container_that_cannot_leave_the_setup_network_is_not_handed_over_and_is_removed(
    rig: Rig,
) -> None:
    """The one step that must hold: a container still on the setup network would keep the internet
    into the agent's turn."""
    rig.engine.refuse["/disconnect"] = 500
    done = run(rig)
    assert done.outcome == OUTCOME_NOT_HANDED_OVER and done.container is None
    assert done.adopted is None
    assert "could not be handed to the agent" in done.detail
    assert all(c.removed for c in rig.engine.containers.values())


# #1009-S05
def test_the_proxy_variables_of_a_customers_machine_are_the_setups_and_the_agent_is_told(
    rig: Rig,
) -> None:
    from code_reviewer_runner.outer_proxy import OuterProxy

    proxy = OuterProxy("10.99.0.1", 3128)
    done = run(rig, outer_proxy=proxy, install_rules=False)
    assert done.adopted is not None
    assert done.adopted.setup_environment == tuple(proxy.tool_environment())


# #745-T11 (#827), #1009: the guard of the script's phase stops with the hand-over; the container is
# alive afterwards and a VM that runs low no longer kills it under the setup's step
def test_the_guard_is_closed_at_the_hand_over(rig: Rig) -> None:
    done = run(rig)
    assert done.outcome == OUTCOME_OK
    rig.set_left(300_000)  # below the floor, after the hand-over
    threading.Event().wait(0.6)  # more than five looks of the guard
    assert rig.engine.container(AGENT_CONTAINER_NAME).running, "the guard did not kill it"


# #1009-OVERHEAD-01
def test_the_overhead_counts_the_rules_the_ready_wait_the_kill_steps_and_the_hand_over() -> None:
    parts = (
        sc.RULES_SECONDS * 4 + sc.READY_SECONDS + sc.SCRIPT_WRITE_SECONDS + sc.HANDOVER_SECONDS * 4
    )
    # A script that has to be killed: the kill, the wait for its exec, and the kill of the clean-up.
    assert sc.KILL_STEPS_SECONDS == 3 * sc.KILL_SECONDS
    assert parts + 3 * sc.KILL_SECONDS == sc.SETUP_OVERHEAD_SECONDS


# -- the script run for real: the shell around it (#1009) ------------------------------------------


class Shell:
    """`RUN_SCRIPT` run by the host's `/bin/sh` as the exec runs it in the container: its standard
    output is a pipe, read to its end, as the daemon's attach is."""

    def __init__(self, directory: Path, text: str) -> None:
        self.script = directory / "setup.sh"
        self.script.write_text(text)
        self.output_file = directory / "setup.out"
        self.pid_file = directory / "daemon.pid"
        self.ended = False
        self.status: int | None = None
        self.seen = bytearray()
        self.process = subprocess.Popen(
            ["/bin/sh", "-c", sc.RUN_SCRIPT, "run", str(self.script), str(self.output_file)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        def read() -> None:
            assert self.process.stdout is not None
            while chunk := self.process.stdout.read(65536):
                self.seen += chunk
            self.ended = True

        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()

    def finish(self, seconds: float = 20.0) -> None:
        self.status = self.process.wait(timeout=seconds)
        self.reader.join(5.0)

    def daemon(self) -> int | None:
        text = self.pid_file.read_text().strip() if self.pid_file.exists() else ""
        return int(text) if text.isdigit() else None


@pytest.fixture
def shell(tmp_path: Path) -> Iterator[Callable[[str], Shell]]:
    made: list[Shell] = []

    def start(text: str) -> Shell:
        made.append(Shell(tmp_path, text))
        return made[-1]

    yield start
    for each in made:
        pid = each.daemon()
        if pid is not None:
            with contextlib.suppress(ProcessLookupError):
                os.kill(pid, signal.SIGKILL)
        each.process.kill()


# #1009-D01
def test_a_daemon_that_inherits_the_scripts_output_does_not_keep_the_exec_stream_open(
    shell: Callable[[str], Shell], tmp_path: Path
) -> None:
    """`nohup postgres &`, `pg_ctl start`, `./server &`: the daemon holds whatever standard output
    the script had. With the daemon holding the exec's pipe the stream never ended, the step waited
    for its time limit though the script had exited 0, and the daemon got SIGPIPE later."""
    pid_file = tmp_path / "daemon.pid"
    run_it = shell(
        f"nohup /bin/sh -c 'echo $$ > {pid_file}; exec sleep 120' &\n"
        f"for i in $(seq 1 50); do [ -s {pid_file} ] && break; sleep 0.1; done\n"
        "echo started\n"
    )
    run_it.finish()
    assert run_it.status == 0
    assert run_it.ended, "the stream ended with the script, not with the daemon"
    assert bytes(run_it.seen) == b"started\n"
    pid = run_it.daemon()
    assert pid is not None
    os.kill(pid, 0)  # still there for the agent
    # Its standard output is the script's output file, not the pipe of the exec: nothing for it to
    # keep open and no SIGPIPE when the pipe goes.
    target = os.readlink(f"/proc/{pid}/fd/1")
    assert not target.startswith("pipe:") and target == str(run_it.output_file), target
    assert os.readlink(f"/proc/{pid}/fd/2") == str(run_it.output_file)


# #1009-D02
def test_the_exit_status_is_the_scripts_and_both_its_streams_are_in_the_output_in_order(
    shell: Callable[[str], Shell],
) -> None:
    run_it = shell("#!/bin/sh\necho first\necho second >&2\necho third\nexit 7\n")
    run_it.finish()
    assert run_it.status == 7
    assert bytes(run_it.seen) == b"first\nsecond\nthird\n"


# #1009-D03
def test_a_script_without_a_shebang_runs_under_bash_dash_e(shell: Callable[[str], Shell]) -> None:
    run_it = shell("false\necho not-reached\n")
    run_it.finish()
    assert run_it.status == 1
    assert bytes(run_it.seen) == b""


# #1009-D04
def test_a_long_output_arrives_whole_and_in_order(shell: Callable[[str], Shell]) -> None:
    run_it = shell("i=0; while [ $i -lt 20000 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; "
                   "i=$((i+1)); done\n")
    run_it.finish(60.0)
    lines = bytes(run_it.seen).decode().splitlines()
    assert run_it.status == 0
    assert len(lines) == 20000 and lines[0].startswith("line-0-") and lines[-1].startswith(
        "line-19999-"
    )


# #1009-D05
def test_the_script_has_no_input(shell: Callable[[str], Shell]) -> None:
    run_it = shell("read -r line || echo no-input\n")
    run_it.finish()
    assert bytes(run_it.seen) == b"no-input\n"


# -- what is checked before the script -------------------------------------------------------------


def _host(**changes: Any) -> Callable[[dict[str, Any]], dict[str, Any]]:
    def change(answer: dict[str, Any]) -> dict[str, Any]:
        return {**answer, "HostConfig": {**answer["HostConfig"], **changes}}

    return change


def _networks(answer: dict[str, Any]) -> dict[str, Any]:
    return {**answer, "NetworkSettings": {"Networks": {sc.SETUP_NETWORK_NAME: {}, "bridge": {}}}}


def _mounts(answer: dict[str, Any]) -> dict[str, Any]:
    socket_mount = {"Type": "bind", "Destination": "/var/run/docker.sock"}
    return {**answer, "Mounts": [*answer["Mounts"], socket_mount]}


def _environment(answer: dict[str, Any]) -> dict[str, Any]:
    return {**answer, "Config": {"Env": ["GIT_TOKEN=x"]}}


CHANGES: list[tuple[Callable[[dict[str, Any]], dict[str, Any]], str]] = [
    (_host(Privileged=True), "privileged"),
    (_host(Runtime="runc"), "runtime"),
    (_host(Binds=["/:/host"]), "host access"),
    (_networks, "networks"),
    (_mounts, "mounts"),
    (_environment, "environment"),
]


@pytest.mark.parametrize(("change", "word"), CHANGES)
# #818-T18
def test_a_container_that_is_not_what_was_asked_for_never_gets_the_script(
    rig: Rig, change: Any, word: str
) -> None:
    rig.engine.inspect_override[AGENT_CONTAINER_NAME] = change
    done = run(rig)
    assert done.outcome == OUTCOME_UNAVAILABLE and word in done.detail
    assert rig.script_text == ""


# #818-T19
def test_a_daemon_without_the_runtime_refuses_before_anything_is_made(rig: Rig) -> None:
    del rig.engine.runtimes["sysbox-runc"]
    done = run(rig)
    assert done.outcome == OUTCOME_UNAVAILABLE and "sysbox-runc" in done.detail
    assert made_containers(rig.engine) == []


# #818-T20
def test_the_ready_file_is_waited_for(rig: Rig) -> None:
    run(rig)
    assert any(e[0] == ["/usr/bin/test", "-e", READY_FILE] for e in rig.execs)


def test_the_runtime_and_entrypoint_of_a_lane_without_sysbox_are_the_agents_to_name(
    rig: Rig,
) -> None:
    rig.engine.runtimes["runc"] = {}
    done = run(rig, runtime="runc", entrypoint=("/bin/sleep", "infinity"))
    assert done.outcome == OUTCOME_OK
    setup = next(c for c in rig.engine.containers.values() if c.name == AGENT_CONTAINER_NAME)
    assert setup.document["HostConfig"]["Runtime"] == "runc"
    assert setup.document["Entrypoint"] == ["/bin/sleep", "infinity"]


def test_every_name_in_a_request_is_a_constant_or_an_identifier(rig: Rig) -> None:
    run(rig)
    for method, target, _ in rig.engine.calls:
        assert re.fullmatch(r"[A-Za-z0-9_/?=&.:*-]+", target), (method, target)
