# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Dockerfile of the Factory-Runner image (#854, R1b, S6): what it must keep saying, because a
release is built from it."""

import re
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

DOCKERFILE = Path(__file__).resolve().parents[2] / "Dockerfile.factory-runner"
DIGEST_REFERENCE = "ghcr.io/itegro-gmbh/code-reviewer-agent@sha256:" + "a" * 64


@pytest.fixture(scope="module")
def text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def instructions(text: str) -> list[str]:
    """The instructions without comments, continuation lines joined."""
    lines = [line for line in text.replace("\\\n", " ").splitlines() if not line.startswith("#")]
    return [line.strip() for line in lines if line.strip()]


# #854-S6
def test_the_base_is_one_build_argument_and_never_a_latest_tag(text: str) -> None:
    froms = [line for line in instructions(text) if line.startswith("FROM ")]
    default = re.search(r"^ARG WORKER_IMAGE=(\S+)$", text, re.MULTILINE)

    assert froms == ["FROM ${WORKER_IMAGE} AS factory-runner"]
    assert default is not None and ":" in default.group(1)  # a tag the commands above build
    assert not default.group(1).endswith(":latest")


# #854-S6
def test_it_says_that_a_release_pins_the_base_and_the_agent_image_by_digest(text: str) -> None:
    prose = " ".join(line.removeprefix("#").strip() for line in text.splitlines()).replace("**", "")

    assert "by digest" in prose and "never from a moving tag" in prose
    assert "Pin it by digest in a release" in prose


# #854-S6
def test_root_is_chosen_and_the_reason_is_written_next_to_it(text: str) -> None:
    lines = text.splitlines()
    user = lines.index("USER 0:0")
    comment = "\n".join(line for line in lines[max(0, user - 8) : user] if line.startswith("#"))

    assert "Why root" in comment
    assert "socket" in comment and "root of the machine" in comment


# #854-S6
@pytest.mark.parametrize(
    ("reference", "warns"),
    [("", False), (DIGEST_REFERENCE, False), ("registry.example/agent:ci", True)],
)
def test_the_build_warns_about_an_agent_image_that_is_a_tag(
    text: str, reference: str, warns: bool
) -> None:
    run = next(line for line in instructions(text) if line.startswith("RUN case "))
    script = run.removeprefix("RUN ")

    done = subprocess.run(
        ["/bin/sh", "-c", script],
        env={"AGENT_IMAGE_REF": reference, "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=False,
    )

    assert done.returncode == 0
    assert ("not a digest" in done.stderr) is warns
