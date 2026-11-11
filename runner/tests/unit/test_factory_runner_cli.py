# SPDX-License-Identifier: LicenseRef-Proprietary

"""The `factory-runner` command (#854, R1b): register, config show, selftest and the refusals of
run, with the app and the machine replaced by doubles."""

import io
import json
import stat
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from code_reviewer_runner.factory_runner import cli as cli_module
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
    EXIT_CREDENTIAL_UNSAVED,
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
    tmp_path: Path, *argv: str, app: FakeApp | None = None, stdin: str = "", **env: str
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
        stdin=io.StringIO(stdin),
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


# #854-N1
def test_register_takes_the_token_from_a_file_from_stdin_or_the_environment(
    tmp_path: Path,
) -> None:
    token_file = tmp_path / "token"
    token_file.write_text(TOKEN + "\n")
    app = FakeApp()

    from_file = invoke(tmp_path, "register", "--token-file", str(token_file), app=app)
    from_stdin = invoke(
        tmp_path, "register", "--token-file", "-", "--force", stdin=TOKEN + "\n", app=app
    )
    from_env = invoke(tmp_path, "register", "--force", app=app, FACTORY_RUNNER_TOKEN=f" {TOKEN} ")

    assert [code for code, _, _ in (from_file, from_stdin, from_env)] == [EXIT_OK] * 3
    assert [token for token, _, _ in app.registered] == [TOKEN] * 3
    assert all(TOKEN not in out + err for _, out, err in (from_file, from_stdin, from_env))


# #854-N1
def test_register_without_any_token_says_where_it_can_come_from(tmp_path: Path) -> None:
    code, _, err = invoke(tmp_path, "register")

    assert code == EXIT_USAGE
    assert "--token-file" in err and "FACTORY_RUNNER_TOKEN" in err
    assert not (tmp_path / "home" / "config.json").exists()


# #854-N1
def test_a_token_file_that_cannot_be_read_or_holds_no_token_is_refused_without_echo(
    tmp_path: Path,
) -> None:
    junk = tmp_path / "junk"
    junk.write_text("hunter2-not-a-token")

    missing = invoke(tmp_path, "register", "--token-file", str(tmp_path / "nope"))
    wrong = invoke(tmp_path, "register", "--token-file", str(junk))

    assert missing[0] == wrong[0] == EXIT_CONFIG
    assert "token file cannot be read" in missing[2]
    assert "hunter2" not in wrong[1] + wrong[2]


# #854-N1
def test_the_token_on_the_command_line_and_in_a_file_together_are_a_usage_error(
    tmp_path: Path,
) -> None:
    code, _, err = invoke(tmp_path, "register", "--token", TOKEN, "--token-file", "-")

    assert code == EXIT_USAGE and TOKEN not in err


# #854-N2
def test_a_credential_that_cannot_be_saved_is_said_plainly_without_a_traceback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> Path:
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(cli_module, "save_config", refuse)

    code, out, err = invoke(tmp_path, "register", "--token", TOKEN)

    assert code == EXIT_CREDENTIAL_UNSAVED
    assert "runner registered, but its credential could not be saved" in err
    assert "revoke it in the app" in err and "register again" in err
    assert "runner-1" in err and "Traceback" not in err
    assert CREDENTIAL not in out + err


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


# #854-F7
def test_selftest_only_looks_it_pulls_and_names_no_image(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[dict[str, Any]] = []

    def prepare(config: RunnerConfig, env: Any, **kwargs: Any) -> Any:
        seen.append(kwargs)
        return SimpleNamespace(selftest=_result(True))

    monkeypatch.setattr(cli_module, "prepare", prepare)

    got = main(
        ["selftest"],
        environment={"FACTORY_RUNNER_HOME": str(tmp_path / "home")},
        out=io.StringIO(),
        err=io.StringIO(),
    )

    assert got == EXIT_OK
    assert seen == [{"pull": None}]


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


# #854-S3
@pytest.mark.parametrize("command", ["run", "config", "selftest"])
def test_a_file_with_a_credential_and_no_runner_id_is_exit_six_that_names_the_way_out(
    tmp_path: Path, command: str
) -> None:
    invoke(tmp_path, "register", "--token", TOKEN)
    path = tmp_path / "home" / "config.json"
    stored = json.loads(path.read_text())
    del stored["runnerId"]
    path.write_text(json.dumps(stored))

    code, _, err = invoke(tmp_path, command, *(["show"] if command == "config" else []))

    assert code == EXIT_CONFIG
    assert "register --force" in err and "runnerId" in err


# #856-S07
def _selftest_with_claude(
    tmp_path: Path, *argv: str, checks: tuple[Check, ...], base_ok: bool = True
) -> tuple[int, str, list[bool]]:
    asked: list[bool] = []

    def claude(
        _config: RunnerConfig, _env: Any, _result: SelfTestResult, with_turn: bool
    ) -> tuple[Check, ...]:
        asked.append(with_turn)
        return checks

    out = io.StringIO()
    got = main(
        ["selftest", *argv],
        environment={"FACTORY_RUNNER_HOME": str(tmp_path / "home")},
        seams=CliSeams(run_selftest=lambda _c, _e: _result(base_ok), claude_code=claude),
        out=out,
        err=io.StringIO(),
    )
    return got, out.getvalue(), asked


READY_CLAUDE = (
    Check("claude-code-login", True, "a usable login (not shown)"),
    Check("claude-code-layer", True, "image"),
    Check("claude-code-version", True, "2.1.311; no model was called"),
)


# #856-S07
def test_selftest_by_default_looks_at_claude_code_without_a_model_call(tmp_path: Path) -> None:
    got, out, asked = _selftest_with_claude(tmp_path, checks=READY_CLAUDE)

    assert (got, asked) == (EXIT_OK, [False])
    assert "ok   claude-code-version: 2.1.311; no model was called" in out
    assert "--with-claude-code" in out and "subscription" in out


# #856-S07
def test_a_claude_code_check_that_fails_is_said_but_does_not_change_the_exit_code_by_default(
    tmp_path: Path,
) -> None:
    failing = (*READY_CLAUDE[:1], Check("claude-code-layer", False, "not built"))

    got, out, _ = _selftest_with_claude(tmp_path, checks=failing)

    assert got == EXIT_OK
    assert "FAIL claude-code-layer: not built" in out and "base: ready" in out


# #856-S07
def test_a_device_without_a_login_prints_no_claude_code_line_by_default(tmp_path: Path) -> None:
    got, out, asked = _selftest_with_claude(tmp_path, checks=())

    assert (got, asked) == (EXIT_OK, [False])
    assert "claude-code" not in out and "--with-claude-code" not in out


# #856-S07
@pytest.mark.parametrize(("turn_ok", "code"), [(True, EXIT_OK), (False, EXIT_NOT_READY)])
def test_with_claude_code_asks_for_the_tiny_turn_and_its_failure_is_the_exit_code(
    tmp_path: Path, turn_ok: bool, code: int
) -> None:
    turn = Check("claude-code-turn", turn_ok, "answered; \u2248 $0.0150" if turn_ok else "llm_auth")

    got, out, asked = _selftest_with_claude(
        tmp_path, "--with-claude-code", checks=(*READY_CLAUDE, turn)
    )

    assert (got, asked) == (code, [True])
    assert ("ok   claude-code-turn" if turn_ok else "FAIL claude-code-turn: llm_auth") in out


# #856-S07
def test_with_claude_code_on_a_machine_whose_base_fails_does_not_start_a_turn(
    tmp_path: Path,
) -> None:
    got, _, asked = _selftest_with_claude(
        tmp_path, "--with-claude-code", checks=READY_CLAUDE, base_ok=False
    )

    assert got == EXIT_NOT_READY and asked == []


# #856-S07
def test_selftest_as_json_carries_the_claude_code_checks_and_whether_the_turn_was_asked(
    tmp_path: Path,
) -> None:
    got, out, _ = _selftest_with_claude(
        tmp_path, "--json", "--with-claude-code", checks=READY_CLAUDE
    )

    report = json.loads(out)
    assert got == EXIT_OK
    assert report["claudeCode"] == {"ready": True, "turnAsked": True}
    assert [c["name"] for c in report["checks"]][-3:] == [c.name for c in READY_CLAUDE]


# #982: the Worker-as-a-process mode on the host's Docker is gone from the program.
def test_the_program_runs_only_with_the_firecracker_sandbox(tmp_path: Path) -> None:
    err = io.StringIO()
    code = main(
        ["run", "--once"],
        environment={
            "FACTORY_RUNNER_HOME": str(tmp_path / "home"),
            "FACTORY_RUNNER_URL": "https://app.example",
            "FACTORY_RUNNER_CREDENTIAL": CREDENTIAL,
        },
        err=err,
        require_sandbox=True,
    )

    assert code == EXIT_CONFIG
    assert "the only sandbox is firecracker" in err.getvalue()
    assert CREDENTIAL not in err.getvalue()


def test_the_entry_point_of_the_program_asks_for_the_sandbox(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from code_reviewer_runner.factory_runner import cli

    asked: list[bool] = []

    def fake_main(*_args: Any, require_sandbox: bool = False, **_kwargs: Any) -> int:
        asked.append(require_sandbox)
        return 0

    monkeypatch.setattr(cli, "main", fake_main)

    with pytest.raises(SystemExit) as stopped:
        cli.entry_point()

    assert stopped.value.code == 0 and asked == [True]
