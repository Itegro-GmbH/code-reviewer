# SPDX-License-Identifier: LicenseRef-Proprietary

"""The credentials of a dispatcher's device as the dispatcher uses them (#980, ADR 0005 decision 4):
which one a job gets, and when the manifest stops offering Claude Code.

The store (`implementer/claude_code/credentials.py`) holds the tokens and what was found out about
them. The pool decides:

- **Per job one credential**, among those not rate limited and not refused whose models allow the
  job's model (an alias matches the ids it stands for, `model_names.py`); the one unused longest
  goes first, so the subscriptions are worn evenly. Only that one is handed to the sandbox.
- **What the manifest offers**: the models of every usable credential, or nothing (the entry is
  withdrawn) while none is usable. The app never learns a name, a count or a reason.
- **What a job's end teaches**: the Worker's exit code says why a subscription refused a job
  (`WorkerExit.SUBSCRIPTION_*`). **Every one of them is a hint that expires**, never a verdict:
  the exit code comes from the job's `result` event, which the agent inside the job's sandbox can
  forge (it runs as the same user as Claude Code and can write to Claude Code's pipes; see
  ADR 0005 3g). What a forgery can do is therefore bounded to the owner's own credentials and to
  hours: a usage limit puts the credential aside for `Cooldowns.limit` (one hour), a 401 for
  `Cooldowns.auth` (six hours), a refused model leaves the list for `Cooldowns.model` (six hours,
  that one id; an alias is never taken off by one refusal, it is set aside once
  `ALIAS_ASIDE_AFTER` ids it covers are, `credentials.py`). `credential retry` ends all of them
  at once, and the list the owner gave is never shrunk.
- **A job that hits the limit fails** (free, `subscription_limit`); it is never moved to another
  credential in the middle of a run (the turn's state is Claude Code's session on one login).

The login of an older device (the token file or the environment variable of R3) is used only while
the store is empty. It has no list of models (it allows any, as before) and its state is not kept
across restarts; a refused model cannot be set aside on it.
"""

import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final

from code_reviewer_runner.implementer.claude_code.credentials import (
    CredentialError,
    CredentialRecord,
    CredentialStore,
)
from code_reviewer_runner.implementer.claude_code.login import (
    OAUTH_VARIABLE,
    ClaudeLogin,
    LoginProblem,
)
from code_reviewer_runner.job_loop.local_credential import LocalCredential
from code_reviewer_runner.job_loop.worker_errors import WorkerExit

# How long a credential that hit the subscription's usage limit is put aside. Anthropic's limits
# reset in windows of hours and what Claude Code prints about the reset is words for a person, so
# the dispatcher does not read it: a credential tried again too early costs the job that finds the
# limit still there, so the pause is long. `factory-runner credential retry` ends it sooner.
LIMIT_COOLDOWN_SECONDS: Final = 60 * 60.0
# How long a credential a job reported as refused (a 401) is set aside, and a model a job reported
# as refused. Long, because a real expiry or a real missing model does not mend itself and every
# early try costs a job; bounded, because the report can be forged from inside the job.
AUTH_COOLDOWN_SECONDS: Final = 6 * 60 * 60.0
MODEL_COOLDOWN_SECONDS: Final = 6 * 60 * 60.0
LIMIT_COOLDOWN_VARIABLE: Final = "FACTORY_RUNNER_CREDENTIAL_LIMIT_COOLDOWN_SECONDS"
AUTH_COOLDOWN_VARIABLE: Final = "FACTORY_RUNNER_CREDENTIAL_AUTH_COOLDOWN_SECONDS"
MODEL_COOLDOWN_VARIABLE: Final = "FACTORY_RUNNER_CREDENTIAL_MODEL_COOLDOWN_SECONDS"
LEGACY_NAME: Final = "(older login)"


@dataclass(frozen=True)
class Cooldowns:
    """How long each kind of hint holds, in seconds."""

    limit: float = LIMIT_COOLDOWN_SECONDS
    auth: float = AUTH_COOLDOWN_SECONDS
    model: float = MODEL_COOLDOWN_SECONDS

    @staticmethod
    def from_environment(environment: Mapping[str, str]) -> "tuple[Cooldowns, tuple[str, ...]]":
        """The cooldowns of this device and the words about a setting that is not a positive
        number of seconds (that one keeps its default; the value is not repeated)."""
        problems: list[str] = []

        def read(variable: str, default: float) -> float:
            raw = environment.get(variable, "").strip()
            if not raw:
                return default
            try:
                seconds = float(raw)
            except ValueError:
                seconds = math.nan
            if not math.isfinite(seconds) or seconds <= 0:
                problems.append(
                    f"{variable} is not a positive number of seconds: the default "
                    f"({default:g}) is used"
                )
                return default
            return seconds

        return (
            Cooldowns(
                limit=read(LIMIT_COOLDOWN_VARIABLE, LIMIT_COOLDOWN_SECONDS),
                auth=read(AUTH_COOLDOWN_VARIABLE, AUTH_COOLDOWN_SECONDS),
                model=read(MODEL_COOLDOWN_VARIABLE, MODEL_COOLDOWN_SECONDS),
            ),
            tuple(problems),
        )


class Verdict(StrEnum):
    """What a job's end says about the credential it ran on."""

    AUTH = "auth"
    LIMIT = "limit"
    MODEL = "model"


_VERDICT_BY_EXIT: Final = {
    int(WorkerExit.SUBSCRIPTION_AUTH): Verdict.AUTH,
    int(WorkerExit.SUBSCRIPTION_LIMIT): Verdict.LIMIT,
    int(WorkerExit.SUBSCRIPTION_MODEL_REFUSED): Verdict.MODEL,
}


def verdict_of_exit(exit_code: int) -> Verdict | None:
    """The verdict a Worker's exit code carries, or None for any other end."""
    return _VERDICT_BY_EXIT.get(exit_code)


@dataclass(frozen=True)
class Offer:
    """What the manifest says about Claude Code while some credential is usable: the models they
    allow, in the order of the credentials; None: the device allows any model (an older login)."""

    models: tuple[str, ...] | None


@dataclass(frozen=True)
class Chosen:
    """The credential a job runs on. The value is never printed."""

    name: str
    credential: LocalCredential = field(repr=False)


@dataclass
class _Legacy:
    limited_until: float = 0.0
    refused_until: float = 0.0


class CredentialPool:
    def __init__(
        self,
        store: CredentialStore,
        legacy: Callable[[], ClaudeLogin | LoginProblem],
        clock: Callable[[], float],
        *,
        cooldowns: Cooldowns = Cooldowns(),  # noqa: B008
    ) -> None:
        self._store = store
        self._legacy_login = legacy
        self._clock = clock
        self._cooldowns = cooldowns
        self._legacy = _Legacy()
        self._last_used: dict[str, float] = {}
        # Words about what could not be read, for the dispatcher's log; never a value.
        self.problems: list[str] = []

    # -- what exists ---------------------------------------------------------------------------

    def _records(self) -> list[CredentialRecord] | None:
        """The credentials of the store; None when the store cannot be read (nothing is offered
        then: a device whose store is broken is not silently run on an older login)."""
        try:
            return self._store.records()
        except CredentialError as error:
            self._problem(str(error))
            return None

    def _problem(self, text: str) -> None:
        if text not in self.problems:
            self.problems.append(text)

    def _legacy_usable(self) -> bool:
        now = self._clock()
        return (
            self._legacy.refused_until <= now
            and self._legacy.limited_until <= now
            and isinstance(self._legacy_login(), ClaudeLogin)
        )

    def offer(self) -> Offer | None:
        """What to announce for Claude Code, or None while no credential can be used: one that is
        rate limited or refused for now, has no model for now, or whose secret cannot be read (an
        entry no credential can serve is not announced: the app would send jobs that could only
        be given back)."""
        records = self._records()
        if records is None:
            return None
        if not records:
            return Offer(None) if self._legacy_usable() else None
        now = self._clock()
        models: list[str] = []
        for record in records:
            if record.usable(now) and self._readable(record):
                models.extend(model for model in record.offered(now) if model not in models)
        return Offer(tuple(models)) if models else None

    def _readable(self, record: CredentialRecord) -> bool:
        try:
            self._store.secret(record.name)
        except CredentialError as error:
            self._problem(f"credential {record.name}: {error}")
            return False
        return True

    # -- a job -----------------------------------------------------------------------------------

    def choose(self, model: str | None) -> Chosen | None:
        """The credential for a job that asks for `model` (None: any), or None when none can serve
        it. The one unused longest goes first."""
        records = self._records()
        if records is None:
            return None
        now = self._clock()
        if not records:
            return self._choose_legacy(now)
        candidates = [
            record for record in records if record.usable(now) and record.allows(now, model)
        ]
        candidates.sort(key=lambda record: (self._last_used.get(record.name, 0.0), record.name))
        for record in candidates:
            try:
                secret = self._store.secret(record.name)
            except CredentialError as error:
                self._problem(f"credential {record.name}: {error}")
                continue
            self._last_used[record.name] = now
            return Chosen(record.name, LocalCredential(OAUTH_VARIABLE, secret))
        return None

    def _choose_legacy(self, now: float) -> Chosen | None:
        if not self._legacy_usable():
            return None
        login = self._legacy_login()
        if not isinstance(login, ClaudeLogin):
            return None
        self._last_used[LEGACY_NAME] = now
        return Chosen(LEGACY_NAME, LocalCredential(OAUTH_VARIABLE, login.secret))

    def report(self, name: str, verdict: Verdict, model: str | None) -> None:
        """A job on credential `name` ended with `verdict`. A credential that is gone (removed
        meanwhile) is nothing to update."""
        now = self._clock()
        try:
            self._report(name, verdict, model, now)
        except CredentialError as error:
            self._problem(f"credential {name}: {error}")

    def _report(self, name: str, verdict: Verdict, model: str | None, now: float) -> None:
        cooldowns = self._cooldowns
        if name == LEGACY_NAME:
            if verdict is Verdict.AUTH:
                self._legacy.refused_until = now + cooldowns.auth
            elif verdict is Verdict.LIMIT:
                self._legacy.limited_until = now + cooldowns.limit
            return
        if verdict is Verdict.AUTH:
            self._store.mark_refused(name, now + cooldowns.auth)
        elif verdict is Verdict.LIMIT:
            self._store.set_limited(name, now + cooldowns.limit)
        elif model is not None:
            self._store.set_model_aside(name, model, now + cooldowns.model)

    def retry(self, name: str) -> None:
        """Let go of every hint held against a credential (the owner knows better)."""
        self._store.clear_hints(name)
