# SPDX-License-Identifier: LicenseRef-Proprietary

"""#856: the install layer of Claude Code on the agent image: pinned, built on the device (never
published by us), cached by the base image and the version. A double stands in for the daemon."""

import base64
import hashlib
import io
import re
import subprocess
import tarfile
from pathlib import Path
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
    find_layer,
    layer_labels,
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
        self.images[tag] = {"Config": {"Labels": layer_labels(SPEC)}}


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

    digest = base64.b64decode(CLAUDE_CODE_INTEGRITY.removeprefix("sha512-")).hex()[:12]
    assert layer_tag(BASE, SPEC) == (
        f"{LAYER_REPOSITORY}:{CLAUDE_CODE_VERSION}-sha512-{digest}-{'ab' * 6}"
    )
    assert layer_tag(BASE, SPEC) != layer_tag(other, SPEC)
    assert layer_tag(BASE, SPEC) != layer_tag(BASE, LayerSpec(version="2.1.318", integrity=None))


# #856-T15
def test_a_layer_that_exists_is_used_and_nothing_is_built() -> None:
    tag = layer_tag(BASE, SPEC)
    daemon = Daemon(
        have={
            "agent:golden": {"Id": BASE},
            tag: {"Config": {"Labels": layer_labels(SPEC)}},
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


UNVERIFIED = LayerSpec(version=CLAUDE_CODE_VERSION, integrity=None)


# #856-T15
def test_an_unverified_layer_of_the_pinned_version_has_another_tag_than_the_verified_one() -> None:
    assert layer_tag(BASE, UNVERIFIED) != layer_tag(BASE, SPEC)
    assert "unverified" in layer_tag(BASE, UNVERIFIED)
    other = LayerSpec(version=CLAUDE_CODE_VERSION, integrity="sha512-" + "A" * 86 + "==")
    assert layer_tag(BASE, other) != layer_tag(BASE, SPEC)
    assert layer_labels(UNVERIFIED) != layer_labels(SPEC)


# #856-T15
def test_a_layer_built_without_the_digest_is_never_taken_as_the_pinned_one() -> None:
    """The device set the pinned version itself and built it without the SHA-512 check; even
    when it sits under the pinned tag and carries the right version label, the pin does not
    accept it."""
    tag = layer_tag(BASE, SPEC)
    unverified_labels = layer_labels(UNVERIFIED)
    daemon = Daemon(
        have={
            "agent:golden": {"Id": BASE},
            tag: {"Config": {"Labels": unverified_labels}},
            layer_tag(BASE, UNVERIFIED): {"Config": {"Labels": unverified_labels}},
        }
    )

    assert find_layer(daemon, "agent:golden", SPEC) is None
    built = ensure_layer(daemon, "agent:golden", SPEC)
    assert built.built is True
    assert [t for t, _ in daemon.built] == [layer_tag(BASE, SPEC)]
    # And the other way round: the verified layer is not the unverified request's either.
    found = find_layer(daemon, "agent:golden", UNVERIFIED)
    assert found is not None and found.image == layer_tag(BASE, UNVERIFIED)


# #856-T15
def test_a_layer_with_another_digest_label_is_not_taken_as_the_pin() -> None:
    wrong = {**layer_labels(SPEC), "com.code-reviewer.claude-code.integrity": "0" * 128}
    daemon = Daemon(
        have={"agent:golden": {"Id": BASE}, layer_tag(BASE, SPEC): {"Config": {"Labels": wrong}}}
    )

    assert find_layer(daemon, "agent:golden", SPEC) is None


def _check_lines(text: str) -> str:
    return "\n".join(
        line.strip().rstrip("\\").strip().removesuffix(";").strip()
        for line in text.splitlines()
        if "sha512sum -c" in line
    )


# #856-T13
def test_the_build_script_fails_when_the_tarball_does_not_have_the_digest(tmp_path: Path) -> None:
    """The check line of the build script, run on a file: the digest of the file passes, any
    other digest fails the build (`set -e`)."""
    tarball = tmp_path / "claude-code.tgz"
    tarball.write_bytes(b"not the pinned tarball")
    good = "sha512-" + base64.b64encode(hashlib.sha512(tarball.read_bytes()).digest()).decode()
    bad = "sha512-" + base64.b64encode(hashlib.sha512(b"another").digest()).decode()

    def run(integrity: str) -> int:
        script = _check_lines(dockerfile(BASE, LayerSpec(integrity=integrity)))
        script = script.replace("/tmp/${tarball}", str(tarball))
        assert "sha512sum -c" in script
        return subprocess.run(
            ["/bin/sh", "-c", script], check=False, capture_output=True
        ).returncode

    assert run(good) == 0
    assert run(bad) != 0
