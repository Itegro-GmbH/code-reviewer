# SPDX-License-Identifier: LicenseRef-Proprietary

"""The `factory-runner` command (#854, R1b): register, config show, selftest and the refusals of
run, with the app and the machine replaced by doubles."""

import io
import json
import stat
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner.app_client import (
    Announcement,
    ApiUnavailable,
    Registered,
    RegistrationRefused,
)
from code_reviewer_runner.factory_runner.base import (
    BASE_VERSION,
    DEFAULT_URL,
    EXIT_CONFIG,
    EXIT_FAILED,
    EXIT_NOT_READY,
    EXIT_OK,
    EXIT_USAGE,
)
from code_reviewer_runner.factory_runner.cli import CliSeams, main
from code_reviewer_runner.factory_runner.config import RunnerConfig, load_config
from code_reviewer_runner.factory_runner.selftest import Check, SelfTestResult

pytestmark = pytest.mark.unit

TOKEN = "crt_" + "T" * 43
CREDENTIAL = "crc_" + "A" * 43


class FakeApp:
    def __init__(self) -> None:
        self.registered: list[tuple[str, str, Announcement]] = []
        self.urls: list[str] = []
        self.error: Exception | None = None

    def factory(self, url: str, credential: str | None) -> Any:
        self.urls.append(url)
        app = self

        class Client:
            def register(self, token: str, name: str, announcement: Announcement) -> Registered:
                if app.error is not None:
                    raise app.error
                app.registered.append((token, name, announcement))
                return Registered("runner-1", CREDENTIAL, "1.0.0")

        return Client()


def invoke(
    tmp_path: Path, *argv: str, app: FakeApp | None = None, **env: str
) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    seams = CliSeams(
        client=(app or FakeApp()).factory, now=lambda: 1234.0, hostname=lambda: "devbox"
    )
    code = main(
        list(argv),
        environment={"FACTORY_RUNNER_HOME": str(tmp_path / "home"), **env},
        seams=seams,
        out=out,
        err=err,
    )
    return code, out.getvalue(), err.getvalue()


def test_register_exchanges_the_token_and_writes_a_private_file(tmp_path: Path) -> None:
    app = FakeApp()

    code, out, err = invoke(
        tmp_path,
        "register", "--token", TOKEN, "--name", "build box", "--labels", "Linux, gpu",
        "--cpus", "4", "--memory-mb", "8192",
        app=app,
    )  # fmt: skip

    assert (code, err) == (EXIT_OK, "")
    token, name, announcement = app.registered[0]
    assert (token, name) == (TOKEN, "build box")
    assert list(announcement.labels) == ["linux", "gpu"]
    assert announcement.base_version == BASE_VERSION
    assert announcement.limits == {"cpus": 4, "memoryMb": 8192, "parallelRuns": 1}
    path = tmp_path / "home" / "config.json"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    saved = load_config({"FACTORY_RUNNER_HOME": str(tmp_path / "home")})
    assert (saved.credential, saved.runner_id, saved.credential_renewed_at) == (
        CREDENTIAL,
        "runner-1",
        1234.0,
    )
    assert CREDENTIAL not in out + err and TOKEN not in out + err


def test_register_goes_to_the_product_unless_told_otherwise(tmp_path: Path) -> None:
    app = FakeApp()
    invoke(tmp_path, "register", "--token", TOKEN, app=app)
    invoke(
        tmp_path,
        "register",
        "--token",
        TOKEN,
        "--force",
        "--url",
        "https://staging.example",
        app=app,
    )

    assert app.urls == [DEFAULT_URL, "https://staging.example"]


def test_register_names_the_machine_after_its_host_by_default(tmp_path: Path) -> None:
    app = FakeApp()
    invoke(tmp_path, "register", "--token", TOKEN, app=app)

    assert app.registered[0][1] == "devbox"


def test_register_does_not_replace_a_registration_without_force(tmp_path: Path) -> None:
    invoke(tmp_path, "register", "--token", TOKEN)

    code, _, err = invoke(tmp_path, "register", "--token", TOKEN)

    assert code == EXIT_CONFIG
    assert "--force" in err


def test_a_refused_token_is_a_failure_that_says_what_to_check_and_writes_nothing(
    tmp_path: Path,
) -> None:
    app = FakeApp()
    app.error = RegistrationRefused("refused", 401, "RUNNER_REGISTRATION_TOKEN_INVALID")

    code, _, err = invoke(tmp_path, "register", "--token", TOKEN, app=app)

    assert code == EXIT_FAILED
    assert "unknown, used or expired" in err
    assert not (tmp_path / "home").exists()


def test_an_app_that_cannot_be_reached_writes_nothing(tmp_path: Path) -> None:
    app = FakeApp()
    app.error = ApiUnavailable("down")

    code, _, _ = invoke(tmp_path, "register", "--token", TOKEN, app=app)

    assert code == EXIT_FAILED
    assert not (tmp_path / "home").exists()


def test_a_wrong_token_or_label_is_refused_before_anything_is_sent_and_never_echoed(
    tmp_path: Path,
) -> None:
    app = FakeApp()
    code, _, err = invoke(tmp_path, "register", "--token", "crt_short-secret-value", app=app)
    assert (code, app.registered) == (EXIT_CONFIG, [])
    assert "short-secret-value" not in err

    code, _, _ = invoke(tmp_path, "register", "--token", TOKEN, "--labels", "bad label", app=app)
    assert (code, app.registered) == (EXIT_CONFIG, [])


def test_config_show_has_no_secret(tmp_path: Path) -> None:
    invoke(tmp_path, "register", "--token", TOKEN, "--labels", "linux")

    code, out, _ = invoke(tmp_path, "config", "show")

    shown = json.loads(out)
    assert code == EXIT_OK
    assert shown["credential"] == "set"
    assert shown["labels"] == ["linux"]
    assert CREDENTIAL not in out


def test_config_show_also_shows_the_environment_of_a_vm(tmp_path: Path) -> None:
    code, out, _ = invoke(
        tmp_path,
        "config",
        "show",
        FACTORY_RUNNER_URL="https://app.example",
        FACTORY_RUNNER_CREDENTIAL=CREDENTIAL,
        FACTORY_RUNNER_LABELS="itegro-claude",
    )

    assert code == EXIT_OK
    assert json.loads(out)["labels"] == ["itegro-claude"]
    assert CREDENTIAL not in out


def test_run_on_a_machine_that_was_never_registered_says_how(tmp_path: Path) -> None:
    code, _, err = invoke(tmp_path, "run", "--once", FACTORY_RUNNER_URL="https://app.example")

    assert code == EXIT_CONFIG
    assert "factory-runner register" in err


def test_run_without_an_app_address_is_a_configuration_error(tmp_path: Path) -> None:
    code, _, err = invoke(tmp_path, "run", "--once")

    assert code == EXIT_CONFIG
    assert "url" in err


def test_a_usage_error_does_not_echo_what_was_typed(tmp_path: Path) -> None:
    code, _, err = invoke(tmp_path, "register", "--token", TOKEN, "--bogus", TOKEN)

    assert code == EXIT_USAGE
    assert TOKEN not in err


def _result(ok: bool) -> SelfTestResult:
    checks = (Check("docker", True), Check("canned-turn", ok, "" if ok else "no answer"))
    capability = (Check("agent-docker", True),) if ok else ()
    return SelfTestResult((*checks, *capability), "sysbox-runc", "1.19.0", 3.2)


@pytest.mark.parametrize(("ok", "code"), [(True, EXIT_OK), (False, EXIT_NOT_READY)])
def test_selftest_prints_every_check_and_its_exit_code_says_whether_the_base_holds(
    tmp_path: Path, ok: bool, code: int
) -> None:
    out, err = io.StringIO(), io.StringIO()
    seams = CliSeams(run_selftest=lambda _config, _env: _result(ok))

    got = main(
        ["selftest"],
        environment={"FACTORY_RUNNER_HOME": str(tmp_path / "home")},
        seams=seams,
        out=out,
        err=err,
    )

    assert got == code
    assert "ok   docker" in out.getvalue()
    assert (
        "base: ready; capabilities: agent-docker" if ok else "base: NOT ready"
    ) in out.getvalue()
    assert ("FAIL canned-turn: no answer" in out.getvalue()) is (not ok)


def test_selftest_as_json_is_machine_readable(tmp_path: Path) -> None:
    out = io.StringIO()
    seams = CliSeams(run_selftest=lambda _config, _env: _result(True))

    main(
        ["selftest", "--json"],
        environment={"FACTORY_RUNNER_HOME": str(tmp_path / "home")},
        seams=seams,
        out=out,
        err=io.StringIO(),
    )

    report = json.loads(out.getvalue())
    assert report["base"] is True
    assert report["capabilities"] == ["agent-docker"]
    assert [check["name"] for check in report["checks"]][:2] == ["docker", "canned-turn"]


def test_selftest_needs_no_registration(tmp_path: Path) -> None:
    seen: list[RunnerConfig] = []

    def selftest(config: RunnerConfig, _env: Any) -> SelfTestResult:
        seen.append(config)
        return _result(True)

    main(
        ["selftest"],
        environment={"FACTORY_RUNNER_HOME": str(tmp_path / "home")},
        seams=CliSeams(run_selftest=selftest),
        out=io.StringIO(),
        err=io.StringIO(),
    )

    assert seen[0].credential is None
