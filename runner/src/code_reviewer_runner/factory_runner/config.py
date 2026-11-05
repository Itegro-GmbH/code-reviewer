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
| `FACTORY_RUNNER_ALLOW_HTTP`   | `1`: accept an `http://` app address (tests and development)     |

A refusal names the variable or the field and never its value: the configuration holds a secret.
"""

import contextlib
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
    # When the credential was last renewed (seconds since the epoch); 0: never recorded.
    credential_renewed_at: float = 0.0


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


def check_limits(raw: Mapping[str, object]) -> Limits:
    parallel = _limit("parallelRuns", raw.get("parallelRuns")) or MAX_PARALLEL_RUNS
    if parallel > MAX_PARALLEL_RUNS:
        raise ConfigError("parallelRuns: this runner takes one job at a time (R2 brings more)")
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
    return value if isinstance(value, str) and value.strip() else None


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
    ):
        fresh = environment.get(variable, "").strip()
        if fresh:
            limits_raw[key] = fresh
    credential = pick("FACTORY_RUNNER_CREDENTIAL", "credential")
    renewed = stored.get("credentialRenewedAt")
    image = pick("FACTORY_RUNNER_AGENT_IMAGE", "agentImage")
    labels = pick("FACTORY_RUNNER_LABELS", "labels")
    address = pick("FACTORY_RUNNER_URL", "url")
    return RunnerConfig(
        url=check_url(address, allow_http=allow_http) if require_url or address else "",
        name=check_name(pick("FACTORY_RUNNER_NAME", "name") or RunnerConfig.name),
        labels=check_labels(labels if labels is not None else []),
        credential=None if credential in (None, "") else check_credential(credential),
        runner_id=_text(stored.get("runnerId")),
        limits=check_limits(limits_raw),
        agent_image=None if image in (None, "") else check_image(image),
        runtime=check_runtime(pick("FACTORY_RUNNER_RUNTIME", "runtime") or "auto"),
        credential_renewed_at=float(renewed) if isinstance(renewed, (int, float)) else 0.0,
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
    """Write the file: the directory 0700, the file 0600 from its first byte (a temporary file in
    the same directory, then a rename, so a crash never leaves half a credential)."""
    path = config_path(environment)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".config-", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(to_document(config), handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise
    return path


def redacted(config: RunnerConfig) -> dict[str, object]:
    """`config show`: everything but the secret. The credential is only said to be there."""
    document = to_document(config)
    document.pop("credential", None)
    document["credential"] = "set" if config.credential is not None else "not set"
    return document


def with_credential(config: RunnerConfig, credential: str, now: float) -> RunnerConfig:
    return replace(config, credential=credential, credential_renewed_at=now)
