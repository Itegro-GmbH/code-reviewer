# SPDX-License-Identifier: LicenseRef-Proprietary

"""The commands of `factory-runner` that manage an installed runner (#855, R2): `config set`,
`credential` and `update`. They run on the device, as the other commands do: a runner is
configured, its credential renewed and its image updated there, never from the app (plan decisions
8 and 9).
"""

import argparse
import json
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
from code_reviewer_runner.factory_runner.update import (
    Fetch,
    Outcome,
    ReleaseChannel,
    UpdateError,
    fetch_https,
    own_image,
    rejected_release,
    release_of,
    rollback,
    stage,
)
from code_reviewer_runner.implementer.docker_api import DockerApi

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
    ("runtime", "--runtime", "auto, runc or sysbox-runc"),
    ("agentImage", "--agent-image", "the agent image to pull, or none for the built-in one"),
    ("autoUpdate", "--auto-update", "on or off: update between jobs"),
)
# What the environment of a VM can override, and so what `config set` may change without effect.
OVERRIDING_VARIABLES = {
    "name": "FACTORY_RUNNER_NAME",
    "labels": "FACTORY_RUNNER_LABELS",
    "cpus": "FACTORY_RUNNER_CPUS",
    "memoryMb": "FACTORY_RUNNER_MEMORY_MB",
    "diskGb": "FACTORY_RUNNER_DISK_GB",
    "runtime": "FACTORY_RUNNER_RUNTIME",
    "agentImage": "FACTORY_RUNNER_AGENT_IMAGE",
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

    credential = commands.add_parser("credential", help="the runner's credential")
    steps = credential.add_subparsers(dest="action", required=True, parser_class=type(credential))
    steps.add_parser("show", help="whether there is one, and how old it is (never the value)")
    steps.add_parser("renew", help="ask the app for a new credential and save it")

    update = commands.add_parser("update", help="fetch and verify the newest runner image")
    update.add_argument(
        "--rollback",
        action="store_true",
        help="go back to the image before the last update; no update takes that release again",
    )


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
    changes: dict[str, object] = {}
    for key, option, _help in SETTING_OPTIONS:
        raw = getattr(arguments, option.lstrip("-").replace("-", "_"))
        if raw is None:
            continue
        removable = key not in ("name", "labels", "runtime", "autoUpdate", "parallelRuns")
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
        err.write(f"{PROGRAM}: the app requires a newer runner (factory-runner update)\n")
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


# -- update -------------------------------------------------------------------------------------


def update_image(
    arguments: argparse.Namespace,
    env: Mapping[str, str],
    out: TextIO,
    err: TextIO,
    *,
    docker: Callable[[], DockerApi],
    hostname: Callable[[], str],
    channel: Callable[[], ReleaseChannel | None],
    fetch: Fetch = fetch_https,
) -> int:
    """Stage the newest verified image; the service switches to it after its running job. Nothing
    is pulled by the service's hand and nothing is ended here."""
    api = docker()
    try:
        home = home_directory(env)
        if arguments.rollback:
            left = rollback(api, home)
            out.write("the earlier image is `current` again; restart the service to use it\n")
            if left > 0:
                out.write(
                    f"release {left} is rejected: no update, by the service or by this command, "
                    "takes it or an older one again; the next higher release is taken\n"
                )
            return EXIT_OK
        release_channel = channel()
        if release_channel is None:
            err.write(
                f"{PROGRAM}: no update: this image has no release channel yet "
                "(runner/release-channel.json is empty until the owner fills it)\n"
            )
            return EXIT_FAILED
        running = own_image(api, hostname())
        staged = stage(
            api,
            release_channel,
            running_release=release_of(running),
            rejected=rejected_release(home),
            fetch=fetch,
        )
    except UpdateError as error:
        err.write(f"{PROGRAM}: no update: {error}\n")
        return EXIT_FAILED
    if staged.outcome is Outcome.UP_TO_DATE:
        out.write(f"up to date (release {staged.release})\n")
        return EXIT_OK
    if staged.outcome is Outcome.REJECTED:
        out.write(
            f"release {staged.release} is announced, but a rollback rejected it: waiting for a "
            "higher release\n"
        )
        return EXIT_OK
    out.write(
        f"release {staged.release} is verified and staged ({staged.digest}); the service "
        "switches to it after the job it is running\n"
    )
    return EXIT_OK
