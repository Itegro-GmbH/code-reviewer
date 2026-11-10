# SPDX-License-Identifier: LicenseRef-Proprietary

"""The local dispatcher's side of Runner v2 (#974): the split claim it reads, the claim it gives
back, the state of a job it asks for, the Worker it starts and the one thing it must never hold, a
job's secrets."""

import asyncio
import io
import json
import logging
import sys
import urllib.request
from email.message import Message
from pathlib import Path
from typing import Any
from urllib.error import HTTPError

import pytest
from loop_support import FakeLauncher, outcome

from code_reviewer_runner.factory_runner.app_client import (
    Announced,
    Announcement,
    AppClient,
    ClaimedWorker,
    JobAccess,
    Revoked,
)
from code_reviewer_runner.factory_runner.config import RunnerConfig
from code_reviewer_runner.factory_runner.prepare import Prepared, implementer_settings
from code_reviewer_runner.factory_runner.sandbox import (
    WORKER_MODULE,
    ProcessSandbox,
    WorkerStart,
)
from code_reviewer_runner.factory_runner.selftest import Check, SelfTestResult
from code_reviewer_runner.factory_runner.service import RunnerService, Seams
from code_reviewer_runner.job_loop.http import ApiRejected, ApiUnavailable
from code_reviewer_runner.job_loop.settings import worker_settings_from_environment
from code_reviewer_runner.job_loop.worker import parse_request
from secret_walk import holds

pytestmark = pytest.mark.unit

JOB = "00000000-0000-4000-8000-000000000001"
RUNNER = "crc_" + "A" * 43
CREDENTIAL = "crj_" + "B" * 43
GIT_TOKEN = "ghs_" + "G" * 36
MODEL_KEY = "sk-or-" + "M" * 40
SECRETS = (GIT_TOKEN, MODEL_KEY)


class Answer:
    """What the opener returns: a response with a status, headers and a body."""

    def __init__(self, status: int, body: bytes = b"", headers: dict[str, str] | None = None):
        self.status = status
        self.headers = headers or {}
        self.body = body
        self._stream = io.BytesIO(body)

    def __enter__(self) -> "Answer":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)

    read1 = read


def as_json(status: int, document: object) -> Answer:
    return Answer(status, json.dumps(document).encode())


def error(status: int, code: str) -> Answer:
    return as_json(status, {"error": {"code": code, "message": "fake"}})


class Opener:
    """Answers the requests one after the other and keeps them."""

    def __init__(self, *answers: Answer | Exception) -> None:
        self.answers = list(answers)
        self.requests: list[urllib.request.Request] = []

    def open(self, request: urllib.request.Request, timeout: float | None = None) -> Answer:
        self.requests.append(request)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        if answer.status >= 400:
            headers = Message()
            for name, value in answer.headers.items():
                headers[name] = value
            raise HTTPError(request.full_url, answer.status, "x", headers, io.BytesIO(answer.body))
        return answer


def client(*answers: Answer | Exception) -> tuple[AppClient, Opener]:
    app = AppClient("https://app.test", credential=RUNNER)
    opener = Opener(*answers)
    app._opener = opener  # type: ignore[assignment]  # pyright: ignore[reportPrivateUsage]
    return app, opener


def split_answer(**job: Any) -> Answer:
    return as_json(
        200,
        {
            "version": 1,
            "job": {
                "id": JOB,
                "credential": CREDENTIAL,
                "reviewKind": "implementer",
                "leaseExpiresAt": "2026-11-10T12:02:00.000Z",
                "heartbeatIntervalSeconds": 30,
                **job,
            },
        },
    )


def sent(request: urllib.request.Request) -> Any:
    return json.loads(request.data) if request.data else None  # type: ignore[arg-type]


# -- the claim -----------------------------------------------------------------------------------


# #974-T01
def test_the_claim_asks_for_the_split_answer_and_reads_the_job_and_its_credential_only() -> None:
    app, opener = client(
        split_answer(
            labels=["gpu", "linux"],
            access={"harness": "claude-code", "auth": "subscription", "model": "sonnet"},
        )
    )

    claimed = app.claim()

    body = sent(opener.requests[0])
    assert body["engines"] == ["implementer"] and body["features"] == ["worker_credential"]
    assert opener.requests[0].full_url.endswith("/api/runners/v1/claim")
    assert claimed == ClaimedWorker(
        JOB, CREDENTIAL, ("gpu", "linux"), JobAccess("claude-code", "subscription", "sonnet")
    )
    # The credential is the Worker's and never printed.
    assert CREDENTIAL not in repr(claimed)


# #974-T01
def test_a_claim_answer_holds_nothing_secret_whatever_the_app_adds_to_it() -> None:
    answer = split_answer(
        extra={"git": {"token": GIT_TOKEN}, "llm": {"apiKey": MODEL_KEY}},
        access={"harness": "opencode", "auth": "app-key", "model": None},
    )
    app, _ = client(answer)

    claimed = app.claim()

    assert claimed is not None
    # What the dispatcher kept has no field for a secret: one in the answer has no place to go.
    assert holds(claimed, SECRETS) is None
    assert set(vars(claimed)) == {"job_id", "credential", "labels", "access"}


# #974-T01
def test_an_answer_that_carries_a_job_input_is_refused_and_never_read_further() -> None:
    legacy = as_json(
        200,
        {
            "version": 1,
            "job": {
                "id": JOB,
                "leaseToken": "lease",
                "leaseExpiresAt": "2026-11-10T12:02:00.000Z",
                "heartbeatIntervalSeconds": 30,
                "tokenExpiresAt": None,
                "input": {"git": {"token": GIT_TOKEN}, "llm": {"apiKey": MODEL_KEY}},
            },
        },
    )
    app, _ = client(legacy)

    with pytest.raises(ApiUnavailable) as refused:
        app.claim()

    assert GIT_TOKEN not in str(refused.value) and MODEL_KEY not in str(refused.value)
    assert holds(app, SECRETS) is None


@pytest.mark.parametrize(
    "job",
    [{"id": "not-a-uuid"}, {"credential": "crc_" + "A" * 43}, {"credential": "crj_short"}],
    ids=["id", "runner credential", "short credential"],
)
def test_a_claim_answer_that_is_not_the_contract_is_unavailable(job: dict[str, Any]) -> None:
    app, _ = client(split_answer(**job))

    with pytest.raises(ApiUnavailable):
        app.claim()


def test_a_claim_with_nothing_to_do_is_none() -> None:
    app, _ = client(Answer(204))

    assert app.claim() is None


# -- release and state ---------------------------------------------------------------------------


def test_a_release_names_the_job_and_sends_the_credential_of_the_claim_in_the_body() -> None:
    app, opener = client(as_json(200, {"version": 1, "job": {"id": JOB, "status": "queued"}}))

    assert app.release(JOB, CREDENTIAL, "launch_failed") == "released"

    request = opener.requests[0]
    assert request.full_url == f"https://app.test/api/runners/v1/jobs/{JOB}/release"
    assert request.get_method() == "POST"
    assert sent(request) == {"credential": CREDENTIAL, "reason": "launch_failed"}
    assert request.get_header("Authorization") == f"Bearer {RUNNER}"


@pytest.mark.parametrize(
    ("answer", "result"),
    [
        (error(409, "RUNNER_JOB_ENDED"), "ended"),
        (error(401, "WORKER_CREDENTIAL_INVALID"), "not_holder"),
        (error(404, "RUNNER_JOB_NOT_FOUND"), "not_holder"),
    ],
)
def test_a_release_the_app_does_not_take_is_said_by_what_it_means(
    answer: Answer, result: str
) -> None:
    app, _ = client(answer)

    assert app.release(JOB, CREDENTIAL, "worker_exited") == result


def test_a_release_by_a_revoked_runner_is_revoked() -> None:
    app, _ = client(error(401, "RUNNER_UNAUTHORIZED"))

    with pytest.raises(Revoked):
        app.release(JOB, CREDENTIAL, "worker_exited")


def test_a_release_refuses_a_job_id_that_is_not_a_uuid_before_anything_is_sent() -> None:
    app, opener = client()

    with pytest.raises(ApiRejected):
        app.release("../x", CREDENTIAL, "worker_exited")

    assert opener.requests == []


# #974-T03
def test_the_state_of_a_job_is_asked_with_the_runner_credential_and_is_its_status() -> None:
    app, opener = client(as_json(200, {"version": 1, "job": {"id": JOB, "status": "running"}}))

    assert app.job_state(JOB) == "running"

    request = opener.requests[0]
    assert request.full_url == f"https://app.test/api/runners/v1/jobs/{JOB}"
    assert request.get_method() == "GET" and request.data is None
    assert request.get_header("Authorization") == f"Bearer {RUNNER}"


# #974-T03
def test_the_state_of_a_job_of_another_workspace_is_none() -> None:
    app, _ = client(error(404, "RUNNER_JOB_NOT_FOUND"))

    assert app.job_state(JOB) is None


def test_a_state_answer_for_another_job_is_not_the_contract() -> None:
    other = "00000000-0000-4000-8000-000000000002"
    app, _ = client(as_json(200, {"version": 1, "job": {"id": other, "status": "running"}}))

    with pytest.raises(ApiUnavailable):
        app.job_state(JOB)


# -- the start hand-over and the sandbox ---------------------------------------------------------


def test_the_start_document_is_the_one_a_worker_reads_and_shows_no_secret_in_its_repr() -> None:
    start = WorkerStart("https://app.test", JOB, CREDENTIAL, {"CLAUDE_CODE_OAUTH_TOKEN": "tok"})

    document = json.loads(start.document())

    assert document == {
        "appUrl": "https://app.test",
        "jobId": JOB,
        "credential": CREDENTIAL,
        "localEnvironment": {"CLAUDE_CODE_OAUTH_TOKEN": "tok"},
    }
    # The hosted Worker's reader takes it (the local variables are for the local Worker).
    request = parse_request(start.document().decode())
    assert request.job_id == JOB and request.credential == CREDENTIAL
    assert CREDENTIAL not in repr(start) and "tok" not in repr(start)


def test_the_process_sandbox_starts_the_worker_module_with_its_own_environment() -> None:
    launcher = FakeLauncher()
    sandbox = ProcessSandbox(launcher, {"PATH": "/usr/bin", "HOME": "/h"}, grace_seconds=135.0)

    async def scenario() -> None:
        worker = await sandbox.start(WorkerStart("https://app.test", JOB, CREDENTIAL))
        launcher.processes[0].finish()
        outcome = await worker.wait()
        assert outcome.exit_code == 0

    asyncio.run(scenario())

    spec = launcher.processes[0].spec
    assert spec.argv == (sys.executable, "-m", WORKER_MODULE)
    assert spec.env == {"PATH": "/usr/bin", "HOME": "/h"}
    assert spec.terminate_grace == 135.0
    assert CREDENTIAL.encode() in spec.stdin
    assert CREDENTIAL not in "".join(spec.env.values()) + " ".join(spec.argv)


# -- the one thing the dispatcher must never hold ------------------------------------------------


def prepared() -> Prepared:
    return Prepared(
        implementer_settings(worker_settings_from_environment({})),
        {"PATH": "/usr/bin"},
        Announcement(("linux",), "1.0.0", {}, {}),
        SelfTestResult((Check("docker", True), Check("agent-container", True)), "runc", "1.19.0"),
    )


class Daemon:
    """A daemon with nothing of ours on it."""

    def request(self, *args: object, **kwargs: object) -> list[object]:
        return []

    def create_container(self, *args: object, **kwargs: object) -> str:
        return "d" * 64

    def inspect_container(self, *args: object, **kwargs: object) -> dict[str, object]:
        from code_reviewer_runner.implementer.docker_api import DockerError

        raise DockerError(404, "no such container")

    def remove_container(self, *args: object, **kwargs: object) -> None:
        return None

    remove_network = remove_container
    remove_image = remove_container


# #974-T01
@pytest.mark.parametrize("answer", ["split", "legacy"])
def test_the_dispatchers_state_and_log_never_hold_a_git_token_or_a_model_key(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, answer: str
) -> None:
    """Whatever the app answers to the claim, and whatever the dispatcher does next, no git token
    and no model key is in what the dispatcher keeps (its fields and what they reach) or logs."""
    claim_answer = (
        split_answer(extra={"git": {"token": GIT_TOKEN}, "llm": {"apiKey": MODEL_KEY}})
        if answer == "split"
        else as_json(
            200,
            {
                "version": 1,
                "job": {
                    "id": JOB,
                    "leaseToken": "lease",
                    "leaseExpiresAt": "2026-11-10T12:02:00.000Z",
                    "heartbeatIntervalSeconds": 30,
                    "tokenExpiresAt": None,
                    "input": {"git": {"token": GIT_TOKEN}, "llm": {"apiKey": MODEL_KEY}},
                },
            },
        )
    )
    app, _ = client(
        as_json(
            200, {"version": 1, "runnerId": "r1", "minBaseVersion": None, "updateNeeded": False}
        ),
        claim_answer,
        # The release the dispatcher makes when the Worker ends badly, and nothing after it.
        as_json(200, {"version": 1, "job": {"id": JOB, "status": "queued"}}),
    )
    launcher = FakeLauncher()
    config = RunnerConfig(url="https://app.example", credential=RUNNER, labels=("linux",))
    environment = {"FACTORY_RUNNER_HOME": str(tmp_path / "home")}
    work = tmp_path / "work"
    work.mkdir()
    handed = prepared()
    service = RunnerService(
        config,
        environment,
        Prepared(
            handed.settings,
            {**handed.environment, "RUNNER_IMPLEMENTER_WORK_DIR": str(work)},
            handed.announcement,
            handed.selftest,
        ),
        app,
        seams=Seams(launcher=lambda _grace: launcher, docker=Daemon, wall=lambda: 1.8e9),  # type: ignore[arg-type,return-value]
    )

    async def scenario() -> int:
        task = asyncio.create_task(service.run(once=True, wait_seconds=0.0))
        for _ in range(300):
            if launcher.processes:
                launcher.processes[0].finish(outcome(exit_code=1, stdout=b""))
                break
            await asyncio.sleep(0.01)
        return await asyncio.wait_for(task, 10)

    with caplog.at_level(logging.DEBUG):
        asyncio.run(scenario())

    assert holds(service, SECRETS) is None
    assert holds(app, SECRETS) is None
    assert not any(secret in caplog.text for secret in SECRETS)
    if answer == "split":
        # The Worker was started for the job, with the credential of the claim and nothing else.
        assert json.loads(launcher.processes[0].spec.stdin)["credential"] == CREDENTIAL
        assert not any(secret.encode() in launcher.processes[0].spec.stdin for secret in SECRETS)
    else:
        assert launcher.processes == []  # the answer was not the contract: no Worker, no job


# #974-T01
def test_the_walk_finds_a_secret_where_it_is_and_only_there() -> None:
    nested = {"a": [("x", {"deep": bytearray(b"..." + GIT_TOKEN.encode())})]}

    assert holds(nested, (GIT_TOKEN,)) == "root['a'][0][1]['deep']"
    assert holds(nested, (MODEL_KEY,)) is None
    announced = Announced(None, False)
    assert holds(announced, SECRETS) is None
