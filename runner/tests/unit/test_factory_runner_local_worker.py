# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Worker a customer's local dispatcher starts (#974): what it reads from its start document
and its environment, the engine it runs and the guard it gets. The job itself is the hosted
Worker's, and tested there (`test_worker.py`, `tests/integration/test_worker_once.py`); what a whole
turn does through this entry is `tests/integration/test_factory_runner_loopback.py`."""

import io
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner import local_worker
from code_reviewer_runner.factory_runner.base import DISK_BUDGET_VARIABLE
from code_reviewer_runner.job_loop.local_credential import (
    LOCAL_CREDENTIAL_NAMES,
    LocalCredential,
)
from code_reviewer_runner.job_loop.settings import WorkerSettings
from code_reviewer_runner.job_loop.worker import (
    WorkerRequest,
    parse_local_credential,
)
from code_reviewer_runner.job_loop.worker_errors import WorkerExit, WorkerSetupError

pytestmark = pytest.mark.unit

JOB = "00000000-0000-4000-8000-000000000001"
CREDENTIAL = "crj_" + "B" * 43
LOGIN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"


def document(**extra: Any) -> str:
    return json.dumps(
        {"appUrl": "https://app.test", "jobId": JOB, "credential": CREDENTIAL, **extra}
    )


# -- the credential of the device in the start document (one shape, #980) -------------------------


def credential_of(
    name: str = "CLAUDE_CODE_OAUTH_TOKEN", value: object = LOGIN
) -> dict[str, object]:
    return {"name": name, "value": value}


def test_a_start_document_without_a_local_credential_has_none() -> None:
    assert parse_local_credential(document()) is None


# #980-T01
def test_a_start_document_names_the_one_credential_of_the_device_the_job_reads() -> None:
    found = parse_local_credential(document(localCredential=credential_of()))

    assert found == LocalCredential("CLAUDE_CODE_OAUTH_TOKEN", LOGIN)
    assert found is not None and found.environment() == {"CLAUDE_CODE_OAUTH_TOKEN": LOGIN}
    assert LOGIN not in repr(found) and LOGIN not in str(found)


@pytest.mark.parametrize(
    "local",
    [
        ["CLAUDE_CODE_OAUTH_TOKEN"],
        {"CLAUDE_CODE_OAUTH_TOKEN": LOGIN},  # the old map form (`localEnvironment`) is gone
        credential_of("claude_code_oauth_token"),
        credential_of(value=1),
        credential_of(value="two words"),
        credential_of(value=""),
        credential_of(value="x" * 5000),
        {"name": "CLAUDE_CODE_OAUTH_TOKEN"},
        {**credential_of(), "extra": "field"},
        "CLAUDE_CODE_OAUTH_TOKEN",
    ],
    ids=["list", "map", "name", "number", "space", "empty", "long", "no value", "extra", "string"],
)
def test_a_local_credential_that_does_not_fit_is_an_input_error(local: object) -> None:
    with pytest.raises(WorkerSetupError) as error:
        parse_local_credential(document(localCredential=local))

    # The text names the field and never the value: the document holds secrets.
    assert "x" * 100 not in str(error.value) and LOGIN not in str(error.value)


def test_the_old_map_form_is_not_read_as_a_credential() -> None:
    assert (
        parse_local_credential(document(localEnvironment={"CLAUDE_CODE_OAUTH_TOKEN": LOGIN}))
        is None
    )


# #974 review, #978-T11, #980-T07
@pytest.mark.parametrize(
    "name",
    [
        "PATH",
        "HOME",
        "LD_PRELOAD",
        "PYTHONPATH",
        "RUNNER_JOB_TIMEOUT_SECONDS",
        "RUNNER_IMPLEMENTER_WORK_DIR",
        "FACTORY_RUNNER_HOME",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
    ],
)
def test_a_start_document_cannot_set_any_variable_but_a_name_of_the_allow_list(name: str) -> None:
    """One allow-list for the Worker of a process and for Control in a VM: a name outside it would
    override what the machine decided (PATH, RUNNER_*)."""
    assert name not in LOCAL_CREDENTIAL_NAMES
    with pytest.raises(WorkerSetupError) as error:
        parse_local_credential(document(localCredential=credential_of(name, "value")))

    assert "value" not in str(error.value)


def test_the_allow_list_is_the_claude_code_login_and_nothing_else() -> None:
    assert {"CLAUDE_CODE_OAUTH_TOKEN"} == LOCAL_CREDENTIAL_NAMES


def test_the_error_of_a_bad_local_credential_never_shows_its_value() -> None:
    with pytest.raises(WorkerSetupError) as error:
        parse_local_credential(document(localCredential=credential_of(value=LOGIN + " extra")))

    assert LOGIN not in str(error.value)


# -- the entry point -----------------------------------------------------------------------------


class Captured:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def run_worker(
        self,
        request: WorkerRequest,
        settings: WorkerSettings,
        environment: Mapping[str, str],
        **keywords: Any,
    ) -> WorkerExit:
        self.calls.append(
            {"request": request, "settings": settings, "environment": environment, **keywords}
        )
        return WorkerExit.OK


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> Captured:
    seen = Captured()
    monkeypatch.setattr(local_worker, "run_worker", seen.run_worker)
    monkeypatch.setattr(local_worker, "configure_logging", lambda: None)
    return seen


def start(
    environment: Mapping[str, str], stdin: str, captured: Captured
) -> tuple[int, dict[str, Any] | None]:
    code = local_worker.main(environment=environment, stdin=io.StringIO(stdin))
    return code, (captured.calls[0] if captured.calls else None)


def test_the_worker_runs_the_implementer_with_the_request_of_the_start_document(
    captured: Captured, tmp_path: Path
) -> None:
    environment = {"RUNNER_IMPLEMENTER_WORK_DIR": str(tmp_path), "PATH": "/usr/bin"}

    code, call = start(environment, document(), captured)

    assert code == int(WorkerExit.OK) and call is not None
    assert call["request"].job_id == JOB and call["request"].credential == CREDENTIAL
    assert call["request"].app_url == "https://app.test"
    # The self-test of the dispatcher is the proof: the Worker advertises the engine of the turns,
    # and nothing of the hosted container's start-up (engine user, rule set) is asked of it.
    assert call["settings"].engines == ("implementer",)
    assert call["settings"].implementer_work_dir == Path("/work")  # the job reads its own variable
    assert call["install_signals"] is True
    assert call["extra_secrets"] == ()
    assert call["guard"] is None  # no disk budget in the environment
    assert call["environment"] == environment


def test_the_local_credentials_go_to_the_job_environment_and_to_the_masker_and_nowhere_else(
    captured: Captured,
) -> None:
    local = {"CLAUDE_CODE_OAUTH_TOKEN": LOGIN}

    code, call = start({"PATH": "/usr/bin"}, document(localCredential=credential_of()), captured)

    assert code == 0 and call is not None
    assert call["environment"] == {"PATH": "/usr/bin", **local}
    assert call["extra_secrets"] == (LOGIN,)
    assert LOGIN not in repr(call["request"]) and LOGIN not in repr(call["settings"])


def test_a_disk_budget_in_the_environment_gives_the_job_host_a_guard(captured: Captured) -> None:
    _, call = start({DISK_BUDGET_VARIABLE: str(5 * 2**30)}, document(), captured)

    assert call is not None and call["guard"] is not None


@pytest.mark.parametrize("raw", ["", "0", "-1", "ten", "1.5"])
def test_a_budget_that_is_not_a_positive_number_is_no_budget(raw: str) -> None:
    assert local_worker.disk_guard({DISK_BUDGET_VARIABLE: raw}) is None


@pytest.mark.parametrize(
    "stdin",
    [
        "",
        "not json",
        "[]",
        json.dumps({"appUrl": "https://app.test"}),
        document().replace("crj_", "crc_"),
    ],
    ids=["empty", "not json", "list", "no job", "runner credential"],
)
def test_a_start_document_that_is_not_one_ends_with_the_setup_error_and_runs_nothing(
    captured: Captured, stdin: str, capsys: pytest.CaptureFixture[str]
) -> None:
    code, call = start({}, stdin, captured)

    assert code == int(WorkerExit.SETUP_ERROR) and call is None
    assert "crc_" not in capsys.readouterr().err


def test_settings_that_do_not_hold_end_with_the_setup_error_before_the_document_is_read(
    captured: Captured,
) -> None:
    stdin = io.StringIO(document())

    code = local_worker.main(environment={"RUNNER_JOB_TIMEOUT_SECONDS": "never"}, stdin=stdin)

    assert code == int(WorkerExit.SETUP_ERROR) and captured.calls == []
    assert stdin.tell() == 0  # the credential is not even read
