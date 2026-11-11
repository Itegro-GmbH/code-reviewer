# SPDX-License-Identifier: LicenseRef-Proprietary

"""The dispatcher's choice of a credential for a job and what it withdraws (#980): which credential
a job gets, when the manifest stops offering Claude Code and when it offers it again. The store is
the real one (in a temporary directory, plain files); only the clock is a double."""

from pathlib import Path

import pytest

from code_reviewer_runner.factory_runner.credential_pool import (
    LIMIT_COOLDOWN_SECONDS,
    CredentialPool,
    Verdict,
    verdict_of_exit,
)
from code_reviewer_runner.implementer.claude_code.credentials import CredentialStore, PlainSealer
from code_reviewer_runner.implementer.claude_code.login import ClaudeLogin, LoginProblem
from code_reviewer_runner.job_loop.worker_errors import WorkerExit

pytestmark = pytest.mark.unit

ONE = "sk-" + "ant-" + "oat01-first-made-up-token-not-real-00000000000"
TWO = "sk-" + "ant-" + "oat01-second-made-up-token-not-real-0000000000"
LEGACY = "sk-" + "ant-" + "oat01-legacy-made-up-token-not-real-000000000"


class Clock:
    def __init__(self) -> None:
        self.now = 10_000.0

    def __call__(self) -> float:
        return self.now


class Rig:
    def __init__(self, tmp_path: Path, *, legacy: ClaudeLogin | LoginProblem | None = None) -> None:
        self.clock = Clock()
        self.store = CredentialStore(
            tmp_path / "home", choice="plain", systemd=PlainSealer(), clock=self.clock
        )
        self.legacy = legacy or LoginProblem("none", configured=False)
        self.pool = CredentialPool(self.store, lambda: self.legacy, self.clock)

    def models(self) -> tuple[str, ...] | str | None:
        offer = self.pool.offer()
        return "withdrawn" if offer is None else offer.models


# #980-T02
def test_with_two_credentials_one_rate_limited_the_job_gets_the_other(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.store.add("a", ONE)
    rig.store.add("b", TWO)
    rig.pool.report("a", Verdict.LIMIT, None)

    for _ in range(3):
        chosen = rig.pool.choose("claude-sonnet-5-5")
        assert chosen is not None and chosen.name == "b" and chosen.credential.value == TWO


def test_usable_credentials_take_turns_the_one_unused_longest_first(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.store.add("a", ONE)
    rig.store.add("b", TWO)

    names: list[str] = []
    for _ in range(4):
        chosen = rig.pool.choose(None)
        assert chosen is not None
        names.append(chosen.name)
        rig.clock.now += 1

    assert names == ["a", "b", "a", "b"]


def test_a_credential_that_does_not_allow_the_model_is_not_chosen(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.store.add("small", ONE, models=("haiku",))
    rig.store.add("big", TWO, models=("opus",))

    chosen = rig.pool.choose("claude-opus-5-5")  # an id; the credential allows its alias

    assert chosen is not None and chosen.name == "big"
    assert rig.pool.choose("claude-sonnet-5-5") is None
    assert rig.pool.choose(None) is not None, "a job that names no model needs no match"


# #980-T03
def test_when_all_credentials_are_rate_limited_the_entry_is_withdrawn_until_one_is_usable(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    rig.store.add("a", ONE)
    rig.store.add("b", TWO)
    assert rig.models() == ("sonnet", "opus", "haiku")

    rig.pool.report("a", Verdict.LIMIT, None)
    assert rig.models() == ("sonnet", "opus", "haiku"), "b still serves"
    rig.clock.now += 5
    rig.pool.report("b", Verdict.LIMIT, None)

    assert rig.models() == "withdrawn" and rig.pool.choose(None) is None
    rig.clock.now += LIMIT_COOLDOWN_SECONDS - 6
    assert rig.models() == "withdrawn"
    rig.clock.now += 2  # the first limit has run out
    assert rig.models() == ("sonnet", "opus", "haiku")
    chosen = rig.pool.choose(None)
    assert chosen is not None and chosen.name == "a"


# #980-T04
def test_a_refused_credential_stays_out_until_it_is_replaced(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.store.add("only", ONE)

    rig.pool.report("only", Verdict.AUTH, None)

    assert rig.models() == "withdrawn"
    rig.clock.now += 10 * LIMIT_COOLDOWN_SECONDS
    assert rig.models() == "withdrawn" and rig.pool.choose(None) is None
    rig.store.add("only", TWO, replace=True)
    assert rig.models() == ("sonnet", "opus", "haiku")


# #980-T05
def test_a_model_the_subscription_refused_is_taken_off_the_entry(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.store.add("a", ONE, models=("sonnet", "opus"))

    rig.pool.report("a", Verdict.MODEL, "claude-opus-5-5")  # the job's model is an id

    assert rig.models() == ("sonnet",)
    assert rig.pool.choose("claude-opus-5-5") is None
    assert rig.pool.choose("claude-sonnet-5-5") is not None
    rig.pool.report("a", Verdict.MODEL, "sonnet")
    assert rig.models() == "withdrawn", "no model left: nothing to offer"


def test_the_entry_lists_the_models_of_every_usable_credential_once(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.store.add("a", ONE, models=("sonnet", "opus"))
    rig.store.add("b", TWO, models=("opus", "claude-haiku-5-5"))

    assert rig.models() == ("sonnet", "opus", "claude-haiku-5-5")
    rig.pool.report("b", Verdict.AUTH, None)
    assert rig.models() == ("sonnet", "opus")


def test_the_login_of_an_older_device_is_used_while_the_store_is_empty(tmp_path: Path) -> None:
    rig = Rig(tmp_path, legacy=ClaudeLogin.oauth_token(LEGACY))

    assert rig.models() is None, "no list of models: the device allows any"
    chosen = rig.pool.choose("claude-sonnet-5-5")
    assert chosen is not None and chosen.credential.value == LEGACY
    rig.pool.report(chosen.name, Verdict.LIMIT, None)
    assert rig.models() == "withdrawn"
    rig.store.add("new", ONE)
    chosen = rig.pool.choose(None)
    assert chosen is not None and chosen.name == "new", "the store wins over the old sources"


def test_a_device_without_any_credential_offers_nothing(tmp_path: Path) -> None:
    rig = Rig(tmp_path)

    assert rig.models() == "withdrawn" and rig.pool.choose(None) is None


def test_a_secret_that_cannot_be_read_is_skipped_and_said_in_words(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.store.add("broken", ONE)
    rig.store.add("fine", TWO)
    (tmp_path / "home" / "credentials" / "broken.secret").chmod(0o644)

    chosen = rig.pool.choose(None)

    assert chosen is not None and chosen.name == "fine"
    assert rig.pool.problems and ONE not in " ".join(rig.pool.problems)


def test_a_store_that_cannot_be_read_offers_nothing_and_says_why(tmp_path: Path) -> None:
    rig = Rig(tmp_path, legacy=ClaudeLogin.oauth_token(LEGACY))
    rig.store.add("a", ONE)
    (tmp_path / "home" / "credentials").chmod(0o755)

    assert rig.models() == "withdrawn"
    assert rig.pool.problems


def test_the_exit_codes_of_the_worker_are_the_verdicts() -> None:
    assert verdict_of_exit(int(WorkerExit.SUBSCRIPTION_AUTH)) is Verdict.AUTH
    assert verdict_of_exit(int(WorkerExit.SUBSCRIPTION_LIMIT)) is Verdict.LIMIT
    assert verdict_of_exit(int(WorkerExit.SUBSCRIPTION_MODEL_REFUSED)) is Verdict.MODEL
    for other in (0, 1, 2, 137, -9):
        assert verdict_of_exit(other) is None
