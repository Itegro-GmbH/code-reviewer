# SPDX-License-Identifier: LicenseRef-Proprietary

"""`factory-runner credential add claude|list|remove|retry` (#980): the Claude Code tokens of a
device are added from the standard input, listed without their value and removed there. Nothing of
them is ever an argument, a line of output or a request to the app."""

import io
import os
import re
import stat
from pathlib import Path

import pytest

from code_reviewer_runner.factory_runner.base import EXIT_FAILED, EXIT_OK, EXIT_USAGE
from code_reviewer_runner.factory_runner.cli import CliSeams, main
from code_reviewer_runner.implementer.claude_code.credentials import (
    CredentialStore,
    PlainSealer,
)

pytestmark = pytest.mark.unit

TOKEN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"
OTHER = "sk-" + "ant-" + "oat01-another-made-up-token-1111111111111111"
NOW = 20 * 86400.0


def invoke(tmp_path: Path, *argv: str, stdin: str = "", **env: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    code = main(
        list(argv),
        environment={
            "FACTORY_RUNNER_HOME": str(tmp_path / "home"),
            "FACTORY_RUNNER_CREDENTIAL_STORAGE": "plain",
            **env,
        },
        seams=CliSeams(now=lambda: NOW),
        out=out,
        err=err,
        stdin=io.StringIO(stdin),
    )
    return code, out.getvalue(), err.getvalue()


def store(tmp_path: Path) -> CredentialStore:
    return CredentialStore(
        tmp_path / "home", choice="plain", systemd=PlainSealer(), clock=lambda: NOW
    )


# #980-T01
def test_a_pasted_token_is_added_from_standard_input_and_never_shown(tmp_path: Path) -> None:
    code, out, err = invoke(
        tmp_path, "credential", "add", "claude", "--name", "work", stdin=TOKEN + "\n"
    )

    assert code == EXIT_OK and err == ""
    assert TOKEN not in out and "work" in out and "sonnet, opus, haiku" in out
    assert store(tmp_path).secret("work") == TOKEN
    secret = tmp_path / "home" / "credentials" / "work.secret"
    assert stat.S_IMODE(secret.stat().st_mode) == 0o600 and secret.stat().st_uid == os.geteuid()


def test_the_token_has_no_option_and_so_no_place_in_the_arguments(tmp_path: Path) -> None:
    code, out, err = invoke(
        tmp_path, "credential", "add", "claude", "--name", "w", "--token", TOKEN
    )

    assert code == EXIT_USAGE and TOKEN not in out + err
    assert not (tmp_path / "home" / "credentials").exists()


def test_the_models_are_given_at_add_time(tmp_path: Path) -> None:
    code, out, _ = invoke(
        tmp_path,
        "credential",
        "add",
        "claude",
        "--name",
        "work",
        "--models",
        "opus, claude-sonnet-5-5",
        stdin=TOKEN,
    )

    assert code == EXIT_OK and "opus, claude-sonnet-5-5" in out
    assert store(tmp_path).records()[0].models == ("opus", "claude-sonnet-5-5")


@pytest.mark.parametrize(
    "stdin", ["", "two words", "a\nb", "x" * 5000], ids=["empty", "space", "lines", "long"]
)
def test_input_that_is_not_one_token_is_refused_without_echoing_it(
    tmp_path: Path, stdin: str
) -> None:
    code, out, err = invoke(tmp_path, "credential", "add", "claude", "--name", "w", stdin=stdin)

    assert code == EXIT_FAILED
    assert "x" * 100 not in out + err and "two words" not in out + err


def test_a_name_that_exists_needs_replace(tmp_path: Path) -> None:
    invoke(tmp_path, "credential", "add", "claude", "--name", "work", stdin=TOKEN)

    code, _, err = invoke(tmp_path, "credential", "add", "claude", "--name", "work", stdin=OTHER)
    assert code == EXIT_FAILED and "--replace" in err and OTHER not in err
    assert store(tmp_path).secret("work") == TOKEN

    code, out, _ = invoke(
        tmp_path, "credential", "add", "claude", "--name", "work", "--replace", stdin=OTHER
    )
    assert code == EXIT_OK and "replaced" in out
    assert store(tmp_path).secret("work") == OTHER


# #980-T01
def test_the_listing_has_name_created_models_and_state_and_never_the_value(
    tmp_path: Path,
) -> None:
    invoke(tmp_path, "credential", "add", "claude", "--name", "work", stdin=TOKEN)
    invoke(
        tmp_path, "credential", "add", "claude", "--name", "spare", "--models", "haiku", stdin=OTHER
    )
    store(tmp_path).set_limited("spare", NOW + 3600)

    code, out, err = invoke(tmp_path, "credential", "list")

    assert code == EXIT_OK and err == ""
    assert TOKEN not in out and OTHER not in out
    lines = out.strip().splitlines()
    assert lines[0].split() == ["NAME", "CREATED", "MODELS", "STATE", "STORAGE"]
    assert "work" in lines[1] and "sonnet,opus,haiku" in lines[1] and "usable" in lines[1]
    assert "spare" in lines[2] and "haiku" in lines[2] and "rate limited" in lines[2]
    assert "plain" in lines[1]
    # Created is a date, never a time stamp of seconds.
    assert re.search(r"\b\d{4}-\d{2}-\d{2}\b", lines[1])


def test_the_listing_says_when_there_is_none(tmp_path: Path) -> None:
    code, out, _ = invoke(tmp_path, "credential", "list")

    assert code == EXIT_OK and "no Claude Code credential" in out and "credential add claude" in out


def test_a_credential_is_removed(tmp_path: Path) -> None:
    invoke(tmp_path, "credential", "add", "claude", "--name", "work", stdin=TOKEN)

    code, out, _ = invoke(tmp_path, "credential", "remove", "work")

    assert code == EXIT_OK and "removed" in out
    assert store(tmp_path).records() == []
    assert invoke(tmp_path, "credential", "remove", "work")[0] == EXIT_FAILED


def test_retry_ends_the_pause_of_a_rate_limited_credential(tmp_path: Path) -> None:
    invoke(tmp_path, "credential", "add", "claude", "--name", "work", stdin=TOKEN)
    store(tmp_path).set_limited("work", NOW + 3600)

    code, out, _ = invoke(tmp_path, "credential", "retry", "work")

    assert code == EXIT_OK and "usable" in out
    assert store(tmp_path).records()[0].limited_until == 0.0


def test_a_refused_credential_is_listed_as_refused_and_says_how_to_replace_it(
    tmp_path: Path,
) -> None:
    invoke(tmp_path, "credential", "add", "claude", "--name", "work", stdin=TOKEN)
    store(tmp_path).mark_refused("work")

    _, out, _ = invoke(tmp_path, "credential", "list")

    assert "refused" in out and "--replace" in out


def test_storage_systemd_creds_that_cannot_be_had_is_said_and_stores_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))  # no systemd-creds to find

    code, _, err = invoke(
        tmp_path,
        "credential",
        "add",
        "claude",
        "--name",
        "work",
        stdin=TOKEN,
        FACTORY_RUNNER_CREDENTIAL_STORAGE="systemd-creds",
    )

    assert code == EXIT_FAILED and "systemd-creds" in err and TOKEN not in err
    assert not (tmp_path / "home" / "credentials" / "work.secret").exists()


def test_by_default_a_machine_without_systemd_creds_keeps_a_plain_file_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))

    code, out, _ = invoke(
        tmp_path,
        "credential",
        "add",
        "claude",
        "--name",
        "work",
        stdin=TOKEN,
        FACTORY_RUNNER_CREDENTIAL_STORAGE="auto",
    )

    assert code == EXIT_OK and "plain file" in out and "0600" in out and TOKEN not in out
