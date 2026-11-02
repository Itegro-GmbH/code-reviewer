# SPDX-License-Identifier: LicenseRef-Proprietary

"""`python -m code_reviewer_runner.implementer.door`: the entry point of the model door container.

Not a mode of `code-reviewer-runner`: the container is started with this module as its command, so
that the door imports the proxy and nothing of PR-Agent, the engines or the job loop."""

import logging
import sys

from .service import run_door


def main() -> int:
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="door: %(message)s")
    # The pipes are UTF-8 JSON lines whatever the locale of the image says.
    sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]  # a text stream here
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    return run_door(sys.stdin, sys.stdout)


if __name__ == "__main__":
    sys.exit(main())
