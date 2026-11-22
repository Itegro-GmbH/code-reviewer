# SPDX-License-Identifier: LicenseRef-Proprietary

"""Command line entry point of the Worker image: `code-reviewer-runner <mode>`.

Two modes (#316, #324), both with the same hardened startup (network rules, end of `NET_ADMIN`,
self-check; `job_loop/service.py`):

| Mode          | What it does                                                                  |
|---------------|-------------------------------------------------------------------------------|
| `worker-once` | One Worker: `{appUrl, jobId, credential}` on stdin, one job, exit code.       |
| `probe`       | Runs the startup, prints a JSON verdict (engines, stable reasons) and exits.  |

The mode is the argument and is required: the Sandbox-Launcher passes it as the container's command.
There is no job loop that claims jobs by itself any more (#700): a Dispatcher claims, a Worker runs.
"""

import argparse
import os
import sys
from collections.abc import Mapping, Sequence
from typing import NoReturn, TextIO

from code_reviewer_runner import __version__
from code_reviewer_runner.job_loop.worker_api import IMAGE_FEATURES, WORKER_FEATURES
from code_reviewer_runner.probe import run_probe
from code_reviewer_runner.worker_cli import run_once as run_worker_once

PROGRAM_NAME = "code-reviewer-runner"
MODE_WORKER_ONCE = "worker-once"
MODE_PROBE = "probe"
MODES = (MODE_WORKER_ONCE, MODE_PROBE)


class _PrintWorkerFeatures(argparse.Action):
    """`--worker-features`: print what this image's Worker reads of a job (`WORKER_FEATURES`, and
    `IMAGE_FEATURES`, which only the golden image reports), comma separated, and exit. The golden
    image build (`docker/incus/build-golden.sh`, #1093) asks the Worker image this and records the
    answer in the image, so that a runner announces a claim feature only when the image it starts
    really has it. No startup, no network, no secret."""

    def __init__(self, option_strings: Sequence[str], dest: str, **_: object) -> None:
        super().__init__(
            option_strings,
            dest,
            nargs=0,
            help="print what the Worker of this image reads, and exit",
        )

    def __call__(
        self,
        parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: object,
        option_string: str | None = None,
    ) -> NoReturn:
        sys.stdout.write(",".join((*WORKER_FEATURES, *IMAGE_FEATURES)) + "\n")
        parser.exit(0)


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        # The text of a usage error echoes the offending argument, which may be a secret that was
        # put in the wrong place. Say what is wrong, not what was typed.
        self.print_usage(sys.stderr)
        sys.stderr.write(f"{PROGRAM_NAME}: invalid arguments (one of: {', '.join(MODES)})\n")
        raise SystemExit(2)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog=PROGRAM_NAME,
        description="Runs one review job as a Worker, or the startup self-check. "
        "The mode is the argument; the Worker's start document is read from stdin. "
        "Settings: RUNNER_JOB_TIMEOUT_SECONDS and the Dynamic slot's variables "
        "(see runner/README.md).",
    )
    parser.add_argument("--version", action="version", version=f"{PROGRAM_NAME} {__version__}")
    parser.add_argument("--worker-features", action=_PrintWorkerFeatures)
    parser.add_argument("mode", choices=MODES, help=", ".join(MODES))
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    stdin: TextIO | None = None,
) -> int:
    """Run the command line interface and return the process exit code."""
    parser = build_parser()
    try:
        arguments = parser.parse_args(argv)
    except SystemExit as exit_request:
        # argparse exits for --version (code 0) and for usage errors (code 2).
        return exit_request.code if isinstance(exit_request.code, int) else 1
    env = dict(os.environ if environment is None else environment)
    if arguments.mode == MODE_PROBE:
        return run_probe(env)
    return run_worker_once(env, stdin=stdin)
