# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a runner decides about its machine (#854, R1b): the runtime to try, the memory, the
environment of the job processes, the announcement, and the limits it puts on the containers."""

import json
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner import prepare as module
from code_reviewer_runner.factory_runner.base import BASE_VERSION
from code_reviewer_runner.factory_runner.config import Limits, RunnerConfig
from code_reviewer_runner.factory_runner.limits import (
    LimitsError,
    agent_environment,
    agent_memory_mb,
    machine_memory_mb,
)
from code_reviewer_runner.factory_runner.prepare import (
    announcement_for,
    baked_agent_image,
    candidate_runtimes,
    job_environment,
    prepare,
    pull_image,
    split_reference,
)
from code_reviewer_runner.factory_runner.selftest import Check, SelfTestResult
from code_reviewer_runner.implementer.docker_api import DockerError

pytestmark = pytest.mark.unit


def config(**changes: Any) -> RunnerConfig:
    values: dict[str, Any] = {"url": "https://app.example", "labels": ("linux", "gpu")}
    values.update(changes)
    return RunnerConfig(**values)


def passing(runtime: str = "runc", *, nested: bool = False) -> SelfTestResult:
    checks = [Check("docker", True), Check("canned-turn", True)]
    if nested:
        checks.append(Check("agent-docker", True))
    return SelfTestResult(tuple(checks), runtime, "1.19.0", 1.0)


def failing(runtime: str) -> SelfTestResult:
    return SelfTestResult((Check("agent-container", False, "did not start"),), runtime)


# -- the memory --------------------------------------------------------------------------------


def test_the_agent_gets_sixty_percent_of_the_machine_up_to_sixteen_gib() -> None:
    assert agent_memory_mb(Limits(), machine_mb=10_000) == 6_000
    assert agent_memory_mb(Limits(), machine_mb=200_000) == 16 * 1024


def test_a_configured_memory_wins() -> None:
    assert agent_memory_mb(Limits(memory_mb=2048), machine_mb=64_000) == 2048


def test_a_machine_or_a_limit_that_leaves_less_than_the_minimum_is_refused_with_no_value() -> None:
    for limits, machine in ((Limits(), 1500), (Limits(memory_mb=900), 64_000), (Limits(), 0)):
        with pytest.raises(LimitsError, match="1024 MB"):
            agent_memory_mb(limits, machine_mb=machine)


def test_the_machines_memory_is_read_from_meminfo(tmp_path: Path) -> None:
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemFree: 1 kB\nMemTotal:        8388608 kB\n")
    assert machine_memory_mb(str(meminfo)) == 8192
    assert machine_memory_mb(str(tmp_path / "missing")) == 0


def test_the_cpu_limit_reaches_the_job_process_as_a_variable() -> None:
    assert agent_environment(Limits(cpus=3)) == {"RUNNER_IMPLEMENTER_AGENT_CPUS": "3"}
    assert agent_environment(Limits()) == {}


# -- the runtime -------------------------------------------------------------------------------


def test_auto_tries_sysbox_first_when_the_daemon_has_it_and_falls_back_to_runc() -> None:
    assert candidate_runtimes("auto", lambda: {"runc", "sysbox-runc"}) == ("sysbox-runc", "runc")
    assert candidate_runtimes("auto", lambda: {"runc"}) == ("runc",)


def test_an_explicit_runtime_is_the_only_one_tried() -> None:
    assert candidate_runtimes("runc", lambda: {"runc", "sysbox-runc"}) == ("runc",)
    assert candidate_runtimes("sysbox-runc", lambda: set()) == ("sysbox-runc",)


def test_a_daemon_that_cannot_list_its_runtimes_is_taken_for_one_without_sysbox() -> None:
    def broken() -> set[str]:
        raise DockerError(0, "no answer")

    assert candidate_runtimes("auto", broken) == ("runc",)


# -- the references ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("reference", "split"),
    [
        ("ghcr.io/itegro-gmbh/agent:1.2", ("ghcr.io/itegro-gmbh/agent", "1.2")),
        ("ghcr.io/itegro-gmbh/agent", ("ghcr.io/itegro-gmbh/agent", "latest")),
        ("localhost:5000/agent", ("localhost:5000/agent", "latest")),
        ("localhost:5000/agent:3", ("localhost:5000/agent", "3")),
        ("ghcr.io/x/agent@sha256:" + "a" * 64, ("ghcr.io/x/agent", "sha256:" + "a" * 64)),
        ("ghcr.io/x/agent:1@sha256:" + "a" * 64, ("ghcr.io/x/agent", "sha256:" + "a" * 64)),
    ],
)
def test_an_image_reference_splits_into_repository_and_tag_or_digest(
    reference: str, split: tuple[str, str]
) -> None:
    assert split_reference(reference) == split


def test_the_agent_image_baked_into_the_runner_image_is_read_from_its_file(tmp_path: Path) -> None:
    file = tmp_path / "agent-image.json"
    file.write_text(json.dumps({"reference": "ghcr.io/x/agent:1"}))
    assert baked_agent_image(file) == "ghcr.io/x/agent:1"
    file.write_text(json.dumps({"reference": ""}))
    assert baked_agent_image(file) is None
    assert baked_agent_image(tmp_path / "missing.json") is None


# -- the environment of the job processes ------------------------------------------------------


def test_the_job_environment_names_the_proof_the_memory_and_the_runtime() -> None:
    environment = job_environment(
        {"PATH": "/usr/bin", "FACTORY_RUNNER_CREDENTIAL": "crc_" + "A" * 43, "HOME": "/root"},
        config(limits=Limits(cpus=2)),
        "sysbox-runc",
        4096,
    )

    assert environment["RUNNER_IMPLEMENTER_WORK_DIR"] == "/work"
    assert environment["RUNNER_IMPLEMENTER_MODEL_DOOR"] == "docker"
    assert environment["RUNNER_IMPLEMENTER_SANDBOX_PROOF"] == "proven"
    assert environment["RUNNER_IMPLEMENTER_AGENT_MEMORY_MB"] == "4096"
    assert environment["RUNNER_IMPLEMENTER_AGENT_RUNTIME"] == "sysbox-runc"
    assert environment["RUNNER_IMPLEMENTER_AGENT_CPUS"] == "2"
    assert environment["PATH"] == "/usr/bin"
    assert "FACTORY_RUNNER_CREDENTIAL" not in environment  # the credential never leaves the loop


# #854-R1
def test_the_job_environment_names_the_runner_for_the_labels_of_its_containers() -> None:
    named = job_environment({}, config(runner_id="r1"), "runc", 4096)
    by_digest = job_environment({}, config(credential="crc_" + "A" * 43), "runc", 4096)
    unnamed = job_environment({}, config(), "runc", 4096)

    assert named["RUNNER_IMPLEMENTER_RUNNER_ID"] == "r1"
    assert by_digest["RUNNER_IMPLEMENTER_RUNNER_ID"].startswith("credential-")
    assert "RUNNER_IMPLEMENTER_RUNNER_ID" not in unnamed


# #854-R1
def test_the_self_test_is_told_the_runner_and_can_be_told_not_to_pull() -> None:
    seen: list[dict[str, Any]] = []

    def selftest(**kwargs: Any) -> SelfTestResult:
        seen.append(kwargs)
        return passing()

    prepare(
        config(runner_id="r1"),
        {},
        selftest=selftest,
        api=lambda: Daemon({"runc"}),  # type: ignore[arg-type,return-value]
        pull=None,
        machine_mb=lambda: 8000,
    )

    assert seen[0]["runner_id"] == "r1" and seen[0]["pull"] is None


# -- the announcement --------------------------------------------------------------------------


def test_the_announcement_says_ready_and_the_capabilities_only_when_they_were_proven() -> None:
    ready = announcement_for(config(), passing(nested=True), 4096)
    not_ready = announcement_for(config(), failing("runc"), 4096)

    assert ready.base_version == BASE_VERSION and list(ready.labels) == ["linux", "gpu"]
    assert ready.manifest["harnesses"] == {"opencode": {"version": "1.19.0", "ready": True}}
    assert ready.manifest["capabilities"] == ["agent-docker"]
    assert not_ready.manifest["harnesses"]["opencode"]["ready"] is False  # type: ignore[index]
    assert "capabilities" not in not_ready.manifest


def test_the_announced_limits_are_the_configured_ones_or_what_the_machine_gives() -> None:
    configured = announcement_for(
        config(limits=Limits(cpus=2, memory_mb=3000, disk_gb=10)), passing(), 3000
    )
    default = announcement_for(config(), passing(), 5000)

    assert configured.limits["cpus"] == 2 and configured.limits["memoryMb"] == 3000
    assert configured.limits["diskGb"] == 10 and configured.limits["parallelRuns"] == 1
    assert default.limits["memoryMb"] == 5000 and default.limits["cpus"] >= 1


# -- prepare -----------------------------------------------------------------------------------


class Daemon:
    def __init__(self, runtimes: set[str]) -> None:
        self._runtimes = runtimes

    def runtimes(self) -> set[str]:
        return self._runtimes


def run_prepare(
    runtimes: set[str], results: dict[str, SelfTestResult], tried: list[str], **changes: Any
) -> module.Prepared:
    def selftest(**kwargs: Any) -> SelfTestResult:
        tried.append(kwargs["runtime"])
        return results[kwargs["runtime"]]

    return prepare(
        config(**changes),
        {"PATH": "/usr/bin"},
        selftest=selftest,
        api=lambda: Daemon(runtimes),  # type: ignore[arg-type,return-value]
        machine_mb=lambda: 8000,
    )


def test_sysbox_is_used_when_it_passes() -> None:
    tried: list[str] = []

    prepared = run_prepare(
        {"runc", "sysbox-runc"},
        {"sysbox-runc": passing("sysbox-runc", nested=True), "runc": passing()},
        tried,
    )

    assert tried == ["sysbox-runc"]
    assert (
        prepared.ready and prepared.environment["RUNNER_IMPLEMENTER_AGENT_RUNTIME"] == "sysbox-runc"
    )
    assert prepared.announcement.manifest["capabilities"] == ["agent-docker"]


def test_a_sysbox_that_fails_its_selftest_falls_back_to_runc_without_the_capability() -> None:
    tried: list[str] = []

    prepared = run_prepare(
        {"runc", "sysbox-runc"}, {"sysbox-runc": failing("sysbox-runc"), "runc": passing()}, tried
    )

    assert tried == ["sysbox-runc", "runc"]
    assert prepared.ready and prepared.environment["RUNNER_IMPLEMENTER_AGENT_RUNTIME"] == "runc"
    assert "capabilities" not in prepared.announcement.manifest


def test_a_machine_that_fails_every_runtime_is_not_ready_and_says_why() -> None:
    prepared = run_prepare({"runc"}, {"runc": failing("runc")}, [])

    assert not prepared.ready
    assert prepared.selftest.failed() is not None
    assert prepared.announcement.manifest["harnesses"]["opencode"]["ready"] is False  # type: ignore[index]


def test_a_memory_limit_below_the_minimum_is_not_ready_and_starts_nothing() -> None:
    tried: list[str] = []

    prepared = run_prepare({"runc"}, {}, tried, limits=Limits(memory_mb=512))

    assert not prepared.ready and tried == []
    assert prepared.selftest.checks[0].name == "memory"


def test_the_host_of_a_runner_advertises_the_implementer_engine_and_nothing_else() -> None:
    prepared = run_prepare({"runc"}, {"runc": passing()}, [])

    assert prepared.settings.engines == ("implementer",)
    assert prepared.settings.implementer_docker is True
    assert prepared.settings.implementer_work_dir == Path("/work")
    assert prepared.settings.diff_job_user is None and prepared.settings.dynamic_engine_user is None


def test_pulling_an_image_is_one_engine_api_pull_and_one_tag() -> None:
    calls: list[tuple[str, str]] = []

    class Api:
        def request(self, method: str, path: str, **_: object) -> None:
            calls.append((method, path))

    pull_image(Api(), "ghcr.io/itegro-gmbh/agent:1.2")  # type: ignore[arg-type]

    assert calls == [
        ("POST", "/images/create?fromImage=ghcr.io/itegro-gmbh/agent&tag=1.2"),
        (
            "POST",
            "/images/ghcr.io/itegro-gmbh/agent:1.2/tag?repo=code-reviewer-agent&tag=golden",
        ),
    ]
