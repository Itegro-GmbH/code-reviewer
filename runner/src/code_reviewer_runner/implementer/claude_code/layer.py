# SPDX-License-Identifier: LicenseRef-Proprietary

"""The install layer of Claude Code on the agent image (#856, plan decision 11).

Claude Code is Anthropic's proprietary software: it is used unmodified, and **we never publish or
ship it**. The runner builds the layer **on the customer's device**, from the npm registry, on top
of the agent image the runner already has, and caches it under a tag that names the version and the
base image (`layer_tag`). A new agent image or a new version is a new layer; an old one is left to
the daemon's own cleanup.

The version is pinned here (`CLAUDE_CODE_VERSION`, the npm `stable` tag of 2026-11-04 that the R0
spike measured) together with the SHA-512 of its npm tarball (`CLAUDE_CODE_INTEGRITY`): the build
fetches the tarball, accepts it only with that digest and installs it from the file. The device may
choose another exact version (`LayerSpec(version=...)`): then there is no digest to compare, and the
choice is the device's. **Verified and unverified layers never share a tag or a label**
(`layer_tag`, `layer_labels`): a device that names the pinned version itself still gets the pinned
spec with its digest, and a layer built without the check is never taken for the pinned one.

The npm package is only a stub: the program is the platform package it names as an optional
dependency (`@anthropic-ai/claude-code-linux-x64`, `-arm64`; the glibc builds, the agent image is
Debian). Both are pinned: `PLATFORM_INTEGRITY` holds the SHA-512 of each platform tarball, the
build fetches the stub **and** the tarball of the machine's architecture, accepts each only with
its digest, and installs from the two files with `--offline`, so npm resolves nothing from the
registry on its own. A machine of another architecture (or libc) cannot build the pinned layer.

A version, never a tag such as `latest`: the adapter's event shapes and the behaviours it relies on
(`--include-partial-messages`, the tool search switch) are those of a version.

The layer adds one thing besides the program: the unprivileged user Claude Code runs as
(`command.py`; `bypassPermissions` refuses to run as root), with a home of its own.
It holds no credential: the login is handed to a turn's exec through its environment (`login.py`).
"""

import base64
import binascii
import hashlib
import io
import re
import tarfile
from dataclasses import dataclass
from typing import Any, Final, Protocol

from code_reviewer_runner.implementer.docker_api import DockerError
from code_reviewer_runner.job_loop.jsonvalues import as_object

from .command import AGENT_HOME, AGENT_UID

PACKAGE: Final = "@anthropic-ai/claude-code"
CLAUDE_CODE_VERSION: Final = "2.1.311"
# `npm view @anthropic-ai/claude-code@2.1.311 dist.integrity`.
CLAUDE_CODE_INTEGRITY: Final = "sha512-7SgBitii1ZscdbRJXLcub7Vv2pfvH3wo7RrCKg4vZpklIfz9HgigJFFJGIjCY6jzoPDvbQcwwugvm3A8PTejzw=="  # noqa: E501
# `npm view @anthropic-ai/claude-code-linux-<arch>@2.1.311 dist.integrity` (glibc builds), by the
# architecture name npm uses. Changing the version means changing all three digests together.
PLATFORM_INTEGRITY: Final[tuple[tuple[str, str], ...]] = (
    (
        "x64",
        "sha512-dk1lVMt7n+NlYucKM7dLp/PfrK32pa/4oKQkacfazlSj8rG+hkH67wnDnaFG9Gs2al3OjK8PTVHgZ2WGHXoWUg==",
    ),
    (
        "arm64",
        "sha512-yZwDmtXmoZcFcCjCaoznOKqjrjjdQyc6PVuh6brANqQcaKpP+WZGuFlgUjgQh86u8HBybHZBB60WWOumKpO6uQ==",
    ),
)
# `uname -m` (of a Linux container or host) to the architecture name of the platform packages.
MACHINE_ARCHITECTURES: Final = {
    "x86_64": "x64",
    "amd64": "x64",
    "aarch64": "arm64",
    "arm64": "arm64",
}
LAYER_REPOSITORY: Final = "code-reviewer-agent-claude-code"
# The labels that say which version a layer holds and whether its tarball was checked against a
# digest (the hex of it, or `UNVERIFIED_LABEL`); a layer under the right tag with other labels is
# not trusted.
VERSION_LABEL: Final = "com.code-reviewer.claude-code"
INTEGRITY_LABEL: Final = "com.code-reviewer.claude-code.integrity"
# A short fingerprint of the platform digests the layer was checked against, or `unverified`. A
# layer built when only the stub was pinned has no such label and is built again.
PLATFORM_LABEL: Final = "com.code-reviewer.claude-code.platform"
UNVERIFIED_LABEL: Final = "unverified"
# Fetching the package and installing it; a slow link is the device's.
BUILD_SECONDS: Final = 1200.0
_VERSION: Final = re.compile(r"\d{1,4}\.\d{1,4}\.\d{1,4}")
_IMAGE_ID: Final = re.compile(r"sha256:[0-9a-f]{64}")


class LayerError(Exception):
    """The layer cannot be had. The message says why, in words of the daemon's or the runner's."""


def platform_package(architecture: str) -> str:
    """The npm package that holds the program for an architecture name of `PLATFORM_INTEGRITY`."""
    return f"{PACKAGE}-linux-{architecture}"


@dataclass(frozen=True)
class LayerSpec:
    version: str = CLAUDE_CODE_VERSION
    # The npm `dist.integrity` of the version's tarball (`sha512-<base64>`); None for a version the
    # device chose, which nobody pinned.
    integrity: str | None = CLAUDE_CODE_INTEGRITY
    # The same for the platform tarballs, by architecture name. A pinned stub always comes with
    # the pinned program and an unpinned one with none: the default follows `integrity`.
    platform_integrity: tuple[tuple[str, str], ...] | None = PLATFORM_INTEGRITY

    def __post_init__(self) -> None:
        if not _VERSION.fullmatch(self.version):
            raise ValueError("a Claude Code version is an exact version such as 2.1.311")
        if self.integrity is not None and _hex_digest(self.integrity) is None:
            raise ValueError("the integrity is an npm sha512 digest")
        if self.integrity is None and self.platform_integrity is PLATFORM_INTEGRITY:
            object.__setattr__(self, "platform_integrity", None)
        if (self.integrity is None) != (self.platform_integrity is None):
            raise ValueError("the stub and the platform program are pinned together or not at all")
        for architecture, integrity in self.platform_integrity or ():
            if architecture not in MACHINE_ARCHITECTURES.values():
                raise ValueError("a platform digest is for x64 or arm64")
            if _hex_digest(integrity) is None:
                raise ValueError("the platform integrity is an npm sha512 digest")


def _hex_digest(integrity: str) -> str | None:
    if not integrity.startswith("sha512-"):
        return None
    try:
        raw = base64.b64decode(integrity.removeprefix("sha512-"), validate=True)
    except (binascii.Error, ValueError):
        return None
    return raw.hex() if len(raw) == 64 else None


def _integrity_word(spec: LayerSpec) -> str:
    """The hex digest the layer is checked against, or `unverified`."""
    digest = None if spec.integrity is None else _hex_digest(spec.integrity)
    return UNVERIFIED_LABEL if digest is None else digest


def _platform_digests(spec: LayerSpec) -> dict[str, str]:
    """The hex digest of the program tarball for each architecture; empty when unverified."""
    pinned = {a: _hex_digest(i) for a, i in spec.platform_integrity or ()}
    return {architecture: digest for architecture, digest in sorted(pinned.items()) if digest}


def _platform_word(spec: LayerSpec) -> str:
    """A fingerprint of every platform digest the layer is checked against, or `unverified`."""
    digests = _platform_digests(spec)
    if not digests:
        return UNVERIFIED_LABEL
    text = "".join(f"{architecture}={digest}\n" for architecture, digest in digests.items())
    return hashlib.sha256(text.encode("ascii")).hexdigest()


def layer_labels(spec: LayerSpec) -> dict[str, str]:
    """The labels the layer carries (`find_layer` compares them all)."""
    return {
        VERSION_LABEL: spec.version,
        INTEGRITY_LABEL: _integrity_word(spec),
        PLATFORM_LABEL: _platform_word(spec),
    }


def _install_script(spec: LayerSpec) -> str:
    """The shell lines (without the line continuations) that fetch, check and install the program.

    Pinned: the stub and the program of this machine's architecture are fetched as tarballs, each
    is checked against its digest (`sha512sum -c` under `set -e` fails the build), and both are
    installed from the files with `--offline`, so nothing else is resolved from the registry.
    Unpinned (a version the device chose): the stub alone, as the device asked.
    """
    lines = [
        "set -eu;",
        "cd /tmp;",
        f'npm pack "{PACKAGE}@{spec.version}" --silent > /tmp/claude-code.name;',
        'tarball="$(cat /tmp/claude-code.name)";',
    ]
    digests = _platform_digests(spec)
    stub = None if spec.integrity is None else _hex_digest(spec.integrity)
    if stub is None or not digests:
        lines.append('npm install --global "/tmp/${tarball}";')
        lines.append("npm cache clean --force;")
        lines.append('rm -f "/tmp/${tarball}" /tmp/claude-code.name;')
        return "\n".join(lines)
    lines.append(f'echo "{stub}  /tmp/${{tarball}}" | sha512sum -c -;')
    lines.append('case "$(uname -m)" in')
    for architecture, digest in digests.items():
        machines = "|".join(m for m, a in MACHINE_ARCHITECTURES.items() if a == architecture)
        lines.append(f'{machines}) platform={architecture}; platform_digest="{digest}" ;;')
    lines.append('*) echo "no pinned Claude Code program for $(uname -m)" >&2; exit 1 ;;')
    lines.append("esac;")
    lines.append(
        f'npm pack "{PACKAGE}-linux-${{platform}}@{spec.version}" --silent '
        "> /tmp/claude-code-platform.name;"
    )
    lines.append('platform_tarball="$(cat /tmp/claude-code-platform.name)";')
    lines.append('echo "${platform_digest}  /tmp/${platform_tarball}" | sha512sum -c -;')
    lines.append(
        "npm install --global --offline --no-audit --no-fund "
        '"/tmp/${tarball}" "/tmp/${platform_tarball}";'
    )
    lines.append("npm cache clean --force;")
    lines.append(
        'rm -f "/tmp/${tarball}" "/tmp/${platform_tarball}" /tmp/claude-code.name '
        "/tmp/claude-code-platform.name;"
    )
    return "\n".join(lines)


def dockerfile(base_id: str, spec: LayerSpec) -> str:
    """The text of the layer. `base_id` is the image **id** of the agent image, so the layer is
    exactly on what its tag names."""
    if not _IMAGE_ID.fullmatch(base_id):
        raise ValueError("the base of the layer is an image id")
    uid = AGENT_UID
    install = " \\\n    ".join(_install_script(spec).split("\n"))
    labels = " ".join(f'{name}="{value}"' for name, value in layer_labels(spec).items())
    return (
        f"FROM {base_id}\n"
        "USER 0:0\n"
        f"LABEL {labels}\n"
        f"RUN {install} \\\n"
        '    ln -sf "$(npm prefix --global)/bin/claude" /usr/local/bin/claude; \\\n'
        f'    test "$(claude --version | cut -d" " -f1)" = "{spec.version}"\n'
        f"RUN groupadd --gid {uid} agent \\\n"
        f"    && useradd --uid {uid} --gid {uid} --create-home --home-dir {AGENT_HOME} "
        "--shell /bin/bash agent \\\n"
        f"    && install -d -m 0700 -o {uid} -g {uid} {AGENT_HOME}/.claude\n"
    )


def build_context(text: str) -> bytes:
    """The tar the daemon builds from: the Dockerfile and nothing else."""
    data = text.encode("utf-8")
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        member = tarfile.TarInfo("Dockerfile")
        member.size = len(data)
        member.mode = 0o644
        archive.addfile(member, io.BytesIO(data))
    return buffer.getvalue()


def layer_tag(base_id: str, spec: LayerSpec) -> str:
    """`code-reviewer-agent-claude-code:<version>-<sha512-<first 12 hex digits of the stub's digest>
    -p<first 8 of the platform fingerprint> or unverified>-<first 12 hex digits of the base image
    id>`."""
    word = _integrity_word(spec)
    program = _platform_word(spec)
    checked = word if word == UNVERIFIED_LABEL else f"sha512-{word[:12]}-p{program[:8]}"
    return f"{LAYER_REPOSITORY}:{spec.version}-{checked}-{base_id.removeprefix('sha256:')[:12]}"


class LayerDaemon(Protocol):
    """The two calls of the daemon the layer needs (`DockerApi`)."""

    def inspect_image(self, reference: str) -> dict[str, Any]: ...

    def build_image(self, context: bytes, tag: str, *, timeout: float) -> None: ...


@dataclass(frozen=True)
class Layer:
    image: str
    # True when this call built it, False when it was there already.
    built: bool


def _is_layer_of(image: dict[str, Any], spec: LayerSpec) -> bool:
    """Whether the labels of an image are exactly those of the layer `spec` asks for."""
    config = as_object(image.get("Config"))
    labels = None if config is None else as_object(config.get("Labels"))
    if labels is None:
        return False
    return all(labels.get(name) == value for name, value in layer_labels(spec).items())


def find_layer(
    daemon: LayerDaemon,
    agent_image: str,
    spec: LayerSpec = LayerSpec(),  # noqa: B008
) -> Layer | None:
    """The layer if it is on the daemon (`built` False), else None. Raises `LayerError` when the
    agent image itself is not there."""
    base_id = _base_id(daemon, agent_image)
    tag = layer_tag(base_id, spec)
    try:
        if _is_layer_of(daemon.inspect_image(tag), spec):
            return Layer(tag, False)
    except DockerError:
        pass
    return None


def _base_id(daemon: LayerDaemon, agent_image: str) -> str:
    try:
        base_id = str(daemon.inspect_image(agent_image).get("Id", ""))
    except DockerError:
        raise LayerError("the agent image is not on this daemon") from None
    if not _IMAGE_ID.fullmatch(base_id):
        raise LayerError("the agent image has no usable id")
    return base_id


def ensure_layer(daemon: LayerDaemon, agent_image: str, spec: LayerSpec = LayerSpec()) -> Layer:  # noqa: B008
    """The agent image with Claude Code in it: found by its tag, built when it is not there (or is
    not what its tag says). Raises `LayerError`."""
    found = find_layer(daemon, agent_image, spec)
    if found is not None:
        return found
    base_id = _base_id(daemon, agent_image)
    tag = layer_tag(base_id, spec)
    try:
        daemon.build_image(build_context(dockerfile(base_id, spec)), tag, timeout=BUILD_SECONDS)
    except DockerError as error:
        raise LayerError(
            f"the layer with Claude Code {spec.version} could not be built: {error.message[:300]}"
        ) from None
    return Layer(tag, True)
