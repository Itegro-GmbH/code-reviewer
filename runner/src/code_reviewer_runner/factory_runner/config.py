# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a Factory-Runner is configured with (#854, R1b): a file on the machine and the environment.

The configuration lives in the runner, not in the app (decision 8 of the plan): the labels, the
limits and the credential are the machine's own. `factory-runner register` writes the file (mode
0600, in a directory of mode 0700); every value can also come from the environment, which is how a
VM that runs one job and ends gets its credential (`FACTORY_RUNNER_CREDENTIAL`, no file at all).
The environment wins over the file.

| Variable                      | Meaning                                                          |
|-------------------------------|------------------------------------------------------------------|
| `FACTORY_RUNNER_HOME`         | The directory of the file (default `~/.factory-runner`)          |
| `FACTORY_RUNNER_URL`          | The app, `https://...`                                           |
| `FACTORY_RUNNER_CREDENTIAL`   | The runner's credential (`crc_...`), a secret                    |
| `FACTORY_RUNNER_NAME`         | The name in the list of runners                                  |
| `FACTORY_RUNNER_LABELS`       | Labels, comma separated                                          |
| `FACTORY_RUNNER_CPUS`         | CPUs the agent's container may use                               |
| `FACTORY_RUNNER_MEMORY_MB`    | Memory of the agent's container                                  |
| `FACTORY_RUNNER_DISK_GB`      | Disk the runner may use (announced; see `limits.py`)             |
| `FACTORY_RUNNER_AGENT_IMAGE`  | The agent image to pull (default: the one baked into the image)  |
| `FACTORY_RUNNER_RUNTIME`      | `auto`, `runc` or `sysbox-runc` (default `auto`)                 |
| `FACTORY_RUNNER_AUTO_UPDATE`  | `1` (default) or `0`: update between jobs (`update.py`)          |
| `FACTORY_RUNNER_ALLOW_HTTP`   | `1`: accept an `http://` app address (tests and development)     |

A refusal names the variable or the field and never its value: the configuration holds a secret.
"""

import contextlib
import errno
import hashlib
import json
import os
import re
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path
from urllib.parse import urlsplit

from code_reviewer_runner.job_loop.jsonvalues import as_object

CONFIG_VERSION = 1
CONFIG_FILE_NAME = "config.json"
HOME_VARIABLE = "FACTORY_RUNNER_HOME"
DEFAULT_HOME = "~/.factory-runner"
# The same patterns as `contracts/runner-registration.v1.json`.
LABEL_PATTERN = re.compile(r"[a-z0-9][a-z0-9._:-]{0,39}")
MAX_LABELS = 20
CREDENTIAL_PATTERN = re.compile(r"crc_[A-Za-z0-9_-]{43}")
TOKEN_PATTERN = re.compile(r"crt_[A-Za-z0-9_-]{43}")
MAX_NAME_CHARS = 80
RUNTIME_CHOICES = ("auto", "runc", "sysbox-runc")
# The numeric bound of the contract's `RunnerLimits`.
MAX_LIMIT = 1_000_000
# The runner takes one job at a time: the containers of a turn have fixed names and the model
# network a fixed address (`implementer/agent_container.py`), so a second run on the same daemon
# would collide. More runs beside each other are R2.
MAX_PARALLEL_RUNS = 1
# With the Firecracker sandbox (#978) a job has a VM of its own and the number of jobs at once is
# the number of slots (a TAP device each, made at install); `FACTORY_RUNNER_SANDBOX` chooses it.
SANDBOX_VARIABLE = "FACTORY_RUNNER_SANDBOX"
SANDBOX_FIRECRACKER = "firecracker"
MAX_FIRECRACKER_PARALLEL_RUNS = 64
# The one local backend (#1007, Runner v2): two Incus instances per job, a pair of bridges per slot.
# `firecracker` stays selectable until its code is retired (#1012).
SANDBOX_INCUS = "incus"
MAX_INCUS_PARALLEL_RUNS = 32


# Where the credential of a loaded configuration came from. Only a credential of the file is the
# runner's to renew; one from the environment belongs to whoever set it (a VM that runs one job).
CREDENTIAL_FROM_FILE = "file"
CREDENTIAL_FROM_ENVIRONMENT = "environment"


class ConfigError(Exception):
    """A value is missing or unusable. The message names it, never its value."""


@dataclass(frozen=True)
class Limits:
    """What the runner works within. `None`: no limit set (the agent gets what the machine has,
    bounded by the memory rule of `limits.py`)."""

    cpus: int | None = None
    memory_mb: int | None = None
    disk_gb: int | None = None
    parallel_runs: int = MAX_PARALLEL_RUNS


@dataclass(frozen=True)
class RunnerConfig:
    url: str
    name: str = "factory-runner"
    labels: tuple[str, ...] = ()
    credential: str | None = field(default=None, repr=False)
    runner_id: str | None = None
    limits: Limits = field(default_factory=Limits)
    agent_image: str | None = None
    runtime: str = "auto"
    # Whether the service updates itself between jobs (`update.py`); `factory-runner update` works
    # either way.
    auto_update: bool = True
    # When the credential was last renewed (seconds since the epoch); 0: never recorded.
    credential_renewed_at: float = 0.0
    # `CREDENTIAL_FROM_FILE` or `CREDENTIAL_FROM_ENVIRONMENT`; not part of what a configuration is
    # (so two configurations with the same values are equal), only of where it was read from.
    credential_source: str = field(default=CREDENTIAL_FROM_ENVIRONMENT, compare=False)


def runner_identity(config: RunnerConfig) -> str:
    """What the containers of this runner are labelled with: the id the app gave it, else (a
    credential from the environment, no file) a short digest of the credential, which names the
    runner for as long as it keeps that credential and says nothing about it. Empty without both."""
    if config.runner_id:
        return config.runner_id
    if config.credential:
        return "credential-" + hashlib.sha256(config.credential.encode()).hexdigest()[:16]
    return ""


def home_directory(environment: Mapping[str, str]) -> Path:
    raw = environment.get(HOME_VARIABLE, "").strip() or DEFAULT_HOME
    return Path(raw).expanduser()


def config_path(environment: Mapping[str, str]) -> Path:
    return home_directory(environment) / CONFIG_FILE_NAME


# -- checks ----------------------------------------------------------------------------------------


def check_url(raw: object, *, allow_http: bool = False) -> str:
    """The app's address: `https://host[:port][/prefix]`, no credentials, query or fragment. Plain
    `http` only for the loopback (or with the explicit switch): the credential travels in it."""
    if not isinstance(raw, str) or not raw.strip():
        raise ConfigError("the app address (url) is missing")
    try:
        parts = urlsplit(raw.strip())
        _ = parts.port
    except ValueError:
        raise ConfigError("the app address (url) is not a valid URL") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ConfigError("the app address (url) must be an http or https URL")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ConfigError("the app address (url) must not hold credentials, a query or a fragment")
    loopback = parts.hostname in ("localhost", "127.0.0.1", "::1")
    if parts.scheme == "http" and not (loopback or allow_http):
        raise ConfigError("the app address (url) must be https")
    return raw.strip().rstrip("/")


def check_name(raw: object) -> str:
    if not isinstance(raw, str) or not 1 <= len(raw.strip()) <= MAX_NAME_CHARS:
        raise ConfigError(f"the name must be 1 to {MAX_NAME_CHARS} characters")
    name = raw.strip()
    if any(not char.isprintable() for char in name):
        raise ConfigError("the name must be one line of printable characters")
    return name


def check_labels(raw: object) -> tuple[str, ...]:
    """Lower-cased, unique, in the order given."""
    if isinstance(raw, str):
        items: list[object] = [part for part in raw.split(",") if part.strip()]
    elif isinstance(raw, (list, tuple)):
        items = list(raw)  # pyright: ignore[reportUnknownArgumentType]
    else:
        raise ConfigError("the labels must be a list")
    labels: list[str] = []
    for item in items:
        label = item.strip().lower() if isinstance(item, str) else ""
        if not LABEL_PATTERN.fullmatch(label):
            raise ConfigError("a label does not fit [a-z0-9][a-z0-9._:-]{0,39}")
        if label not in labels:
            labels.append(label)
    if len(labels) > MAX_LABELS:
        raise ConfigError(f"at most {MAX_LABELS} labels")
    return tuple(labels)


def _limit(name: str, raw: object) -> int | None:
    if raw is None or raw == "":
        return None
    if isinstance(raw, bool):
        raise ConfigError(f"{name} must be a whole number")
    try:
        value = int(raw) if isinstance(raw, (int, str)) else None
    except ValueError:
        value = None
    if value is None or not 1 <= value <= MAX_LIMIT:
        raise ConfigError(f"{name} must be a whole number from 1 to {MAX_LIMIT}")
    return value


def _max_parallel_runs(sandbox: str) -> int:
    """The most jobs at once the sandbox allows: one per slot (a TAP device, or two bridges)."""
    if sandbox == SANDBOX_INCUS:
        return MAX_INCUS_PARALLEL_RUNS
    if sandbox == SANDBOX_FIRECRACKER:
        return MAX_FIRECRACKER_PARALLEL_RUNS
    return MAX_PARALLEL_RUNS


def check_limits(raw: Mapping[str, object], *, max_parallel: int = MAX_PARALLEL_RUNS) -> Limits:
    parallel = _limit("parallelRuns", raw.get("parallelRuns")) or MAX_PARALLEL_RUNS
    if parallel > max_parallel:
        raise ConfigError(
            "parallelRuns: this runner takes one job at a time "
            f"(the Incus sandbox, {SANDBOX_VARIABLE}={SANDBOX_INCUS}, takes more)"
            if max_parallel == MAX_PARALLEL_RUNS
            else f"parallelRuns: at most {max_parallel} jobs at a time"
        )
    return Limits(
        cpus=_limit("cpus", raw.get("cpus")),
        memory_mb=_limit("memoryMb", raw.get("memoryMb")),
        disk_gb=_limit("diskGb", raw.get("diskGb")),
        parallel_runs=parallel,
    )


def check_credential(raw: object) -> str:
    if not isinstance(raw, str) or not CREDENTIAL_PATTERN.fullmatch(raw.strip()):
        raise ConfigError("the credential does not have the form of a runner credential")
    return raw.strip()


def check_token(raw: object) -> str:
    if not isinstance(raw, str) or not TOKEN_PATTERN.fullmatch(raw.strip()):
        raise ConfigError("the registration token does not have the form of a token")
    return raw.strip()


def check_runtime(raw: object) -> str:
    if raw not in RUNTIME_CHOICES:
        raise ConfigError(f"runtime must be one of: {', '.join(RUNTIME_CHOICES)}")
    return str(raw)


_FLAG_WORDS = {
    "1": True,
    "true": True,
    "on": True,
    "yes": True,
    "0": False,
    "false": False,
    "off": False,
    "no": False,
}


def check_flag(name: str, raw: object, *, default: bool = True) -> bool:
    """A switch: a boolean, or one of on/off, yes/no, true/false, 1/0. Absent: `default`."""
    if raw is None or raw == "":
        return default
    if isinstance(raw, bool):
        return raw
    value = _FLAG_WORDS.get(raw.strip().lower()) if isinstance(raw, str) else None
    if value is None:
        raise ConfigError(f"{name} must be on or off")
    return value


# -- file and environment -------------------------------------------------------------------------


def _read_file(path: Path) -> dict[str, object]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError:
        raise ConfigError("the configuration file cannot be read") from None
    try:
        document = json.loads(text)
    except ValueError:
        raise ConfigError("the configuration file is not JSON") from None
    stored = as_object(document)
    if stored is None:
        raise ConfigError("the configuration file must be an object")
    return stored


def _text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def load_config(environment: Mapping[str, str], *, require_url: bool = True) -> RunnerConfig:
    """The configuration: the file (if there is one) with the environment over it. Raises
    `ConfigError` for a value that is wrong and, with `require_url`, for a missing app address."""
    stored = _read_file(config_path(environment))
    allow_http = environment.get("FACTORY_RUNNER_ALLOW_HTTP", "").strip() == "1"

    def pick(variable: str, key: str) -> object:
        fresh = environment.get(variable, "").strip()
        return fresh if fresh else stored.get(key)

    stored_limits = stored.get("limits")
    limits_raw: dict[str, object] = dict(as_object(stored_limits) or {})
    for variable, key in (
        ("FACTORY_RUNNER_CPUS", "cpus"),
        ("FACTORY_RUNNER_MEMORY_MB", "memoryMb"),
        ("FACTORY_RUNNER_DISK_GB", "diskGb"),
        ("FACTORY_RUNNER_PARALLEL_RUNS", "parallelRuns"),
    ):
        fresh = environment.get(variable, "").strip()
        if fresh:
            limits_raw[key] = fresh
    credential = pick("FACTORY_RUNNER_CREDENTIAL", "credential")
    from_environment = bool(environment.get("FACTORY_RUNNER_CREDENTIAL", "").strip())
    renewed = stored.get("credentialRenewedAt")
    image = pick("FACTORY_RUNNER_AGENT_IMAGE", "agentImage")
    labels = pick("FACTORY_RUNNER_LABELS", "labels")
    address = pick("FACTORY_RUNNER_URL", "url")
    runner_id = _text(stored.get("runnerId"))
    if credential not in (None, "") and not from_environment and runner_id is None:
        # The id names the runner's containers for as long as it lives. Without it the name would
        # be a digest of the credential, which every renewal changes: the containers of the
        # earlier credential would look like another runner's.
        raise ConfigError(
            "the configuration file has a credential but no runnerId: register again "
            "(factory-runner register --force), or add the runnerId of this runner to the file"
        )
    return RunnerConfig(
        url=check_url(address, allow_http=allow_http) if require_url or address else "",
        name=check_name(pick("FACTORY_RUNNER_NAME", "name") or RunnerConfig.name),
        labels=check_labels(labels if labels is not None else []),
        credential=None if credential in (None, "") else check_credential(credential),
        runner_id=runner_id,
        limits=check_limits(
            limits_raw,
            max_parallel=_max_parallel_runs(environment.get(SANDBOX_VARIABLE, "").strip()),
        ),
        agent_image=None if image in (None, "") else check_image(image),
        runtime=check_runtime(pick("FACTORY_RUNNER_RUNTIME", "runtime") or "auto"),
        auto_update=check_flag("autoUpdate", pick("FACTORY_RUNNER_AUTO_UPDATE", "autoUpdate")),
        credential_renewed_at=float(renewed) if isinstance(renewed, (int, float)) else 0.0,
        credential_source=CREDENTIAL_FROM_ENVIRONMENT if from_environment else CREDENTIAL_FROM_FILE,
    )


_IMAGE_PATTERN = re.compile(
    r"[a-z0-9][a-z0-9._/-]{0,200}(:[A-Za-z0-9._-]{1,128})?(@sha256:[0-9a-f]{64})?"
)


def check_image(raw: object) -> str:
    if not isinstance(raw, str) or not _IMAGE_PATTERN.fullmatch(raw.strip()):
        raise ConfigError("the agent image is not an image reference")
    return raw.strip()


def to_document(config: RunnerConfig) -> dict[str, object]:
    """What is written to the file."""
    document: dict[str, object] = {
        "version": CONFIG_VERSION,
        "url": config.url,
        "name": config.name,
        "labels": list(config.labels),
        "limits": limits_document(config.limits),
        "runtime": config.runtime,
        "autoUpdate": config.auto_update,
    }
    if config.credential is not None:
        document["credential"] = config.credential
        document["credentialRenewedAt"] = config.credential_renewed_at
    if config.runner_id is not None:
        document["runnerId"] = config.runner_id
    if config.agent_image is not None:
        document["agentImage"] = config.agent_image
    return document


def limits_document(limits: Limits) -> dict[str, int]:
    """The limits as the contract's `RunnerLimits` and the file name them."""
    values = {
        "cpus": limits.cpus,
        "memoryMb": limits.memory_mb,
        "diskGb": limits.disk_gb,
        "parallelRuns": limits.parallel_runs,
    }
    return {key: value for key, value in values.items() if value is not None}


def save_config(config: RunnerConfig, environment: Mapping[str, str]) -> Path:
    """Write the file with exactly the configuration given: the directory 0700, the file 0600 from
    its first byte (a temporary file in the same directory, then a rename, so a crash never leaves
    half a credential). Only `register` calls it, with a configuration made from its arguments; a
    configuration that `load_config` returned has the environment over the file and must never be
    written back (`update_credential` is the write of the loop)."""
    return _write_document(config_path(environment), to_document(config))


def update_credential(
    environment: Mapping[str, str],
    *,
    runner_id: str | None,
    renewed_at: float,
    credential: str | None = None,
) -> Path:
    """Change the credential's time (and, with `credential`, the credential itself) in the file as
    it is on disk; every other value, the address, name, labels and limits above all, stays as the
    file has it and is never taken from the environment. `ConfigError` when there is no file, or
    when the file belongs to another runner than `runner_id` (it was registered again meanwhile):
    a credential of this runner is never written over that one's."""
    path = config_path(environment)
    document = _read_file(path)
    if not document:
        raise ConfigError("the configuration file is gone")
    if _text(document.get("runnerId")) != runner_id:
        raise ConfigError("the configuration file belongs to another runner")
    if credential is not None:
        document["credential"] = credential
    document["credentialRenewedAt"] = renewed_at
    return _write_document(path, document)


SETTING_KEYS = ("name", "labels", "runtime", "agentImage", "autoUpdate")
LIMIT_KEYS = ("cpus", "memoryMb", "diskGb", "parallelRuns")


def edit_config(environment: Mapping[str, str], changes: Mapping[str, object]) -> Path:
    """`factory-runner config set`: change settings in the file as it is on disk. A key of
    `SETTING_KEYS` or `LIMIT_KEYS` with a value sets it, with `None` removes it (a limit then has
    none, `agentImage` is the one baked into the image, `labels` has none to remove: pass an
    empty list). Every value goes through the check of `register`; nothing is written when one is
    wrong. The credential, the runner id and everything not named stay as they are, and the
    environment is never written into the file. `ConfigError` when there is no file."""
    path = config_path(environment)
    document = _read_file(path)
    if not document:
        raise ConfigError("there is no configuration file: register this machine first")
    limits: dict[str, object] = dict(as_object(document.get("limits")) or {})
    for key, value in changes.items():
        if key in LIMIT_KEYS:
            if value is None:
                limits.pop(key, None)
            else:
                limits[key] = value
        elif key == "name":
            document[key] = check_name(value)
        elif key == "labels":
            document[key] = list(check_labels(value))
        elif key == "runtime":
            document[key] = check_runtime(value)
        elif key == "agentImage":
            if value is None:
                document.pop(key, None)
            else:
                document[key] = check_image(value)
        elif key == "autoUpdate":
            document[key] = check_flag("autoUpdate", value)
        else:
            raise ConfigError(f"{key} is not a setting of the runner")
    document["limits"] = limits_document(check_limits(limits))
    return _write_document(path, document)


def _write_document(path: Path, document: Mapping[str, object]) -> Path:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".config-", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _sync_directory(path.parent)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise
    return path


def _sync_directory(directory: Path) -> None:
    """Make the rename durable: a crash after it must not bring the old file back (the app has
    already put the new credential in place of the old one's successor)."""
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    except OSError as error:
        # A file system that cannot sync a directory has nothing to say about the rename.
        if error.errno not in (errno.EINVAL, errno.ENOTSUP):
            raise
    finally:
        os.close(descriptor)


def redacted(config: RunnerConfig) -> dict[str, object]:
    """`config show`: everything but the secret. The credential is only said to be there."""
    document = to_document(config)
    document.pop("credential", None)
    document["credential"] = "set" if config.credential is not None else "not set"
    return document


def with_credential(config: RunnerConfig, credential: str, now: float) -> RunnerConfig:
    return replace(config, credential=credential, credential_renewed_at=now)
