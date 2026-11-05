# SPDX-License-Identifier: LicenseRef-Proprietary

"""How the job host hands the stored session of a follow-up turn to the job process (#840).

The process holds neither the lease token nor the Worker's credential, so it cannot ask the app for
the conversation of the session. The host does (`job_loop/worker_api.py`, `resume_session`), checks
the digest, and puts the gzip file into the directory the process starts in, as
`RESUME_FILE_NAME`.
What the process is told about it is one environment variable, `RESUME_STATE_VARIABLE`:

- `file <size> <rawBytes> <sha256> <version>`: the file is there. The numbers are those of the
  snapshot header (`snapshot_wire.py`): the size of the gzip file, the size of the JSON inside it,
  the digest of the gzip file and the engine version that wrote it. The process checks them again;
  it trusts nothing but the bytes it hashes itself.
- `failed <reason>`: the host could not get it, for one of the words of `ResumeReason`.

No variable is the same as `failed download_failed` for a turn the app says has a conversation: a
host that does not know this channel gets nothing for the process, and the turn falls back to the
summary.
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Final

from code_reviewer_runner.snapshot_wire import SnapshotHeader, parse_header

RESUME_STATE_VARIABLE: Final = "RUNNER_RESUME_SESSION"
RESUME_FILE_NAME: Final = "resume-session.gz"


class ResumeReason(StrEnum):
    """Why a follow-up turn continues from a summary and not from the conversation. Stable words:
    they are in the result (`implementer.resume.reason`), and the Runs page translates them."""

    NO_SNAPSHOT = "no_snapshot"
    DOWNLOAD_FAILED = "download_failed"
    SNAPSHOT_UNREADABLE = "snapshot_unreadable"
    IMPORT_FAILED = "import_failed"
    VERSION_CHANGED = "version_changed"


@dataclass(frozen=True)
class ResumeState:
    """What the host told the process: a file with this header, or the reason there is none."""

    header: SnapshotHeader | None
    reason: ResumeReason | None


def file_state(header: SnapshotHeader) -> str:
    return f"file {header.size} {header.raw_bytes} {header.sha256} {header.version}"


def failed_state(reason: ResumeReason) -> str:
    return f"failed {reason.value}"


def parse_state(value: str | None) -> ResumeState:
    """The state the host named. Anything that is not one of the two forms is a failed download."""
    unusable = ResumeState(None, ResumeReason.DOWNLOAD_FAILED)
    if value is None:
        return unusable
    kind, _, rest = value.partition(" ")
    if kind == "failed":
        try:
            return ResumeState(None, ResumeReason(rest))
        except ValueError:
            return unusable
    if kind == "file":
        header = parse_header(f"S {rest}\n".encode("ascii", "replace"))
        return unusable if header is None else ResumeState(header, None)
    return unusable


# The headers of `GET /api/workers/v1/jobs/{id}/resume-session` (`ResumeSessionHeaders` in the
# Worker contract): every part carries the description of the whole file, the body is the bytes of
# the part.
HEADER_PARTS: Final = "x-snapshot-parts"
HEADER_BYTES: Final = "x-snapshot-bytes"
HEADER_RAW_BYTES: Final = "x-snapshot-raw-bytes"
HEADER_SHA256: Final = "x-snapshot-sha256"
HEADER_VERSION: Final = "x-snapshot-opencode-version"
