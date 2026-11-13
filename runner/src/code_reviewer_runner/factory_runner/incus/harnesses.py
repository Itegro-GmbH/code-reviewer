# SPDX-License-Identifier: LicenseRef-Proprietary

"""The harnesses of the Incus golden image, as the runner announces them (#1023).

The image is built **on the device** (`docker/incus/build-golden.sh`): the agent's image holds
OpenCode, and Claude Code is installed on top of it as R3's layer (`implementer/claude_code/
layer.py`: the pinned version, the SHA-512 of every npm tarball, the program unmodified, its
self-update off by configuration of the agent's environment). Claude Code is Anthropic's
proprietary software and **never ships with our repository or an image of ours**: the device
fetches it itself, the same as the Docker mode builds its layer.

The harnesses live in Docker **inside** the image, and a runner boots no instance to announce
itself. So the build records what it **found** (the programs' own `--version`) as properties of the
Incus image, and this module reads them back:

* `code-reviewer.opencode`: the version `opencode --version` printed in the agent's image;
* `code-reviewer.agent-image`: the id of the agent image in the image's Docker;
* `code-reviewer.claude-code`: the version `claude --version` printed in the layer;
* `code-reviewer.claude-code.layer`: the tag of the layer (`layer_tag`: the version, the digests it
  was checked against, the base it sits on).

Claude Code is ready only when the layer in the image is **exactly** the one this runner would
build (the same tag): a runner whose pin moved on, or a device that chose another version, announces
nothing until the image is built again. Each job looks again at the real daemon
(`job_run.device_harness`), so a property never lets a job run on a layer that is not there."""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from code_reviewer_runner.implementer.claude_code.layer import layer_tag
from code_reviewer_runner.implementer.claude_code.login import LoginProblem, load_login
from code_reviewer_runner.implementer.claude_code.readiness import HarnessStatus, layer_spec

PROPERTY_OPENCODE: Final = "code-reviewer.opencode"
PROPERTY_AGENT_IMAGE: Final = "code-reviewer.agent-image"
PROPERTY_CLAUDE_CODE: Final = "code-reviewer.claude-code"
PROPERTY_CLAUDE_CODE_LAYER: Final = "code-reviewer.claude-code.layer"

REBUILD: Final = "build the golden image again with docker/incus/build-golden.sh"
_VERSION: Final = re.compile(r"\d{1,4}\.\d{1,4}\.\d{1,4}")
_IMAGE_ID: Final = re.compile(r"sha256:[0-9a-f]{64}")


@dataclass(frozen=True)
class GoldenHarnesses:
    """What the image says of its harnesses. `opencode_version` is None when it does not say (an
    image built before the properties existed); `claude` is None when the image has no Claude Code
    (left out at the build, or older). `notes` are words for the log, never a secret."""

    opencode_version: str | None
    claude: HarnessStatus | None
    notes: tuple[str, ...]


def _claude_status(
    properties: Mapping[str, str], environment: Mapping[str, str], home: Path
) -> HarnessStatus:
    spec = layer_spec(environment)
    if isinstance(spec, str):
        return HarnessStatus("0", False, (spec,))
    held = properties.get(PROPERTY_CLAUDE_CODE, "")
    base = properties.get(PROPERTY_AGENT_IMAGE, "")
    layer = properties.get(PROPERTY_CLAUDE_CODE_LAYER, "")
    if not _IMAGE_ID.fullmatch(base) or layer != layer_tag(base, spec) or held != spec.version:
        return HarnessStatus(
            spec.version,
            False,
            (
                f"the golden image holds Claude Code {held or '?'} in a layer that is not the one "
                f"this runner pins ({spec.version}): {REBUILD}",
            ),
        )
    login = load_login(environment, home)
    return HarnessStatus(
        spec.version, True, (login.text,) if isinstance(login, LoginProblem) else ()
    )


def golden_harnesses(
    properties: Mapping[str, str] | None, environment: Mapping[str, str], home: Path
) -> GoldenHarnesses:
    """What the golden image's properties say of OpenCode and Claude Code, and whether this runner
    can run Claude Code on that layer."""
    if properties is None:
        return GoldenHarnesses(None, None, ("the golden image has no properties to read",))
    notes: list[str] = []
    opencode = properties.get(PROPERTY_OPENCODE, "")
    if not _VERSION.fullmatch(opencode):
        notes.append(f"the golden image does not name its OpenCode version: {REBUILD}")
    claude: HarnessStatus | None = None
    if PROPERTY_CLAUDE_CODE in properties:
        claude = _claude_status(properties, environment, home)
        notes.extend(claude.notes)
    else:
        notes.append(
            "the golden image has no Claude Code (built with --no-claude-code, or before it was "
            f"installed there): {REBUILD}"
        )
    return GoldenHarnesses(opencode if _VERSION.fullmatch(opencode) else None, claude, tuple(notes))
