# SPDX-License-Identifier: LicenseRef-Proprietary

"""Command line entry point of the Worker: `code-reviewer-worker --once` (#323).

Runs exactly one job and exits (0 ok, 1 failed, 2 setup error; see `job_loop/worker.py`). The start
document `{"appUrl", "jobId", "credential"}` comes on stdin: the per-job credential is a secret and
has no way in through the arguments or the environment. The other settings are the environment
variables the runner reads (`RUNNER_JOB_TIMEOUT_SECONDS` and the Dynamic slot's variables).
"""

import argparse
import asyncio
import logging
import os
import sys
from collections.abc import Mapping, Sequence
from typing import NoReturn, TextIO

from code_reviewer_runner import __version__
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.implementer.environment_control import report_worker_end
from code_reviewer_runner.job_loop.service import LOGGER_NAME, configure_logging, run_startup
from code_reviewer_runner.job_loop.settings import SettingsError, worker_settings_from_environment
from code_reviewer_runner.job_loop.worker import (
    MAX_START_DOCUMENT_BYTES,
    parse_request,
    run_worker,
)
from code_reviewer_runner.job_loop.worker_errors import (
    WorkerExit,
    WorkerFailure,
    WorkerSetupError,
)

PROGRAM_NAME = "code-reviewer-worker"


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        # The text of a usage error echoes the offending argument; here that may be a secret that
        # was put in the wrong place. Say what is wrong, not what was typed.
        self.print_usage(sys.stderr)
        sys.stderr.write(f"{PROGRAM_NAME}: invalid arguments (only --once is accepted)\n")
        raise SystemExit(WorkerExit.SETUP_ERROR)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog=PROGRAM_NAME,
        description="Runs exactly one review job with a per-job credential and exits. "
        "The start document {appUrl, jobId, credential} is read from stdin.",
    )
    parser.add_argument("--version", action="version", version=f"{PROGRAM_NAME} {__version__}")
    parser.add_argument("--once", action="store_true", required=True, help="run one job and exit")
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    stdin: TextIO | None = None,
) -> int:
    """Run the Worker and return the process exit code."""
    try:
        build_parser().parse_args(argv)
    except SystemExit as exit_request:
        # argparse exits for --version (code 0) and for usage errors (code 2).
        return exit_request.code if isinstance(exit_request.code, int) else 1
    env = dict(os.environ if environment is None else environment)
    configure_logging()
    code = _run(env, sys.stdin if stdin is None else stdin)
    # #975: the sandbox's environment control hears how the Worker ended (vsock only; best effort,
    # it never changes the exit code).
    report_worker_end(env, int(code))
    return code


def _run(env: dict[str, str], source: TextIO) -> int:
    log = logging.getLogger(LOGGER_NAME)
    try:
        settings = worker_settings_from_environment(env)
    except SettingsError as error:
        log.error("worker cannot start: %s: %s", WorkerFailure.SETTINGS_INVALID.value, error)
        return WorkerExit.SETUP_ERROR
    try:
        # The same startup as every mode, and the first thing a container does: the network setup
        # and the end of `NET_ADMIN` come first, `opencode` is advertised only after the self-check
        # passed, and the hardened container spec's read-only root is part of it. No job process
        # exists before it is done, and the start document (the credential) is not even read yet.
        settings, _ = run_startup(settings, require_read_only_root=True)
    except IsolationError as error:
        log.error("worker cannot start: %s", error)
        return WorkerExit.SETUP_ERROR
    try:
        request = parse_request(source.read(MAX_START_DOCUMENT_BYTES + 1))
    except WorkerSetupError as error:
        log.error("worker cannot start: %s", error)
        return WorkerExit.SETUP_ERROR
    return asyncio.run(run_worker(request, settings, env, install_signals=True))


def run_once(environment: Mapping[str, str], *, stdin: TextIO | None = None) -> int:
    """`code-reviewer-runner worker-once`: the same Worker as `code-reviewer-worker --once`."""
    return main(["--once"], environment=environment, stdin=stdin)


if __name__ == "__main__":
    sys.exit(main())
