# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a machine with the Incus sandbox finds out before it takes a job (#1007): the counterpart
of `firecracker/prepare.py`.

The checks are about the host: `incus` answers (the user is in `incus-admin`), the pool and the
golden image are there, every slot has its two bridges, the state directory is writable. They are
what the installer (#1011) arranges; a machine that fails one is not ready and the check says which.
The instances' own content (Docker, the Worker image) is proven by the release's smoke test in CI
and by the readiness probe of every job. The one thing a runner does boot an instance for is the
capability `agent-docker` (#1136, `probe.py`): it is announced only after the agent's container
unpacked and ran an image of several layers in its own Docker. What the image holds of the
harnesses (OpenCode, Claude Code) is read from the properties the image build recorded
(`harnesses.py`, #1023); a job looks at the real Docker of instance B again."""

import asyncio
import os
from collections.abc import Callable, Mapping

from code_reviewer_runner.factory_runner.app_client import (
    FEATURE_MULTI_REPO,
    FEATURE_PUSH_ALLOWLIST,
)
from code_reviewer_runner.factory_runner.config import RunnerConfig, home_directory
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
from code_reviewer_runner.implementer.claude_code.readiness import HARNESS_CLAUDE_CODE
from code_reviewer_runner.job_loop.settings import worker_settings_from_environment
from code_reviewer_runner.job_loop.worker_api import FEATURE_INNER_DOCKER_VOLUME

from .client import CliIncusClient, IncusClient, IncusError
from .harnesses import GoldenHarnesses, golden_harnesses
from .probe import probe_agent_docker
from .provision import misconfigured_objects, missing_objects
from .settings import IncusSettings, SettingsError, settings_from_environment

RUNTIME = "incus"

# What the checks use: a client of Incus; a test brings its own.
ClientFactory = Callable[[IncusSettings], IncusClient]
# The check of the agent's own Docker (#1136); a test brings its own.
AgentDockerProbe = Callable[[IncusSettings, IncusClient], Check]


def _real_client(settings: IncusSettings) -> IncusClient:
    return CliIncusClient(
        settings.incus,
        call_seconds=min(settings.call_seconds, 30.0),
        state_dir=settings.state_dir,
    )


async def _host_checks(settings: IncusSettings, client: IncusClient) -> tuple[Check, ...]:
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
    writable = os.access(settings.state_dir, os.W_OK)
    check("state-dir", writable, f"{settings.state_dir} is missing or not writable")
    return tuple(checks)


def host_checks(settings: IncusSettings, client: IncusClient) -> tuple[Check, ...]:
    return asyncio.run(_host_checks(settings, client))


def agent_docker_check(settings: IncusSettings, client: IncusClient) -> Check:
    """Run the probe instance (`probe.py`): `agent-docker` is true only when the container's own
    Docker unpacked and ran an image of several layers."""
    return asyncio.run(probe_agent_docker(settings, client))


def image_harnesses(
    settings: IncusSettings, client: IncusClient, source: Mapping[str, str]
) -> GoldenHarnesses:
    """What the golden image says of its harnesses (never raises: an image that cannot be read
    costs the harnesses, not the machine)."""
    try:
        properties = asyncio.run(client.image_properties(settings.image))
    except (IncusError, OSError) as error:
        detail = error.detail if isinstance(error, IncusError) else "the incus program is missing"
        return GoldenHarnesses(
            None, None, (f"the golden image could not be read for its harnesses ({detail})",)
        )
    return golden_harnesses(properties, source, home_directory(source))


def prepare_incus(
    config: RunnerConfig,
    source: Mapping[str, str],
    *,
    checks: Callable[[IncusSettings], tuple[Check, ...]] | None = None,
    client: ClientFactory = _real_client,
    agent_docker: AgentDockerProbe | None = None,
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
        return host_checks(each, client(each))

    run = checks or real_checks
    host = run(vm)
    ready = all(check.ok for check in host)
    # Only on a machine whose base holds: the image is there to be read.
    found = image_harnesses(vm, client(vm), source) if ready else GoldenHarnesses(None, None, ())
    # `agent-docker` is announced only for what was run (#1136): an instance of the golden image,
    # the agent's container in it and an image of several layers in that container's Docker. The
    # probe runs this service's code; the jobs run the Worker in the image, so the image must say
    # that its Worker makes the container the same way. A machine that is not ready is not asked:
    # there may be no image to make an instance from.
    docker: tuple[Check, ...] = ()
    if ready and FEATURE_INNER_DOCKER_VOLUME not in found.worker_features:
        docker = (
            Check(
                CHECK_AGENT_DOCKER,
                False,
                "the golden image's Worker does not give the agent's Docker a volume for its data "
                '(rebuild the golden image: docs/runner.md, "The agent\'s own Docker on Incus")',
            ),
        )
    elif ready:
        docker = ((agent_docker or agent_docker_check)(vm, client(vm)),)
    results = (*host, *docker)
    environment = {name: source[name] for name in ("RUNNER_JOB_TIMEOUT_SECONDS",) if name in source}
    result = SelfTestResult(results, RUNTIME, opencode_version=found.opencode_version)
    claude = found.claude
    added = {HARNESS_CLAUDE_CODE: claude} if claude is not None else {}
    return Prepared(
        settings,
        environment,
        announcement_for(config, result, vm.memory_mib, added),
        result,
        found.notes,
        claude_version=claude.version if claude is not None and claude.ready else None,
        # The Worker is the golden image's, not this service's code: the feature is announced only
        # when the image says its Worker has it (a rebuild of the image and a restart of the service
        # make it so; `docs/runner.md`, "Rolling out a new Worker").
        multi_repo=FEATURE_MULTI_REPO in found.worker_features,
        push_allowlist=FEATURE_PUSH_ALLOWLIST in found.worker_features,
    )
