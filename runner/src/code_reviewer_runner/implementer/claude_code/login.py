# SPDX-License-Identifier: LicenseRef-Proprietary

"""The login of Claude Code, which comes from the customer's device (#856, plan decisions 1 and 11).

The unmodified Claude Code is used with **each user's own credentials**, on the device of the one
who runs the runner. The credential is a one-year inference-only token from `claude setup-token`:
it is printed once and stored nowhere by Claude Code, and it is **never stored in our app or its
database, never sent to the app, never logged**. The runner reads it from

1. the file named by `FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE`, else
2. `claude-code-token` in the runner's home directory (`FACTORY_RUNNER_HOME`), else
3. `CLAUDE_CODE_OAUTH_TOKEN` in the runner's own environment,

and hands it to the agent's container as `CLAUDE_CODE_OAUTH_TOKEN` for the turn (`command.py`). A
file must be a plain file (not a link), owned by the user the runner runs as, that only its owner
can read, like an SSH key (the mode is checked for root too). The stored
login file of Claude Code (`~/.claude/.credentials.json`) is not used: it refreshes itself against
Anthropic's endpoint, which the agent's container must not reach.

A problem is described in words and never with the value.
"""

import os
import re
import stat
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

from .credentials import store_login

TOKEN_FILE_VARIABLE: Final = "FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE"
TOKEN_FILE_NAME: Final = "claude-code-token"
OAUTH_VARIABLE: Final = "CLAUDE_CODE_OAUTH_TOKEN"
API_KEY_VARIABLE: Final = "ANTHROPIC_API_KEY"
MAX_TOKEN_CHARS: Final = 4096
_TOKEN: Final = re.compile(rf"[\x21-\x7e]{{1,{MAX_TOKEN_CHARS}}}")
_HOW: Final = "make one with `claude setup-token` and save it (mode 0600)"


@dataclass(frozen=True)
class LoginProblem:
    """Why there is no login to use. `text` never holds a secret. `configured` is False when the
    device has none at all (it does not use Claude Code), True when it has one that is unusable."""

    text: str
    configured: bool = True


@dataclass(frozen=True)
class ClaudeLogin:
    """One credential for one turn: the subscription's token, or an API key (the key of a provider
    behind the model door, and the fake provider of the tests). Never printed: `repr` and `str`
    name the kind only."""

    kind: str
    secret: str = field(repr=False)

    @staticmethod
    def oauth_token(secret: str) -> "ClaudeLogin":
        return ClaudeLogin(OAUTH_VARIABLE, secret)

    @staticmethod
    def api_key(secret: str) -> "ClaudeLogin":
        return ClaudeLogin(API_KEY_VARIABLE, secret)

    def environment(self) -> dict[str, str]:
        """The one variable that carries it. A key wins over a token in Claude Code, so a login is
        never both."""
        return {self.kind: self.secret}

    def __str__(self) -> str:
        return f"<claude login: {self.kind}>"


def _usable(text: str) -> str | None:
    token = text.strip()
    return token if _TOKEN.fullmatch(token) else None


def _read_file(path: Path) -> ClaudeLogin | LoginProblem:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return LoginProblem(
            f"the token file {path.name} is not there, or is a link or cannot be opened: {_HOW}"
        )
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            return LoginProblem(f"the token file {path.name} is not a plain file")
        if info.st_uid != os.geteuid():
            return LoginProblem(
                f"the token file {path.name} is not owned by the user the runner runs as"
            )
        if info.st_mode & 0o077:  # root is no exception: a careless file stays a careless file
            return LoginProblem(
                f"the token file {path.name} can be read by others: change its mode to 0600"
            )
        raw = os.read(descriptor, MAX_TOKEN_CHARS + 2)
    finally:
        os.close(descriptor)
    token = _usable(raw.decode("utf-8", errors="replace"))
    if token is None:
        return LoginProblem(
            f"the token file {path.name} does not hold exactly one token "
            f"(one line, no spaces, at most {MAX_TOKEN_CHARS} characters): {_HOW}"
        )
    return ClaudeLogin.oauth_token(token)


def load_login(environment: Mapping[str, str], home: Path) -> ClaudeLogin | LoginProblem:
    """The subscription login of this device, or why there is none: the file the operator named,
    else the first usable credential of the store (`credentials.py`, #980), else the older sources
    of `load_legacy_login`. A job process has no home to look in and finds its credential in its
    own environment."""
    named = environment.get(TOKEN_FILE_VARIABLE, "").strip()
    if named:
        return _read_file(Path(named))
    stored = store_login(home)
    if stored is not None:
        return stored
    return load_legacy_login(environment, home)


def load_legacy_login(environment: Mapping[str, str], home: Path) -> ClaudeLogin | LoginProblem:
    """The login of the sources that came before the store (R3): the file `claude-code-token` in the
    runner's home, else `CLAUDE_CODE_OAUTH_TOKEN` in the runner's own environment (the file named by
    `FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE` is taken first by `load_login`; here too)."""
    named = environment.get(TOKEN_FILE_VARIABLE, "").strip()
    if named:
        return _read_file(Path(named))
    default = home / TOKEN_FILE_NAME
    if os.path.lexists(default):
        return _read_file(default)
    from_environment = environment.get(OAUTH_VARIABLE)
    if from_environment is not None:
        token = _usable(from_environment)
        if token is None:
            return LoginProblem(f"{OAUTH_VARIABLE} does not hold exactly one token: {_HOW}")
        return ClaudeLogin.oauth_token(token)
    return LoginProblem(
        f"no Claude Code login on this device: {_HOW}, or set {OAUTH_VARIABLE}", configured=False
    )


def login_source(environment: Mapping[str, str], home: Path) -> dict[str, str]:
    """What the job process of the runner needs to find the same login again (#856): the path of
    the token file (never its content), or, for a login that only the runner's environment holds,
    that variable. Nothing for a device without a login. It does not judge the login."""
    named = environment.get(TOKEN_FILE_VARIABLE, "").strip()
    if named:
        return {TOKEN_FILE_VARIABLE: named}
    default = home / TOKEN_FILE_NAME
    if os.path.lexists(default):
        return {TOKEN_FILE_VARIABLE: str(default)}
    held = environment.get(OAUTH_VARIABLE)
    return {} if held is None else {OAUTH_VARIABLE: held}
