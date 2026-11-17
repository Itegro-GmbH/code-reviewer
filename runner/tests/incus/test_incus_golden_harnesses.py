# SPDX-License-Identifier: LicenseRef-Proprietary

"""The harnesses of the real golden image (#1023), on the DevBox: what the recipe
(`docker/incus/build-golden.sh`) installed **on the device** (Claude Code as R3's layer on the
agent image, in the image's own Docker) and recorded in the image, read the way `prepare_incus`
reads it, and checked against what the image's Docker really holds.

What is real: Incus, the golden image, an instance of it with the golden image's Docker, the
launcher's own client, and the runner's own reading of the image (`golden_harnesses`). What is not
here: a model, the subscription's login or a whole job. The subscription path of a job ends at
`api.anthropic.com` through the network door, a name the lane's CA (one domain, a critical name
constraint) cannot sign for and the agent's container does not trust the lane's CA for, so a
Claude Code job against a fake endpoint is a follow-up; the unit tests cover the placement of the
look (`test_device_harness.py`) and the announcement (`test_incus_harnesses.py`).

Run it with `-m incus --force-enable-socket` and the variables of `incus_lane.py`
(`load_job_machine`; the image must come from a build without `--no-claude-code`)."""

import asyncio
import re
import time
import uuid
from collections.abc import Coroutine, Iterator
from pathlib import Path
from typing import Any

import pytest
from incus_lane import JobMachine

from code_reviewer_runner.factory_runner.incus.client import (
    CliIncusClient,
    ExecResult,
    InstanceSpec,
    run_exec,
)
from code_reviewer_runner.factory_runner.incus.harnesses import (
    PROPERTY_AGENT_IMAGE,
    PROPERTY_CLAUDE_CODE_LAYER,
    golden_harnesses,
)
from code_reviewer_runner.implementer.claude_code.layer import CLAUDE_CODE_VERSION
from code_reviewer_runner.implementer.claude_code.readiness import AGENT_IMAGE

pytestmark = pytest.mark.incus

DOCKER_READY_SECONDS = 90.0


def go(coroutine: Coroutine[Any, Any, Any]) -> Any:
    return asyncio.run(coroutine)


async def sh(client: CliIncusClient, name: str, command: str, seconds: float = 120.0) -> ExecResult:
    return await run_exec(client, name, ("sh", "-c", command), timeout=seconds)


@pytest.fixture(scope="module")
def client(job_machine: JobMachine) -> CliIncusClient:
    job_machine.machine.state.mkdir(parents=True, exist_ok=True)
    return CliIncusClient(call_seconds=120.0, state_dir=job_machine.machine.state)


@pytest.fixture(scope="module")
def instance(job_machine: JobMachine, client: CliIncusClient) -> Iterator[str]:
    """One instance of the golden image, with the same security settings as a job's B and no
    network (nothing here needs one), deleted at the end."""
    machine = job_machine.machine
    name = f"{machine.prefix}-hrn-{uuid.uuid4().hex[:6]}"
    spec = InstanceSpec(
        name,
        machine.image,
        machine.pool,
        config={
            "security.privileged": "false",
            "security.nesting": "true",
            "security.idmap.isolated": "true",
            "limits.memory": "2048MiB",
        },
        disk_gib=16,
    )
    go(client.create(spec))
    try:
        go(client.start(name))
        deadline = time.monotonic() + DOCKER_READY_SECONDS
        while time.monotonic() < deadline:
            if go(sh(client, name, "docker info >/dev/null 2>&1", 20.0)).exit_code == 0:
                break
            time.sleep(2.0)
        else:
            raise AssertionError("the image's Docker does not answer")
        yield name
    finally:
        go(client.delete(name))


# #1023-T21
def test_the_image_says_what_it_holds_and_the_runner_reads_both_harnesses_from_it(
    job_machine: JobMachine, client: CliIncusClient, tmp_path: Path
) -> None:
    properties = go(client.image_properties(job_machine.machine.image))

    assert properties is not None
    found = golden_harnesses(properties, {}, tmp_path)

    assert found.opencode_version is not None and re.fullmatch(
        r"\d+\.\d+\.\d+", found.opencode_version
    )
    # Claude Code is the pinned version and ready (the login is the dispatcher's pool's to judge).
    assert found.claude is not None and found.claude.ready, found.notes
    assert found.claude.version == CLAUDE_CODE_VERSION


# #1023-T22
def test_the_images_docker_holds_the_layer_the_properties_name_and_the_programs_agree(
    job_machine: JobMachine, client: CliIncusClient, instance: str
) -> None:
    properties = go(client.image_properties(job_machine.machine.image))
    assert properties is not None
    layer = properties[PROPERTY_CLAUDE_CODE_LAYER]
    base = properties[PROPERTY_AGENT_IMAGE]

    ids = go(sh(client, instance, f"docker image inspect -f '{{{{.Id}}}}' {AGENT_IMAGE}"))
    claude = go(
        sh(
            client,
            instance,
            f"docker run --rm --network none --entrypoint claude {layer} --version",
        )
    )
    opencode = go(
        sh(
            client,
            instance,
            "docker run --rm --network none --entrypoint /usr/local/bin/opencode "
            f"{AGENT_IMAGE} --version",
        )
    )

    # The agent image the properties name is the one in the image's Docker, the layer sits on it
    # (its tag carries that id), and what the programs say is what the properties said.
    assert ids.stdout.strip() == base
    assert claude.exit_code == 0 and claude.stdout.split()[0] == CLAUDE_CODE_VERSION, claude
    assert (
        opencode.exit_code == 0 and opencode.stdout.strip() == properties["code-reviewer.opencode"]
    )
