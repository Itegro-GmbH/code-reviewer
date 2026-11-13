# SPDX-License-Identifier: LicenseRef-Proprietary

"""#1023: what a runner on the Incus backend announces about the harnesses of its golden image.

Claude Code is never shipped by us: `docker/incus/build-golden.sh` installs the pinned, checked
program into the golden image **on the device** (R3's layer) and records what it found as image
properties. The runner reads those properties (it boots no instance to announce itself) and says
`claude-code` with the subscription only when the layer in the image is the one this runner pins,
and OpenCode with the version the image really holds."""

from collections.abc import Mapping
from pathlib import Path

import pytest
from incus_support import FakeIncus, short_directory

from code_reviewer_runner.factory_runner import config
from code_reviewer_runner.factory_runner.config import RunnerConfig
from code_reviewer_runner.factory_runner.incus.client import IncusError
from code_reviewer_runner.factory_runner.incus.harnesses import (
    PROPERTY_AGENT_IMAGE,
    PROPERTY_CLAUDE_CODE,
    PROPERTY_CLAUDE_CODE_LAYER,
    PROPERTY_OPENCODE,
    golden_harnesses,
)
from code_reviewer_runner.factory_runner.incus.prepare import prepare_incus
from code_reviewer_runner.implementer.claude_code.layer import (
    CLAUDE_CODE_VERSION,
    LayerSpec,
    layer_tag,
)
from code_reviewer_runner.implementer.claude_code.readiness import VERSION_VARIABLE

pytestmark = pytest.mark.unit

AGENT_ID = "sha256:" + "cd" * 32
SPEC = LayerSpec()
TOKEN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"


def golden(**changes: str | None) -> dict[str, str]:
    """The properties `build-golden.sh` records for an image that holds OpenCode and Claude Code."""
    properties: dict[str, str | None] = {
        "description": "code-reviewer golden image",
        PROPERTY_OPENCODE: "1.19.0",
        PROPERTY_AGENT_IMAGE: AGENT_ID,
        PROPERTY_CLAUDE_CODE: CLAUDE_CODE_VERSION,
        PROPERTY_CLAUDE_CODE_LAYER: layer_tag(AGENT_ID, SPEC),
    }
    properties.update(changes)
    return {name: value for name, value in properties.items() if value is not None}


def runner_config() -> RunnerConfig:
    return RunnerConfig(
        url="https://app.example.com",
        credential="crr_" + "x" * 40,
        limits=config.Limits(parallel_runs=1),
    )


def environment(root: Path, **extra: str) -> dict[str, str]:
    return {
        "FACTORY_RUNNER_VM_STATE_DIR": str(root),
        "FACTORY_RUNNER_INCUS_POOL": "crpool",
        "FACTORY_RUNNER_VM_IMAGE_ID": "sha256:" + "ab" * 32,
        "FACTORY_RUNNER_SLOT_NETWORK": "10.99.0.0/24",
        "FACTORY_RUNNER_HOME": str(root / "home"),
        **extra,
    }


def entries(announced: Mapping[str, object]) -> dict[str, dict[str, object]]:
    manifest = announced["manifest"]
    assert isinstance(manifest, dict)
    return {each["harness"]: each for each in manifest["harnesses"]}  # type: ignore[index]


def announced_by(properties: Mapping[str, str] | None, **extra: str) -> tuple[dict[str, dict[str, object]], str | None, tuple[str, ...]]:
    with short_directory() as root:
        incus = FakeIncus(pool="crpool")
        if properties is not None:
            incus.image_properties_of["code-reviewer-golden"] = dict(properties)
        prepared = prepare_incus(runner_config(), environment(root, **extra), client=incus.provision)
        announcement = prepared.announcement
        document = {"manifest": announcement.manifest}
        return entries(document), prepared.claude_version, prepared.harness_notes


# #1023-T01
def test_an_image_with_claude_code_announces_it_with_the_subscription_and_opencode_with_its_version() -> None:
    harnesses, claude_version, _ = announced_by(golden())

    assert harnesses["claude-code"] == {
        "harness": "claude-code",
        "version": CLAUDE_CODE_VERSION,
        "auth": "subscription",
    }
    assert harnesses["opencode"] == {"harness": "opencode", "version": "1.19.0", "auth": "app-key"}
    assert claude_version == CLAUDE_CODE_VERSION


# #1023-T02
def test_an_image_built_without_claude_code_announces_opencode_only() -> None:
    properties = golden(
        **{PROPERTY_CLAUDE_CODE: None, PROPERTY_CLAUDE_CODE_LAYER: None}
    )

    harnesses, claude_version, notes = announced_by(properties)

    assert set(harnesses) == {"opencode"}
    assert harnesses["opencode"]["version"] == "1.19.0"
    assert claude_version is None
    assert any("no Claude Code" in note for note in notes), notes


# #1023-T03
def test_an_older_image_without_any_property_still_runs_opencode_and_says_to_rebuild() -> None:
    harnesses, claude_version, notes = announced_by({"description": "old"})

    assert set(harnesses) == {"opencode"} and claude_version is None
    assert any("build-golden.sh" in note for note in notes), notes


# #1023-T04
def test_a_layer_that_is_not_the_one_this_runner_pins_is_not_announced() -> None:
    other = LayerSpec(version="2.1.300", integrity=None)
    properties = golden(
        **{
            PROPERTY_CLAUDE_CODE: other.version,
            PROPERTY_CLAUDE_CODE_LAYER: layer_tag(AGENT_ID, other),
        }
    )

    harnesses, claude_version, notes = announced_by(properties)

    assert "claude-code" not in harnesses and claude_version is None
    assert any("not the one this runner pins" in note for note in notes), notes


# #1023-T05
def test_the_version_the_device_chose_is_announced_only_when_the_image_holds_exactly_that() -> None:
    chosen = LayerSpec(version="2.1.300", integrity=None)
    held = golden(
        **{
            PROPERTY_CLAUDE_CODE: chosen.version,
            PROPERTY_CLAUDE_CODE_LAYER: layer_tag(AGENT_ID, chosen),
        }
    )

    harnesses, claude_version, _ = announced_by(held, **{VERSION_VARIABLE: "2.1.300"})
    assert harnesses["claude-code"]["version"] == "2.1.300" and claude_version == "2.1.300"

    harnesses, claude_version, notes = announced_by(golden(), **{VERSION_VARIABLE: "2.1.300"})
    assert "claude-code" not in harnesses and claude_version is None
    assert any("not the one this runner pins" in note for note in notes), notes

    harnesses, _, notes = announced_by(golden(), **{VERSION_VARIABLE: "latest"})
    assert "claude-code" not in harnesses
    assert any("exact version" in note for note in notes), notes


# #1023-T06
def test_properties_that_are_not_what_the_build_writes_never_announce_claude_code() -> None:
    for bad in (
        golden(**{PROPERTY_AGENT_IMAGE: "latest"}),
        golden(**{PROPERTY_CLAUDE_CODE: "latest"}),
        golden(**{PROPERTY_CLAUDE_CODE: "9.9.9"}),
        golden(**{PROPERTY_CLAUDE_CODE_LAYER: "x:y"}),
    ):
        harnesses, claude_version, _ = announced_by(bad)

        assert "claude-code" not in harnesses and claude_version is None, bad
    harnesses, _, _ = announced_by(golden(**{PROPERTY_OPENCODE: "not a version"}))
    assert harnesses["opencode"]["version"] == "0"


# #1023-T07
def test_an_image_that_cannot_be_read_costs_the_harnesses_but_not_the_machine() -> None:
    with short_directory() as root:
        incus = FakeIncus(pool="crpool")
        incus.fail["image_properties"] = IncusError("image list", "boom")

        prepared = prepare_incus(runner_config(), environment(root), client=incus.provision)

        assert prepared.ready and prepared.claude_version is None
        assert any("boom" in note for note in prepared.harness_notes)


# #1023-T08
def test_the_image_is_not_read_when_the_machine_is_not_ready() -> None:
    with short_directory() as root:
        incus = FakeIncus(pool="crpool")
        incus.images.clear()

        prepared = prepare_incus(runner_config(), environment(root), client=incus.provision)

        assert not prepared.ready and prepared.claude_version is None
        assert ("image_properties",) not in incus.calls


# #1023-T09
def test_the_log_says_what_the_login_of_the_device_is_without_a_secret() -> None:
    with short_directory() as root:
        found = golden_harnesses(golden(), {"FACTORY_RUNNER_HOME": str(root)}, root / "home")
        assert found.claude is not None and found.claude.ready
        assert any("no Claude Code login" in note for note in found.claude.notes)

        with_login = golden_harnesses(
            golden(), {"CLAUDE_CODE_OAUTH_TOKEN": TOKEN}, root / "home"
        )
        assert with_login.claude is not None and with_login.claude.ready
        assert not any(TOKEN in note for note in with_login.claude.notes)
        assert not with_login.claude.notes
