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
choice is the device's. A version, never a tag such as `latest`: the adapter's event shapes and the
behaviours it relies on (`--include-partial-messages`, the tool search switch) are those of a
version.

The layer adds one thing besides the program: the unprivileged user Claude Code runs as
(`command.py`; `bypassPermissions` refuses to run as root), with a home of its own.
It holds no credential: the login is handed to a turn's exec through its environment (`login.py`).
"""

import base64
import binascii
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
LAYER_REPOSITORY: Final = "code-reviewer-agent-claude-code"
# The label that says which version a layer holds; a layer under the right tag with another label
# is not trusted.
VERSION_LABEL: Final = "com.code-reviewer.claude-code"
# Fetching the package and installing it; a slow link is the device's.
BUILD_SECONDS: Final = 1200.0
_VERSION: Final = re.compile(r"\d{1,4}\.\d{1,4}\.\d{1,4}")
_IMAGE_ID: Final = re.compile(r"sha256:[0-9a-f]{64}")


class LayerError(Exception):
    """The layer cannot be had. The message says why, in words of the daemon's or the runner's."""


@dataclass(frozen=True)
class LayerSpec:
    version: str = CLAUDE_CODE_VERSION
    # The npm `dist.integrity` of the version's tarball (`sha512-<base64>`); None for a version the
    # device chose, which nobody pinned.
    integrity: str | None = CLAUDE_CODE_INTEGRITY

    def __post_init__(self) -> None:
        if not _VERSION.fullmatch(self.version):
            raise ValueError("a Claude Code version is an exact version such as 2.1.311")
        if self.integrity is not None and _hex_digest(self.integrity) is None:
            raise ValueError("the integrity is an npm sha512 digest")


def _hex_digest(integrity: str) -> str | None:
    if not integrity.startswith("sha512-"):
        return None
    try:
        raw = base64.b64decode(integrity.removeprefix("sha512-"), validate=True)
    except (binascii.Error, ValueError):
        return None
    return raw.hex() if len(raw) == 64 else None


def dockerfile(base_id: str, spec: LayerSpec) -> str:
    """The text of the layer. `base_id` is the image **id** of the agent image, so the layer is
    exactly on what its tag names."""
    if not _IMAGE_ID.fullmatch(base_id):
        raise ValueError("the base of the layer is an image id")
    check = ""
    if spec.integrity is not None:
        digest = _hex_digest(spec.integrity)
        check = f'    echo "{digest}  /tmp/${{tarball}}" | sha512sum -c -; \\\n'
    uid = AGENT_UID
    return (
        f"FROM {base_id}\n"
        "USER 0:0\n"
        f'LABEL {VERSION_LABEL}="{spec.version}"\n'
        "RUN set -eu; \\\n"
        "    cd /tmp; \\\n"
        f'    npm pack "{PACKAGE}@{spec.version}" --silent > /tmp/claude-code.name; \\\n'
        '    tarball="$(cat /tmp/claude-code.name)"; \\\n'
        f"{check}"
        '    npm install --global "/tmp/${tarball}"; \\\n'
        "    npm cache clean --force; \\\n"
        '    rm -f "/tmp/${tarball}" /tmp/claude-code.name; \\\n'
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
    """`code-reviewer-agent-claude-code:<version>-<first 12 hex digits of the base image id>`."""
    return f"{LAYER_REPOSITORY}:{spec.version}-{base_id.removeprefix('sha256:')[:12]}"


class LayerDaemon(Protocol):
    """The two calls of the daemon the layer needs (`DockerApi`)."""

    def inspect_image(self, reference: str) -> dict[str, Any]: ...

    def build_image(self, context: bytes, tag: str, *, timeout: float) -> None: ...


@dataclass(frozen=True)
class Layer:
    image: str
    # True when this call built it, False when it was there already.
    built: bool


def _version_of(image: dict[str, Any]) -> object:
    """The version label of an image, None when it has none."""
    config = as_object(image.get("Config"))
    labels = None if config is None else as_object(config.get("Labels"))
    return None if labels is None else labels.get(VERSION_LABEL)


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
        if _version_of(daemon.inspect_image(tag)) == spec.version:
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
