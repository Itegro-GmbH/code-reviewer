# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Claude Code credentials of a device (#980, Runner v2, ADR 0005 decision 4): the tokens that
`claude setup-token` made, several of them, kept only on the dispatcher's machine.

A credential is a name (visible only here), the token, the models its subscription allows (given
when it is added; the aliases `sonnet`, `opus` and `haiku` by default) and what the dispatcher found
out about it (rate limited until, refused). They live in `<runner home>/credentials/`, a directory
only its owner may enter:

- `index.json` (0600): names, creation times, models, how each token is stored, the state. **No
  value.** The dispatcher and `credential list` read this.
- `<name>.secret` (0600): the token. With `systemd-creds` available it is sealed (the file holds
  `systemd-creds --user encrypt` output); without it, or with
  `FACTORY_RUNNER_CREDENTIAL_STORAGE=plain`, it is the token itself in a file that only the owner
  can read, like an SSH key (the same rule as the token file of R3). `auto` (the default) seals when
  it works and falls back to the plain file; `systemd-creds` refuses to fall back; `plain` never
  asks `systemd-creds`.

The token is **never sent to the app, never logged, never in an argument** (`systemd-creds` gets it
on its standard input) and is **never mirrored from `~/.claude/.credentials.json`**: that file
refreshes itself against Anthropic's endpoint, and the host and a VM would invalidate each other's
copy.

A problem is described in words and never with the value.
"""

import contextlib
import fcntl
import json
import os
import re
import stat
import subprocess
import tempfile
import time
from collections.abc import Callable, Generator, Mapping, Sequence
from dataclasses import dataclass
from dataclasses import replace as with_changes
from pathlib import Path
from typing import TYPE_CHECKING, Final, Protocol

if TYPE_CHECKING:
    from .login import ClaudeLogin, LoginProblem

DIRECTORY_NAME: Final = "credentials"
INDEX_NAME: Final = "index.json"
LOCK_NAME: Final = ".lock"
INDEX_VERSION: Final = 1
# Words the dispatcher puts on a credential's state in a listing.
STATE_USABLE: Final = "usable"
STATE_LIMITED: Final = "rate limited"
STATE_REFUSED: Final = "refused"
STATE_NO_MODELS: Final = "no models"
STORAGE_PLAIN: Final = "plain"
STORAGE_SYSTEMD: Final = "systemd-creds"
STORAGE_AUTO: Final = "auto"
STORAGE_CHOICES: Final = (STORAGE_AUTO, STORAGE_SYSTEMD, STORAGE_PLAIN)
STORAGE_VARIABLE: Final = "FACTORY_RUNNER_CREDENTIAL_STORAGE"
# What a subscription offers every account; the manifest announces them as they are.
DEFAULT_MODELS: Final = ("sonnet", "opus", "haiku")
MAX_MODELS: Final = 64
NAME_PATTERN: Final = re.compile(r"[a-z0-9][a-z0-9._-]{0,39}")
# The same pattern as `MODEL_NAME_PATTERN` of the app (`app/src/runner-identity/access.ts`).
MODEL_PATTERN: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}")
MAX_TOKEN_CHARS: Final = 4096
_TOKEN: Final = re.compile(rf"[\x21-\x7e]{{1,{MAX_TOKEN_CHARS}}}")
_SECRET_FILE_BYTES: Final = 64 * 1024
_SEAL_SECONDS: Final = 15.0


class CredentialError(Exception):
    """A credential cannot be stored or read. The message is words: never a value."""


@dataclass(frozen=True)
class CredentialRecord:
    """What the index says of one credential: nothing secret."""

    name: str
    created: float
    models: tuple[str, ...]
    storage: str
    # Until when the subscription's usage limit holds it back (0: not at all).
    limited_until: float = 0.0
    # The token was refused (a 401: expired or revoked): it stays out until it is replaced.
    refused: bool = False

    def state(self, now: float) -> str:
        if self.refused:
            return STATE_REFUSED
        if self.limited_until > now:
            return STATE_LIMITED
        if not self.models:
            return STATE_NO_MODELS
        return STATE_USABLE

    def usable(self, now: float) -> bool:
        return self.state(now) == STATE_USABLE


class Sealer(Protocol):
    """How a token is made unreadable at rest: `systemd-creds`, or nothing."""

    @property
    def name(self) -> str: ...

    def available(self) -> bool: ...

    def seal(self, name: str, secret: str) -> bytes: ...

    def unseal(self, name: str, blob: bytes) -> str: ...


class PlainSealer:
    """The token as it is, in a file that only its owner can read."""

    name = STORAGE_PLAIN

    def available(self) -> bool:
        return True

    def seal(self, name: str, secret: str) -> bytes:
        return secret.encode("ascii")

    def unseal(self, name: str, blob: bytes) -> str:
        return blob.decode("ascii", errors="replace").strip()


Run = Callable[..., "subprocess.CompletedProcess[str]"]


class SystemdCreds:
    """`systemd-creds --user encrypt|decrypt`: the token goes in on standard input, the sealed text
    comes out on standard output, and the name binds the one to the other. The user's own key is
    systemd 256 and later; an older systemd (or one with no key for the user) says no and the store
    falls back to a plain file when its choice allows it."""

    name = STORAGE_SYSTEMD

    def __init__(self, run: Run = subprocess.run) -> None:
        self._run = run
        self._available: bool | None = None

    def _call(self, verb: str, name: str, text: str) -> str:
        try:
            done = self._run(
                ["systemd-creds", "--user", verb, f"--name={name}", "-", "-"],
                input=text,
                capture_output=True,
                text=True,
                timeout=_SEAL_SECONDS,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            raise CredentialError("systemd-creds could not be run") from None
        if done.returncode != 0:
            raise CredentialError(f"systemd-creds {verb} failed (exit {done.returncode})")
        return str(done.stdout)

    def available(self) -> bool:
        if self._available is None:
            try:
                probe = "probe-value-not-a-secret"
                self._available = self.unseal("probe", self.seal("probe", probe)) == probe
            except CredentialError:
                self._available = False
        return self._available

    def seal(self, name: str, secret: str) -> bytes:
        return self._call("encrypt", name, secret).encode("ascii")

    def unseal(self, name: str, blob: bytes) -> str:
        return self._call("decrypt", name, blob.decode("ascii", errors="replace")).strip()


def check_name(raw: str) -> str:
    if not NAME_PATTERN.fullmatch(raw):
        raise CredentialError(
            "the name must be 1 to 40 characters of a-z, 0-9, dot, dash and underscore, "
            "starting with a letter or a digit"
        )
    return raw


def check_token(raw: str) -> str:
    token = raw.strip()
    if not _TOKEN.fullmatch(token):
        raise CredentialError(
            f"that is not exactly one token (one line, no spaces, at most {MAX_TOKEN_CHARS} "
            "characters): paste the output of `claude setup-token`"
        )
    return token


def check_models(models: Sequence[str]) -> tuple[str, ...]:
    if not 1 <= len(models) <= MAX_MODELS:
        raise CredentialError(f"a credential allows 1 to {MAX_MODELS} models")
    for model in models:
        if not MODEL_PATTERN.fullmatch(model):
            raise CredentialError("a model is a name such as sonnet or claude-sonnet-5-5")
    return tuple(dict.fromkeys(models))


def _owned_private(info: os.stat_result, what: str, *, directory: bool) -> None:
    if directory and not stat.S_ISDIR(info.st_mode):
        raise CredentialError(f"{what} is not a directory")
    if not directory and not stat.S_ISREG(info.st_mode):
        raise CredentialError(f"{what} is not a plain file")
    if info.st_uid != os.geteuid():
        raise CredentialError(f"{what} is not owned by the user the runner runs as")
    if info.st_mode & 0o077:
        mode = "0700" if directory else "0600"
        raise CredentialError(f"{what} can be reached by others: change its mode to {mode}")


class CredentialStore:
    """The credentials of one device, under `<home>/credentials/`. Safe to use from the service and
    the command at once (a lock file orders the writes, every write replaces a file whole)."""

    def __init__(
        self,
        home: Path,
        *,
        choice: str = STORAGE_AUTO,
        systemd: Sealer | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._directory = home / DIRECTORY_NAME
        self._home = home
        self._choice = choice
        self._systemd: Sealer = systemd if systemd is not None else SystemdCreds()
        self._plain = PlainSealer()
        self._clock = clock

    # -- reading ---------------------------------------------------------------------------------

    def records(self) -> list[CredentialRecord]:
        """Every credential, in the order they were added. Empty when the store does not exist."""
        if not os.path.lexists(self._directory):
            return []
        self._check_directory()
        return self._read_index()

    def secret(self, name: str) -> str:
        """The token of a credential. `CredentialError` in words when it cannot be had."""
        record = self._find(self.records(), name)
        self._check_directory()
        path = self._directory / f"{record.name}.secret"
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            raise CredentialError(
                f"the secret of {name} is not there, or is a link or cannot be opened"
            ) from None
        try:
            _owned_private(os.fstat(descriptor), f"the secret file of {name}", directory=False)
            raw = os.read(descriptor, _SECRET_FILE_BYTES)
        finally:
            os.close(descriptor)
        sealer = self._systemd if record.storage == STORAGE_SYSTEMD else self._plain
        token = sealer.unseal(record.name, raw)
        if not _TOKEN.fullmatch(token):
            raise CredentialError(f"the secret of {name} does not hold exactly one token")
        return token

    # -- writing ---------------------------------------------------------------------------------

    def add(
        self,
        name: str,
        secret: str,
        *,
        models: Sequence[str] | None = None,
        replace: bool = False,
    ) -> CredentialRecord:
        """Store a token under a name. `replace` is `--replace`: the token is exchanged
        and what was held against the old one (refused, rate limited) is forgotten; the models stay
        unless new ones are given."""
        check_name(name)
        token = check_token(secret)
        chosen = check_models(models) if models is not None else None
        with self._locked():
            records = self._read_index() if os.path.lexists(self._directory / INDEX_NAME) else []
            existing = next((record for record in records if record.name == name), None)
            if existing is not None and not replace:
                raise CredentialError(
                    f"a credential named {name} exists: use --replace to exchange its token"
                )
            storage, blob = self._seal_new(name, token)
            self._write_secret(name, blob)
            record = CredentialRecord(
                name=name,
                created=self._clock(),
                models=chosen
                if chosen is not None
                else (existing.models if existing is not None else DEFAULT_MODELS),
                storage=storage,
            )
            if existing is None:
                self._write_index([*records, record])
            else:
                self._write_index([record if other.name == name else other for other in records])
            return record

    def remove(self, name: str) -> None:
        with self._locked():
            records = self._read_index() if os.path.lexists(self._directory / INDEX_NAME) else []
            record = self._find(records, name)
            self._write_index([other for other in records if other.name != record.name])
            with contextlib.suppress(FileNotFoundError):
                (self._directory / f"{record.name}.secret").unlink()

    def mark_refused(self, name: str) -> None:
        """The token was refused (a 401): it stays out until it is replaced."""
        self._update(name, lambda record: with_changes(record, refused=True))

    def set_limited(self, name: str, until: float) -> None:
        """The subscription's usage limit holds the credential back until `until`; 0 lets it go."""
        self._update(name, lambda record: with_changes(record, limited_until=until))

    def drop_model(self, name: str, model: str) -> None:
        """The subscription does not allow `model`: it is taken off the credential's list."""
        self._update(
            name,
            lambda record: with_changes(
                record, models=tuple(known for known in record.models if known != model)
            ),
        )

    # -- internals -------------------------------------------------------------------------------

    def _update(self, name: str, change: Callable[[CredentialRecord], CredentialRecord]) -> None:
        with self._locked():
            records = self._read_index() if os.path.lexists(self._directory / INDEX_NAME) else []
            record = self._find(records, name)
            self._write_index([change(r) if r.name == record.name else r for r in records])

    @staticmethod
    def _find(records: Sequence[CredentialRecord], name: str) -> CredentialRecord:
        for record in records:
            if record.name == name:
                return record
        raise CredentialError(f"there is no credential named {name}")

    def _seal_new(self, name: str, token: str) -> tuple[str, bytes]:
        """How a new token is stored, by the operator's choice, and the bytes of its file."""
        if self._choice not in STORAGE_CHOICES:
            raise CredentialError(
                f"{STORAGE_VARIABLE} is {' or '.join(STORAGE_CHOICES)}, not anything else"
            )
        if self._choice != STORAGE_PLAIN:
            if self._systemd.available():
                try:
                    return STORAGE_SYSTEMD, self._systemd.seal(name, token)
                except CredentialError:
                    # A key that worked a moment ago and does not now: `auto` keeps the token in a
                    # plain file rather than lose it, `systemd-creds` insists.
                    if self._choice == STORAGE_SYSTEMD:
                        raise
            elif self._choice == STORAGE_SYSTEMD:
                raise CredentialError(
                    "systemd-creds is not available for this user (it needs systemd 256 or "
                    f"later), and {STORAGE_VARIABLE} forbids a plain file"
                )
        return STORAGE_PLAIN, self._plain.seal(name, token)

    def _directory_exists(self) -> None:
        self._home.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._directory.mkdir(mode=0o700, exist_ok=True)

    def _check_directory(self) -> None:
        try:
            info = os.lstat(self._directory)
        except OSError:
            raise CredentialError("the credentials directory cannot be read") from None
        if stat.S_ISLNK(info.st_mode):
            raise CredentialError("the credentials directory is a link")
        _owned_private(info, "the credentials directory", directory=True)

    @contextlib.contextmanager
    def _locked(self) -> Generator[None]:
        self._directory_exists()
        self._check_directory()
        descriptor = os.open(self._directory / LOCK_NAME, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    def _read_index(self) -> list[CredentialRecord]:
        path = self._directory / INDEX_NAME
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return []
        except OSError:
            raise CredentialError("the credentials index cannot be opened") from None
        try:
            _owned_private(os.fstat(descriptor), "the credentials index", directory=False)
            raw = os.read(descriptor, _SECRET_FILE_BYTES)
        finally:
            os.close(descriptor)
        try:
            document = json.loads(raw)
            if document["version"] != INDEX_VERSION:
                raise ValueError("version")
            return [_record_of(item) for item in document["credentials"]]
        except (ValueError, KeyError, TypeError):
            raise CredentialError("the credentials index is not one this version wrote") from None

    def _write_index(self, records: Sequence[CredentialRecord]) -> None:
        document = {
            "version": INDEX_VERSION,
            "credentials": [
                {
                    "name": record.name,
                    "created": record.created,
                    "models": list(record.models),
                    "storage": record.storage,
                    "limitedUntil": record.limited_until,
                    "refused": record.refused,
                }
                for record in records
            ],
        }
        self._replace_file(INDEX_NAME, json.dumps(document, indent=2).encode("utf-8") + b"\n")

    def _write_secret(self, name: str, blob: bytes) -> None:
        self._replace_file(f"{name}.secret", blob if blob.endswith(b"\n") else blob + b"\n")

    def _replace_file(self, name: str, content: bytes) -> None:
        """A file replaced whole: written beside it with mode 0600 and moved over it."""
        descriptor, temporary = tempfile.mkstemp(dir=self._directory, prefix=".new-")
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self._directory / name)
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary)
            raise


def _record_of(item: Mapping[str, object]) -> CredentialRecord:
    name, created = item["name"], item["created"]
    models, storage = item["models"], item["storage"]
    limited, refused = item["limitedUntil"], item["refused"]
    if (
        not isinstance(name, str)
        or not NAME_PATTERN.fullmatch(name)
        or not isinstance(created, (int, float))
        or not isinstance(models, list)
        or not all(isinstance(model, str) for model in models)  # pyright: ignore[reportUnknownVariableType]
        or storage not in (STORAGE_PLAIN, STORAGE_SYSTEMD)
        or not isinstance(limited, (int, float))
        or not isinstance(refused, bool)
    ):
        raise ValueError("record")
    return CredentialRecord(
        name=name,
        created=float(created),
        models=tuple(models),  # pyright: ignore[reportUnknownArgumentType]
        storage=str(storage),
        limited_until=float(limited),
        refused=refused,
    )


def store_for(environment: Mapping[str, str], home: Path) -> CredentialStore:
    """The store of this device: its home, and the storage the operator chose."""
    choice = environment.get(STORAGE_VARIABLE, "").strip() or STORAGE_AUTO
    return CredentialStore(home, choice=choice)


def store_login(home: Path) -> "ClaudeLogin | LoginProblem | None":
    """The login of the first usable credential in the store at `home`, `None` when the store has
    none, a `LoginProblem` when it has credentials and none can be used. The credentials of a store
    are read only here and by the dispatcher's own pool: a job process has no home to look in."""
    from .login import ClaudeLogin, LoginProblem  # a cycle otherwise: login.py reads the store

    store = CredentialStore(home)
    try:
        records = store.records()
    except CredentialError as error:
        return LoginProblem(str(error))
    if not records:
        return None
    reasons: list[str] = []
    for record in records:
        try:
            return ClaudeLogin.oauth_token(store.secret(record.name))
        except CredentialError as error:
            reasons.append(f"{record.name}: {error}")
    return LoginProblem("no credential of this device can be used (" + "; ".join(reasons) + ")")
