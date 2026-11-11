# SPDX-License-Identifier: LicenseRef-Proprietary

"""The credential store of a device (#980): where the Claude Code tokens of a dispatcher's machine
are kept, in what form, and what never leaves it. No real `systemd-creds` runs: the sealer is a seam
and a fake stands in for it."""

import json
import os
import stat
import subprocess
from collections.abc import Sequence
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.claude_code.credentials import (
    DEFAULT_MODELS,
    CredentialError,
    CredentialStore,
    PlainSealer,
    SystemdCreds,
    store_login,
)
from code_reviewer_runner.implementer.claude_code.login import (
    ClaudeLogin,
    LoginProblem,
    load_login,
)

pytestmark = pytest.mark.unit

TOKEN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"
OTHER = "sk-" + "ant-" + "oat01-another-made-up-token-1111111111111111"


class FakeSealer:
    """Stands in for `systemd-creds`: a reversible scramble that never holds the token as it is."""

    name = "systemd-creds"

    def __init__(self, *, works: bool = True) -> None:
        self.works = works
        self.sealed: list[str] = []

    def available(self) -> bool:
        return self.works

    def seal(self, name: str, secret: str) -> bytes:
        self.sealed.append(name)
        return ("SEALED:" + name + ":" + secret[::-1]).encode()

    def unseal(self, name: str, blob: bytes) -> str:
        head, _, rest = blob.decode().strip().partition(":")
        assert head == "SEALED"
        sealed_name, _, reversed_secret = rest.partition(":")
        if sealed_name != name:
            raise CredentialError("the credential was sealed under another name")
        return reversed_secret[::-1]


def store_in(tmp_path: Path, *, sealer: FakeSealer | None = None, choice: str = "auto") -> CredentialStore:
    return CredentialStore(
        tmp_path / "home",
        choice=choice,
        systemd=sealer if sealer is not None else FakeSealer(works=False),
        clock=lambda: 1_000.0,
    )


def mode_of(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


# #980-T01
def test_a_pasted_token_is_stored_0600_in_a_directory_only_its_owner_enters(tmp_path: Path) -> None:
    store = store_in(tmp_path)

    record = store.add("work", TOKEN)

    directory = tmp_path / "home" / "credentials"
    assert mode_of(directory) == 0o700
    files = sorted(path for path in directory.iterdir() if path.is_file())
    assert files and all(mode_of(path) == 0o600 for path in files)
    assert all(path.stat().st_uid == os.geteuid() for path in files)
    assert record.name == "work" and record.models == DEFAULT_MODELS
    assert store.secret("work") == TOKEN


# #980-T01
def test_the_index_and_the_listing_never_hold_the_value(tmp_path: Path) -> None:
    store = store_in(tmp_path)
    store.add("work", TOKEN)

    directory = tmp_path / "home" / "credentials"
    index = (directory / "index.json").read_text()
    assert TOKEN not in index and json.loads(index)["credentials"][0]["name"] == "work"
    for record in store.records():
        assert TOKEN not in repr(record) and TOKEN not in str(record)


def test_the_default_models_are_the_three_aliases(tmp_path: Path) -> None:
    assert DEFAULT_MODELS == ("sonnet", "opus", "haiku")
    assert store_in(tmp_path).add("a", TOKEN).models == DEFAULT_MODELS


def test_models_are_given_at_add_time_and_checked(tmp_path: Path) -> None:
    store = store_in(tmp_path)

    assert store.add("a", TOKEN, models=("opus", "claude-sonnet-5-5")).models == (
        "opus",
        "claude-sonnet-5-5",
    )
    for bad in (("",), ("two words",), ("x" * 101,), tuple(f"m{i}" for i in range(65)), ()):
        with pytest.raises(CredentialError):
            store.add("b", OTHER, models=bad)


@pytest.mark.parametrize("name", ["", "Work", "-a", "a b", "a/b", "../x", "a" * 41, "x\n"])
def test_a_name_that_is_not_a_plain_label_is_refused(tmp_path: Path, name: str) -> None:
    with pytest.raises(CredentialError):
        store_in(tmp_path).add(name, TOKEN)


@pytest.mark.parametrize("token", ["", "two words", "x\ny", "a" * 5000, "tab\there"])
def test_a_value_that_is_not_one_token_is_refused_without_showing_it(
    tmp_path: Path, token: str
) -> None:
    with pytest.raises(CredentialError) as error:
        store_in(tmp_path).add("work", token)

    assert "a" * 100 not in str(error.value)


def test_an_added_name_is_not_replaced_without_the_flag(tmp_path: Path) -> None:
    store = store_in(tmp_path)
    store.add("work", TOKEN)

    with pytest.raises(CredentialError) as error:
        store.add("work", OTHER)

    assert "--replace" in str(error.value) and store.secret("work") == TOKEN
    store.add("work", OTHER, replace=True)
    assert store.secret("work") == OTHER


# #980-T04
def test_replacing_a_credential_clears_what_was_held_against_it(tmp_path: Path) -> None:
    store = store_in(tmp_path)
    store.add("work", TOKEN, models=("opus",))
    store.mark_refused("work")
    store.set_limited("work", 5_000.0)

    store.add("work", OTHER, replace=True)

    [record] = store.records()
    assert not record.refused and record.limited_until == 0.0
    assert record.models == ("opus",), "the models stay unless new ones are given"
    store.add("work", TOKEN, models=("haiku",), replace=True)
    assert store.records()[0].models == ("haiku",)


def test_a_credential_is_removed_with_its_secret(tmp_path: Path) -> None:
    store = store_in(tmp_path)
    store.add("a", TOKEN)
    store.add("b", OTHER)

    store.remove("a")

    assert [record.name for record in store.records()] == ["b"]
    assert not any(TOKEN in path.read_text() for path in (tmp_path / "home" / "credentials").iterdir() if path.is_file())
    with pytest.raises(CredentialError):
        store.remove("a")
    with pytest.raises(CredentialError):
        store.secret("a")


def test_the_state_of_a_credential_is_kept_across_stores(tmp_path: Path) -> None:
    store = store_in(tmp_path)
    store.add("a", TOKEN)
    store.set_limited("a", 9_000.0)
    store.drop_model("a", "haiku")

    again = store_in(tmp_path).records()[0]

    assert again.limited_until == 9_000.0 and again.models == ("sonnet", "opus")


def test_a_state_in_the_past_is_not_a_limit(tmp_path: Path) -> None:
    store = store_in(tmp_path)
    record = store.add("a", TOKEN)
    store.set_limited("a", 500.0)

    assert store.records()[0].state(1_000.0) == "usable"
    assert store.records()[0].state(100.0) == "rate limited"
    store.mark_refused("a")
    assert store.records()[0].state(1_000.0) == "refused"
    assert record.state(1_000.0) == "usable"


# -- storage ---------------------------------------------------------------------------------


def test_with_systemd_creds_the_file_holds_the_sealed_form_and_the_listing_says_so(
    tmp_path: Path,
) -> None:
    sealer = FakeSealer()
    store = store_in(tmp_path, sealer=sealer)

    record = store.add("work", TOKEN)

    assert record.storage == "systemd-creds" and sealer.sealed == ["work"]
    secret_file = tmp_path / "home" / "credentials" / "work.secret"
    assert TOKEN.encode() not in secret_file.read_bytes() and mode_of(secret_file) == 0o600
    assert store.secret("work") == TOKEN


def test_without_systemd_creds_the_token_is_a_plain_file_and_the_listing_says_so(
    tmp_path: Path,
) -> None:
    store = store_in(tmp_path, sealer=FakeSealer(works=False))

    record = store.add("work", TOKEN)

    assert record.storage == "plain"
    assert (tmp_path / "home" / "credentials" / "work.secret").read_text().strip() == TOKEN


def test_the_choice_systemd_creds_does_not_fall_back_to_a_plain_file(tmp_path: Path) -> None:
    store = store_in(tmp_path, sealer=FakeSealer(works=False), choice="systemd-creds")

    with pytest.raises(CredentialError) as error:
        store.add("work", TOKEN)

    assert "systemd-creds" in str(error.value)
    assert not (tmp_path / "home" / "credentials" / "work.secret").exists()


def test_the_choice_plain_never_asks_systemd_creds(tmp_path: Path) -> None:
    sealer = FakeSealer()

    record = store_in(tmp_path, sealer=sealer, choice="plain").add("work", TOKEN)

    assert record.storage == "plain" and sealer.sealed == []


def test_an_unknown_storage_choice_is_a_configuration_error(tmp_path: Path) -> None:
    with pytest.raises(CredentialError):
        store_in(tmp_path, choice="vault").add("work", TOKEN)


def test_a_sealed_credential_that_cannot_be_opened_is_said_in_words(tmp_path: Path) -> None:
    store = store_in(tmp_path, sealer=FakeSealer())
    store.add("work", TOKEN)
    (tmp_path / "home" / "credentials" / "work.secret").write_bytes(b"SEALED:other:abc")

    with pytest.raises(CredentialError) as error:
        store.secret("work")

    assert TOKEN not in str(error.value)


# -- what is refused on reading -----------------------------------------------------------------


def test_a_secret_file_others_can_read_is_refused(tmp_path: Path) -> None:
    store = store_in(tmp_path)
    store.add("work", TOKEN)
    path = tmp_path / "home" / "credentials" / "work.secret"
    path.chmod(0o644)

    with pytest.raises(CredentialError) as error:
        store.secret("work")

    assert "0600" in str(error.value) and TOKEN not in str(error.value)


def test_a_link_in_place_of_a_secret_file_is_refused(tmp_path: Path) -> None:
    store = store_in(tmp_path)
    store.add("work", TOKEN)
    path = tmp_path / "home" / "credentials" / "work.secret"
    elsewhere = tmp_path / "elsewhere"
    elsewhere.write_text(TOKEN)
    elsewhere.chmod(0o600)
    path.unlink()
    path.symlink_to(elsewhere)

    with pytest.raises(CredentialError):
        store.secret("work")


def test_a_directory_others_can_enter_is_refused(tmp_path: Path) -> None:
    store = store_in(tmp_path)
    store.add("work", TOKEN)
    (tmp_path / "home" / "credentials").chmod(0o755)

    with pytest.raises(CredentialError):
        store.secret("work")
    with pytest.raises(CredentialError):
        store.records()


def test_a_missing_store_has_no_credentials(tmp_path: Path) -> None:
    assert store_in(tmp_path).records() == []


def test_an_index_that_is_not_ours_is_an_error_in_words(tmp_path: Path) -> None:
    store = store_in(tmp_path)
    store.add("work", TOKEN)
    (tmp_path / "home" / "credentials" / "index.json").write_text("not json")
    (tmp_path / "home" / "credentials" / "index.json").chmod(0o600)

    with pytest.raises(CredentialError):
        store.records()


# -- the login of the device reads the store too ---------------------------------------------------


def test_the_login_of_a_device_is_found_in_the_store(tmp_path: Path) -> None:
    store_in(tmp_path).add("work", TOKEN)

    login = load_login({}, tmp_path / "home")

    assert isinstance(login, ClaudeLogin) and login.secret == TOKEN


def test_an_empty_store_is_no_login_and_does_not_hide_the_older_sources(tmp_path: Path) -> None:
    home = tmp_path / "home"
    assert isinstance(load_login({}, home), LoginProblem)
    assert store_login(home) is None

    login = load_login({"CLAUDE_CODE_OAUTH_TOKEN": TOKEN}, home)
    assert isinstance(login, ClaudeLogin) and login.secret == TOKEN


def test_a_store_whose_credentials_are_all_unusable_is_a_login_problem(tmp_path: Path) -> None:
    store = store_in(tmp_path)
    store.add("work", TOKEN)
    (tmp_path / "home" / "credentials" / "work.secret").chmod(0o644)

    login = load_login({}, tmp_path / "home")

    assert isinstance(login, LoginProblem) and login.configured
    assert TOKEN not in login.text


# -- systemd-creds as a command ------------------------------------------------------------------


class Run:
    """A fake `subprocess.run` that records what the command was given."""

    def __init__(self, *, fail: bool = False) -> None:
        self.calls: list[tuple[Sequence[str], str | None]] = []
        self.fail = fail

    def __call__(self, argv: Sequence[str], **options: object) -> subprocess.CompletedProcess[str]:
        self.calls.append((list(argv), options.get("input")))  # type: ignore[arg-type]
        if self.fail:
            return subprocess.CompletedProcess(argv, 1, "", "no such thing")
        if "encrypt" in argv:
            return subprocess.CompletedProcess(argv, 0, "SEAL(" + str(options["input"]) + ")", "")
        text = str(options["input"])
        return subprocess.CompletedProcess(argv, 0, text.removeprefix("SEAL(").removesuffix(")"), "")


def test_systemd_creds_gets_the_token_on_stdin_and_never_in_an_argument() -> None:
    run = Run()
    sealer = SystemdCreds(run=run)

    blob = sealer.seal("work", TOKEN)

    assert sealer.unseal("work", blob) == TOKEN
    for argv, _ in run.calls:
        assert TOKEN not in " ".join(argv) and "--name=work" in argv
    assert any(given == TOKEN for _, given in run.calls)


def test_systemd_creds_is_available_when_a_round_trip_works() -> None:
    assert SystemdCreds(run=Run()).available() is True
    assert SystemdCreds(run=Run(fail=True)).available() is False


def test_systemd_creds_that_is_not_installed_is_not_available() -> None:
    def missing(argv: Sequence[str], **options: object) -> subprocess.CompletedProcess[str]:
        raise FileNotFoundError

    assert SystemdCreds(run=missing).available() is False


def test_a_failing_systemd_creds_says_so_without_the_token() -> None:
    with pytest.raises(CredentialError) as error:
        SystemdCreds(run=Run(fail=True)).seal("work", TOKEN)

    assert TOKEN not in str(error.value)


def test_the_plain_sealer_is_the_identity() -> None:
    sealer = PlainSealer()
    assert sealer.unseal("a", sealer.seal("a", TOKEN)) == TOKEN
