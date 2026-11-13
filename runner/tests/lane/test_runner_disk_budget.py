# SPDX-License-Identifier: LicenseRef-Proprietary

"""The disk budget of a runner's job on a real Docker daemon (#855, R2): what a container writes
into its own layer is measured (the agent's container is also the one the environment's setup
script ran in, #1009), a budget that is passed is noticed, and the cleaning after a job frees it,
and the image an earlier version committed a setup result as. The host's side (the job is ended and
reported) is the unit test's; this proves the measure and the removal against the daemon they
are for."""

import asyncio
import time
from pathlib import Path

from lane_support import docker, lane_config

from code_reviewer_runner.factory_runner.disk_budget import guard_for, used_bytes
from code_reviewer_runner.factory_runner.housekeeping import (
    ENVIRONMENT_IMAGE,
    ROLE_LABEL,
    TidySeams,
    tidy,
)
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.role_labels import RUNNER_LABEL

RUNNER = "lane-budget-runner"
WRITER = "code-reviewer-lane-budget-writer"
COMMITTED = "code-reviewer-lane-budget-committed"
MEGABYTES = 80


# #855-L01
def test_what_a_container_writes_is_measured_noticed_and_freed_by_the_tidy(tmp_path: Path) -> None:
    worker = lane_config().worker_image
    docker("rm", "-f", WRITER, check=False)
    try:
        docker(
            "run", "-d", "--name", WRITER, "--label", f"{ROLE_LABEL}=agent",
            "--label", f"{RUNNER_LABEL}={RUNNER}", "--entrypoint", "sh", worker, "-c",
            f"dd if=/dev/zero of=/var/tmp/fill bs=1M count={MEGABYTES} && sleep 600",
        )  # fmt: skip
        api = DockerApi()
        for name in ("reserve", "repo", "result"):
            (tmp_path / name).mkdir()

        used = 0
        for _ in range(60):  # the writer needs a moment
            used = used_bytes(api, tmp_path, RUNNER)
            if used >= MEGABYTES * 2**20:
                break
            time.sleep(1)
        assert used >= MEGABYTES * 2**20, f"the container's layer is not counted ({used} bytes)"

        message = asyncio.run(
            asyncio.wait_for(
                guard_for(20 * 2**20, lambda: used_bytes(api, tmp_path, RUNNER), interval=1)(), 60
            )
        )
        assert "disk budget" in message

        assert tidy(TidySeams(work_dir=tmp_path, runner_id=RUNNER)) == []

        assert used_bytes(api, tmp_path, RUNNER) < 2**20
        assert docker("ps", "-aq", "--filter", f"name={WRITER}").stdout.strip() == ""
    finally:
        docker("rm", "-f", WRITER, check=False)


# #855-L02, #1009
def test_the_image_an_earlier_version_committed_a_setup_result_as_is_removed_by_the_tidy(
    tmp_path: Path,
) -> None:
    config = lane_config()
    base = config.agent_image
    docker("rm", "-f", COMMITTED, check=False)
    try:
        docker(
            "run", "--name", COMMITTED, "--entrypoint", "sh", base, "-c",
            "head -c 5000000 /dev/zero > /var/tmp/x",
        )  # fmt: skip
        docker("commit", COMMITTED, ENVIRONMENT_IMAGE)
        docker("rm", "-f", COMMITTED)
        api = DockerApi()

        # Nothing is counted for the name: a setup result is not committed any more, what the script
        # left is in the agent's container, whose layer is measured above.
        assert used_bytes(api, tmp_path, RUNNER) < 2**20

        assert tidy(TidySeams(work_dir=tmp_path, runner_id=RUNNER)) == []

        assert docker("image", "inspect", ENVIRONMENT_IMAGE, check=False).returncode != 0
        assert docker("image", "inspect", base).returncode == 0  # only the name of the result went
    finally:
        docker("rm", "-f", COMMITTED, check=False)
        docker("rmi", ENVIRONMENT_IMAGE, check=False)
