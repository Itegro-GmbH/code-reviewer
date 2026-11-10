# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Worker a customer's local dispatcher starts (#974, Runner v2): `python -m
code_reviewer_runner.factory_runner.local_worker`.

It is the Worker of the hosted Control (`job_loop/worker.py`: the start document on stdin, the job
fetched over the Worker API with the credential of the claim, the same job host, heartbeats, steps,
snapshot and result), started by a dispatcher that holds none of the job's secrets. What differs is
what the hosted container's start-up decides and a runner's machine decides differently:

- the engine is the Implementer's: the self-test of the dispatcher's start (`prepare`) proved the
  base on this machine, so there is no engine user or rule set of a hosted Worker to check here;
- the disk budget of the machine (`FACTORY_RUNNER_DISK_BUDGET_BYTES`, #855) ends a job that fills
  the disk, as it did when the loop ran the job itself;
- a credential that exists only on this device (a Claude Code subscription, `localEnvironment` of
  the start document) goes into the environment of the job process and into the masker, and nowhere
  else.

The Worker's exit code is the Worker's (`WorkerExit`): 0 the job was run to its end (or given back,
superseded, cancelled), 1 it failed or could not be delivered, 2 it could not start. The dispatcher
reads it, and gives the claim back when the Worker ended without a result.
"""

import asyncio
import logging
import os
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import TextIO

from code_reviewer_runner.factory_runner.base import DISK_BUDGET_VARIABLE
from code_reviewer_runner.factory_runner.disk_budget import guard_for, used_bytes
from code_reviewer_runner.factory_runner.prepare import implementer_settings
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.role_labels import RUNNER_ID_VARIABLE
from code_reviewer_runner.job import IMPLEMENTER_WORK_DIR, IMPLEMENTER_WORK_DIR_VARIABLE
from code_reviewer_runner.job_loop.service import LOGGER_NAME, configure_logging
from code_reviewer_runner.job_loop.settings import (
    SettingsError,
    WorkerSettings,
    worker_settings_from_environment,
)
from code_reviewer_runner.job_loop.worker import (
    MAX_START_DOCUMENT_BYTES,
    WorkerRequest,
    parse_local_environment,
    parse_request,
    run_worker,
)
from code_reviewer_runner.job_loop.worker_errors import (
    WorkerExit,
    WorkerFailure,
    WorkerSetupError,
)


def disk_guard(environment: Mapping[str, str]) -> Callable[[], Awaitable[str]] | None:
    """The guard for the disk budget named in the environment; none without one."""
    raw = environment.get(DISK_BUDGET_VARIABLE, "").strip()
    if not raw.isascii() or not raw.isdigit() or int(raw) < 1:
        return None
    limit = int(raw)
    work_dir = Path(environment.get(IMPLEMENTER_WORK_DIR_VARIABLE) or IMPLEMENTER_WORK_DIR)
    runner = environment.get(RUNNER_ID_VARIABLE, "").strip()
    return guard_for(limit, lambda: used_bytes(DockerApi(), work_dir, runner))


def main(
    *,
    environment: Mapping[str, str] | None = None,
    stdin: TextIO | None = None,
) -> int:
    """Run the Worker and return the process exit code."""
    env = dict(os.environ if environment is None else environment)
    configure_logging()
    log = logging.getLogger(LOGGER_NAME)
    try:
        settings = implementer_settings(worker_settings_from_environment(env))
    except SettingsError as error:
        log.error("worker cannot start: %s: %s", WorkerFailure.SETTINGS_INVALID.value, error)
        return WorkerExit.SETUP_ERROR
    raw = (stdin if stdin is not None else sys.stdin).read(MAX_START_DOCUMENT_BYTES + 1)
    try:
        request = parse_request(raw)
        local = parse_local_environment(raw)
    except WorkerSetupError as error:
        log.error("worker cannot start: %s", error)
        return WorkerExit.SETUP_ERROR
    return int(_run(request, settings, env, local, guard=disk_guard(env)))


def _run(
    request: WorkerRequest,
    settings: WorkerSettings,
    env: Mapping[str, str],
    local: Mapping[str, str],
    *,
    guard: Callable[[], Awaitable[str]] | None,
) -> WorkerExit:
    secrets: Sequence[str] = tuple(local.values())
    # The job process gets the credentials of the device in its environment; the Worker's own
    # environment holds none (they came on stdin).
    return asyncio.run(
        run_worker(
            request,
            settings,
            {**env, **local},
            install_signals=True,
            guard=guard,
            extra_secrets=secrets,
        )
    )


if __name__ == "__main__":
    sys.exit(main())
