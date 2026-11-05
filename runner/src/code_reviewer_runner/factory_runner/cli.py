# SPDX-License-Identifier: LicenseRef-Proprietary

"""`factory-runner`: the command of the Factory-Runner (#854, R1b).

- `register`: exchanges a registration token for the runner's credential and writes the
  configuration (file mode 0600). The token comes from a file (`--token-file`, `-` for the standard
  input), from `FACTORY_RUNNER_TOKEN`, or from `--token`, which is the least safe (the process list
  and the shell history show it).
- `run`: the service loop. `--once` takes one job and ends; with no job within `--wait` seconds it
  ends with exit code 0 and says so, and with an app that never answered during the wait it ends
  with exit code 7.
- `selftest`: proves the base on this machine; exit code 0 when it holds. It only looks: it pulls
  and names no image, so a machine whose agent image is missing or not the pinned one is reported
  as not ready (a running service pulls it at its own start). It may run beside a service, though
  its throwaway container is one more on the daemon for as long as it takes.
- `config show`, `config set`: the configuration without its secret, and changing it
  (`cli_manage.py`); `credential show|renew` and `update [--rollback]` are there too.

The app address, the credential, the labels and the limits can come from the environment instead of
the file (`config.py`): a VM that runs one job needs no `register`.

Exit codes (`base.py`): 0 done (also: no job within the wait), 1 a job failed, 2 usage, 3 the app
requires an update, 4 revoked, 5 not ready (the self-test failed), 6 configuration, 7 `run --once`:
the app never answered during the wait, 8 `register`: registered, but the credential could not be
saved, 9 another runner uses this Docker daemon (the log names the first container or
network of another runner that was found), 10 the service ended so that its supervisor starts the
image that `update` staged.
"""

import argparse
import asyncio
import json
import logging
import os
import socket
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import NoReturn, TextIO

from code_reviewer_runner import __version__
from code_reviewer_runner.factory_runner import cli_manage
from code_reviewer_runner.factory_runner.app_client import (
    Announcement,
    ApiError,
    AppClient,
    RegistrationRefused,
    UpdateNeeded,
)
from code_reviewer_runner.factory_runner.base import (
    BASE_VERSION,
    DEFAULT_URL,
    EXIT_CONFIG,
    EXIT_CREDENTIAL_UNSAVED,
    EXIT_FAILED,
    EXIT_NOT_READY,
    EXIT_OK,
    EXIT_USAGE,
)
from code_reviewer_runner.factory_runner.config import (
    ConfigError,
    Limits,
    RunnerConfig,
    check_image,
    check_labels,
    check_limits,
    check_name,
    check_runtime,
    check_token,
    check_url,
    config_path,
    load_config,
    save_config,
)
from code_reviewer_runner.factory_runner.job_api import RunnerJobApi
from code_reviewer_runner.factory_runner.prepare import Prepared, prepare
from code_reviewer_runner.factory_runner.selftest import SelfTestResult, summary
from code_reviewer_runner.factory_runner.service import (
    DEFAULT_ONCE_WAIT_SECONDS,
    LOGGER_NAME,
    RunnerService,
    Seams,
)
from code_reviewer_runner.factory_runner.update import (
    Fetch,
    ReleaseChannel,
    fetch_https,
    load_channel,
)
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.job_loop.service import configure_logging
from code_reviewer_runner.job_loop.settings import SettingsError

PROGRAM = "factory-runner"
TOKEN_VARIABLE = "FACTORY_RUNNER_TOKEN"


@dataclass(frozen=True)
class CliSeams:
    """What the tests replace; production leaves the defaults."""

    client: Callable[[str, str | None], AppClient] = lambda url, credential: AppClient(
        url, credential=credential
    )
    prepare: Callable[[RunnerConfig, Mapping[str, str]], Prepared] = prepare
    # What `selftest` runs: the same checks, but nothing is pulled or named in the daemon.
    check: Callable[[RunnerConfig, Mapping[str, str]], Prepared] = lambda config, env: _look(
        config, env
    )
    run_selftest: Callable[[RunnerConfig, Mapping[str, str]], SelfTestResult] | None = None
    now: Callable[[], float] = time.time
    hostname: Callable[[], str] = socket.gethostname
    # The daemon the loop tidies (`housekeeping.py`).
    docker: Callable[[], DockerApi] = DockerApi
    # The release channel of the image and how its documents are fetched (`update.py`).
    channel: Callable[[], ReleaseChannel | None] = load_channel
    fetch: Fetch = fetch_https


def _look(config: RunnerConfig, env: Mapping[str, str]) -> Prepared:
    """`prepare` that pulls and names no image."""
    return prepare(config, env, pull=None)


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        # The text of a usage error echoes the offending argument, which may be a token that was
        # put in the wrong place. Say what is wrong, not what was typed.
        self.print_usage(sys.stderr)
        sys.stderr.write(f"{PROGRAM}: invalid arguments\n")
        raise SystemExit(EXIT_USAGE)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(prog=PROGRAM, description="The runner of a Code Reviewer workspace.")
    parser.add_argument(
        "--version", action="version", version=f"{PROGRAM} {__version__} (base {BASE_VERSION})"
    )
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)

    register = commands.add_parser(
        "register", help="register this machine with a token from the app"
    )
    source = register.add_mutually_exclusive_group()
    source.add_argument("--token-file", help="a file with the registration token; - reads stdin")
    source.add_argument(
        "--token",
        help="the registration token (crt_...); visible in the process list and the shell history, "
        f"so prefer --token-file or {TOKEN_VARIABLE}",
    )
    register.add_argument("--name", help="the name in the list of runners (default: host name)")
    register.add_argument("--labels", default="", help="comma separated labels, e.g. linux,gpu")
    register.add_argument("--url", help=f"the app (default: {DEFAULT_URL})")
    register.add_argument("--cpus", type=int, help="CPUs the agent's container may use")
    register.add_argument("--memory-mb", type=int, help="memory of the agent's container")
    register.add_argument("--disk-gb", type=int, help="disk the runner may use")
    register.add_argument("--runtime", default="auto", help="auto, runc or sysbox-runc")
    register.add_argument("--agent-image", help="the agent image to pull when it is not here")
    register.add_argument("--force", action="store_true", help="replace an existing configuration")

    run = commands.add_parser("run", help="take jobs")
    run.add_argument("--once", action="store_true", help="take one job, then end")
    run.add_argument(
        "--wait",
        type=float,
        default=DEFAULT_ONCE_WAIT_SECONDS,
        help="with --once: seconds to wait for a job (default %(default)g)",
    )

    selftest = commands.add_parser("selftest", help="prove the base on this machine")
    selftest.add_argument("--json", action="store_true", help="print the result as JSON")

    cli_manage.add_parsers(commands)
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    seams: CliSeams = CliSeams(),  # noqa: B008
    out: TextIO | None = None,
    err: TextIO | None = None,
    stdin: TextIO | None = None,
) -> int:
    """Run the command and return the exit code."""
    stdout: TextIO = out or sys.stdout
    stderr: TextIO = err or sys.stderr
    try:
        arguments = build_parser().parse_args(argv)
    except SystemExit as request:
        return request.code if isinstance(request.code, int) else EXIT_FAILED
    env = dict(os.environ if environment is None else environment)
    try:
        if arguments.command == "register":
            return _register(arguments, env, seams, stdout, stderr, stdin or sys.stdin)
        if arguments.command == "config":
            if arguments.action == "set":
                return cli_manage.config_set(arguments, env, stdout, stderr)
            return cli_manage.config_show(env, stdout)
        if arguments.command == "credential":
            if arguments.action == "renew":
                return cli_manage.credential_renew(
                    env, stdout, stderr, client=seams.client, now=seams.now
                )
            return cli_manage.credential_show(env, stdout, seams.now)
        if arguments.command == "update":
            return cli_manage.update_image(
                arguments,
                env,
                stdout,
                stderr,
                docker=seams.docker,
                hostname=seams.hostname,
                channel=seams.channel,
                fetch=seams.fetch,
            )
        if arguments.command == "selftest":
            return _selftest(arguments, env, seams, stdout, stderr)
        return _run(arguments, env, seams, stderr)
    except ConfigError as error:
        stderr.write(f"{PROGRAM}: configuration: {error}\n")
        return EXIT_CONFIG
    except SettingsError as error:
        stderr.write(f"{PROGRAM}: configuration: {error}\n")
        return EXIT_CONFIG


# -- register --------------------------------------------------------------------------------------


def _register(
    arguments: argparse.Namespace,
    env: Mapping[str, str],
    seams: CliSeams,
    out: TextIO,
    err: TextIO,
    stdin: TextIO,
) -> int:
    path = config_path(env)
    if path.exists() and not arguments.force:
        err.write(f"{PROGRAM}: {path} exists: this machine is registered (--force replaces it)\n")
        return EXIT_CONFIG
    allow_http = env.get("FACTORY_RUNNER_ALLOW_HTTP", "").strip() == "1"
    raw_token = _token_of(arguments, env, stdin)
    if raw_token is None:
        err.write(
            f"{PROGRAM}: register needs a token: --token-file FILE (- for the standard input), "
            f"{TOKEN_VARIABLE}, or --token\n"
        )
        return EXIT_USAGE
    token = check_token(raw_token)
    config = RunnerConfig(
        url=check_url(
            arguments.url or env.get("FACTORY_RUNNER_URL") or DEFAULT_URL, allow_http=allow_http
        ),
        name=check_name(arguments.name or seams.hostname()),
        labels=check_labels(arguments.labels),
        limits=check_limits(
            {
                key: value
                for key, value in (
                    ("cpus", arguments.cpus),
                    ("memoryMb", arguments.memory_mb),
                    ("diskGb", arguments.disk_gb),
                )
                if value is not None
            }
        ),
        agent_image=check_image(arguments.agent_image) if arguments.agent_image else None,
        runtime=check_runtime(arguments.runtime),
    )
    # The manifest is empty: what the runner can do is proven by `run`'s self-test, which announces
    # it. A runner that is registered and not yet started takes no job.
    announcement = Announcement(config.labels, BASE_VERSION, {}, _limits(config.limits))
    try:
        registered = seams.client(config.url, None).register(token, config.name, announcement)
    except RegistrationRefused as refused:
        err.write(
            f"{PROGRAM}: the app refused the registration ({refused.code or refused.status}): "
            "the token is unknown, used or expired, or a value does not fit\n"
        )
        return EXIT_FAILED
    except UpdateNeeded:
        err.write(f"{PROGRAM}: the app requires a newer runner\n")
        return EXIT_FAILED
    except ApiError as error:
        err.write(f"{PROGRAM}: the app could not be reached ({error})\n")
        return EXIT_FAILED
    config = replace(
        config,
        credential=registered.credential,
        runner_id=registered.runner_id,
        credential_renewed_at=seams.now(),
    )
    try:
        written = save_config(config, env)
    except OSError as error:
        # The app has the runner and the credential is shown only once: nothing here can use it.
        err.write(
            f"{PROGRAM}: runner registered, but its credential could not be saved "
            f"({error.strerror or type(error).__name__}): revoke it in the app "
            f"(runner {registered.runner_id}) and register again\n"
        )
        return EXIT_CREDENTIAL_UNSAVED
    out.write(
        f"registered as {config.name} (runner {registered.runner_id}); configuration in {written}\n"
    )
    if registered.min_base_version:
        out.write(f"the app requires a base of at least {registered.min_base_version}\n")
    return EXIT_OK


def _token_of(arguments: argparse.Namespace, env: Mapping[str, str], stdin: TextIO) -> str | None:
    """The registration token from where the caller put it: `--token`, `--token-file` (`-`: the
    standard input), or `FACTORY_RUNNER_TOKEN`, in that order. None when there is none; a file that
    cannot be read is a `ConfigError` that never says what was in it."""
    if arguments.token is not None:
        return arguments.token
    if arguments.token_file is not None:
        try:
            if arguments.token_file == "-":
                return stdin.read().strip()
            with open(arguments.token_file, encoding="utf-8") as handle:
                return handle.read().strip()
        except (OSError, UnicodeDecodeError):
            raise ConfigError("the token file cannot be read") from None
    return env.get(TOKEN_VARIABLE, "").strip() or None


def _limits(limits: Limits) -> dict[str, int]:
    from code_reviewer_runner.factory_runner.config import limits_document

    return limits_document(limits)


# -- selftest ------------------------------------------------------------------------------


def _selftest(
    arguments: argparse.Namespace,
    env: Mapping[str, str],
    seams: CliSeams,
    out: TextIO,
    err: TextIO,
) -> int:
    config = load_config(env, require_url=False)
    if seams.run_selftest is not None:
        result = seams.run_selftest(config, env)
    else:
        result = seams.check(config, env).selftest
    if arguments.json:
        json.dump(
            {
                "base": result.base_ok,
                "runtime": result.runtime,
                "opencodeVersion": result.opencode_version,
                "capabilities": list(result.capabilities),
                "seconds": round(result.seconds, 1),
                "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in result.checks],
            },
            out,
            indent=2,
        )
        out.write("\n")
    else:
        for line in summary(result):
            out.write(line + "\n")
        out.write(
            f"base: {'ready' if result.base_ok else 'NOT ready'}; "
            f"capabilities: {', '.join(result.capabilities) or 'none'}\n"
        )
    return EXIT_OK if result.base_ok else EXIT_NOT_READY


# -- run -----------------------------------------------------------------------------------


def _run(
    arguments: argparse.Namespace, env: Mapping[str, str], seams: CliSeams, err: TextIO
) -> int:
    config = load_config(env)
    if config.credential is None:
        err.write(
            f"{PROGRAM}: this machine is not registered (factory-runner register --token ...)\n"
        )
        return EXIT_CONFIG
    if arguments.once and arguments.wait < 0:
        err.write(f"{PROGRAM}: --wait must not be negative\n")
        return EXIT_USAGE
    configure_logging()
    prepared = seams.prepare(config, env)
    service = RunnerService(
        config,
        env,
        prepared,
        seams.client(config.url, config.credential),
        RunnerJobApi(config.url, config.credential),
        logger=logging.getLogger(LOGGER_NAME),
        seams=Seams(docker=seams.docker),
    )
    return asyncio.run(service.run(once=arguments.once, wait_seconds=arguments.wait))


def entry_point() -> None:
    raise SystemExit(main())
