# SPDX-License-Identifier: LicenseRef-Proprietary

"""The parsers behind the Implementer's result lists (#764): the bounds of the contract
(`ImplementerResult`: 200 commits, 500 files, subjects of 500 characters) hold whatever git
prints."""

from code_reviewer_runner.implementer.history import (
    MAX_COMMITS,
    MAX_FILES,
    MAX_SUBJECT_CHARS,
    ChangeKind,
    CommitInfo,
    FileChange,
    parse_commits,
    parse_name_status,
)

SHA = "{:040x}"


def lines(count: int) -> bytes:
    return "".join(f"{SHA.format(number)} subject {number}\n" for number in range(count)).encode()


# #764-T03
def test_commits_come_oldest_first_and_the_head_is_always_the_last_when_cut() -> None:
    newest_first = lines(250)  # git prints the newest first

    commits = parse_commits(newest_first)

    assert len(commits) == MAX_COMMITS
    assert commits[-1] == CommitInfo(SHA.format(0), "subject 0"), "the head commit stays"
    assert commits[0] == CommitInfo(SHA.format(249), "subject 249"), "oldest of the kept ones"


# #764-T03
def test_a_short_list_is_just_reversed() -> None:
    assert [c.subject for c in parse_commits(lines(3))] == ["subject 2", "subject 1", "subject 0"]


# #764-T03
def test_a_subject_is_cut_and_cleaned_and_a_line_that_is_no_commit_is_dropped() -> None:
    raw = (
        f"{SHA.format(1)} {'x' * 900}\n".encode()
        + f"{SHA.format(2)} bell\x07 and escape \x1b[2J done\n".encode()
        + b"not a commit line\n"
        + f"{SHA.format(3)} \xff\xfe bytes\n".encode("latin-1")
    )

    commits = parse_commits(raw)

    assert [c.sha for c in commits] == [SHA.format(3), SHA.format(2), SHA.format(1)]
    assert len(commits[2].subject) == MAX_SUBJECT_CHARS
    assert "\x07" not in commits[1].subject and "\x1b" not in commits[1].subject
    assert "bell" in commits[1].subject and "done" in commits[1].subject


# #764-T03
def test_name_status_maps_every_letter_of_the_contract() -> None:
    raw = b"A\0a.txt\0M\0b.txt\0D\0c.txt\0T\0d.txt\0R100\0old.txt\0new.txt\0C75\0src\0copy\0"

    assert parse_name_status(raw) == [
        FileChange("a.txt", ChangeKind.ADDED),
        FileChange("b.txt", ChangeKind.MODIFIED),
        FileChange("c.txt", ChangeKind.DELETED),
        FileChange("d.txt", ChangeKind.TYPECHANGE),
        FileChange("new.txt", ChangeKind.RENAMED),
        FileChange("copy", ChangeKind.COPIED),
    ]


# #764-T03
def test_a_status_the_contract_has_no_word_for_and_a_broken_record_are_skipped() -> None:
    raw = b"U\0unmerged.txt\0A\0ok.txt\0R100\0only-one-path"

    assert parse_name_status(raw) == [FileChange("ok.txt", ChangeKind.ADDED)]


# #764-T03
def test_the_file_list_is_cut_at_the_bound_and_a_path_over_4096_is_dropped() -> None:
    raw = b"".join(b"A\0" + f"f{number}".encode() + b"\0" for number in range(MAX_FILES + 50))
    raw += b"A\0" + b"p" * 5000 + b"\0"

    files = parse_name_status(raw)

    assert len(files) == MAX_FILES
    assert all(0 < len(change.path) <= 4096 for change in files)
