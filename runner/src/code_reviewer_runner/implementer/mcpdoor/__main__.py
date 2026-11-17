# SPDX-License-Identifier: LicenseRef-Proprietary

"""`python -m code_reviewer_runner.implementer.mcpdoor`: the entry point of the MCP door container
(#1067). Not a mode of `code-reviewer-runner`: the container is started with this module as its
command, so that the door imports the relay and nothing of PR-Agent, the engines or the job loop's
runner. `--bind HOST:PORT` moves where it listens (the Incus backend binds instance A's address; a
test of the process uses loopback)."""

import sys

from .service import main

if __name__ == "__main__":
    sys.exit(main())
