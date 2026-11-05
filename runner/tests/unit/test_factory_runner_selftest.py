# SPDX-License-Identifier: LicenseRef-Proprietary

"""The self-test of the Factory-Runner (#854, R1b): what each check needs, what it makes in the
daemon, and that it cleans up. The daemon and the container's commands are doubles; the lane runs
the real thing."""

import json
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner import selftest as module
from code_reviewer_runner.factory_runner.config import Limits
from code_reviewer_runner.factory_runner.selftest import (
    CANNED_PORT,
    SelfTestResult,
    SelfTestSeams,
    pinned_opencode_version,
    run_selftest,
    turn_problem,
)
from code_reviewer_runner.implementer.agent_container import AGENT_IMAGE_REFERENCE
from code_reviewer_runner.implementer.docker_api import DockerError
from code_reviewer_runner.implementer.git_process import Outcome

pytestmark = pytest.mark.unit

# What `opencode run --format json` printed against the canned model, from a real run of the
# pinned OpenCode 1.19.0 (ids shortened).
REAL_TURN = "\n".join(
    json.dumps(event)
    for event in (
        {"type": "step_start", "part": {"type": "step-start"}},
        {"type": "text", "part": {"type": "text", "text": "SELFTEST-OK"}},
        {
            "type": "step_finish",
            "part": {
                "type": "step-finish",
                "reason": "stop",
                "tokens": {"total": 10, "input": 7, "output": 3, "reasoning": 0},
                "cost": 0,
            },
        },
    )
)


class FakeDocker:
    def __init__(self, *, runtimes: Sequence[str] = ("runc",), image: bool = True) -> None:
        self.answers = True
        self.runtimes_set = set(runtimes)
        self.image = image
        self.work_volume: str | None = "work-volume"
        self.created: list[tuple[dict[str, Any], str]] = []
        self.removed: list[str] = []
        self.pulled: list[str] = []

    def ping(self) -> bool:
        return self.answers

    def runtimes(self) -> set[str]:
        return self.runtimes_set

    def inspect_container(self, _ref: str) -> dict[str, Any]:
        mounts = (
            []
            if self.work_volume is None
            else [{"Destination": "/work", "Type": "volume", "Name": self.work_volume}]
        )
        return {"Mounts": mounts}

    def inspect_image(self, _ref: str) -> dict[str, Any]:
        if not self.image:
            raise DockerError(404, "no such image")
        return {"Id": "sha256:" + "a" * 64}

    def create_container(self, document: dict[str, Any], name: str) -> str:
        self.created.append((document, name))
        return "cid"

    def start_container(self, _container: str) -> None:
        return None

    def stop_container(self, container: str, *, grace: int, timeout: float) -> None:
        return None

    def remove_container(self, container: str) -> None:
        self.removed.append(container)


class Commands:
    """What the container's commands answer, by what they are."""

    def __init__(self) -> None:
        self.ready = True
        self.version = "1.19.0"
        self.turn_output = REAL_TURN
        self.turn_code = 0
        self.nested_ok = True
        self.log: list[str] = []
        self.written: dict[str, bytes] = {}

    def __call__(self, api: Any, container: str, argv: Sequence[str], **kwargs: Any) -> Outcome:
        kind = self._kind(argv)
        self.log.append(kind)
        if kind == "ready":
            return Outcome(0 if self.ready else 1, "", "")
        if kind == "version":
            return Outcome(0, self.version + "\n", "")
        if kind == "write":
            self.written[argv[-1]] = kwargs["stdin"]
            return Outcome(0, "", "")
        if kind == "turn":
            return Outcome(self.turn_code, self.turn_output, "")
        return Outcome(0 if self.nested_ok else 1, "", "")

    @staticmethod
    def _kind(argv: Sequence[str]) -> str:
        if argv[0] == "/usr/bin/test":
            return "ready"
        if argv[0] == "opencode":
            return "version"
        script = argv[2] if len(argv) > 2 else ""
        if "cat >" in script:
            return "write"
        return "nested" if "docker import" in script else "turn"


class Rig:
    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.docker = FakeDocker()
        self.commands = Commands()
        monkeypatch.setattr(module, "run_exec", self.commands)
        pin = tmp_path / "opencode-pin.json"
        pin.write_text(json.dumps({"version": "1.19.0"}))
        work = tmp_path / "work"
        work.mkdir()
        self.clock = 0.0
        self.seams = SelfTestSeams(
            api=lambda: self.docker,  # type: ignore[arg-type,return-value]
            hostname=lambda: "me",
            clock=self._time,
            sleep=self._sleep,
            pin_file=pin,
            work_dir=work,
        )
        meminfo = tmp_path / "meminfo"
        meminfo.write_text("MemTotal:       16777216 kB\n")
        self.meminfo = str(meminfo)

    def _time(self) -> float:
        return self.clock

    def _sleep(self, seconds: float) -> None:
        self.clock += seconds

    def run(
        self,
        *,
        runtime: str = "runc",
        limits: Limits = Limits(),  # noqa: B008
        image: str | None = None,
        pull: Callable[[Any, str], None] | None = None,
    ) -> SelfTestResult:
        return run_selftest(
            runtime=runtime,
            limits=limits,
            agent_image=image,
            pull=pull,
            seams=self.seams,
            meminfo=self.meminfo,
        )


@pytest.fixture
def rig(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Rig:
    return Rig(tmp_path, monkeypatch)


def names(result: SelfTestResult) -> list[str]:
    return [check.name for check in result.checks]


def failed(result: SelfTestResult) -> str | None:
    check = result.failed()
    return None if check is None else check.name


def test_a_machine_that_holds_the_base_passes_every_check(rig: Rig) -> None:
    result = rig.run()

    assert result.base_ok and failed(result) is None
    assert names(result) == [
        "docker", "work-volume", "memory", "agent-image", "agent-container", "opencode", "canned-turn",
    ]  # fmt: skip
    assert result.opencode_version == "1.19.0"
    assert result.capabilities == ()  # no Sysbox: no `agent-docker`
    assert "nested" not in rig.commands.log


def test_the_canned_model_and_its_config_are_put_into_the_container(rig: Rig) -> None:
    rig.run()

    assert b"SELFTEST-OK" in rig.commands.written["/tmp/selftest/canned_provider.py"]
    config = json.loads(rig.commands.written["/tmp/selftest/opencode.json"])
    assert (
        config["provider"]["selftest"]["options"]["baseURL"] == f"http://127.0.0.1:{CANNED_PORT}/v1"
    )
    assert config["enabled_providers"] == ["selftest"]
    assert config["permission"] == {"*": "deny"}  # nothing the model calls may run


def test_the_throwaway_container_has_no_network_no_volume_and_the_limits(rig: Rig) -> None:
    rig.run(limits=Limits(cpus=2, memory_mb=3000))

    document, name = rig.docker.created[0]
    host = document["HostConfig"]
    assert name == "code-reviewer-selftest-agent"
    assert host["NetworkMode"] == "none" and host["Mounts"] == [] and host["Privileged"] is False
    assert host["Memory"] == host["MemorySwap"] == 3000 * 1024 * 1024
    assert host["NanoCpus"] == 2 * 10**9
    assert host["Runtime"] == "runc"
    assert document["Image"] == AGENT_IMAGE_REFERENCE
    assert "sleep infinity" in document["Entrypoint"][-1]  # the ready-only init under runc
    assert "NetworkingConfig" not in document


def test_the_container_is_removed_whatever_the_checks_say(rig: Rig) -> None:
    rig.commands.turn_output = ""

    result = rig.run()

    assert failed(result) == "canned-turn"
    assert rig.docker.removed.count("cid") >= 1
    assert rig.docker.removed[0] == "code-reviewer-selftest-agent"  # and one left by a killed test


def test_under_sysbox_a_container_that_runs_in_the_agents_docker_is_the_capability(
    rig: Rig,
) -> None:
    rig.docker.runtimes_set = {"runc", "sysbox-runc"}

    result = rig.run(runtime="sysbox-runc")

    assert result.agent_docker and result.capabilities == ("agent-docker",)
    assert rig.docker.created[0][0]["HostConfig"]["Runtime"] == "sysbox-runc"
    assert "Entrypoint" in rig.docker.created[0][0]
    assert rig.docker.created[0][0]["Entrypoint"][-1] == "/usr/local/bin/agent-init"


def test_a_failing_nested_docker_costs_the_capability_and_not_the_base(rig: Rig) -> None:
    rig.docker.runtimes_set = {"runc", "sysbox-runc"}
    rig.commands.nested_ok = False

    result = rig.run(runtime="sysbox-runc")

    assert result.base_ok and not result.agent_docker
    assert result.capabilities == ()
    assert failed(result) is None


def test_a_runtime_the_daemon_does_not_have_is_named(rig: Rig) -> None:
    result = rig.run(runtime="sysbox-runc")

    assert failed(result) == "docker"
    assert "sysbox-runc" in result.checks[0].detail
    assert rig.docker.created == []


def test_a_daemon_that_does_not_answer_stops_at_the_first_check(rig: Rig) -> None:
    rig.docker.answers = False

    result = rig.run()

    assert names(result) == ["docker"] and not result.base_ok


def test_a_container_without_the_work_volume_says_how_to_start_it(rig: Rig) -> None:
    rig.docker.work_volume = None

    result = rig.run()

    assert failed(result) == "work-volume"
    assert "-v <name>:/work" in result.checks[-1].detail


def test_too_little_memory_is_a_failed_check_before_anything_starts(rig: Rig) -> None:
    result = rig.run(limits=Limits(memory_mb=512))

    assert failed(result) == "memory"
    assert rig.docker.created == []


def test_a_missing_agent_image_is_pulled_from_the_reference_and_checked_again(rig: Rig) -> None:
    rig.docker.image = False
    pulled: list[str] = []

    def pull(api: FakeDocker, reference: str) -> None:
        pulled.append(reference)
        api.image = True

    result = rig.run(image="ghcr.io/itegro-gmbh/agent:1.0", pull=pull)

    assert pulled == ["ghcr.io/itegro-gmbh/agent:1.0"]
    assert result.base_ok and result.checks[3].detail == "pulled"


def test_a_missing_agent_image_without_a_reference_says_what_to_set(rig: Rig) -> None:
    rig.docker.image = False

    result = rig.run()

    assert failed(result) == "agent-image"
    assert "FACTORY_RUNNER_AGENT_IMAGE" in result.checks[-1].detail


def test_a_pull_the_daemon_refuses_fails_the_check(rig: Rig) -> None:
    rig.docker.image = False

    def pull(_api: Any, _reference: str) -> None:
        raise DockerError(500, "denied crc_secret")

    result = rig.run(image="x/y:1", pull=pull)

    assert failed(result) == "agent-image"
    assert "crc_secret" not in result.checks[-1].detail


def test_a_container_that_never_becomes_ready_fails_and_is_removed(rig: Rig) -> None:
    rig.commands.ready = False

    result = rig.run()

    assert failed(result) == "agent-container"
    assert "cid" in rig.docker.removed
    assert rig.clock >= 120  # it waited, then gave up


def test_an_engine_of_another_version_than_the_pin_fails(rig: Rig) -> None:
    rig.commands.version = "1.18.0"

    result = rig.run()

    assert failed(result) == "opencode"
    assert "1.18.0" in result.checks[-1].detail and "1.19.0" in result.checks[-1].detail


def test_a_turn_whose_engine_errors_fails_even_when_the_events_look_right(rig: Rig) -> None:
    rig.commands.turn_code = 1

    assert failed(rig.run()) == "canned-turn"


# -- reading the events of a turn -------------------------------------------------------------------


def test_the_events_of_a_real_turn_pass() -> None:
    assert turn_problem(REAL_TURN) is None


def test_a_turn_without_the_canned_answer_is_named() -> None:
    assert turn_problem("") == "the engine did not stream the canned answer"
    assert "canned answer" in str(turn_problem(REAL_TURN.replace("SELFTEST-OK", "other")))


def test_a_turn_with_other_usage_than_the_model_gave_is_named() -> None:
    assert "usage" in str(turn_problem(REAL_TURN.replace('"input": 7', '"input": 0')))


def test_noise_between_the_events_is_ignored() -> None:
    assert turn_problem("log line\n" + REAL_TURN + "\n{broken") is None


def test_the_pinned_version_is_read_from_the_pin_file(tmp_path: Path) -> None:
    pin = tmp_path / "pin.json"
    pin.write_text(json.dumps({"version": "1.19.0"}))
    assert pinned_opencode_version(pin) == "1.19.0"
    pin.write_text("{")
    assert pinned_opencode_version(pin) is None
    assert pinned_opencode_version(tmp_path / "missing.json") is None
