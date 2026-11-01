# SPDX-License-Identifier: LicenseRef-Proprietary

"""The header-only reader of `git log -z --format=raw` (#764): any way the stream is cut into
chunks gives the same headers, and nothing of a message is kept."""

import pytest

from code_reviewer_runner.implementer.commit_headers import (
    MAX_HEADER_BYTES,
    CommitHeaderReader,
    HeaderTooLarge,
)

SHA_A = "a" * 40
SHA_B = "b" * 40


def entry(sha: str, message: str = "    subject\n") -> bytes:
    headers = f"commit {sha}\ntree {'0' * 40}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n"
    return f"{headers}\n{message}".encode()


def read(chunks: list[bytes]) -> list[list[str]]:
    seen: list[list[str]] = []
    reader = CommitHeaderReader(seen.append)
    for chunk in chunks:
        reader.feed(chunk)
    reader.finish()
    return seen


STREAM = entry(SHA_A, "    one\n\n    body\n") + b"\0" + entry(SHA_B, "    two\n")


# #764-F2
def test_every_commit_gives_its_header_lines_and_no_message_line() -> None:
    seen = read([STREAM])

    assert [headers[0] for headers in seen] == [f"commit {SHA_A}", f"commit {SHA_B}"]
    assert all("subject" not in " ".join(headers) for headers in seen)
    assert seen[0][-1] == "committer A <a@b> 1 +0000"
    assert not any(line.startswith("    ") for headers in seen for line in headers)


# #764-F2
@pytest.mark.parametrize("size", [1, 2, 3, 7, 50, 1000])
def test_the_cut_of_the_stream_into_chunks_changes_nothing(size: int) -> None:
    chunks = [STREAM[start : start + size] for start in range(0, len(STREAM), size)]

    assert read(chunks) == read([STREAM])


# #764-F2
def test_a_message_with_a_blank_line_is_not_a_second_header() -> None:
    stream = entry(SHA_A, "    a\n\n    committer X <x@y> 1 +0000\n\n    more\n")

    seen = read([stream])

    assert len(seen) == 1
    assert [line for line in seen[0] if line.startswith("committer ")] == [
        "committer A <a@b> 1 +0000"
    ]


# #764-F2
def test_an_entry_without_a_message_and_without_a_terminator_is_complete() -> None:
    headers = f"commit {SHA_A}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n".encode()

    assert [h[0] for h in read([headers])] == [f"commit {SHA_A}"]
    assert [h[0] for h in read([headers + b"\0" + headers])] == [f"commit {SHA_A}"] * 2


# #764-F2
def test_a_nul_inside_a_header_starts_a_new_entry_that_the_caller_can_refuse() -> None:
    stream = f"commit {SHA_A}\nauthor A <a@b> 1 +0000\0forged\ncommitter A\n\n    m\n".encode()

    seen = read([stream])

    assert seen[0][0] == f"commit {SHA_A}"
    assert not seen[1][0].startswith("commit "), "the caller sees a first line that is no commit"


# #764-F2
def test_a_header_block_over_the_bound_is_refused_whatever_the_chunking() -> None:
    bloated = f"commit {SHA_A}\n".encode() + b"extra " + b"z" * (MAX_HEADER_BYTES + 10)

    for size in (len(bloated), 4096):
        chunks = [bloated[start : start + size] for start in range(0, len(bloated), size)]
        with pytest.raises(HeaderTooLarge):
            read(chunks)


# #764-F2
def test_a_huge_message_is_dropped_as_it_passes() -> None:
    seen: list[list[str]] = []
    reader = CommitHeaderReader(seen.append)
    reader.feed(entry(SHA_A, "    start\n"))
    for _ in range(200):
        reader.feed(b"    " + b"m" * 1_000_000 + b"\n")  # 200 MB of message, in pieces

    assert len(reader._header) == 0  # pyright: ignore[reportPrivateUsage]
    reader.feed(b"\0" + entry(SHA_B))
    reader.finish()
    assert [headers[0] for headers in seen] == [f"commit {SHA_A}", f"commit {SHA_B}"]
