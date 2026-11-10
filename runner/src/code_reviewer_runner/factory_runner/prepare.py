# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a runner finds out about its machine before it takes a job (#854, R1b): the runtime, the
agent image, the memory, the self-test, and from them the announcement and the environment of the
job processes.

The result is `Prepared`. A runner whose base is not proven announces no OpenCode entry and
takes no job (the app routes only to a runner that announces OpenCode); the failed check says why.
"""

import json
import os
import shutil
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Final

from code_reviewer_runner.capabilities import ENGINE_IMPLEMENTER
from code_reviewer_runner.factory_runner.app_client import Announcement
from code_reviewer_runner.factory_runner.base import (
    AUTH_APP_KEY,
    AUTH_SUBSCRIPTION,
    BASE_VERSION,
    HARNESS_OPENCODE,
)
from code_reviewer_runner.factory_runner.config import (
    RunnerConfig,
    home_directory,
    limits_document,
    runner_identity,
)
from code_reviewer_runner.factory_runner.limits import (
    LimitsError,
    agent_environment,
    agent_memory_mb,
    machine_memory_mb,
)
from code_reviewer_runner.factory_runner.selftest import (
    CHECK_MEMORY,
    Check,
    SelfTestResult,
    pinned_opencode_version,
    run_selftest,
)
from code_reviewer_runner.implementer.agent_container import AGENT_IMAGE_REFERENCE, AGENT_RUNTIME
from code_reviewer_runner.implementer.claude_code.login import login_source
from code_reviewer_runner.implementer.claude_code.readiness import (
    HARNESS_CLAUDE_CODE,
    HarnessStatus,
    claude_code_status,
)
from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError
from code_reviewer_runner.implementer.role_labels import RUNNER_ID_VARIABLE
from code_reviewer_runner.implementer.runner_profile import AGENT_RUNTIME_VARIABLE
from code_reviewer_runner.job import (
    IMPLEMENTER_AGENT_MEMORY_VARIABLE,
    IMPLEMENTER_MODEL_DOOR_VARIABLE,
    IMPLEMENTER_SANDBOX_PROOF_VARIABLE,
    IMPLEMENTER_WORK_DIR,
    IMPLEMENTER_WORK_DIR_VARIABLE,
)
from code_reviewer_runner.job_loop.settings import WorkerSettings, worker_settings_from_environment
from code_reviewer_runner.pr_agent_config import PASSTHROUGH_VARIABLES

IMAGE_FILE: Final = Path("/opt/code-reviewer/agent-image.json")
PULL_SECONDS: Final = 900.0
RUNC: Final = "runc"
_GOLDEN_REPOSITORY, _GOLDEN_TAG = AGENT_IMAGE_REFERENCE.split(":")


@dataclass(frozen=True)
class Prepared:
    settings: WorkerSettings
    # The environment of the job host: the plain runtime variables of the process and the
    # variables that say how the containers of a turn are made.
    environment: Mapping[str, str]
    announcement: Announcement
    selftest: SelfTestResult
    # What the runner found out about the harnesses it adds to the base (#856), for its log.
    harness_notes: tuple[str, ...] = ()

    @property
    def ready(self) -> bool:
        return self.selftest.base_ok


def baked_agent_image(path: Path = IMAGE_FILE) -> str | None:
    """The agent image reference the runner image was built with (`agent-image.json`), if any."""
    try:
        reference = json.loads(path.read_text(encoding="utf-8")).get("reference")
    except (OSError, ValueError, AttributeError):
        return None
    return reference if isinstance(reference, str) and reference else None


def split_reference(reference: str) -> tuple[str, str]:
    """`(repository, tag or digest)` of an image reference (`name:tag`, `name@sha256:...`, or a
    name with a tag and a digest, where the digest wins)."""
    name, _, digest = reference.partition("@")
    if digest:
        name = name.rsplit(":", 1)[0] if ":" in name.rsplit("/", 1)[-1] else name
        return name, digest
    if ":" in name.rsplit("/", 1)[-1]:
        repository, _, tag = name.rpartition(":")
        return repository, tag
    return name, "latest"


def pull_image(api: DockerApi, reference: str) -> None:
    """Pull `reference` and give it the name the runner starts agents from. `DockerError` when the
    daemon cannot."""
    repository, tag = split_reference(reference)
    api.request(
        "POST", f"/images/create?fromImage={repository}&tag={tag}", ok=(200,), timeout=PULL_SECONDS
    )
    api.request(
        "POST",
        f"/images/{reference}/tag?repo={_GOLDEN_REPOSITORY}&tag={_GOLDEN_TAG}",
        ok=(201,),
    )


def candidate_runtimes(choice: str, available: Callable[[], set[str]]) -> tuple[str, ...]:
    """The runtimes to try, best first. `auto` takes Sysbox when the daemon has it and falls back
    to `runc` when the self-test does not pass under it."""
    if choice != "auto":
        return (choice,)
    try:
        has_sysbox = AGENT_RUNTIME in available()
    except DockerError:
        has_sysbox = False
    return (AGENT_RUNTIME, RUNC) if has_sysbox else (RUNC,)


def _failure(check: str, detail: str) -> SelfTestResult:
    return SelfTestResult((Check(check, False, detail),), RUNC)


def job_environment(
    source: Mapping[str, str], config: RunnerConfig, runtime: str, memory_mb: int
) -> dict[str, str]:
    """The environment of the job host: the plain variables the process may have (never the
    runner's credential), and the variables that describe this machine's containers."""
    environment = {name: source[name] for name in PASSTHROUGH_VARIABLES if name in source}
    if "PR_AGENT_COMMAND" in source:  # test stacks only, as for the Worker
        environment["PR_AGENT_COMMAND"] = source["PR_AGENT_COMMAND"]
    environment.update(
        {
            IMPLEMENTER_WORK_DIR_VARIABLE: IMPLEMENTER_WORK_DIR,
            IMPLEMENTER_MODEL_DOOR_VARIABLE: "docker",
            IMPLEMENTER_SANDBOX_PROOF_VARIABLE: "proven",
            IMPLEMENTER_AGENT_MEMORY_VARIABLE: str(memory_mb),
            AGENT_RUNTIME_VARIABLE: runtime,
            **agent_environment(config.limits),
        }
    )
    if identity := runner_identity(config):
        environment[RUNNER_ID_VARIABLE] = identity
    # #856: a job that asks for Claude Code reads the login of this device in its own process.
    environment.update(login_source(source, home_directory(source)))
    return environment


def free_disk_gb(path: Path = Path(IMPLEMENTER_WORK_DIR)) -> int | None:
    try:
        return max(1, shutil.disk_usage(path).free // 2**30)
    except OSError:
        return None


# The harnesses a runner adds to the base, as `(api, environment, build) -> {name: status}`.
HarnessChecks = Callable[[DockerApi, Mapping[str, str], bool], dict[str, HarnessStatus]]


def harness_checks(
    api: DockerApi, source: Mapping[str, str], build: bool
) -> dict[str, HarnessStatus]:
    """What this device adds to the base: Claude Code when it has a login for it (#856). `build`
    False only looks."""
    found = claude_code_status(api, source, home_directory(source), build=build)
    return {} if found is None else {HARNESS_CLAUDE_CODE: found}


def announcement_for(
    config: RunnerConfig,
    result: SelfTestResult,
    memory_mb: int | None,
    harnesses: Mapping[str, HarnessStatus] | None = None,
) -> Announcement:
    """What this runner says about itself: its labels, the base, the entries it can run (a harness
    with the source of its access, #973), the harnesses it adds (never instead of OpenCode), the
    capabilities of the self-test, the limits it works within.

    An entry is announced only while the runner can run it: a base that is not proven announces no
    OpenCode (a runner without it gets no job) and a harness that is not ready is left out. OpenCode
    runs on the key the app hands out through the Worker API (`app-key`); Claude Code on the
    subscription of this device, whatever model it reads (no `models`)."""
    announced: list[dict[str, object]] = []
    if result.base_ok:
        announced.append(
            {
                "harness": HARNESS_OPENCODE,
                "version": result.opencode_version or pinned_opencode_version() or "0",
                "auth": AUTH_APP_KEY,
            }
        )
    for name, status in (harnesses or {}).items():
        if name != HARNESS_OPENCODE and status.ready:
            announced.append(
                {"harness": name, "version": status.version, "auth": AUTH_SUBSCRIPTION}
            )
    manifest: dict[str, object] = {"harnesses": announced}
    if result.capabilities:
        manifest["capabilities"] = list(result.capabilities)
    limits = limits_document(config.limits)
    limits.setdefault("cpus", os.cpu_count() or 1)
    if memory_mb is not None:
        limits.setdefault("memoryMb", memory_mb)
    disk = free_disk_gb()
    if disk is not None:
        limits.setdefault("diskGb", disk)
    return Announcement(config.labels, BASE_VERSION, manifest, limits)


def prepare(
    config: RunnerConfig,
    source: Mapping[str, str],
    *,
    selftest: Callable[..., SelfTestResult] = run_selftest,
    api: Callable[[], DockerApi] = DockerApi,
    pull: Callable[[DockerApi, str], None] | None = pull_image,
    machine_mb: Callable[[], int] = machine_memory_mb,
    harnesses: HarnessChecks = harness_checks,
) -> Prepared:
    """Test the machine and decide what the runner is. Never raises for a machine that is not
    ready: that is a `Prepared` whose base is not proven. `pull=None` only looks: an image that is
    not here, or is not the pinned one, is reported and left alone."""
    settings = worker_settings_from_environment(source)
    settings = _implementer_settings(settings)
    reference = config.agent_image or baked_agent_image()
    try:
        memory = agent_memory_mb(config.limits, machine_mb=machine_mb())
    except LimitsError as error:
        result = _failure(CHECK_MEMORY, str(error))
        return Prepared(settings, {}, announcement_for(config, result, None), result)
    docker = api()
    result = _failure("docker", "no runtime was tried")
    runtime = RUNC
    for runtime in candidate_runtimes(config.runtime, docker.runtimes):
        result = selftest(
            runtime=runtime,
            limits=config.limits,
            agent_image=reference,
            pull=pull,
            runner_id=runner_identity(config),
        )
        if result.base_ok:
            break
    # Only on a machine whose base holds: a daemon that fails the base cannot build a layer either.
    added = harnesses(docker, source, pull is not None) if result.base_ok else {}
    return Prepared(
        settings,
        job_environment(source, config, runtime, memory),
        announcement_for(config, result, memory, added),
        result,
        tuple(f"{name}: {note}" for name, status in sorted(added.items()) for note in status.notes),
    )


def _implementer_settings(settings: WorkerSettings) -> WorkerSettings:
    """The settings of a runner's job host: it advertises the Implementer engine and nothing else
    (the self-test is the proof, there is no engine user or rule set of the hosted Worker here)."""
    return replace(
        settings,
        engines=(ENGINE_IMPLEMENTER,),
        implementer_work_dir=Path(IMPLEMENTER_WORK_DIR),
        implementer_docker=True,
    )
