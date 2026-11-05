# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job process's end of the snapshot channel (#839): it hands the session file to the job host
over the descriptor `RUNNER_SNAPSHOT_FD` and closes it.

Best effort, like the live view's pump: the write is bounded by the seconds the caller gives it (it
is part of the export's budget in the sums of the end of the turn, `session.py`), a host that does
not read costs those seconds and nothing more, and a failure only means no snapshot. The host
uploads it to the app after the turn's push and before the result is delivered; this end does not
wait for that.
"""

import contextlib
import os
import socket
import time
from collections.abc import Callable, Mapping
from typing import Final

from code_reviewer_runner.implementer.session_export import SessionSnapshot
from code_reviewer_runner.snapshot_wire import (
    SNAPSHOT_FD_VARIABLE,
    SnapshotHeader,
    header_line,
)

_MIN_WRITE_SECONDS: Final = 0.05


class SnapshotPump:
    """One per turn: `send` once."""

    def __init__(
        self, channel: socket.socket, *, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._channel = channel
        self._clock = clock

    def send(self, snapshot: SessionSnapshot, version: str, seconds: float) -> bool:
        """Hand the file over within `seconds`. True when every byte is in the channel. The channel
        is closed either way: it carries one message."""
        header = SnapshotHeader(len(snapshot.data), snapshot.raw_bytes, snapshot.sha256, version)
        try:
            self._channel.settimeout(max(seconds, _MIN_WRITE_SECONDS))
            self._channel.sendall(header_line(header) + snapshot.data)
        except OSError:
            return False
        finally:
            self.close()
        return True

    def close(self) -> None:
        with contextlib.suppress(OSError):
            self._channel.close()


def snapshot_pump_from_environment(environment: Mapping[str, str]) -> SnapshotPump | None:
    """The pump over the descriptor the job host named, or None for a process started without one
    (an app without the feature, a runner of another kind): such a turn takes no export."""
    raw = environment.get(SNAPSHOT_FD_VARIABLE)
    if raw is None:
        return None
    try:
        descriptor = int(raw)
        # Not inherited by anything this process starts (the engine must never hold it).
        os.set_inheritable(descriptor, False)
        return SnapshotPump(socket.socket(fileno=descriptor))
    except (OSError, ValueError):
        return None
