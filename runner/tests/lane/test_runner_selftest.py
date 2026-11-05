# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Factory-Runner's self-test on a real Docker daemon (#854, R1b): the real agent image with the
pinned OpenCode, started the way a runner starts it (no network, the limits of the configuration),
a whole turn of the engine against the canned model inside it, and the removal of everything.

CI has no Sysbox, so the runtime is `runc` (`LANE_RUNTIME`) and the image's init, which starts the
inner Docker, is replaced by a ready marker: this proves the base of a runner that has no Sysbox,
and that such a runner does not announce `agent-docker`. On a VM with Sysbox (`LANE_RUNTIME=
sysbox-runc`) the same test also expects the capability; that is the run on a spike VM
(`docs/runner.md`)."""

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from lane_support import docker, lane_config

from code_reviewer_runner.factory_runner.config import Limits
from code_reviewer_runner.factory_runner.selftest import (
    SELFTEST_CONTAINER,
    SelfTestSeams,
    run_selftest,
)

ROOT = Path(__file__).resolve().parents[3]
CONTROL = "code-reviewer-lane-selftest-control"
VOLUME = "code-reviewer-lane-selftest-work"


@pytest.fixture
def control(tmp_path: Path) -> Iterator[str]:
    """A container with a Docker volume at /work: the runner's own container, as far as the
    self-test looks at it (it reads its mounts from the daemon)."""
    config = lane_config()
    docker("rm", "-f", CONTROL, check=False)
    docker("volume", "rm", "-f", VOLUME, check=False)
    docker("create", "--name", CONTROL, "-v", f"{VOLUME}:/work", config.worker_image, "true")
    yield CONTROL
    docker("rm", "-f", CONTROL, SELFTEST_CONTAINER, check=False)
    docker("volume", "rm", "-f", VOLUME, check=False)


def seams(control: str, tmp_path: Path) -> SelfTestSeams:
    work = tmp_path / "work"
    work.mkdir()
    return SelfTestSeams(
        hostname=lambda: control,
        pin_file=ROOT / "runner" / "opencode-pin.json",
        work_dir=work,
        image=lane_config().agent_image,
    )


# #854-L01
def test_the_base_of_a_runner_is_proven_by_a_whole_turn_in_the_real_agent_image(
    control: str, tmp_path: Path
) -> None:
    config = lane_config()

    result = run_selftest(
        runtime=config.runtime,
        limits=Limits(cpus=1, memory_mb=2048),
        agent_image=None,
        seams=seams(control, tmp_path),
    )

    failed = result.failed()
    assert failed is None, f"{failed.name}: {failed.detail}" if failed else ""
    assert [check.name for check in result.checks][:7] == [
        "docker",
        "work-volume",
        "memory",
        "agent-image",
        "agent-container",
        "opencode",
        "canned-turn",
    ]
    pinned = json.loads((ROOT / "runner" / "opencode-pin.json").read_text())["version"]
    assert result.opencode_version == pinned
    # Whatever it made is gone.
    assert docker("ps", "-a", "--filter", f"name={SELFTEST_CONTAINER}", "-q").stdout.strip() == ""
    # The capability is announced only where a container ran in the agent's own Docker.
    assert result.agent_docker is config.under_sysbox


# #854-L02
def test_a_missing_agent_image_is_pulled_by_the_reference_the_runner_was_given(
    control: str, tmp_path: Path
) -> None:
    config = lane_config()
    pulled: list[str] = []

    def pull(api: object, reference: str) -> None:
        pulled.append(reference)

    result = run_selftest(
        runtime=config.runtime,
        limits=Limits(memory_mb=2048),
        agent_image="registry.invalid/agent:1",
        pull=pull,  # type: ignore[arg-type]
        seams=SelfTestSeams(
            hostname=lambda: control,
            pin_file=ROOT / "runner" / "opencode-pin.json",
            work_dir=tmp_path,
            image="code-reviewer-lane-no-such-image:1",
        ),
    )

    assert pulled == ["registry.invalid/agent:1"]  # the daemon had no such image, so the pull ran
    failed = result.failed()
    assert failed is not None and failed.name == "agent-image"
