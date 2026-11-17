# SPDX-License-Identifier: LicenseRef-Proprietary

"""#1023: the look at the device that a job asking for Claude Code gets (`device_harness`), on the
Incus backend. Control runs in instance A and the agent in instance B (`placement.py`): the agent
image and the Claude Code layer are in **B's** Docker, which Control reaches through the socket the
launcher made, and the login is the one local credential the dispatcher put into Control's own
environment (#980), not a file of a runner home that Control does not have."""

from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.implementer import job_run
from code_reviewer_runner.implementer.claude_code.layer import LayerSpec, layer_labels, layer_tag
from code_reviewer_runner.implementer.claude_code.readiness import (
    HarnessNotReady,
    ReadyHarness,
)
from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError
from code_reviewer_runner.implementer.placement import (
    B_DOCKER_SOCKET,
    DOOR_ADDRESS_VARIABLE,
    PLACEMENT_VARIABLE,
    SOCKET_VARIABLE,
)

pytestmark = pytest.mark.unit

BASE = "sha256:" + "ab" * 32
TOKEN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"
SPLIT = {
    PLACEMENT_VARIABLE: "split",
    SOCKET_VARIABLE: B_DOCKER_SOCKET,
    DOOR_ADDRESS_VARIABLE: "10.98.0.2",
}


class Daemon:
    def __init__(self, *, layer: bool) -> None:
        self.images: dict[str, dict[str, Any]] = {"code-reviewer-agent:golden": {"Id": BASE}}
        if layer:
            self.images[layer_tag(BASE, LayerSpec())] = {
                "Config": {"Labels": layer_labels(LayerSpec())}
            }

    def inspect_image(self, reference: str) -> dict[str, Any]:
        if reference not in self.images:
            raise DockerError(404, "no such image")
        return self.images[reference]

    def build_image(self, context: bytes, tag: str, *, timeout: float) -> None:
        raise AssertionError("a job never builds a layer")


# #1023-T11
def test_the_split_placement_asks_b_s_docker_and_the_hosted_one_the_default_socket() -> None:
    split = job_run.device_daemon(SPLIT)
    hosted = job_run.device_daemon({})

    assert isinstance(split, DockerApi) and isinstance(hosted, DockerApi)
    assert split._path == B_DOCKER_SOCKET and split.half_close is False  # pyright: ignore[reportPrivateUsage]
    assert hosted._path != B_DOCKER_SOCKET and hosted.half_close is True  # pyright: ignore[reportPrivateUsage]


# #1023-T12
def test_a_split_job_finds_the_layer_in_b_and_the_login_in_control_s_environment() -> None:
    asked: list[dict[str, str]] = []

    def daemon(environment: Any) -> Daemon:
        asked.append(dict(environment))
        return Daemon(layer=True)

    looked = job_run.device_harness({**SPLIT, "CLAUDE_CODE_OAUTH_TOKEN": TOKEN}, daemon=daemon)

    assert isinstance(looked, ReadyHarness)
    assert looked.login.secret == TOKEN
    assert looked.image == layer_tag(BASE, LayerSpec())
    assert asked and asked[0][PLACEMENT_VARIABLE] == "split"


# #1023-T13
def test_no_layer_in_b_and_no_local_credential_each_refuse_the_job_in_words() -> None:
    no_layer = job_run.device_harness(
        {**SPLIT, "CLAUDE_CODE_OAUTH_TOKEN": TOKEN}, daemon=lambda _: Daemon(layer=False)
    )
    no_login = job_run.device_harness(SPLIT, daemon=lambda _: Daemon(layer=True))

    assert isinstance(no_layer, HarnessNotReady) and "not on this daemon" in no_layer.text
    assert isinstance(no_login, HarnessNotReady) and "no Claude Code login" in no_login.text
    assert TOKEN not in no_layer.text + no_login.text


# #1023-T14
def test_a_placement_that_is_wrong_and_a_daemon_that_does_not_answer_are_words_not_errors(
    tmp_path: Path,
) -> None:
    wrong = job_run.device_harness({PLACEMENT_VARIABLE: "elsewhere"})
    silent = job_run.device_harness(
        {**SPLIT, SOCKET_VARIABLE: str(tmp_path / "no.sock"), "CLAUDE_CODE_OAUTH_TOKEN": TOKEN}
    )

    assert isinstance(wrong, HarnessNotReady) and "placement_invalid" in wrong.text
    assert isinstance(silent, HarnessNotReady) and silent.text
