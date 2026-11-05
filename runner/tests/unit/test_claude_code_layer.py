# SPDX-License-Identifier: LicenseRef-Proprietary

"""#856: the install layer of Claude Code on the agent image: pinned, built on the device (never
published by us), cached by the base image and the version. A double stands in for the daemon."""

import base64
import io
import re
import tarfile
from typing import Any

import pytest

from code_reviewer_runner.implementer.claude_code.command import AGENT_UID
from code_reviewer_runner.implementer.claude_code.layer import (
    CLAUDE_CODE_INTEGRITY,
    CLAUDE_CODE_VERSION,
    LAYER_REPOSITORY,
    LayerError,
    LayerSpec,
    build_context,
    dockerfile,
    ensure_layer,
    layer_tag,
)
from code_reviewer_runner.implementer.docker_api import DockerError

BASE = "sha256:" + "ab" * 32


class Daemon:
    """The two calls the layer makes of the daemon."""

    def __init__(self, *, have: dict[str, dict[str, Any]] | None = None, refuse: str | None = None):
        self.images = dict(have or {})
        self.refuse = refuse
        self.built: list[tuple[str, bytes]] = []

    def inspect_image(self, reference: str) -> dict[str, Any]:
        if reference not in self.images:
            raise DockerError(404, "no such image")
        return self.images[reference]

    def build_image(self, context: bytes, tag: str, *, timeout: float) -> None:
        if self.refuse:
            raise DockerError(0, self.refuse)
        self.built.append((tag, context))
        self.images[tag] = {"Config": {"Labels": {"com.code-reviewer.claude-code": SPEC.version}}}


SPEC = LayerSpec()


# #856-T13
def test_the_layer_is_pinned_to_one_exact_version_with_the_integrity_of_its_tarball() -> None:
    text = dockerfile(BASE, SPEC)

    assert re.fullmatch(r"\d+\.\d+\.\d+", CLAUDE_CODE_VERSION)
    assert f"@anthropic-ai/claude-code@{CLAUDE_CODE_VERSION}" in text
    for moving in ("@latest", "@stable", "@next"):
        assert moving not in text
    digest = base64.b64decode(CLAUDE_CODE_INTEGRITY.removeprefix("sha512-")).hex()
    assert len(digest) == 128 and digest in text and "sha512sum -c" in text


# #856-T13
def test_a_version_chosen_on_the_device_is_exact_but_has_no_integrity_to_check() -> None:
    text = dockerfile(BASE, LayerSpec(version="2.1.318", integrity=None))

    assert "claude-code@2.1.318" in text and "sha512sum" not in text
    for bad in ("latest", "2.1", "2.1.318 && curl x", "^2.1.318", ""):
        with pytest.raises(ValueError):
            LayerSpec(version=bad, integrity=None)


# #856-T14
def test_the_layer_makes_the_user_the_exec_runs_as_and_leaves_the_base_alone() -> None:
    text = dockerfile(BASE, SPEC)

    assert text.startswith(f"FROM {BASE}\n")
    assert f"--uid {AGENT_UID}" in text and f"--gid {AGENT_UID}" in text
    assert "/home/agent" in text
    # The version it installed is the version it was asked for, or the build fails.
    assert "claude --version" in text
    assert "USER" not in text.replace("USER 0:0", "")
    # No credential of any kind can be in an image others may keep.
    assert not re.search(r"(?i)token|api[_-]?key|oauth|secret", text)


# #856-T14
def test_the_build_context_is_the_dockerfile_alone() -> None:
    with tarfile.open(fileobj=io.BytesIO(build_context(dockerfile(BASE, SPEC)))) as archive:
        names = archive.getnames()

    assert names == ["Dockerfile"]


# #856-T15
def test_the_tag_names_the_version_and_the_base_it_was_built_on() -> None:
    other = "sha256:" + "cd" * 32

    assert layer_tag(BASE, SPEC) == f"{LAYER_REPOSITORY}:{CLAUDE_CODE_VERSION}-{'ab' * 6}"
    assert layer_tag(BASE, SPEC) != layer_tag(other, SPEC)
    assert layer_tag(BASE, SPEC) != layer_tag(BASE, LayerSpec(version="2.1.318", integrity=None))


# #856-T15
def test_a_layer_that_exists_is_used_and_nothing_is_built() -> None:
    tag = layer_tag(BASE, SPEC)
    daemon = Daemon(
        have={
            "agent:golden": {"Id": BASE},
            tag: {"Config": {"Labels": {"com.code-reviewer.claude-code": SPEC.version}}},
        }
    )

    found = ensure_layer(daemon, "agent:golden", SPEC)

    assert (found.image, found.built) == (tag, False)
    assert daemon.built == []


# #856-T15
def test_a_missing_layer_is_built_once_and_then_found() -> None:
    daemon = Daemon(have={"agent:golden": {"Id": BASE}})

    first = ensure_layer(daemon, "agent:golden", SPEC)
    second = ensure_layer(daemon, "agent:golden", SPEC)

    assert (first.built, second.built) == (True, False)
    assert [tag for tag, _ in daemon.built] == [first.image]


# #856-T15
def test_a_layer_of_another_version_under_the_same_tag_is_not_trusted() -> None:
    tag = layer_tag(BASE, SPEC)
    daemon = Daemon(
        have={
            "agent:golden": {"Id": BASE},
            tag: {"Config": {"Labels": {"com.code-reviewer.claude-code": "0.0.1"}}},
        }
    )

    assert ensure_layer(daemon, "agent:golden", SPEC).built is True


# #856-T16
def test_a_build_the_daemon_refuses_is_a_layer_error_with_the_reason() -> None:
    daemon = Daemon(have={"agent:golden": {"Id": BASE}}, refuse="npm could not be reached")

    with pytest.raises(LayerError) as failed:
        ensure_layer(daemon, "agent:golden", SPEC)

    assert "npm could not be reached" in str(failed.value)


# #856-T16
def test_no_agent_image_is_a_layer_error_too() -> None:
    with pytest.raises(LayerError):
        ensure_layer(Daemon(), "agent:golden", SPEC)
