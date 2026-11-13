# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a machine with the Incus sandbox finds out before it takes a job (#1007): the counterpart
of `firecracker/prepare.py`.

The checks are about the host: `incus` answers (the user is in `incus-admin`), the pool and the
golden image are there, every slot has its two bridges, the state directory is writable. They are
what the installer (#1011) arranges; a machine that fails one is not ready and the check says which.
The instances' own content (Docker, the Worker image) is proven by the release's smoke test in CI
and
by the readiness probe of every job, not here: a runner does not boot instances to announce
itself."""

import asyncio
import os
from collections.abc import Callable, Mapping

from code_reviewer_runner.factory_runner.config import RunnerConfig
from code_reviewer_runner.factory_runner.prepare import (
    Prepared,
    announcement_for,
    implementer_settings,
)
from code_reviewer_runner.factory_runner.selftest import (
    CHECK_AGENT_DOCKER,
    Check,
    SelfTestResult,
)
from code_reviewer_runner.job_loop.settings import worker_settings_from_environment

from .client import CliIncusClient, IncusClient, IncusError
from .host_wall import HostWallGate, WallVerdict
from .provision import misconfigured_objects, missing_objects
from .settings import IncusSettings, SettingsError, settings_from_environment

RUNTIME = "incus"

# What the checks use: a client of Incus; a test brings its own.
ClientFactory = Callable[[IncusSettings], IncusClient]
# What says whether the host's nft table of the outer wall is in place (#1008): the gate's verdict.
WallCheck = Callable[[IncusSettings], WallVerdict]


def _real_wall(settings: IncusSettings) -> WallVerdict:
    return HostWallGate.for_settings(settings).verify()


def _real_client(settings: IncusSettings) -> IncusClient:
    return CliIncusClient(
        settings.incus,
        call_seconds=min(settings.call_seconds, 30.0),
        state_dir=settings.state_dir,
    )


async def _host_checks(
    settings: IncusSettings, client: IncusClient, wall: WallCheck
) -> tuple[Check, ...]:
    checks: list[Check] = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append(Check(name, ok, "" if ok else detail))

    try:
        await client.version()
    except (IncusError, OSError) as error:
        detail = error.detail if isinstance(error, IncusError) else "the incus program is missing"
        check(
            "incus",
            False,
            f"{settings.incus} does not answer ({detail}); is the user in incus-admin?",
        )
        return tuple(checks)
    check("incus", True, "")
    try:
        lacking = await missing_objects(client, settings)
        wrong = await misconfigured_objects(client, settings)
    except IncusError as error:
        check("incus-objects", False, f"Incus could not be asked ({error.detail})")
    else:
        problems = [
            *([f"missing: {', '.join(lacking.items)} (made at install)"] if lacking else []),
            *([f"not as the launcher needs them: {'; '.join(wrong)}"] if wrong else []),
        ]
        check("incus-objects", not problems, " | ".join(problems))
    verdict = wall(settings)
    check("outer-wall-table", verdict.ok, verdict.reason)
    writable = os.access(settings.state_dir, os.W_OK)
    check("state-dir", writable, f"{settings.state_dir} is missing or not writable")
    return tuple(checks)


def host_checks(
    settings: IncusSettings, client: IncusClient, wall: WallCheck = _real_wall
) -> tuple[Check, ...]:
    return asyncio.run(_host_checks(settings, client, wall))


def prepare_incus(
    config: RunnerConfig,
    source: Mapping[str, str],
    *,
    checks: Callable[[IncusSettings], tuple[Check, ...]] | None = None,
    client: ClientFactory = _real_client,
    wall: WallCheck = _real_wall,
) -> Prepared:
    """Test the machine and decide what the runner is. Never raises: a machine that is not ready
    is a `Prepared` whose base is not proven, and the failed check says why."""
    settings = implementer_settings(worker_settings_from_environment(source))
    try:
        vm = settings_from_environment(
            source,
            parallel_runs=config.limits.parallel_runs,
            disk_gb=config.limits.disk_gb,
            job_environment=source,
        )
    except SettingsError as error:
        result = SelfTestResult((Check("incus-settings", False, str(error)),), RUNTIME)
        return Prepared(settings, {}, announcement_for(config, result, None), result)

    def real_checks(each: IncusSettings) -> tuple[Check, ...]:
        return host_checks(each, client(each), wall)

    run = checks or real_checks
    results = (*run(vm), Check(CHECK_AGENT_DOCKER, True, "Docker is in the instances"))
    result = SelfTestResult(results, RUNTIME)
    environment = {name: source[name] for name in ("RUNNER_JOB_TIMEOUT_SECONDS",) if name in source}
    return Prepared(settings, environment, announcement_for(config, result, vm.memory_mib), result)
