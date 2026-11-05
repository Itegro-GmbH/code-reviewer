# SPDX-License-Identifier: LicenseRef-Proprietary

"""The stored conversation of a follow-up turn, read and checked on the job process's side (#840).

The job host downloaded the gzip file (`resume_wire.py`); this module decides whether it is one the
engine may be asked to import. Nothing is trusted: the size and the digest are computed again, the
decompression is bounded (a few kilobytes of gzip can be gigabytes), and the document must be the
shape of the engine's export with a session id that is safe to put in a URL. The bytes that go to
the engine are the decompressed file as it is, not a re-serialisation of what was parsed.

Every way this can fail is `ResumeFailed` with a reason word, and every reason means the same: the
turn continues from the summary (`preface.py`). It is never the turn's failure.
"""

import hashlib
import json
import re
import zlib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, cast

from code_reviewer_runner.implementer.session_export import MAX_RAW_BYTES
from code_reviewer_runner.job import ImplementerResume
from code_reviewer_runner.resume_wire import (
    RESUME_FILE_NAME,
    RESUME_STATE_VARIABLE,
    ResumeReason,
    parse_state,
)
from code_reviewer_runner.snapshot_wire import SnapshotHeader

# An id of the engine (`ses_` and letters and digits); nothing that could change a URL path.
_SESSION_ID: Final = re.compile(r"[A-Za-z0-9_-]{1,128}")


class ResumeFailed(Exception):
    def __init__(self, reason: ResumeReason) -> None:
        super().__init__(reason.value)
        self.reason = reason


@dataclass(frozen=True)
class ResumeSnapshot:
    """The conversation, ready to import: the JSON the engine's `import` reads, the id of the
    session in it (`info.id`) and the engine version that wrote it."""

    data: bytes
    session_id: str
    version: str


@dataclass(frozen=True)
class ResumeInput:
    """What the turn has of its earlier conversation: the snapshot, or why there is none."""

    snapshot: ResumeSnapshot | None
    reason: ResumeReason | None

    @staticmethod
    def without(reason: ResumeReason) -> "ResumeInput":
        return ResumeInput(None, reason)


def decode_snapshot(data: bytes, header: SnapshotHeader) -> ResumeSnapshot:
    """The snapshot in `data` (the gzip file), judged against the header the host named. Raises
    `ResumeFailed(SNAPSHOT_UNREADABLE)` for anything that is not exactly that file."""
    unreadable = ResumeFailed(ResumeReason.SNAPSHOT_UNREADABLE)
    if len(data) != header.size or hashlib.sha256(data).hexdigest() != header.sha256:
        raise unreadable
    decoder = zlib.decompressobj(wbits=31)
    limit = min(header.raw_bytes, MAX_RAW_BYTES)
    try:
        raw = decoder.decompress(data, limit + 1)
    except zlib.error:
        raise unreadable from None
    # More than announced, or a stream that is not at its end: not the file the digest was made of.
    if len(raw) != header.raw_bytes or not decoder.eof or decoder.unused_data:
        raise unreadable
    try:
        document: Any = json.loads(raw)
    except ValueError:
        raise unreadable from None
    session_id = _session_id(document)
    if session_id is None:
        raise unreadable
    return ResumeSnapshot(data=raw, session_id=session_id, version=header.version)


def _session_id(document: object) -> str | None:
    if not isinstance(document, dict):
        return None
    root = cast("Mapping[str, Any]", document)
    info, messages = root.get("info"), root.get("messages")
    if not isinstance(info, dict) or not isinstance(messages, list):
        return None
    identifier = cast("Mapping[str, Any]", info).get("id")
    if not isinstance(identifier, str) or _SESSION_ID.fullmatch(identifier) is None:
        return None
    return identifier


def resume_input(
    resume: ImplementerResume, environment: Mapping[str, str], directory: Path
) -> ResumeInput:
    """What the follow-up turn `resume` has of its conversation: the file the host put in
    `directory`, checked, or the reason it is not used. Never raises."""
    if not resume.snapshot:
        return ResumeInput.without(ResumeReason.NO_SNAPSHOT)
    state = parse_state(environment.get(RESUME_STATE_VARIABLE))
    if state.header is None:
        return ResumeInput.without(state.reason or ResumeReason.DOWNLOAD_FAILED)
    try:
        data = (directory / RESUME_FILE_NAME).read_bytes()
    except OSError:
        return ResumeInput.without(ResumeReason.DOWNLOAD_FAILED)
    try:
        return ResumeInput(decode_snapshot(data, state.header), None)
    except ResumeFailed as failure:
        return ResumeInput.without(failure.reason)
