# SPDX-License-Identifier: LicenseRef-Proprietary

"""The commands of `factory-runner` that manage an installed runner (#855, R2): `config set`,
and `credential`. They run on the device, as the other commands do: a runner is configured and
its credential renewed there, never from the app (plan decision 8). `update`, `rollback`,
`status` and `uninstall` are the root script's (`runner/install/install.sh`, #982), reached
through the command the installer writes.
"""

import argparse
import getpass
import json
import time
from collections.abc import Callable, Mapping
from typing import Any, TextIO

from code_reviewer_runner.factory_runner.app_client import (
    ApiError,
    AppClient,
    Revoked,
    UpdateNeeded,
)
from code_reviewer_runner.factory_runner.base import (
    EXIT_CONFIG,
    EXIT_FAILED,
    EXIT_OK,
    EXIT_REVOKED,
    EXIT_UPDATE_NEEDED,
    EXIT_USAGE,
)
from code_reviewer_runner.factory_runner.config import (
    CREDENTIAL_FROM_FILE,
    ConfigError,
    config_path,
    edit_config,
    home_directory,
    load_config,
    redacted,
    update_credential,
)
from code_reviewer_runner.implementer.claude_code.credentials import (
    DEFAULT_MODELS,
    STATE_LIMITED,
    STATE_REFUSED,
    STORAGE_SYSTEMD,
    CredentialError,
    store_for,
)

PROGRAM = "factory-runner"
# What a limit is set to in order to remove it.
UNSET_WORDS = ("none", "unset", "default")
# The options of `config set`, by the key of the configuration they change.
SETTING_OPTIONS = (
    ("name", "--name", "the name in the list of runners"),
    ("labels", "--labels", "comma separated labels (replaces all; '' removes them all)"),
    ("cpus", "--cpus", "CPUs the agent's container may use, or none"),
    ("memoryMb", "--memory-mb", "memory of the agent's container, or none"),
    ("diskGb", "--disk-gb", "the disk budget of a job in GB (/work and its containers), or none"),
    ("parallelRuns", "--parallel", "jobs at a time (this runner takes one)"),
    ("autoUpdate", "--auto-update", "on or off: the scheduled look for a signed release"),
)
# Options of the Docker-based runner that did nothing once every job ran in a Firecracker VM, whose
# container runtime and agent image are part of the signed VM artifacts: refused with this message
# instead of being accepted and ignored.
REMOVED_OPTIONS = {"--runtime": "runtime", "--agent-image": "agent_image"}
REMOVED_MESSAGE = (
    "{option} is not a setting any more: every job runs in a Firecracker VM, and its container "
    'runtime and agent image are part of the signed VM artifacts (docs/runner.md, "Install")'
)


def refuse_removed_options(arguments: argparse.Namespace, err: TextIO) -> bool:
    """Whether a removed option was given (and said so)."""
    for option, name in REMOVED_OPTIONS.items():
        if getattr(arguments, name, None) is not None:
            err.write(f"{PROGRAM}: {REMOVED_MESSAGE.format(option=option)}\n")
            return True
    return False


# What the environment of a VM can override, and so what `config set` may change without effect.
OVERRIDING_VARIABLES = {
    "name": "FACTORY_RUNNER_NAME",
    "labels": "FACTORY_RUNNER_LABELS",
    "cpus": "FACTORY_RUNNER_CPUS",
    "memoryMb": "FACTORY_RUNNER_MEMORY_MB",
    "diskGb": "FACTORY_RUNNER_DISK_GB",
    "autoUpdate": "FACTORY_RUNNER_AUTO_UPDATE",
}
DAY_SECONDS = 86400.0


def add_parsers(commands: "argparse._SubParsersAction[Any]") -> None:  # pyright: ignore[reportPrivateUsage]
    config = commands.add_parser("config", help="show or change the configuration")
    actions = config.add_subparsers(dest="action", required=True, parser_class=type(config))
    actions.add_parser("show", help="the configuration, the credential only as set / not set")
    change = actions.add_parser("set", help="change settings in the configuration file")
    for _key, option, help_text in SETTING_OPTIONS:
        change.add_argument(option, help=help_text)
    for option, name in REMOVED_OPTIONS.items():
        change.add_argument(option, dest=name, help=argparse.SUPPRESS)

    credential = commands.add_parser(
        "credential", help="the runner's credential, and the Claude Code credentials of this device"
    )
    steps = credential.add_subparsers(dest="action", required=True, parser_class=type(credential))
    steps.add_parser(
        "show", help="the runner's own credential: whether there is one, and how old it is"
    )
    steps.add_parser("renew", help="ask the app for a new runner credential and save it")
    add = steps.add_parser(
        "add",
        help="add a Claude Code token (made with `claude setup-token`) to this device; the token "
        "is read from the standard input, never from an argument",
    )
    add.add_argument("kind", choices=("claude",), help="what kind of credential")
    add.add_argument("--name", required=True, help="a name for it, visible only on this device")
    add.add_argument(
        "--models",
        help="the models its subscription allows, comma separated (default: sonnet,opus,haiku)",
    )
    add.add_argument(
        "--replace", action="store_true", help="exchange the token of a name that exists"
    )
    steps.add_parser(
        "list", help="the Claude Code credentials: name, created, models, state (never the value)"
    )
    remove = steps.add_parser("remove", help="remove a Claude Code credential")
    remove.add_argument("name")
    retry = steps.add_parser(
        "retry",
        help="let go of everything held against a Claude Code credential (rate limited, refused, "
        "models set aside) and use it again now; the models you gave are never changed",
    )
    retry.add_argument("name")


# -- config -------------------------------------------------------------------------------------


def config_show(env: Mapping[str, str], out: TextIO) -> int:
    config = load_config(env, require_url=False)
    document = redacted(config)
    document["configFile"] = str(config_path(env))
    json.dump(document, out, indent=2, sort_keys=True)
    out.write("\n")
    return EXIT_OK


def config_set(
    arguments: argparse.Namespace, env: Mapping[str, str], out: TextIO, err: TextIO
) -> int:
    if refuse_removed_options(arguments, err):
        return EXIT_USAGE
    changes: dict[str, object] = {}
    for key, option, _help in SETTING_OPTIONS:
        raw = getattr(arguments, option.lstrip("-").replace("-", "_"))
        if raw is None:
            continue
        removable = key not in ("name", "labels", "autoUpdate", "parallelRuns")
        changes[key] = None if removable and raw.strip().lower() in UNSET_WORDS else raw
    if not changes:
        err.write(f"{PROGRAM}: config set needs at least one setting (see --help)\n")
        return EXIT_USAGE
    path = edit_config(env, changes)
    out.write(f"saved in {path}: {', '.join(sorted(changes))}\n")
    shadowed = sorted(
        key for key in changes if env.get(OVERRIDING_VARIABLES.get(key, ""), "").strip()
    )
    for key in shadowed:
        err.write(
            f"{PROGRAM}: note: {OVERRIDING_VARIABLES[key]} is set in the environment and wins "
            f"over the file for {key}\n"
        )
    out.write("a running service reads the configuration when it starts: after its current job,\n")
    out.write("restart it (sudo systemctl restart factory-runner)\n")
    return EXIT_OK


# -- credential ---------------------------------------------------------------------------------


def credential_show(env: Mapping[str, str], out: TextIO, now: Callable[[], float]) -> int:
    config = load_config(env, require_url=False)
    if config.credential is None:
        out.write("credential: not set\n")
        return EXIT_OK
    out.write(f"credential: set (from the {config.credential_source})\n")
    if config.credential_source == CREDENTIAL_FROM_FILE and config.credential_renewed_at > 0:
        days = int((now() - config.credential_renewed_at) // DAY_SECONDS)
        out.write(f"renewed: {days} days ago (the service renews it after 7 days)\n")
    return EXIT_OK


def credential_renew(
    env: Mapping[str, str],
    out: TextIO,
    err: TextIO,
    *,
    client: Callable[[str, str | None], AppClient],
    now: Callable[[], float],
) -> int:
    config = load_config(env)
    if config.credential is None:
        err.write(f"{PROGRAM}: this machine is not registered\n")
        return EXIT_CONFIG
    if config.credential_source != CREDENTIAL_FROM_FILE:
        err.write(
            f"{PROGRAM}: the credential comes from the environment, which is not this "
            "command's to change\n"
        )
        return EXIT_CONFIG
    try:
        fresh = client(config.url, config.credential).renew()
    except Revoked:
        err.write(f"{PROGRAM}: the app does not know this runner any more (revoked)\n")
        return EXIT_REVOKED
    except UpdateNeeded:
        err.write(f"{PROGRAM}: the app requires a newer runner (sudo factory-runner update)\n")
        return EXIT_UPDATE_NEEDED
    except ApiError as error:
        err.write(f"{PROGRAM}: the app could not be reached ({error})\n")
        return EXIT_FAILED
    try:
        # Written before anything uses it; the app keeps the old one valid until the new one has
        # been used once, so a failed write loses nothing.
        update_credential(env, runner_id=config.runner_id, renewed_at=now(), credential=fresh)
    except (OSError, ConfigError):
        err.write(
            f"{PROGRAM}: the new credential could not be saved: the old one stays in use "
            "(try again)\n"
        )
        return EXIT_FAILED
    out.write("credential renewed; the running service uses it from its next start\n")
    return EXIT_OK


# -- the Claude Code credentials of this device (#980) -------------------------------------------

# What a pasted token may be at most: one line of a token, with room for the line's end.
MAX_PASTED_BYTES = 8 * 1024
DEFAULT_MODELS_TEXT = ", ".join(DEFAULT_MODELS)


def _read_token(stdin: TextIO) -> str:
    """The token from the standard input: a person at a terminal is asked without an echo, a pipe
    or a file is read whole (up to `MAX_PASTED_BYTES`). Never from an argument."""
    if stdin.isatty():
        return getpass.getpass("Claude Code token (input is hidden): ")
    return stdin.read(MAX_PASTED_BYTES + 1)


def _how_stored(storage: str) -> str:
    if storage == STORAGE_SYSTEMD:
        return "sealed with systemd-creds"
    return "kept as a plain file that only its owner can read (mode 0600)"


def credential_add(
    arguments: argparse.Namespace,
    env: Mapping[str, str],
    out: TextIO,
    err: TextIO,
    stdin: TextIO,
) -> int:
    store = store_for(env, home_directory(env))
    models = (
        [model.strip() for model in str(arguments.models).split(",") if model.strip()]
        if arguments.models is not None
        else None
    )
    try:
        existed = any(record.name == arguments.name for record in store.records())
        record = store.add(
            arguments.name, _read_token(stdin), models=models, replace=arguments.replace
        )
    except CredentialError as error:
        err.write(f"{PROGRAM}: credential: {error}\n")
        return EXIT_FAILED
    verb = "replaced" if existed else "added"
    out.write(
        f"{verb} credential {record.name} (models: {', '.join(record.models)}); "
        f"the token is {_how_stored(record.storage)}\n"
    )
    out.write(
        "a running service reads its credentials before each claim: no restart is needed, even "
        "when it started before the first credential; it offers Claude Code to the app (the "
        "layer with Claude Code is built when the service starts) as soon as one can be used\n"
    )
    return EXIT_OK


def credential_list(env: Mapping[str, str], out: TextIO, now: Callable[[], float]) -> int:
    try:
        records = store_for(env, home_directory(env)).records()
    except CredentialError as error:
        out.write(f"credentials: {error}\n")
        return EXIT_FAILED
    if not records:
        out.write(
            "no Claude Code credential in the store of this device "
            f"(factory-runner credential add claude --name NAME; models default to "
            f"{DEFAULT_MODELS_TEXT})\n"
        )
        return EXIT_OK
    current = now()
    rows = [("NAME", "CREATED", "MODELS", "STATE", "STORAGE")]
    for record in records:
        state = record.state(current)
        if state == STATE_LIMITED:
            state += " until " + _clock_time(record.limited_until)
        elif state == STATE_REFUSED:
            state += " until " + _clock_time(record.refused_until)
        created = time.strftime("%Y-%m-%d", time.gmtime(record.created))
        rows.append((record.name, created, ",".join(record.models), state, record.storage))
    widths = [max(len(row[column]) for row in rows) for column in range(5)]
    for row in rows:
        out.write(
            "  ".join(cell.ljust(width) for cell, width in zip(row, widths, strict=True)).rstrip()
            + "\n"
        )
    for record in records:
        if record.refused_until > current:
            out.write(
                f"{record.name} was reported as refused by Anthropic (a 401). It is tried again "
                f"after that time: for good, make a new token with `claude setup-token` and run "
                f"`factory-runner credential add claude --name {record.name} --replace`; to try "
                f"it now, `factory-runner credential retry {record.name}`\n"
            )
        for model, until in record.models_aside:
            if until > current:
                out.write(
                    f"{record.name}: model {model} is set aside until {_clock_time(until)} "
                    f"(a job on it was reported refused); `factory-runner credential retry "
                    f"{record.name}` lets it go now\n"
                )
    return EXIT_OK


def _clock_time(moment: float) -> str:
    """`moment` in the device's own time, with its date: hints last hours, and a bare HH:MM would
    not say which day."""
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(moment))


def credential_remove(name: str, env: Mapping[str, str], out: TextIO, err: TextIO) -> int:
    try:
        store_for(env, home_directory(env)).remove(name)
    except CredentialError as error:
        err.write(f"{PROGRAM}: credential: {error}\n")
        return EXIT_FAILED
    out.write(f"removed credential {name}\n")
    return EXIT_OK


def credential_retry(name: str, env: Mapping[str, str], out: TextIO, err: TextIO) -> int:
    try:
        store_for(env, home_directory(env)).clear_hints(name)
    except CredentialError as error:
        err.write(f"{PROGRAM}: credential: {error}\n")
        return EXIT_FAILED
    out.write(f"credential {name} is usable again (nothing is held against it any more)\n")
    return EXIT_OK
