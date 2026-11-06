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
    PLATFORM_INTEGRITY,
    PLATFORM_LABEL,
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
    platform_word = layer_labels(SPEC)[PLATFORM_LABEL][:8]
    assert layer_tag(BASE, SPEC) == (
        f"{LAYER_REPOSITORY}:{CLAUDE_CODE_VERSION}-sha512-{digest}-p{platform_word}-{'ab' * 6}"
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


def _hex(integrity: str) -> str:
    return base64.b64decode(integrity.removeprefix("sha512-")).hex()


def _integrity_of(data: bytes) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


# #856-T13
def test_the_platform_program_is_pinned_for_linux_x64_and_arm64_with_its_own_digest() -> None:
    pinned = dict(PLATFORM_INTEGRITY)
    text = dockerfile(BASE, SPEC)

    assert set(pinned) == {"x64", "arm64"}
    assert pinned["x64"] != pinned["arm64"] and CLAUDE_CODE_INTEGRITY not in pinned.values()
    for arch, integrity in pinned.items():
        assert _hex(integrity) in text, arch
        assert f"@anthropic-ai/claude-code-linux-${{platform}}@{CLAUDE_CODE_VERSION}" in text
    # Both tarballs are checked, then installed from the files, with no further registry fetch.
    assert text.count("sha512sum -c") == 2
    install = next(line for line in text.splitlines() if "npm install --global" in line)
    assert "--offline" in install and "${tarball}" in install and "${platform_tarball}" in install
    assert text.index("sha512sum -c") < text.index("npm install --global")
    assert text.rindex("sha512sum -c") < text.index("npm install --global")


# #856-T13
def test_a_version_chosen_on_the_device_pins_no_platform_program_either() -> None:
    chosen = LayerSpec(version="2.1.318", integrity=None)
    text = dockerfile(BASE, chosen)

    assert chosen.platform_integrity is None
    assert "sha512sum" not in text and "claude-code-linux" not in text and "--offline" not in text
    # A pinned stub with no pinned program (or the other way round) is not a spec.
    with pytest.raises(ValueError):
        LayerSpec(platform_integrity=None)
    with pytest.raises(ValueError):
        LayerSpec(integrity=None, platform_integrity=(("x64", PLATFORM_INTEGRITY[1][1]),))
    with pytest.raises(ValueError):
        LayerSpec(platform_integrity=(("x64", "sha512-nope"),))
    with pytest.raises(ValueError):
        LayerSpec(
            platform_integrity=(("x64", CLAUDE_CODE_INTEGRITY), ("riscv", CLAUDE_CODE_INTEGRITY))
        )


# #856-T13
def test_a_layer_built_before_the_platform_pin_is_not_taken_as_the_pin() -> None:
    """The earlier verified layer pinned the stub only: same version, same stub digest label."""
    old_labels = {k: v for k, v in layer_labels(SPEC).items() if k != PLATFORM_LABEL}
    daemon = Daemon(
        have={
            "agent:golden": {"Id": BASE},
            layer_tag(BASE, SPEC): {"Config": {"Labels": old_labels}},
        }
    )

    assert find_layer(daemon, "agent:golden", SPEC) is None
    other = LayerSpec(
        platform_integrity=(("x64", PLATFORM_INTEGRITY[0][1]), ("arm64", CLAUDE_CODE_INTEGRITY))
    )
    assert layer_labels(other)[PLATFORM_LABEL] != layer_labels(SPEC)[PLATFORM_LABEL]
    assert layer_tag(BASE, other) != layer_tag(BASE, SPEC)
    assert layer_labels(UNVERIFIED)[PLATFORM_LABEL] == "unverified"


FAKE_NPM = r"""#!/bin/sh
# `npm pack <spec> --silent` writes <name>.tgz into the working directory from $FAKE_NPM_DIR/<name>
# and prints the file name; `npm install ...` records its arguments.
case "$1" in
  pack)
    name="$(printf %s "$2" | sed 's/^@//; s/@[0-9.]*$//; s#/#-#g').tgz"
    cp "$FAKE_NPM_DIR/$name" "./$name"
    echo "$name"
    ;;
  install)
    shift
    echo "$@" > "$FAKE_NPM_DIR/install-arguments"
    ;;
esac
"""


def _build_script(spec: LayerSpec, work: Path) -> str:
    """The first RUN of the layer (the install), up to the `npm install` itself, with /tmp moved
    into `work`: what the daemon would run to fetch and check the two tarballs."""
    text = dockerfile(BASE, spec)
    run = text.split("RUN set -eu; \\\n", 1)[1].split("RUN groupadd", 1)[0]
    lines = [line.strip().removesuffix("\\").strip() for line in run.splitlines()]
    start = next(i for i, line in enumerate(lines) if "npm install --global" in line)
    return ("set -eu; " + " ".join(lines[:start])).replace("/tmp", str(work))


def _run_build(tmp_path: Path, *, stub: bytes, platform: bytes, pinned_platform: bytes):
    """Run the check part of the script with a fake `npm` that serves `stub` and `platform`."""
    import platform as host

    arch = "arm64" if host.machine() in ("aarch64", "arm64") else "x64"
    fake = tmp_path / "fake"
    fake.mkdir()
    (fake / "npm").write_text(FAKE_NPM)
    (fake / "npm").chmod(0o755)
    registry = tmp_path / "registry"
    registry.mkdir()
    (registry / "anthropic-ai-claude-code.tgz").write_bytes(stub)
    (registry / f"anthropic-ai-claude-code-linux-{arch}.tgz").write_bytes(platform)
    work = tmp_path / "work"
    work.mkdir()
    pins = tuple((a, _integrity_of(pinned_platform)) for a in ("x64", "arm64"))
    spec = LayerSpec(integrity=_integrity_of(b"the stub"), platform_integrity=pins)
    script = _build_script(spec, work)
    return subprocess.run(
        ["/bin/sh", "-c", script],
        check=False,
        capture_output=True,
        text=True,
        cwd=work,
        env={"PATH": f"{fake}:/usr/bin:/bin", "FAKE_NPM_DIR": str(registry)},
    )


# #856-T13
def test_the_build_script_passes_when_both_tarballs_have_their_digests(tmp_path: Path) -> None:
    done = _run_build(
        tmp_path, stub=b"the stub", platform=b"the program", pinned_platform=b"the program"
    )

    assert done.returncode == 0, done.stderr


# #856-T13
def test_the_build_script_fails_when_the_stub_does_not_have_its_digest(tmp_path: Path) -> None:
    done = _run_build(
        tmp_path, stub=b"a changed stub", platform=b"the program", pinned_platform=b"the program"
    )

    assert done.returncode != 0 and "claude-code.tgz: FAILED" in done.stdout


# #856-T13
def test_the_build_script_fails_when_the_platform_program_does_not_have_its_digest(
    tmp_path: Path,
) -> None:
    done = _run_build(
        tmp_path, stub=b"the stub", platform=b"a changed program", pinned_platform=b"the program"
    )

    assert done.returncode != 0 and "claude-code-linux-" in done.stdout and "FAILED" in done.stdout
