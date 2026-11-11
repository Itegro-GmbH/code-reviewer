# SPDX-License-Identifier: LicenseRef-Proprietary

"""`factory-runner config set` and `credential` (#855, R2): the settings of a runner live in its
file and are changed on the device, and the credential is renewed there and never shown. (The
update is the root script's since #982: `test_install_script.py`.)"""

import io
import json
import stat
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner.app_client import ApiError, Revoked
from code_reviewer_runner.factory_runner.base import (
    EXIT_CONFIG,
    EXIT_FAILED,
    EXIT_OK,
    EXIT_REVOKED,
    EXIT_USAGE,
)
from code_reviewer_runner.factory_runner.cli import CliSeams, main
from code_reviewer_runner.factory_runner.config import (
    Limits,
    RunnerConfig,
    load_config,
    save_config,
)

pytestmark = pytest.mark.unit

CREDENTIAL = "crc_" + "A" * 43
RENEWED = "crc_" + "B" * 43


class Client:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.renewals = 0

    def renew(self) -> str:
        self.renewals += 1
        if self.error is not None:
            raise self.error
        return RENEWED


def invoke(
    tmp_path: Path,
    *argv: str,
    client: Client | None = None,
    **env: str,
) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    seams = CliSeams(
        client=lambda _url, _credential: client or Client(),  # type: ignore[arg-type,return-value]
        now=lambda: 10 * 86400.0,
        hostname=lambda: "box",
    )
    code = main(
        list(argv),
        environment={"FACTORY_RUNNER_HOME": str(tmp_path / "home"), **env},
        seams=seams,
        out=out,
        err=err,
        stdin=io.StringIO(),
    )
    return code, out.getvalue(), err.getvalue()


def register(tmp_path: Path, **changes: Any) -> dict[str, str]:
    environment = {"FACTORY_RUNNER_HOME": str(tmp_path / "home")}
    save_config(
        RunnerConfig(
            url="https://app.example",
            name="box",
            labels=("linux",),
            credential=CREDENTIAL,
            runner_id="r1",
            credential_renewed_at=3 * 86400.0,
            limits=Limits(cpus=2),
            **changes,
        ),
        environment,
    )
    return environment


# -- config set --------------------------------------------------------------------------------


def test_config_set_changes_labels_limits_and_parallelism_and_keeps_the_rest(
    tmp_path: Path,
) -> None:
    environment = register(tmp_path)

    code, out, _ = invoke(
        tmp_path,
        "config", "set",
        "--labels", "Linux,GPU",
        "--memory-mb", "8192",
        "--disk-gb", "40",
        "--parallel", "1",
    )  # fmt: skip

    assert code == EXIT_OK
    config = load_config(environment)
    assert config.labels == ("linux", "gpu")
    assert config.limits == Limits(cpus=2, memory_mb=8192, disk_gb=40, parallel_runs=1)
    assert (config.credential, config.runner_id, config.name) == (CREDENTIAL, "r1", "box")
    assert "restart" in out
    path = tmp_path / "home" / "config.json"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_a_limit_is_removed_with_none_and_a_wrong_value_changes_nothing(tmp_path: Path) -> None:
    environment = register(tmp_path)
    path = tmp_path / "home" / "config.json"
    before = path.read_text()

    code, _, err = invoke(tmp_path, "config", "set", "--cpus", "none")
    assert code == EXIT_OK
    assert load_config(environment).limits.cpus is None

    path.write_text(before)
    code, _, err = invoke(tmp_path, "config", "set", "--labels", "ok", "--memory-mb", "lots")
    assert code == EXIT_CONFIG
    assert "memoryMb" in err
    assert path.read_text() == before  # the label was not saved either


def test_more_than_one_job_at_a_time_is_refused_with_the_reason(tmp_path: Path) -> None:
    register(tmp_path)

    code, _, err = invoke(tmp_path, "config", "set", "--parallel", "3")

    assert code == EXIT_CONFIG
    assert "one job at a time" in err


def test_auto_update_is_a_switch_and_config_show_has_it(tmp_path: Path) -> None:
    register(tmp_path)

    assert invoke(tmp_path, "config", "set", "--auto-update", "off")[0] == EXIT_OK
    _, out, _ = invoke(tmp_path, "config", "show")

    assert json.loads(out)["autoUpdate"] is False
    assert invoke(tmp_path, "config", "set", "--auto-update", "maybe")[0] == EXIT_CONFIG


def test_config_set_without_a_setting_is_a_usage_error_and_needs_a_registration(
    tmp_path: Path,
) -> None:
    code, _, err = invoke(tmp_path, "config", "set", "--cpus", "2")
    assert code == EXIT_CONFIG
    assert "register" in err

    register(tmp_path)
    assert invoke(tmp_path, "config", "set")[0] == EXIT_USAGE


def test_config_set_says_when_the_environment_wins_over_the_file(tmp_path: Path) -> None:
    register(tmp_path)

    _, _, err = invoke(tmp_path, "config", "set", "--labels", "a", FACTORY_RUNNER_LABELS="b")

    assert "FACTORY_RUNNER_LABELS" in err


# -- credential --------------------------------------------------------------------------------


def test_credential_show_says_set_and_its_age_but_never_the_value(tmp_path: Path) -> None:
    register(tmp_path)

    code, out, err = invoke(tmp_path, "credential", "show")

    assert code == EXIT_OK
    assert "set (from the file)" in out
    assert "7 days ago" in out
    assert CREDENTIAL not in out + err


def test_credential_show_without_one_says_not_set(tmp_path: Path) -> None:
    assert invoke(tmp_path, "credential", "show")[1] == "credential: not set\n"


def test_credential_renew_saves_the_new_one_before_anything_uses_it(tmp_path: Path) -> None:
    environment = register(tmp_path)
    client = Client()

    code, out, err = invoke(tmp_path, "credential", "renew", client=client)

    assert code == EXIT_OK
    config = load_config(environment)
    assert config.credential == RENEWED
    assert config.credential_renewed_at == 10 * 86400.0
    assert client.renewals == 1
    assert RENEWED not in out + err


@pytest.mark.parametrize(
    ("error", "code"),
    [(Revoked("no", 401), EXIT_REVOKED), (ApiError("down"), EXIT_FAILED)],
)
def test_a_renewal_that_fails_leaves_the_credential_alone(
    tmp_path: Path, error: Exception, code: int
) -> None:
    environment = register(tmp_path)

    assert invoke(tmp_path, "credential", "renew", client=Client(error=error))[0] == code
    assert load_config(environment).credential == CREDENTIAL


def test_a_credential_from_the_environment_is_not_renewed_here(tmp_path: Path) -> None:
    register(tmp_path)
    client = Client()

    code, _, _ = invoke(
        tmp_path, "credential", "renew", client=client, FACTORY_RUNNER_CREDENTIAL=RENEWED
    )

    assert code == EXIT_CONFIG
    assert client.renewals == 0


def test_update_is_not_a_command_of_the_program_but_of_the_root_script(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # #982: `factory-runner update` is handled by the command the installer writes; the program
    # itself has no image to pull and no channel, and says it is a usage error.
    code, _, _ = invoke(tmp_path, "update")

    assert code == EXIT_USAGE and "invalid arguments" in capsys.readouterr().err
