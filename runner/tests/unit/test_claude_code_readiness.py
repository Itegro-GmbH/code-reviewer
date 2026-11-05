# SPDX-License-Identifier: LicenseRef-Proprietary

"""#856: when a runner announces Claude Code (decision 4 of the plan): only when the device has a
login for it and the layer with the pinned version is there (built on a start, only looked for in
the self-test command), and never as a reason for the base to fail."""

from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner.config import RunnerConfig
from code_reviewer_runner.factory_runner.prepare import announcement_for, prepare
from code_reviewer_runner.factory_runner.selftest import Check, SelfTestResult
from code_reviewer_runner.implementer.claude_code.layer import (
    CLAUDE_CODE_VERSION,
    LayerSpec,
    layer_tag,
)
from code_reviewer_runner.implementer.claude_code.readiness import (
    HARNESS_CLAUDE_CODE,
    HarnessStatus,
    claude_code_status,
)
from code_reviewer_runner.implementer.docker_api import DockerError

TOKEN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"
BASE = "sha256:" + "ab" * 32
SPEC = LayerSpec()
LABEL = "com.code-reviewer.claude-code"


class Daemon:
    def __init__(self, *, layer: bool = False, refuse: str | None = None) -> None:
        self.images: dict[str, dict[str, Any]] = {"code-reviewer-agent:golden": {"Id": BASE}}
        if layer:
            self.images[layer_tag(BASE, SPEC)] = {"Config": {"Labels": {LABEL: SPEC.version}}}
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
        self.images[tag] = {"Config": {"Labels": {LABEL: SPEC.version}}}

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
    if __import__("os").geteuid() == 0:
        pytest.skip("root reads every file")
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


# #856-T29
def test_the_announcement_adds_claude_code_and_never_removes_opencode() -> None:
    config = RunnerConfig(url="https://app.example")
    announced = announcement_for(
        config,
        passing(),
        4096,
        {HARNESS_CLAUDE_CODE: HarnessStatus("2.1.311", True, ())},
    )

    assert announced.manifest["harnesses"] == {
        "opencode": {"version": "1.19.0", "ready": True},
        "claude-code": {"version": "2.1.311", "ready": True},
    }


# #856-T29
def test_a_harness_that_is_not_ready_is_announced_as_such() -> None:
    config = RunnerConfig(url="https://app.example")
    announced = announcement_for(
        config, passing(), 4096, {HARNESS_CLAUDE_CODE: HarnessStatus("2.1.311", False, ("x",))}
    )

    assert announced.manifest["harnesses"]["claude-code"] == {  # type: ignore[index]
        "version": "2.1.311",
        "ready": False,
    }


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
    assert "claude-code" in good.announcement.manifest["harnesses"]  # type: ignore[operator]
    assert good.harness_notes == ("claude-code: a note",)
    assert "claude-code" not in bad.announcement.manifest["harnesses"]  # type: ignore[operator]
