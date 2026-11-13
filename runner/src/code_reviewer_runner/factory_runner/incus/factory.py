# SPDX-License-Identifier: LicenseRef-Proprietary

"""The sandbox factory the service takes (`Seams.sandbox`) for `FACTORY_RUNNER_SANDBOX=incus`
(#1007): the settings of the machine and its limits make an `IncusSandbox`."""

from collections.abc import Callable, Mapping

from code_reviewer_runner.factory_runner.config import RunnerConfig
from code_reviewer_runner.factory_runner.sandbox import WorkerSandbox

from .client import CliIncusClient
from .launcher import IncusSandbox
from .settings import settings_from_environment


def incus_sandbox_factory(
    config: RunnerConfig, source: Mapping[str, str]
) -> Callable[[Mapping[str, str], float], WorkerSandbox]:
    """`(job environment, stop grace) -> sandbox`, as the service calls its factory. The grace is
    the Worker-as-a-process mode's: a job's instances are deleted at once and have a wall clock."""

    def make(environment: Mapping[str, str], grace_seconds: float) -> WorkerSandbox:
        _ = grace_seconds
        settings = settings_from_environment(
            source,
            parallel_runs=config.limits.parallel_runs,
            disk_gb=config.limits.disk_gb,
            job_environment=environment,
        )
        return IncusSandbox(
            settings,
            CliIncusClient(
                settings.incus, call_seconds=settings.call_seconds, state_dir=settings.state_dir
            ),
        )

    return make
