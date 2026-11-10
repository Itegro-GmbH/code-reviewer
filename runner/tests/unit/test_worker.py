# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Worker's entry (#323): what it reads from stdin, what it refuses, and that the per-job
credential and the job input never leave the places meant for them. The API and the process are
doubles; the real ones are run in tests/integration/test_worker_once.py."""

import asyncio
import io
import json
import logging
from collections.abc import Mapping
from typing import Any

import pytest
from loop_support import FakeLauncher, FakeProcess, outcome, result_line
from support import API_KEY, TOKEN, make_job_dict

from code_reviewer_runner import worker_cli
from code_reviewer_runner.job import ReviewKind
from code_reviewer_runner.job_loop.api import CompleteReply, HeartbeatReply
from code_reviewer_runner.job_loop.host import process_stdin
from code_reviewer_runner.job_loop.process import ProcessSpec, RunningProcess
from code_reviewer_runner.job_loop.settings import (
    SettingsError,
    WorkerSettings,
    worker_settings_from_environment,
)
from code_reviewer_runner.job_loop.worker import WorkerRequest, parse_request, run_worker
from code_reviewer_runner.job_loop.worker_api import WorkerJob
from code_reviewer_runner.job_loop.worker_errors import (
    WorkerExit,
    WorkerFailure,
    WorkerSetupError,
)

CREDENTIAL = "crj_" + "Zq3_-" * 8 + "Zq3"
JOB_ID = "00000000-0000-4000-8000-000000000001"
APP_URL = "http://127.0.0.1:4030"
REQUEST = WorkerRequest(app_url=APP_URL, job_id=JOB_ID, credential=CREDENTIAL)


def start_document(**overrides: Any) -> str:
    document: dict[str, Any] = {"appUrl": APP_URL, "jobId": JOB_ID, "credential": CREDENTIAL}
    document.update(overrides)
    return json.dumps(document)


class FakeWorkerApi:
    def __init__(self, job_input: Mapping[str, Any] | None = None) -> None:
        self.input = dict(job_input or make_job_dict())
        self.checked = 0
        self.fetched = 0
        self.completions: list[dict[str, Any]] = []
        self.check_error: WorkerSetupError | None = None

    async def check_app(self, job_id: str) -> None:
        self.checked += 1
        if self.check_error is not None:
            raise self.check_error

    async def fetch(self, job_id: str) -> WorkerJob:
        self.fetched += 1
        return WorkerJob(id=job_id, heartbeat_interval=30.0, input=self.input)

    async def heartbeat(self, job_id: str, lease_token: str) -> HeartbeatReply:
        return HeartbeatReply()

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> CompleteReply:
        self.completions.append(dict(result))
        return CompleteReply("succeeded", False)


class FinishingLauncher(FakeLauncher):
    """Every process ends at once with `result`."""

    def __init__(self, result: bytes | None = None, stderr: bytes = b"") -> None:
        super().__init__()
        self._result = result
        self._stderr = stderr

    async def start(self, spec: ProcessSpec) -> RunningProcess:
        process = await super().start(spec)
        assert isinstance(process, FakeProcess)
        process.finish(
            outcome(
                stdout=self._result if self._result is not None else result_line(),
                stderr=self._stderr,
            )
        )
        return process


class Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


def settings(**overrides: Any) -> WorkerSettings:
    values: dict[str, Any] = {"job_command": ("fake-job-process",)}
    values.update(overrides)
    return WorkerSettings(**values)


def run(
    api: FakeWorkerApi, launcher: FinishingLauncher, logger: logging.Logger | None = None
) -> WorkerExit:
    return asyncio.run(
        run_worker(
            REQUEST,
            settings(),
            {
                "PATH": "/usr/bin",
                "HOME": "/home/runner",
                "RUNNER_TOKEN": "must-not-pass-0123456789",
            },
            api=api,
            launcher=launcher,
            logger=logger,
        )
    )


# -- the start document ----------------------------------------------------------------------


CONTROL_TOKEN = "control-token-of-the-host-0123456789-abcdefghij"


# #977-T07
def test_the_start_document_may_carry_the_token_of_the_environment_control() -> None:
    request = parse_request(start_document(controlToken=CONTROL_TOKEN))

    assert request.control_token == CONTROL_TOKEN
    assert CONTROL_TOKEN not in repr(request)
    assert parse_request(start_document()).control_token is None


# #977-T07
@pytest.mark.parametrize("bad", ["short", 7, None, CONTROL_TOKEN + " ", CONTROL_TOKEN + "\n", ""])
def test_a_token_that_is_not_the_contracts_is_refused_without_naming_it(bad: Any) -> None:
    with pytest.raises(WorkerSetupError) as refusal:
        parse_request(start_document(controlToken=bad))

    assert refusal.value.code is WorkerFailure.INPUT_INVALID
    assert CONTROL_TOKEN not in str(refusal.value)


# #977-T07
def test_the_job_process_of_an_implementer_gets_the_token_on_its_stdin_and_no_other_does() -> None:
    raw: dict[str, Any] = {"reviewKind": "implementer", "git": {}, "env": {}}

    implementer = json.loads(process_stdin(raw, ReviewKind.IMPLEMENTER, CONTROL_TOKEN))
    review = json.loads(process_stdin({"reviewKind": "diff"}, ReviewKind.DIFF, CONTROL_TOKEN))
    without = json.loads(process_stdin(raw, ReviewKind.IMPLEMENTER, None))

    assert implementer == {**raw, "environmentControlToken": CONTROL_TOKEN}
    assert "environmentControlToken" not in review
    assert without == raw
    assert raw == {"reviewKind": "implementer", "git": {}, "env": {}}  # the input is not changed


def test_the_start_document_names_the_app_the_job_and_the_credential() -> None:
    request = parse_request(start_document(appUrl=f"{APP_URL}/"))

    assert request == WorkerRequest(app_url=APP_URL, job_id=JOB_ID, credential=CREDENTIAL)


def test_a_field_a_newer_dispatcher_adds_is_ignored() -> None:
    assert parse_request(start_document(somethingNew=1)).job_id == JOB_ID


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "not json",
        "[]",
        "{}",
        start_document(credential="crj_short"),
        start_document(credential="dispatcher-token-0123456789"),
        start_document(credential=None),
        start_document(jobId="not-a-uuid"),
        start_document(jobId=7),
        start_document(appUrl="ftp://app"),
        start_document(appUrl="http://user:pass@app"),
        start_document(appUrl=""),
        '{"appUrl": "http://app", "jobId": "' + JOB_ID + '"}',
        "x" * 100_000,
    ],
)
def test_a_start_document_that_does_not_fit_is_refused_without_echoing_it(raw: str) -> None:
    with pytest.raises(WorkerSetupError) as refused:
        parse_request(raw)

    assert refused.value.code is WorkerFailure.INPUT_INVALID
    assert CREDENTIAL not in str(refused.value)
    assert "pass" not in str(refused.value)


def test_a_credential_in_a_refused_document_is_not_repeated() -> None:
    with pytest.raises(WorkerSetupError) as refused:
        parse_request(start_document(jobId="nope"))

    assert CREDENTIAL not in str(refused.value) and CREDENTIAL not in repr(refused.value)


def test_the_request_does_not_show_the_credential_in_its_repr() -> None:
    assert CREDENTIAL not in repr(REQUEST)


# -- #323-T03 --------------------------------------------------------------------------------


# #323-T03
def test_the_credential_and_the_job_input_stay_out_of_the_argv_the_environment_and_the_logs(
    capsys: pytest.CaptureFixture[str],
) -> None:
    api = FakeWorkerApi()
    # A job process that leaks everything it has onto both streams and into its result.
    leak = f"token {TOKEN} key {API_KEY} credential {CREDENTIAL}"
    launcher = FinishingLauncher(
        result_line(ok=False, errorCode="command_failed", logTail=leak, commentUrl=None),
        stderr=leak.encode(),
    )
    handler = Capture()
    logger = logging.getLogger("worker-test-t03")
    logger.handlers = [handler]
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    code = run(api, launcher, logger)

    assert code is WorkerExit.FAILED
    (process,) = launcher.processes
    spec = process.spec
    everything_the_process_was_given = [*spec.argv, *spec.env.keys(), *spec.env.values()]
    for secret in (CREDENTIAL, TOKEN, API_KEY, "must-not-pass-0123456789"):
        assert not any(secret in item for item in everything_the_process_was_given)
    # The job goes in on stdin; the credential does not go in at all.
    assert CREDENTIAL.encode() not in spec.stdin
    assert json.loads(spec.stdin)["git"]["token"] == TOKEN
    # Neither the host's log, nor its stdout or stderr, nor the delivered result hold a secret.
    captured = capsys.readouterr()
    seen = "\n".join([*handler.lines, captured.out, captured.err, json.dumps(api.completions)])
    for secret in (CREDENTIAL, TOKEN, API_KEY):
        assert secret not in seen
    assert api.completions, "the failure was delivered"


# #323-T03
def test_a_refusal_at_startup_names_no_secret(capsys: pytest.CaptureFixture[str]) -> None:
    code = worker_cli.main(
        ["--once"], environment={"PATH": "/usr/bin"}, stdin=io.StringIO(start_document(jobId="x"))
    )

    captured = capsys.readouterr()
    assert code == WorkerExit.SETUP_ERROR
    assert CREDENTIAL not in captured.out + captured.err
    assert captured.out == ""  # stdout stays free; the log goes to stderr


# -- #323-T09 --------------------------------------------------------------------------------


# #323-T09
def test_an_app_without_the_worker_api_is_refused_before_anything_is_fetched_or_started() -> None:
    api = FakeWorkerApi()
    api.check_error = WorkerSetupError(WorkerFailure.APP_UNSUPPORTED, "the app has no Worker API")
    launcher = FinishingLauncher()
    handler = Capture()
    logger = logging.getLogger("worker-test-t09")
    logger.handlers = [handler]
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    code = run(api, launcher, logger)

    assert code is WorkerExit.SETUP_ERROR
    assert api.fetched == 0 and api.completions == []
    assert launcher.processes == []
    assert any(WorkerFailure.APP_UNSUPPORTED.value in line for line in handler.lines)


# -- the command line ------------------------------------------------------------------------


def test_the_worker_needs_the_once_flag() -> None:
    code = worker_cli.main([], environment={}, stdin=io.StringIO(start_document()))

    assert code == WorkerExit.SETUP_ERROR


def test_the_credential_is_not_accepted_as_an_argument_and_a_usage_error_does_not_echo_it(
    capsys: pytest.CaptureFixture[str],
) -> None:
    code = worker_cli.main(
        ["--once", "--credential", CREDENTIAL], environment={}, stdin=io.StringIO(start_document())
    )

    captured = capsys.readouterr()
    assert code == WorkerExit.SETUP_ERROR
    assert CREDENTIAL not in captured.out + captured.err


def test_unusable_configuration_is_a_setup_error_that_names_the_variable() -> None:
    with pytest.raises(SettingsError) as refused:
        worker_settings_from_environment({"RUNNER_JOB_TIMEOUT_SECONDS": "soon"})

    assert "RUNNER_JOB_TIMEOUT_SECONDS" in str(refused.value)


def test_the_worker_reads_the_same_runtime_settings_as_the_runner_but_no_token_or_url() -> None:
    worker = worker_settings_from_environment(
        {"RUNNER_JOB_TIMEOUT_SECONDS": "90", "PR_AGENT_COMMAND": "fake-job --flag"}
    )

    assert worker.job_timeout == 90.0
    assert worker.job_command == ("fake-job", "--flag")
    assert not hasattr(worker, "token") and not hasattr(worker, "api_url")


# #396-T05
def test_a_worker_whose_run_was_superseded_delivers_its_result_and_exits_0() -> None:
    from loop_support import outcome

    line = (
        json.dumps(
            {
                "ok": False,
                "durationMs": 1,
                "commentUrl": None,
                "errorCode": "superseded",
                "logTail": "superseded",
                "logTruncated": False,
                "usage": None,
            }
        )
        + "\n"
    ).encode()

    class Superseding(FinishingLauncher):
        async def start(self, spec: ProcessSpec) -> RunningProcess:
            process = await FakeLauncher.start(self, spec)
            assert isinstance(process, FakeProcess)
            process.finish(outcome(exit_code=1, stdout=line))
            return process

    api = FakeWorkerApi()

    assert run(api, Superseding()) is WorkerExit.OK
    assert [item["errorCode"] for item in api.completions] == ["superseded"]
