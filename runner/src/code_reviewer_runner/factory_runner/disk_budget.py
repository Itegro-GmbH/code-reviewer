# SPDX-License-Identifier: LicenseRef-Proprietary

"""The disk budget of a runner's job (#855, R2; plan decision 8).

`diskGb` is what one job may hold on the machine's disk, beside what the machine keeps for itself.
It is measured while the job runs and counts what the job makes:

- the folders of the turn in `/work` (`reserve`, `repo`, `result`; the git mirror, the agent's
  repository, the finish tool's file), by walking them;
- the writable layer of every container of this runner (the agent's, the setup container's, the
  door's: what an agent writes into its container, or its session files, are in there), asked from
  the daemon;
- the image the setup container's result is committed as (`code-reviewer-agent:environment`), but
  only what the commit **added** to the agent image it was made from (its size minus the agent
  image's), because the agent image is the runner's, shared and there before the job. Once that
  image exists, the setup container's own writable layer is not counted any more: it is what the
  commit wrote into the image, and one copy of it is the job's.

The Docker images of the runner itself and the images the daemon holds for other things are not the
job's and not counted. A hosted VM is thrown away with whatever the job wrote; a machine is not, so
the budget is the one place where a job that fills the disk is stopped instead of the machine.

When the measure passes the budget the job host ends the job (`JobHost` `guard`): the process is
ended the way a shutdown ends it, the job is reported as failed with the reason
`disk_budget_exceeded` and a text that says what the budget was and what was in use, and the
cleaning that follows every job (`housekeeping.tidy`: the containers, the folders of `/work`, the
environment image) frees all of it. The job is not given back: it would fill the disk again.
"""

import asyncio
import json
import os
import stat
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Final
from urllib.parse import quote

from code_reviewer_runner.factory_runner.config import Limits
from code_reviewer_runner.factory_runner.housekeeping import (
    ENVIRONMENT_IMAGE,
    WORK_SUBDIRECTORIES,
    container_filters,
)
from code_reviewer_runner.implementer.agent_container import AGENT_IMAGE_REFERENCE
from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError
from code_reviewer_runner.implementer.role_labels import ROLE_LABEL
from code_reviewer_runner.job_loop.jsonvalues import as_object

GIB: Final = 2**30
# How often the budget is measured. A walk of a big repository and the daemon's sizes take seconds,
# and a job fills a disk over minutes, not between two looks.
MEASURE_SECONDS: Final = 20.0
SIZE_TIMEOUT_SECONDS: Final = 60.0
# The role label of the setup container (`setup_container.py`).
SETUP_ROLE: Final = "setup"


def budget_bytes(limits: Limits) -> int | None:
    """The budget in bytes, None without one (`diskGb` not set: the machine's disk is the limit)."""
    return None if limits.disk_gb is None else limits.disk_gb * GIB


def tree_bytes(root: Path) -> int:
    """What a folder holds on the disk: the allocated blocks of every file below it, a file with
    several links once, links not followed, a folder that cannot be read counted as far as it can
    be. Missing: 0."""
    total = 0
    seen: set[tuple[int, int]] = set()
    pending = [root]
    while pending:
        folder = pending.pop()
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            try:
                status = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISDIR(status.st_mode):
                pending.append(Path(entry.path))
            if status.st_nlink > 1 and not stat.S_ISDIR(status.st_mode):
                key = (status.st_dev, status.st_ino)
                if key in seen:
                    continue
                seen.add(key)
            total += status.st_blocks * 512
    return total


def _image_size(api: DockerApi, reference: str) -> int | None:
    try:
        size = api.inspect_image(reference).get("Size")
    except DockerError:
        return None
    return size if isinstance(size, int) and not isinstance(size, bool) else None


def environment_bytes(api: DockerApi, base_image: str = AGENT_IMAGE_REFERENCE) -> int | None:
    """What the commit of a setup result added to the agent image: the environment image's size
    minus the agent image's. None when there is no environment image; 0 when the agent image's size
    cannot be read (a part the daemon cannot say counts as nothing)."""
    size = _image_size(api, ENVIRONMENT_IMAGE)
    if size is None:
        return None
    base = _image_size(api, base_image)
    return 0 if base is None else max(0, size - base)


def used_bytes(
    api: DockerApi, work_dir: Path, runner_id: str, *, base_image: str = AGENT_IMAGE_REFERENCE
) -> int:
    """What the job holds now, see the module text (`base_image`: the image the setup container
    is made from). A part the daemon cannot say counts as 0: a daemon that cannot answer is the
    loop's problem to find, not a reason to end a job."""
    total = sum(tree_bytes(work_dir / name) for name in WORK_SUBDIRECTORIES)
    environment = environment_bytes(api, base_image)
    selector = quote(json.dumps({"label": container_filters(runner_id)}))
    try:
        listed = api.request("GET", f"/containers/json?all=1&filters={selector}")
    except DockerError:
        listed = []
    for item in listed if isinstance(listed, list) else []:  # pyright: ignore[reportUnknownVariableType]
        entry = as_object(item)  # pyright: ignore[reportUnknownArgumentType]
        identifier = None if entry is None else entry.get("Id")
        if not isinstance(identifier, str):
            continue
        labels = as_object(entry.get("Labels")) if entry is not None else None
        if environment is not None and (labels or {}).get(ROLE_LABEL) == SETUP_ROLE:
            continue  # its layer is in the environment image, counted once below
        try:
            total += api.container_rw_bytes(identifier, timeout=SIZE_TIMEOUT_SECONDS) or 0
        except DockerError:
            continue
    return total + (environment or 0)


def exceeded_message(limit_bytes: int, used: int) -> str:
    return (
        f"the runner's disk budget of {limit_bytes / GIB:.1f} GB for a job is used up "
        f"({used / GIB:.1f} GB in use): the job was ended and what it wrote was removed "
        "(raise it with `factory-runner config set --disk-gb`)"
    )


def guard_for(
    limit_bytes: int, measure: Callable[[], int], *, interval: float = MEASURE_SECONDS
) -> Callable[[], Awaitable[str]]:
    """The job host's guard: a coroutine function whose coroutine returns the text when the measure
    passes the budget and otherwise runs until it is cancelled. The measure runs in a thread (it
    walks folders)."""

    async def watch() -> str:
        while True:
            try:
                used = await asyncio.to_thread(measure)
            except Exception:
                # A measure that fails is no reason to end a job; the next look may work.
                used = 0
            if used > limit_bytes:
                return exceeded_message(limit_bytes, used)
            await asyncio.sleep(interval)

    return watch
