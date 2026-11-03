# SPDX-License-Identifier: LicenseRef-Proprietary

"""A whole Implementer turn on a real Docker daemon (#745, step 4): the real agent image with the
pinned OpenCode, the real reader, the real door code and the production session, against a scripted
model and a bare repository standing in for GitHub (`lane_support`). The journeys of the plan's
table that still mean something with the agent in a container of its own: E01, E03, E04, E05, E12
and E09 here, E06 and E07 in `test_implementer_git.py`, E15 in `test_reader_hostile.py`."""

from pathlib import Path

from fakes.wire.formats import Turn
from lane_support import commit, lane_turn, says, write_file

from git_support import raw

CLOSING = "I added hello.txt and committed it."


# #745-E01
def test_the_agent_writes_a_file_and_commits_it_and_the_commit_arrives_once_at_the_end(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [write_file(repo, "hello.txt"), commit("Add hello"), says(CLOSING)]

    with lane_turn(tmp_path, script) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert [c.subject for c in result.commits] == ["Add hello"]
        assert [(f.path, f.kind.value) for f in result.files_changed] == [("hello.txt", "added")]
        assert result.summary == CLOSING
        assert result.pushed and result.head_commit == result.commits[-1].sha
        assert turned.origin_tip() == result.head_commit
        assert len(turned.messages) == 1, "a clean tree gets no extra message"
        subjects = raw(
            "log", "--format=%s", "main..implementer/a1b2c3",
            cwd=turned.origin.path, git=turned.origin.git,
        )  # fmt: skip
        assert subjects.splitlines() == ["Add hello"]
