# SPDX-License-Identifier: LicenseRef-Proprietary

"""#1023: the Claude Code of the Incus golden image.

`docker/incus/build-golden.sh` runs on the device and installs the pinned, checksum-verified
Claude Code into the agent image there (Claude Code is never shipped by us: R3's rule). It takes
R3's own layer (`implementer/claude_code/layer.py`: the pin, the SHA-512 checks, the unmodified
program) through `runner/scripts/build_claude_layer.py`, so there is one pin and one recipe. The
script runs on plain `python3` of the host; these tests hold the pieces together without Incus."""

import base64
import io
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from code_reviewer_runner.factory_runner.incus import harnesses
from code_reviewer_runner.implementer.claude_code.layer import (
    CLAUDE_CODE_INTEGRITY,
    CLAUDE_CODE_VERSION,
    PLATFORM_INTEGRITY,
    LayerSpec,
    dockerfile,
    layer_tag,
)

pytestmark = pytest.mark.unit

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "runner" / "scripts" / "build_claude_layer.py"
BUILD_GOLDEN = ROOT / "docker" / "incus" / "build-golden.sh"
BASE = "sha256:" + "ab" * 32


def run_script(*arguments: str) -> subprocess.CompletedProcess[bytes]:
    """As build-golden.sh runs it: plain python3, from another directory, no virtual environment."""
    return subprocess.run(
        [sys.executable, str(SCRIPT), *arguments],
        capture_output=True,
        check=False,
        cwd="/",
        timeout=60,
    )


# #1023-T15
def test_the_layer_of_the_golden_build_is_r3s_layer_with_r3s_pin() -> None:
    tagged = run_script("tag", "--base-id", BASE)
    context = run_script("context", "--base-id", BASE)

    assert tagged.returncode == 0 and context.returncode == 0, (tagged.stderr, context.stderr)
    assert tagged.stdout.decode().strip() == layer_tag(BASE, LayerSpec())
    with tarfile.open(fileobj=io.BytesIO(context.stdout)) as archive:
        assert archive.getnames() == ["Dockerfile"]
        member = archive.extractfile("Dockerfile")
        assert member is not None
        text = member.read().decode()
    assert text == dockerfile(BASE, LayerSpec())
    # The checks that make it the pinned program: every digest of the pin is in the build, the
    # build stops on a mismatch, and the program must report the pinned version.
    for digest in (CLAUDE_CODE_INTEGRITY, *(each for _, each in PLATFORM_INTEGRITY)):
        assert base64.b64decode(digest.removeprefix("sha512-")).hex() in text
    assert text.count("sha512sum -c -") == 2
    assert f'test "$(claude --version | cut -d" " -f1)" = "{CLAUDE_CODE_VERSION}"' in text


# #1023-T15
def test_the_script_names_the_pinned_version_and_refuses_what_is_not_an_image_id() -> None:
    assert run_script("version").stdout.decode().strip() == CLAUDE_CODE_VERSION
    for bad in ("latest", "sha256:xyz", ""):
        refused = run_script("tag", "--base-id", bad)
        assert refused.returncode != 0 and refused.stdout == b""
    assert run_script().returncode != 0


# #1023-T16
def test_build_golden_installs_the_layer_after_the_agent_image_and_checks_it_across_a_restart() -> (
    None
):
    text = BUILD_GOLDEN.read_text(encoding="utf-8")

    assert "runner/scripts/build_claude_layer.py" in text
    loaded = text.index('load_image "$AGENT" "$AGENT_COMMAND"')
    built = text.index("docker build", loaded)
    restarted = text.index('ix restart "$BUILD"')
    published = text.index("ix publish")
    assert loaded < built < restarted < published
    # The layer must have the id it had before the restart, like the two images.
    assert 'id_of "$claude_tag"' in text[restarted:published]


# #1023-T16
def test_build_golden_has_an_option_to_leave_claude_code_out_and_opens_npm_only_for_it() -> None:
    text = BUILD_GOLDEN.read_text(encoding="utf-8")

    assert "--no-claude-code)" in text and "CLAUDE_CODE=0" in text
    # The build instance's only way out lists the registry only when the layer is built.
    assert "proxy_hosts+=(registry.npmjs.org)" in text
    assert text.count("registry.npmjs.org") == 1
    # Every proxy build argument is the build's own host address, never anything else.
    assert "HTTPS_PROXY=http://$HOST_ADDRESS:$PROXY_PORT" in text


# #1023-T17
def test_build_golden_records_what_it_found_in_the_image_under_the_names_the_runner_reads() -> None:
    text = BUILD_GOLDEN.read_text(encoding="utf-8")

    for name in (
        harnesses.PROPERTY_OPENCODE,
        harnesses.PROPERTY_AGENT_IMAGE,
        harnesses.PROPERTY_CLAUDE_CODE,
        harnesses.PROPERTY_CLAUDE_CODE_LAYER,
    ):
        assert name in text, name
    # Observed in the build instance (the program's own answer), not copied from the pin.
    assert "claude --version" in text and "opencode --version" in text
    published = text[text.index("ix publish") :].splitlines()[0]
    assert '"${props[@]}"' in published


# #1023-T18
def test_build_golden_is_valid_shell() -> None:
    checked = subprocess.run(
        ["bash", "-n", str(BUILD_GOLDEN)], capture_output=True, check=False, timeout=30
    )

    assert checked.returncode == 0, checked.stderr.decode()
