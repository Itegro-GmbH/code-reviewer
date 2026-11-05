# SPDX-License-Identifier: LicenseRef-Proprietary

"""The stored conversation of a follow-up turn on the job process's side (#840): what the host
named in the environment, the file it put in the directory, and every way they can fail. Each
failure is a reason word, never an exception for the turn."""

import gzip
import hashlib
import json
import zlib
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.implementer.resume_session import (
    ResumeFailed,
    decode_snapshot,
    resume_input,
)
from code_reviewer_runner.job import ImplementerResume, ResumeBranch
from code_reviewer_runner.resume_wire import (
    RESUME_FILE_NAME,
    RESUME_STATE_VARIABLE,
    ResumeReason,
    failed_state,
    file_state,
    parse_state,
)
from code_reviewer_runner.snapshot_wire import SnapshotHeader

SESSION = "ses_01HZXEXAMPLE0123456789"


def document(**changes: Any) -> dict[str, Any]:
    return {"info": {"id": SESSION, "title": "t"}, "messages": [], **changes}


def packed(value: object) -> tuple[bytes, bytes]:
    """(the JSON text, its gzip file)."""
    raw = value if isinstance(value, bytes) else json.dumps(value).encode("utf-8")
    return raw, gzip.compress(raw, mtime=0)


def header_of(raw: bytes, data: bytes, **changes: Any) -> SnapshotHeader:
    values: dict[str, Any] = {
        "size": len(data),
        "raw_bytes": len(raw),
        "sha256": hashlib.sha256(data).hexdigest(),
        "version": "1.19.0",
    }
    return SnapshotHeader(**{**values, **changes})


def follow_up(snapshot: bool = True) -> ImplementerResume:
    return ImplementerResume(
        turn=2,
        branches=(ResumeBranch("implementer/a1b2c3", "a" * 40),),
        checkout=None,
        snapshot=snapshot,
    )


def failure_of(data: bytes, header: SnapshotHeader) -> ResumeReason:
    with pytest.raises(ResumeFailed) as caught:
        decode_snapshot(data, header)
    return caught.value.reason


# #840-T50
def test_a_snapshot_is_decoded_to_the_json_the_engine_imports_and_its_session_id() -> None:
    raw, data = packed(document())

    snapshot = decode_snapshot(data, header_of(raw, data))

    assert snapshot.data == raw  # the bytes as they were, not a re-serialisation
    assert snapshot.session_id == SESSION
    assert snapshot.version == "1.19.0"


# #840-T51
@pytest.mark.parametrize(
    "change",
    [
        {"size": 1},
        {"sha256": "0" * 64},
        {"raw_bytes": 3},
    ],
)
def test_a_file_that_is_not_the_one_the_header_describes_is_unreadable(
    change: dict[str, Any],
) -> None:
    raw, data = packed(document())

    assert failure_of(data, header_of(raw, data, **change)) is ResumeReason.SNAPSHOT_UNREADABLE


# #840-T52
def test_bytes_that_are_not_gzip_are_unreadable_even_with_a_matching_digest() -> None:
    data = b"this is not gzip at all"
    header = header_of(data, data)

    assert failure_of(data, header) is ResumeReason.SNAPSHOT_UNREADABLE


# #840-T53
def test_a_truncated_gzip_stream_is_unreadable() -> None:
    raw, data = packed(document(messages=[{"x": "y" * 1000}] * 50))
    cut = data[: len(data) // 2]

    assert failure_of(cut, header_of(raw, cut)) is ResumeReason.SNAPSHOT_UNREADABLE


# #840-T54
def test_a_file_that_inflates_beyond_what_the_header_announced_is_unreadable_and_not_inflated() -> (
    None
):
    bomb_raw = b'{"info": {"id": "ses_1"}, "messages": ["' + b"a" * 50_000_000 + b'"]}'
    data = gzip.compress(bomb_raw, mtime=0)
    announced = 1000

    reason = failure_of(data, header_of(bomb_raw, data, raw_bytes=announced))

    assert reason is ResumeReason.SNAPSHOT_UNREADABLE


# #840-T55
def test_a_gzip_stream_with_bytes_after_its_end_is_unreadable() -> None:
    raw, data = packed(document())
    padded = data + b"\x00\x01trailing"

    assert failure_of(padded, header_of(raw, padded)) is ResumeReason.SNAPSHOT_UNREADABLE


# #840-T56
def test_a_raw_size_over_the_cap_is_unreadable() -> None:
    raw, data = packed(document())

    assert (
        failure_of(data, header_of(raw, data, raw_bytes=64 * 1024 * 1024 + 1))
        is ResumeReason.SNAPSHOT_UNREADABLE
    )


# #840-T57
@pytest.mark.parametrize(
    "content",
    [
        b"not json at all",
        b"[]",
        b'"a string"',
        b"null",
        json.dumps({"messages": []}).encode(),
        json.dumps({"info": {}, "messages": []}).encode(),
        json.dumps({"info": {"id": SESSION}}).encode(),
        json.dumps({"info": {"id": SESSION}, "messages": {}}).encode(),
        json.dumps({"info": "x", "messages": []}).encode(),
        json.dumps({"info": {"id": 7}, "messages": []}).encode(),
    ],
)
def test_a_document_that_is_not_the_engines_export_is_unreadable(content: bytes) -> None:
    raw, data = packed(content)

    assert failure_of(data, header_of(raw, data)) is ResumeReason.SNAPSHOT_UNREADABLE


# #840-T58
@pytest.mark.parametrize(
    "identifier",
    ["", "../../etc/passwd", "ses_1/../x", "ses 1", "ses_1\n", "ses_1?x=1", "ses_1#x", "a" * 129],
)
def test_a_session_id_that_is_not_safe_in_a_url_is_unreadable(identifier: str) -> None:
    raw, data = packed(document(info={"id": identifier}))

    assert failure_of(data, header_of(raw, data)) is ResumeReason.SNAPSHOT_UNREADABLE


# #840-T59
def test_the_state_names_a_file_or_a_reason() -> None:
    header = SnapshotHeader(620544, 2_600_000, "1" * 64, "1.19.0")

    assert parse_state(file_state(header)).header == header
    assert parse_state(file_state(header)).reason is None
    for reason in ResumeReason:
        state = parse_state(failed_state(reason))
        assert state.header is None and state.reason is reason


# #840-T60
@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "ok",
        "failed",
        "failed something_else",
        "file",
        "file 1 2",
        "file x 2 " + "1" * 64 + " 1.19.0",
        "file 1 2 " + "Z" * 64 + " 1.19.0",
        "file 1 2 " + "1" * 64 + " ../x",
        "file 0 2 " + "1" * 64 + " 1.19.0",
        "file 9999999999 2 " + "1" * 64 + " 1.19.0",
    ],
)
def test_anything_else_the_host_says_is_a_failed_download(value: str | None) -> None:
    state = parse_state(value)

    assert state.header is None
    assert state.reason is ResumeReason.DOWNLOAD_FAILED


def env(raw: bytes, data: bytes) -> dict[str, str]:
    return {RESUME_STATE_VARIABLE: file_state(header_of(raw, data))}


# #840-T61
def test_a_turn_the_app_says_has_no_conversation_asks_for_none(tmp_path: Path) -> None:
    result = resume_input(follow_up(snapshot=False), {}, tmp_path)

    assert result.snapshot is None
    assert result.reason is ResumeReason.NO_SNAPSHOT


# #840-T62
def test_the_file_the_host_left_is_read_and_checked(tmp_path: Path) -> None:
    raw, data = packed(document())
    (tmp_path / RESUME_FILE_NAME).write_bytes(data)

    result = resume_input(follow_up(), env(raw, data), tmp_path)

    assert result.reason is None
    assert result.snapshot is not None and result.snapshot.session_id == SESSION


# #840-T63
def test_no_word_from_the_host_is_a_failed_download(tmp_path: Path) -> None:
    result = resume_input(follow_up(), {}, tmp_path)

    assert (result.snapshot, result.reason) == (None, ResumeReason.DOWNLOAD_FAILED)


# #840-T64
@pytest.mark.parametrize("reason", list(ResumeReason))
def test_the_reason_the_host_names_is_the_reason_of_the_turn(
    tmp_path: Path, reason: ResumeReason
) -> None:
    result = resume_input(follow_up(), {RESUME_STATE_VARIABLE: failed_state(reason)}, tmp_path)

    assert (result.snapshot, result.reason) == (None, reason)


# #840-T65
def test_a_file_that_is_gone_is_a_failed_download(tmp_path: Path) -> None:
    raw, data = packed(document())

    result = resume_input(follow_up(), env(raw, data), tmp_path)

    assert (result.snapshot, result.reason) == (None, ResumeReason.DOWNLOAD_FAILED)


# #840-T66
def test_a_file_that_was_changed_after_the_host_checked_it_is_unreadable(tmp_path: Path) -> None:
    raw, data = packed(document())
    (tmp_path / RESUME_FILE_NAME).write_bytes(data[:5] + b"\x01" + data[6:])

    result = resume_input(follow_up(), env(raw, data), tmp_path)

    assert (result.snapshot, result.reason) == (None, ResumeReason.SNAPSHOT_UNREADABLE)


# #840-T67
def test_a_directory_in_place_of_the_file_is_a_failed_download_not_a_crash(tmp_path: Path) -> None:
    raw, data = packed(document())
    (tmp_path / RESUME_FILE_NAME).mkdir()

    result = resume_input(follow_up(), env(raw, data), tmp_path)

    assert (result.snapshot, result.reason) == (None, ResumeReason.DOWNLOAD_FAILED)


# #840-T68
def test_a_corrupt_zlib_stream_in_a_gzip_envelope_is_unreadable() -> None:
    raw = json.dumps(document()).encode()
    broken = bytearray(gzip.compress(raw, mtime=0))
    broken[12:20] = bytes(zlib.compressobj().compress(b"junk") or b"\xff" * 8)[:8].ljust(8, b"\xff")
    data = bytes(broken)

    assert failure_of(data, header_of(raw, data)) is ResumeReason.SNAPSHOT_UNREADABLE
