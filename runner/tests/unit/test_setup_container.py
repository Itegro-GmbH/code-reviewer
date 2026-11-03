# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Setup container of an environment (#818, step 5 of the sandbox plan), against the fake Docker
Engine of `fakes/docker_engine`.

The questions: what the daemon is asked for (a Sysbox container from the agent's image with the
repository and nothing else, no secret and no variable in any body), that the VM's rules for its
bridge go in first and are only drops, that the script runs as a file in the container with the
streams merged, that a script that fails or runs out of time or a container that goes away is told
apart, that the committed image is the result, and that the container and the network are always
taken away."""

import json
import re
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
from code_reviewer_runner.implementer.agent_container import READY_FILE, WRITE_FILE_SCRIPT
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.door_launcher import PRIVATE_RANGES
from code_reviewer_runner.implementer.setup_container import (
    OUTCOME_NOT_SAVED,
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
        # What the end script finds: "stops" (the container's Docker stops and the container
        # ends with it), "no-docker" (nothing runs in it but its init) or "hangs".
        self.finish_mode = "no-docker"
        self.execs: list[tuple[list[str], dict[str, str], str | None]] = []

    def api(self) -> DockerApi:
        return DockerApi(str(self.socket), timeout=5.0)

    def seams(self, **options: Any) -> SetupSeams:
        base: dict[str, Any] = {
            "api": self.api,
            "hostname": lambda: HOSTNAME,
            "ready_seconds": 5.0,
            "finish_seconds": 5.0,
            "commit_seconds": 5.0,
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
            stdout.write(self.script_output)
            if self.script_waits:
                made.killed.wait(30)
                return 137
            return self.script_exit
        if argv[:3] == ["/bin/sh", "-c", sc.FINISH_SCRIPT]:
            if self.finish_mode == "no-docker":
                stdout.write(sc.NO_DOCKER + "\n")
            else:
                stdout.write("stopping\n")
                if self.finish_mode == "stops":
                    threading.Timer(
                        0.2, lambda: self.engine.kill(sc.SETUP_CONTAINER_NAME, exit_code=0)
                    ).start()
            return 0
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
    setup = next(c for c in rig.engine.containers.values() if c.name == sc.SETUP_CONTAINER_NAME)
    document = setup.document
    host = document["HostConfig"]
    assert document["Image"] == AGENT_IMAGE_ID
    assert document["User"] == "0:0"
    assert document["Env"] == []
    assert host["Runtime"] == "sysbox-runc"
    assert host["Privileged"] is False
    assert host["NetworkMode"] == sc.SETUP_NETWORK_NAME
    assert host["Memory"] == host["MemorySwap"] == 2048 * 1024 * 1024
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
    setup = next(c for c in rig.engine.containers.values() if c.name == sc.SETUP_CONTAINER_NAME)
    assert setup.document["Cmd"] == []
    assert setup.document["Labels"] == {"code-reviewer.role": "setup"}


# #818-T03
def test_the_document_is_made_of_constants_and_the_given_names_only() -> None:
    first = setup_document("sha256:aa", "volume-1", 1_000_000)
    second = setup_document("sha256:aa", "volume-1", 1_000_000)
    assert first == second
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
    assert roles == ["bridge-ipv6", "setup-rules", "setup-rules-check"]
    ipv6, rules, check = helpers
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
    assert created[-1].endswith(sc.SETUP_CONTAINER_NAME)
    assert all(t.endswith(host_rules.HELPER_NAME) for t in created[:-1])


# #818-T06
def test_a_setup_whose_rules_did_not_go_in_is_never_started(rig: Rig) -> None:
    rig.engine.rules_exit = 1
    done = run(rig)
    assert done.outcome == OUTCOME_UNAVAILABLE
    assert "network rules" in done.detail
    assert not any(
        t == "/containers/create?name=" + sc.SETUP_CONTAINER_NAME for _, t, _ in rig.engine.calls
    )
    assert rig.engine.networks == {}, "the network is taken away again"


# #818-T06b
def test_a_setup_whose_bridge_could_not_be_closed_to_ipv6_is_never_started(rig: Rig) -> None:
    rig.engine.ipv6_exit = 1
    done = run(rig)
    assert done.outcome == OUTCOME_UNAVAILABLE and "network rules" in done.detail
    assert not any(
        t == "/containers/create?name=" + sc.SETUP_CONTAINER_NAME for _, t, _ in rig.engine.calls
    )


# -- the script ------------------------------------------------------------------------------------


# #818-T07
def test_the_script_is_a_file_in_the_container_run_as_root_in_the_repository(rig: Rig) -> None:
    done = run(rig, script="#!/bin/bash\napt-get update\n")
    assert done.outcome == OUTCOME_OK and done.exit_code == 0
    assert rig.script_text == "#!/bin/bash\napt-get update\n"
    ran = next(e for e in rig.execs if e[0][:3] == ["/bin/sh", "-c", sc.RUN_SCRIPT])
    assert ran[0][3:] == ["run", sc.SCRIPT_PATH]
    assert ran[1] == sc.SCRIPT_ENVIRONMENT
    assert ran[2] == "/work/repo"
    # The script is never in an argument of a call: it is the standard input of one exec.
    assert "apt-get" not in calls_text(rig.engine)
    # Both streams in one, in order: the merge is the script's wrapper's (`2>&1`).
    assert "2>&1" in sc.RUN_SCRIPT


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
def test_a_script_that_exits_non_zero_is_its_own_outcome_and_nothing_is_committed(rig: Rig) -> None:
    rig.script_exit = 3
    done = run(rig)
    assert done.outcome == OUTCOME_SCRIPT_FAILED and done.exit_code == 3
    assert done.image is None and rig.engine.committed == []
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
    assert rig.engine.committed == []
    assert all(c.removed for c in rig.engine.containers.values())


# #818-T11
def test_a_stop_of_the_runner_ends_the_script_and_removes_the_container(rig: Rig) -> None:
    rig.script_waits = True
    stop = threading.Event()
    threading.Timer(0.4, stop.set).start()
    done = run(rig, seconds=30, should_stop=stop.is_set)
    assert done.outcome == OUTCOME_STOPPED
    assert all(c.removed for c in rig.engine.containers.values())


# #818-T12
def test_a_container_killed_under_the_script_is_the_scripts_and_says_why(rig: Rig) -> None:
    rig.script_waits = True

    def oom() -> None:
        setup = next(c for c in rig.engine.containers.values() if c.name == sc.SETUP_CONTAINER_NAME)
        rig.engine.kill(setup.name, exit_code=137, oom=True)

    threading.Timer(0.4, oom).start()
    done = run(rig, seconds=30)
    assert done.outcome == OUTCOME_SCRIPT_FAILED
    assert "killed for its memory" in done.detail


# -- the result ------------------------------------------------------------------------------------


# #818-T13
def test_a_script_that_ended_well_becomes_the_image_after_the_docker_is_stopped(rig: Rig) -> None:
    done = run(rig)
    assert done.outcome == OUTCOME_OK
    assert done.image is not None and done.image.startswith("sha256:")
    assert done.image_bytes == 123_456_789
    # The order: the end script (it removes the file and stops the container's Docker), the stop of
    # the container, the commit, the removal.
    paths = [(m, t.split("?")[0]) for m, t, _ in rig.engine.calls]
    names = [
        f"{m} {p.split('/')[1]}{'/' + p.split('/')[-1] if len(p.split('/')) > 2 else ''}"
        for m, p in paths
    ]
    stop_at = max(i for i, n in enumerate(names) if n.endswith("/stop"))
    commit_at = names.index("POST commit")
    remove_at = max(i for i, n in enumerate(names) if n.startswith("DELETE containers"))
    assert stop_at < commit_at < remove_at
    assert any(e[0][:3] == ["/bin/sh", "-c", sc.FINISH_SCRIPT] for e in rig.execs)
    assert any(t.split("?")[0].endswith("/stop") for m, t, _ in rig.engine.calls if m == "POST")
    repository, tag = rig.engine.committed[0][1]["repo"], rig.engine.committed[0][1]["tag"]
    assert (repository, tag) == (sc.SETUP_IMAGE_REPOSITORY, sc.SETUP_IMAGE_TAG)
    assert rig.engine.committed[0][1]["pause"] == "false"


# #818-T14
def test_the_script_file_is_removed_before_the_commit(rig: Rig) -> None:
    run(rig)
    finish = next(e for e in rig.execs if e[0][:3] == ["/bin/sh", "-c", sc.FINISH_SCRIPT])
    assert finish[0][-1] == sc.SCRIPT_PATH and 'rm -f "$1"' in sc.FINISH_SCRIPT


# #818-T15
def test_a_docker_that_does_not_stop_means_the_images_are_not_kept(rig: Rig) -> None:
    rig.finish_mode = "hangs"
    done = run(rig, docker_stop_seconds=0.5)
    assert done.outcome == OUTCOME_NOT_SAVED and "Docker did not stop" in done.detail
    assert rig.engine.committed == []


# #818-T15b
def test_a_docker_that_stops_ends_the_container_by_itself_and_then_the_commit_happens(
    rig: Rig,
) -> None:
    rig.finish_mode = "stops"
    done = run(rig)
    assert done.outcome == OUTCOME_OK and done.image is not None
    # The container ended by itself: no stop call was needed.
    assert not any(t.split("?")[0].endswith("/stop") for m, t, _ in rig.engine.calls if m == "POST")


# #818-T16
def test_a_commit_the_disk_cannot_hold_is_told_as_such(rig: Rig) -> None:
    rig.engine.commit_fails = True
    done = run(rig)
    assert done.outcome == OUTCOME_NOT_SAVED and "no space left" in done.detail
    assert done.image is None
    assert all(c.removed for c in rig.engine.containers.values())


# #818-T17
def test_a_container_that_never_stops_is_not_committed(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sc, "STOP_WAIT_SECONDS", 0.3)
    rig.engine.stop_hangs = True
    done = run(rig)
    assert done.outcome == OUTCOME_NOT_SAVED and "did not stop" in done.detail
    assert rig.engine.committed == []


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
    rig.engine.inspect_override[sc.SETUP_CONTAINER_NAME] = change
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
    setup = next(c for c in rig.engine.containers.values() if c.name == sc.SETUP_CONTAINER_NAME)
    assert setup.document["HostConfig"]["Runtime"] == "runc"
    assert setup.document["Entrypoint"] == ["/bin/sleep", "infinity"]


def test_every_name_in_a_request_is_a_constant_or_an_identifier(rig: Rig) -> None:
    run(rig)
    for method, target, _ in rig.engine.calls:
        assert re.fullmatch(r"[A-Za-z0-9_/?=&.:*-]+", target), (method, target)
