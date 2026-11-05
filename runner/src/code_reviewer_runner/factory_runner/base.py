# SPDX-License-Identifier: LicenseRef-Proprietary

"""What every Factory-Runner is, by name (#854, R1b)."""

from typing import Final

# The version of the base every runner provides (plan decision 3): the pinned OpenCode, the model
# door with the key out of the agent, the cost ledger, live steps, the finish tool, resume, the git
# rules. The app compares it with `RUNNER_MIN_BASE_VERSION`. It changes when the base does, not with
# the package: raise the minor version for an addition to the base and the major for a change that
# makes an older runner unable to run a job the app now sends.
BASE_VERSION: Final = "1.0.0"
# Where `factory-runner register` goes when `--url` and `FACTORY_RUNNER_URL` are not given.
DEFAULT_URL: Final = "https://code-review.com"
HARNESS_OPENCODE: Final = "opencode"

# Exit codes of `factory-runner` (the list is in docs/runner.md). 0 is also "no job came in time" in
# `run --once`; 7 is "the app could not be reached for the whole wait" there.
EXIT_OK: Final = 0
EXIT_FAILED: Final = 1
EXIT_USAGE: Final = 2
EXIT_UPDATE_NEEDED: Final = 3
EXIT_REVOKED: Final = 4
EXIT_NOT_READY: Final = 5
EXIT_CONFIG: Final = 6
EXIT_APP_UNREACHABLE: Final = 7
