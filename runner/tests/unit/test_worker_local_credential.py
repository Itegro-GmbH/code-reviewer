# SPDX-License-Identifier: LicenseRef-Proprietary

"""The local credential in Control, the Worker of a VM (#980): the same shape and the same
allow-list as the Worker of a process (`test_factory_runner_local_worker.py`), and the way the
Worker tells the dispatcher of the device why a subscription refused a job (its exit code)."""

import asyncio
import io
import json
from collections.abc import Mapping
from typing import Any

import pytest
from loop_support import FakeLauncher, FakeProcess, outcome, result_line
from support import make_job_dict

from code_reviewer_runner import worker_cli
from code_reviewer_runner.job_loop.api import CompleteReply, HeartbeatReply
from code_reviewer_runner.job_loop.process import ProcessSpec, RunningProcess
from code_reviewer_runner.job_loop.settings import WorkerSettings
from code_reviewer_runner.job_loop.worker import WorkerRequest, run_worker
from code_reviewer_runner.job_loop.worker_api import WorkerJob
from code_reviewer_runner.job_loop.worker_errors import WorkerExit
from code_reviewer_runner.result import ErrorCode

pytestmark = pytest.mark.unit

JOB = "00000000-0000-4000-8000-000000000001"
CREDENTIAL = "crj_" + "B" * 43
CONTROL_TOKEN = "control-token-of-the-host-0123456789-abcdefghij"
LOGIN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"


def document(**extra: Any) -> str:
    return json.dumps(
        {
            "appUrl": "https://app.test",
            "jobId": JOB,
            "credential": CREDENTIAL,
            "controlToken": CONTROL_TOKEN,
            **extra,
        }
    )


class Seen:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def run_worker(
        self,
        request: WorkerRequest,
        settings: WorkerSettings,
        environment: Mapping[str, str],
        **keywords: Any,
    ) -> WorkerExit:
        self.calls.append({"request": request, "environment": dict(environment), **keywords})
        return WorkerExit.OK


@pytest.fixture
def seen(monkeypatch: pytest.MonkeyPatch) -> Seen:
    found = Seen()
    monkeypatch.setattr(worker_cli, "run_worker", found.run_worker)
    monkeypatch.setattr(worker_cli, "configure_logging", lambda: None)

    def startup(settings: WorkerSettings, **_: object) -> tuple[WorkerSettings, None]:
        return settings, None

    monkeypatch.setattr(worker_cli, "run_startup", startup)
    return found


def control(stdin: str) -> worker_cli.Ended:
    return worker_cli._run({"PATH": "/usr/bin"}, io.StringIO(stdin))  # pyright: ignore[reportPrivateUsage]


# #980-T01
def test_control_puts_the_credential_into_the_job_environment_and_the_masker(seen: Seen) -> None:
    ended = control(document(localCredential={"name": "CLAUDE_CODE_OAUTH_TOKEN", "value": LOGIN}))

    assert ended.code == int(WorkerExit.OK)
    [call] = seen.calls
    assert call["environment"] == {"PATH": "/usr/bin", "CLAUDE_CODE_OAUTH_TOKEN": LOGIN}
    assert call["extra_secrets"] == (LOGIN,)
    assert LOGIN not in repr(call["request"])


def test_a_control_without_a_credential_adds_nothing(seen: Seen) -> None:
    control(document())

    [call] = seen.calls
    assert call["environment"] == {"PATH": "/usr/bin"} and call["extra_secrets"] == ()


# #980-T07 (the review of #977: Control's own allow-list)
@pytest.mark.parametrize("name", ["PATH", "LD_PRELOAD", "RUNNER_JOB_TIMEOUT_SECONDS", "HOME"])
def test_control_refuses_every_name_it_does_not_know_before_it_runs_anything(
    seen: Seen, name: str, capsys: pytest.CaptureFixture[str]
) -> None:
    ended = control(document(localCredential={"name": name, "value": LOGIN}))

    assert ended.code == int(WorkerExit.SETUP_ERROR) and seen.calls == []
    assert LOGIN not in capsys.readouterr().err


# #977 review: the host's token is for the environment control, not for the agent
def test_the_token_of_the_host_goes_to_the_environment_control_and_not_into_the_environment(
    seen: Seen,
) -> None:
    ended = control(document(localCredential={"name": "CLAUDE_CODE_OAUTH_TOKEN", "value": LOGIN}))

    [call] = seen.calls
    assert ended.control_token == CONTROL_TOKEN
    assert CONTROL_TOKEN not in json.dumps(call["environment"])
    assert CONTROL_TOKEN not in json.dumps(call["extra_secrets"])
    assert call["request"].control_token == CONTROL_TOKEN


# -- why a subscription refused a job: the Worker's exit code -------------------------------------


class FakeApi:
    def __init__(self) -> None:
        self.completions: list[dict[str, Any]] = []

    async def check_app(self, job_id: str) -> None: ...

    async def fetch(self, job_id: str) -> WorkerJob:
        return WorkerJob(id=job_id, heartbeat_interval=30.0, input=make_job_dict())

    async def heartbeat(self, job_id: str, lease_token: str) -> HeartbeatReply:
        return HeartbeatReply()

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> CompleteReply:
        self.completions.append(dict(result))
        return CompleteReply("failed", False)


class Finishing(FakeLauncher):
    def __init__(self, stdout: bytes, exit_code: int) -> None:
        super().__init__()
        self._stdout = stdout
        self._exit_code = exit_code

    async def start(self, spec: ProcessSpec) -> RunningProcess:
        process = await super().start(spec)
        assert isinstance(process, FakeProcess)
        process.finish(outcome(exit_code=self._exit_code, stdout=self._stdout))
        return process


def worker_ends(code: str | None) -> WorkerExit:
    stdout = (
        result_line(ok=False, errorCode=code, commentUrl=None, logTail="no")
        if code
        else result_line()
    )
    request = WorkerRequest(app_url="https://app.test", job_id=JOB, credential=CREDENTIAL)
    settings = WorkerSettings(job_command=("fake-job",))
    return asyncio.run(
        run_worker(
            request,
            settings,
            {"PATH": "/usr/bin"},
            api=FakeApi(),
            launcher=Finishing(stdout, 1 if code else 0),
        )  # type: ignore[arg-type]
    )


# #980-T04, #980-T05, #980-T02
@pytest.mark.parametrize(
    ("code", "exit_code"),
    [
        (ErrorCode.SUBSCRIPTION_AUTH.value, WorkerExit.SUBSCRIPTION_AUTH),
        (ErrorCode.SUBSCRIPTION_LIMIT.value, WorkerExit.SUBSCRIPTION_LIMIT),
        (ErrorCode.SUBSCRIPTION_MODEL_REFUSED.value, WorkerExit.SUBSCRIPTION_MODEL_REFUSED),
        (ErrorCode.LLM_AUTH.value, WorkerExit.FAILED),
        (ErrorCode.COMMAND_FAILED.value, WorkerExit.FAILED),
        (None, WorkerExit.OK),
    ],
)
def test_a_job_the_subscription_refused_ends_with_the_exit_code_that_says_why(
    code: str | None, exit_code: WorkerExit
) -> None:
    assert worker_ends(code) is exit_code


def test_the_verdict_exit_codes_stay_clear_of_the_ones_docker_and_vm_init_use() -> None:
    verdicts = {
        int(WorkerExit.SUBSCRIPTION_AUTH),
        int(WorkerExit.SUBSCRIPTION_LIMIT),
        int(WorkerExit.SUBSCRIPTION_MODEL_REFUSED),
    }
    assert len(verdicts) == 3 and verdicts.isdisjoint({0, 1, 2, 125, 126, 127, 137, 143})
    assert all(0 < code < 125 for code in verdicts)
