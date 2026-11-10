# SPDX-License-Identifier: LicenseRef-Proprietary

"""#856: when a runner announces Claude Code (decision 4 of the plan): only when the device has a
login for it and the layer with the pinned version is there (built on a start, only looked for in
the self-test command), and never as a reason for the base to fail."""

from pathlib import Path
from typing import Any

from code_reviewer_runner.factory_runner.config import RunnerConfig
from code_reviewer_runner.factory_runner.prepare import announcement_for, prepare
from code_reviewer_runner.factory_runner.selftest import Check, SelfTestResult
from code_reviewer_runner.implementer.claude_code.layer import (
    CLAUDE_CODE_VERSION,
    LayerSpec,
    layer_labels,
    layer_tag,
)
from code_reviewer_runner.implementer.claude_code.readiness import (
    HARNESS_CLAUDE_CODE,
    HarnessNotReady,
    HarnessStatus,
    ReadyHarness,
    claude_code_status,
    layer_spec,
    ready_harness,
)
from code_reviewer_runner.implementer.docker_api import DockerError

TOKEN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"
BASE = "sha256:" + "ab" * 32
SPEC = LayerSpec()


class Daemon:
    def __init__(self, *, layer: bool = False, refuse: str | None = None) -> None:
        self.images: dict[str, dict[str, Any]] = {"code-reviewer-agent:golden": {"Id": BASE}}
        if layer:
            self.images[layer_tag(BASE, SPEC)] = {"Config": {"Labels": layer_labels(SPEC)}}
        self.refuse = refuse
        self.built = 0

    def inspect_image(self, reference: str) -> dict[str, Any]:
        if reference not in self.images:
            raise DockerError(404, "no such image")
        return self.images[reference]

    def build_image(self, context: bytes, tag: str, *, timeout: float) -> None:
        if self.refuse:
            raise DockerError(0, self.refuse)
        self.built += 1
        self.images[tag] = {"Config": {"Labels": layer_labels(SPEC)}}

    def runtimes(self) -> set[str]:
        return {"runc"}


def token_in(directory: Path, mode: int = 0o600) -> dict[str, str]:
    path = directory / "claude-code-token"
    path.write_text(TOKEN)
    path.chmod(mode)
    return {"FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE": str(path)}


def status(daemon: Daemon, environment: dict[str, str], tmp_path: Path, *, build: bool = True):
    return claude_code_status(daemon, environment, tmp_path, build=build)


# #856-T26
def test_a_device_with_no_login_for_claude_code_does_not_announce_it(tmp_path: Path) -> None:
    daemon = Daemon()

    assert status(daemon, {}, tmp_path) is None
    assert daemon.built == 0, "nothing is built for a device that will not use it"


# #856-T26
def test_a_device_with_a_login_and_the_layer_announces_it_ready_with_the_pinned_version(
    tmp_path: Path,
) -> None:
    found = status(Daemon(layer=True), token_in(tmp_path), tmp_path)

    assert found == HarnessStatus(CLAUDE_CODE_VERSION, True, ())


# #856-T26
def test_a_start_builds_a_missing_layer_once(tmp_path: Path) -> None:
    daemon = Daemon()
    environment = token_in(tmp_path)

    first = status(daemon, environment, tmp_path)
    second = status(daemon, environment, tmp_path)

    assert first is not None and first.ready and second is not None and second.ready
    assert daemon.built == 1


# #856-T26
def test_the_pinned_version_chosen_on_the_device_is_still_the_verified_layer(
    tmp_path: Path,
) -> None:
    """Setting the variable to the pin must not build the layer without the SHA-512 check under
    the tag of the verified one."""
    daemon = Daemon()
    environment = {**token_in(tmp_path), "FACTORY_RUNNER_CLAUDE_CODE_VERSION": CLAUDE_CODE_VERSION}

    found = status(daemon, environment, tmp_path)

    assert found is not None and found.ready
    assert layer_spec(environment) == LayerSpec()
    assert list(daemon.images) == ["code-reviewer-agent:golden", layer_tag(BASE, SPEC)]


# #856-T26
def test_another_version_chosen_on_the_device_is_an_unverified_layer(tmp_path: Path) -> None:
    environment = {**token_in(tmp_path), "FACTORY_RUNNER_CLAUDE_CODE_VERSION": "2.1.318"}
    chosen = layer_spec(environment)

    assert isinstance(chosen, LayerSpec) and chosen.integrity is None
    assert layer_tag(BASE, chosen) != layer_tag(BASE, SPEC)


# #856-T27
def test_the_self_test_command_only_looks_and_says_the_layer_is_not_built_yet(
    tmp_path: Path,
) -> None:
    daemon = Daemon()

    found = status(daemon, token_in(tmp_path), tmp_path, build=False)

    assert found is not None and not found.ready and daemon.built == 0
    assert any("not built" in note for note in found.notes)


# #856-T27
def test_a_build_that_fails_is_not_ready_with_the_reason_and_never_raises(tmp_path: Path) -> None:
    found = status(Daemon(refuse="npm could not be reached"), token_in(tmp_path), tmp_path)

    assert found is not None and not found.ready
    assert any("npm could not be reached" in note for note in found.notes)


# #856-T28
def test_a_login_that_cannot_be_used_is_not_ready_and_the_note_never_holds_the_token(
    tmp_path: Path,
) -> None:
    found = status(Daemon(layer=True), token_in(tmp_path, mode=0o644), tmp_path)

    assert found is not None and not found.ready
    assert not any(TOKEN in note for note in found.notes)
    assert any("0600" in note for note in found.notes)


# -- the announcement -----------------------------------------------------------------------------


def passing_selftest(**_options: Any) -> SelfTestResult:
    return passing()


def failing_selftest(**_options: Any) -> SelfTestResult:
    return failing()


def passing() -> SelfTestResult:
    return SelfTestResult(
        (Check("docker", True), Check("canned-turn", True)), "runc", "1.19.0", 1.0
    )


def failing() -> SelfTestResult:
    return SelfTestResult((Check("agent-container", False, "did not start"),), "runc")


# #856-T29, #973-T05
def test_the_announcement_adds_claude_code_as_a_subscription_and_never_removes_opencode() -> None:
    config = RunnerConfig(url="https://app.example")
    announced = announcement_for(
        config,
        passing(),
        4096,
        {HARNESS_CLAUDE_CODE: HarnessStatus("2.1.311", True, ())},
    )

    assert announced.manifest["harnesses"] == [
        {"harness": "opencode", "version": "1.19.0", "auth": "app-key"},
        {"harness": "claude-code", "version": "2.1.311", "auth": "subscription"},
    ]


# #856-T29, #973-T03
def test_a_harness_that_is_not_ready_is_left_out_of_the_announcement() -> None:
    config = RunnerConfig(url="https://app.example")
    announced = announcement_for(
        config, passing(), 4096, {HARNESS_CLAUDE_CODE: HarnessStatus("2.1.311", False, ("x",))}
    )

    assert announced.manifest["harnesses"] == [
        {"harness": "opencode", "version": "1.19.0", "auth": "app-key"}
    ]


# #856-T29
def test_prepare_asks_for_the_harnesses_only_when_the_base_is_proven() -> None:
    asked: list[bool] = []

    def harnesses(*_: Any, **__: Any) -> dict[str, HarnessStatus]:
        asked.append(True)
        return {HARNESS_CLAUDE_CODE: HarnessStatus("2.1.311", True, ("a note",))}

    config = RunnerConfig(url="https://app.example")
    good = prepare(
        config,
        {},
        selftest=passing_selftest,
        api=lambda: Daemon(),  # type: ignore[arg-type,return-value]
        machine_mb=lambda: 8000,
        harnesses=harnesses,
    )
    bad = prepare(
        config,
        {},
        selftest=failing_selftest,
        api=lambda: Daemon(),  # type: ignore[arg-type,return-value]
        machine_mb=lambda: 8000,
        harnesses=harnesses,
    )

    assert asked == [True]
    assert [e["harness"] for e in good.announcement.manifest["harnesses"]] == [  # type: ignore[union-attr,index]
        "opencode",
        "claude-code",
    ]
    assert good.harness_notes == ("claude-code: a note",)
    assert bad.announcement.manifest["harnesses"] == []


# #856-H01
def test_a_job_is_run_on_a_device_that_still_has_the_login_and_the_layer(tmp_path: Path) -> None:
    daemon = Daemon(layer=True)

    found = ready_harness(daemon, token_in(tmp_path), tmp_path)

    assert isinstance(found, ReadyHarness)
    assert found.login.secret == TOKEN and found.image == layer_tag(BASE, SPEC)
    assert daemon.built == 0, "a job never builds a layer"


# #856-H01
def test_the_layer_gone_since_the_announcement_refuses_the_job_and_builds_nothing(
    tmp_path: Path,
) -> None:
    daemon = Daemon(layer=False)

    found = ready_harness(daemon, token_in(tmp_path), tmp_path)

    assert isinstance(found, HarnessNotReady) and "layer" in found.text
    assert daemon.built == 0


# #856-H01
def test_a_login_gone_or_loosened_since_the_announcement_refuses_the_job(tmp_path: Path) -> None:
    gone = ready_harness(Daemon(layer=True), {}, tmp_path)
    loose = ready_harness(Daemon(layer=True), token_in(tmp_path, mode=0o644), tmp_path)

    assert isinstance(gone, HarnessNotReady) and isinstance(loose, HarnessNotReady)
    assert TOKEN not in gone.text and TOKEN not in loose.text


# #856-H01
def test_an_agent_image_that_is_not_there_refuses_the_job(tmp_path: Path) -> None:
    daemon = Daemon(layer=True)
    daemon.images.pop("code-reviewer-agent:golden")

    assert isinstance(ready_harness(daemon, token_in(tmp_path), tmp_path), HarnessNotReady)
