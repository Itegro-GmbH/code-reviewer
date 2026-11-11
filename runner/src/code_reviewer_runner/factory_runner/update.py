# SPDX-License-Identifier: LicenseRef-Proprietary

"""The switch to a release that the installer's updater staged (#982; the plan's decision 9).

The dispatcher does not download anything and does not know a channel: the program and the VM
artifacts are root's and read-only for the service (a VMM that escaped must not be able to change
what every later VM boots from), so a **root** script stages a new release
(`runner/install/install.sh`, `update`, run by a timer or by hand: a signed manifest, every file
checked by its digest) and writes the marker file `pending`. The service only looks at that file,
**between two jobs and never during one**: when it exists, the service ends with exit code 10
before its next claim, and the unit's start (as root, `ExecStartPre=+`) makes the staged release
current in one atomic step and starts the service from it.

So a switch needs three things this module does not do: a release (the updater), the atomic switch
(the unit's start) and the way back (`factory-runner rollback`). What it does is the one thing
only the service can: not to end while a job runs.

A runner that was not started by that unit (no `FACTORY_RUNNER_PENDING_FILE`) never ends itself
for an update, and `run --once` never updates. The app never triggers an update: it only says,
with the claim's `426`, that it requires a newer base; the service then says so in its log and, if
a release is staged, switches at once.
"""

import logging
from collections.abc import Mapping
from pathlib import Path
from typing import Final

# The marker the updater writes and the unit's start removes; the settings file names its path.
PENDING_FILE_VARIABLE: Final = "FACTORY_RUNNER_PENDING_FILE"
# The release the service runs, set by the unit's start (`run-service`): only for the log.
RELEASE_VARIABLE: Final = "FACTORY_RUNNER_RELEASE"


class UpdatePolicy:
    """When the service ends so that the unit's start switches to a staged release. Used between
    two jobs only; every call ends in `False` (go on) or `True` (end now, the unit restarts)."""

    def __init__(
        self, environment: Mapping[str, str], *, logger: logging.Logger | None = None
    ) -> None:
        raw = environment.get(PENDING_FILE_VARIABLE, "").strip()
        self._pending = Path(raw) if raw else None
        self._release = environment.get(RELEASE_VARIABLE, "").strip()
        self._log = logger or logging.getLogger(__name__)
        self._said_staged = False
        self._said_needed = False

    @property
    def follows_a_release(self) -> bool:
        """The unit's start switches releases and restarts this service: it may end for one."""
        return self._pending is not None

    def staged(self) -> bool:
        """Whether the updater has staged a release that is not current yet."""
        if self._pending is None:
            return False
        try:
            return self._pending.exists()
        except OSError:
            return False

    def switch_due(self, *, needed: bool = False) -> bool:
        """True when this service should end now. `needed`: the app requires a newer base; with
        nothing staged it is said (the timer or `sudo factory-runner update` stages a release: this
        service downloads nothing)."""
        if self._pending is None:
            return False
        if self.staged():
            if not self._said_staged:
                self._log.info(
                    "a release is staged (running release %s): ending between jobs so that the "
                    "service starts it",
                    self._release or "unknown",
                )
                self._said_staged = True
            return True
        if needed and not self._said_needed:
            self._log.warning(
                "the app requires a newer runner and no release is staged: run "
                "'sudo factory-runner update' (the update timer looks every six hours)"
            )
            self._said_needed = True
        return False
