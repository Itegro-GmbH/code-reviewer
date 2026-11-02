# SPDX-License-Identifier: LicenseRef-Proprietary

"""`python -m code_reviewer_runner.implementer.door`: the entry point of the model door container.

Not a mode of `code-reviewer-runner`: the container is started with this module as its command, so
that the door imports the proxy and nothing of PR-Agent, the engines or the job loop.

The container is started without arguments: it listens at the model network's fixed address
(`model_door_route.py`) on the port of its start document. `--bind HOST:PORT` moves where it
listens, for a test of the process on a machine that does not have that address; nothing in the
runner passes it."""

import logging
import sys
from collections.abc import Sequence

from .service import run_door


def parse_bind(argument: str) -> tuple[str, int]:
    host, _, port = argument.rpartition(":")
    if not host or not port.isdigit() or not 0 < int(port) < 65536:
        raise SystemExit(2)
    return host, int(port)


def main(arguments: Sequence[str] | None = None) -> int:
    given = list(sys.argv[1:] if arguments is None else arguments)
    bind = None
    if given[:1] == ["--bind"] and len(given) == 2:
        bind = parse_bind(given[1])
    elif given:
        return 2
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="door: %(message)s")
    # The pipes are UTF-8 JSON lines whatever the locale of the image says.
    sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]  # a text stream here
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    return run_door(sys.stdin, sys.stdout, bind=bind)


if __name__ == "__main__":
    sys.exit(main())
