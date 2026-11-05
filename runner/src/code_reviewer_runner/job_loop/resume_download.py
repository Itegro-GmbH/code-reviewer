# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the job host needs of an API to fetch the stored session of a follow-up turn (#840): the
call, and the two answers it can fail with. The Worker API has it (`worker_api.py`); the runner API
does not, and a host over it has no conversation to hand over (the turn continues from a summary).
"""

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from code_reviewer_runner.resume_wire import ResumeReason
from code_reviewer_runner.snapshot_wire import SnapshotHeader

# One request of the download, and the whole download: the file is at most 8 MiB in three requests.
# The download runs before the process starts and so before the first heartbeat, which comes one
# interval after that (30 s from the app, at most 60 s for this runner: `MAX_HEARTBEAT_INTERVAL_
# SECONDS`), while the lease is four intervals, 120 s, from the claim. The total plus the longest
# interval is 105 s, so 15 s are left for the job's details and the start of the process; 60 s here
# would leave none. The host ends the wait at the total whatever the thread does (`host.py`).
RESUME_REQUEST_TIMEOUT_SECONDS = 30.0
RESUME_TOTAL_SECONDS = 45.0


class ResumeUnavailable(Exception):
    """The stored session could not be had; `reason` is the word the turn's result will carry."""

    def __init__(self, reason: ResumeReason) -> None:
        super().__init__(reason.value)
        self.reason = reason


@dataclass(frozen=True)
class ResumeFile:
    """The stored session as the app sent it: the gzip file and the description it came with."""

    header: SnapshotHeader
    data: bytes


@runtime_checkable
class ResumeSessionApi(Protocol):
    async def resume_session(self, job_id: str) -> ResumeFile:
        """Get the stored session of the job's session. Raises `ResumeUnavailable`."""
        ...
