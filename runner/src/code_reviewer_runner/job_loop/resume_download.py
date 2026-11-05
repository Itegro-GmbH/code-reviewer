# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the job host needs of an API to fetch the stored session of a follow-up turn (#840): the
call, and the two answers it can fail with. The Worker API has it (`worker_api.py`); the runner API
does not, and a host over it has no conversation to hand over (the turn continues from a summary).
"""

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from code_reviewer_runner.resume_wire import ResumeReason
from code_reviewer_runner.snapshot_wire import SnapshotHeader


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
