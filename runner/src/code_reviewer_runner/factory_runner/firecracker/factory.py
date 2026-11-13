# SPDX-License-Identifier: LicenseRef-Proprietary

"""The sandbox factory the service takes (`Seams.sandbox`) for `FACTORY_RUNNER_SANDBOX=firecracker`
(#978): the settings of the machine and its limits make a `FirecrackerSandbox`."""

from collections.abc import Callable, Mapping

from code_reviewer_runner.factory_runner.config import RunnerConfig
from code_reviewer_runner.factory_runner.sandbox import WorkerSandbox

from .launcher import FirecrackerSandbox
from .settings import settings_from_environment


def firecracker_sandbox_factory(
    config: RunnerConfig, source: Mapping[str, str]
) -> Callable[[Mapping[str, str], float], WorkerSandbox]:
    """`(job environment, stop grace) -> sandbox`, as the service calls its factory. The grace is
    the Worker-as-a-process mode's: a VM is killed at once and has its own wall clock."""

    def make(environment: Mapping[str, str], grace_seconds: float) -> WorkerSandbox:
        _ = grace_seconds
        return FirecrackerSandbox(
            settings_from_environment(
                source,
                parallel_runs=config.limits.parallel_runs,
                disk_gb=config.limits.disk_gb,
                job_environment=environment,
            )
        )

    return make
