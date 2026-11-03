# SPDX-License-Identifier: LicenseRef-Proprietary

"""A whole Implementer turn on a real Docker daemon (#745, step 4): the real agent image with the
pinned OpenCode, the real reader, the real door code and the production session, against a scripted
model and a bare repository standing in for GitHub (`lane_support`). The journeys of the plan's
table that still mean something with the agent in a container of its own: E01, E03, E04, E05, E12
and E09 here, E06 and E07 in `test_implementer_git.py`, E15 in `test_reader_hostile.py`."""

import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from fakes.wire.formats import Turn
from lane_support import Turned, bash, commit, docker, lane_turn, says, write_file
from opencode_native import REAL_KEY

from code_reviewer_runner.implementer.agent_container import AGENT_CONTAINER_NAME
from code_reviewer_runner.implementer.git_workspace import LEFTOVER_MESSAGE
from code_reviewer_runner.implementer.prompts import LEFTOVER_PROMPT
from code_reviewer_runner.implementer.reader import (
    READER_CONTAINER_NAME,
    READER_WRITER_CONTAINER_NAME,
)
from code_reviewer_runner.result import ErrorCode
from git_support import TOKEN, files_mentioning, raw

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


def committed_by_the_system(turned: Turned) -> list[str]:
    return [c.sha for c in turned.result.commits if c.subject == LEFTOVER_MESSAGE]


# #745-E03
def test_changes_left_uncommitted_get_exactly_one_more_message_and_the_system_commits_nothing(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "notes.txt"),
            says("Done, I think."),
            commit("Add notes"),  # the answer to the extra message
            says("Committed."),
        ]

    with lane_turn(tmp_path, script) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert len(turned.messages) == 2
        assert turned.messages[0][0] == turned.messages[1][0], "the same session"
        assert turned.messages[1][1] == LEFTOVER_PROMPT
        assert [c.subject for c in result.commits] == ["Add notes"]
        assert committed_by_the_system(turned) == []
        assert result.summary == "Done, I think.", "the summary is the closing text of the work"
        assert turned.origin_tip() == result.head_commit


# #745-E04
def test_changes_left_uncommitted_and_ignored_are_committed_by_the_system_and_pushed(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [write_file(repo, "draft.txt"), says("Done."), says("I will not commit.")]

    with lane_turn(tmp_path, script) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert len(turned.messages) == 2, "one extra message, not more"
        assert [c.subject for c in result.commits] == [LEFTOVER_MESSAGE]
        assert result.pushed and turned.origin_tip() == result.head_commit
        identity = turned.workspace.identity
        author = raw(
            "log", "-1", "--format=%an <%ae>|%cn <%ce>", result.head_commit or "",
            cwd=turned.workspace.mirror, git=turned.origin.git,
        )  # fmt: skip
        assert author == f"{identity.name} <{identity.email}>|{identity.name} <{identity.email}>"
        assert any("committed by the system" in note for note in result.notes)


# #745-E05
def test_the_cost_limit_ends_the_turn_and_what_was_written_is_committed_and_pushed(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [write_file(repo, f"f{number}.txt") for number in range(40)]

    with lane_turn(tmp_path, script, limit="0.05") as turned:
        result = turned.result
        calls_at_end = len(turned.upstream.records)

        assert result.error_code is ErrorCode.COST_LIMIT_REACHED, result.notes
        assert result.files_changed, "what the agent wrote before the limit is kept"
        assert [c.subject for c in result.commits] == [LEFTOVER_MESSAGE]
        assert result.pushed and turned.origin_tip() == result.head_commit
        assert len(turned.messages) == 1, "no extra message after a limit"
        assert len(turned.requests) < 40
        assert calls_at_end == len(turned.upstream.records), "no model call after the end"
        assert result.usage.cost_usd is not None and result.usage.cost_usd > 0


# #745-E12
def test_an_agent_that_only_answers_in_text_gave_up_and_nothing_is_pushed(tmp_path: Path) -> None:
    with lane_turn(tmp_path, lambda repo: [says("There is nothing I can do here.")]) as turned:
        result = turned.result

        assert result.error_code is ErrorCode.AGENT_GAVE_UP
        assert result.summary == "There is nothing I can do here."
        assert result.commits == () and result.head_commit is None and not result.pushed
        assert turned.origin_tip() is None, "no ref is created on the remote"
        assert turned.origin.branches() == ["refs/heads/main"]
        assert len(turned.messages) == 1


# What an agent that looks for a secret runs. The needles are put together by the shell, so that the
# command the model sends, which the engine keeps in its own files, does not hold them whole.
def finder(*secrets: str) -> str:
    joined = " ".join(
        f'-e "{secret[: len(secret) // 2]}""{secret[len(secret) // 2 :]}"' for secret in secrets
    )
    return (
        f"grep -rIlF {joined} / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null"
    )


PROBE = (
    "echo '== env'; env; "
    "echo '== environ of every process'; "
    "for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>&1; done; "
    "echo '== ps'; ps -eo user,pid,args; "
    "echo '== config'; cat /work/repo/.git/config; "
    "echo '== remote'; git remote -v; "
    "echo '== where the volume is'; ls -a /work; "
    "echo '== sockets'; ls -la /var/run/docker.sock /run/docker.sock 2>&1"
)


# #745-E09
def test_no_secret_is_anywhere_the_agent_can_look_and_none_is_left_on_the_volume(
    tmp_path: Path,
) -> None:
    seen: dict[str, str] = {}

    def judge(headers: Mapping[str, str], body: Mapping[str, Any]) -> None:
        # While the agent works (it has its first commands behind it), the definitions of the
        # containers the runner made are as the daemon holds them.
        if body.get("tools") and "inspected" not in seen and len(body.get("messages", [])) > 2:
            seen["inspected"] = docker(
                "inspect", AGENT_CONTAINER_NAME, READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME
            ).stdout

    def script(repo: Path) -> list[Turn]:
        return [
            bash(f"{PROBE}; echo '[probe-start-done]'"),
            bash(
                f"echo '== files holding a secret'; {finder(TOKEN, REAL_KEY)}; echo '[find-done]'"
            ),
            write_file(repo, "probe.txt", "probe\n"),
            commit("Add probe"),
            says("Looked around, then committed probe.txt."),
        ]

    with lane_turn(tmp_path, script, judge=judge) as turned:
        result = turned.result
        assert result.ok, (result.error_code, result.error_detail, result.notes)
        capability = turned.session._model.capability  # pyright: ignore[reportPrivateUsage,reportOptionalMemberAccess]
        probed = turned.tool_results()

        # It could look: its own environment, every process of the container, the repository.
        assert "[probe-start-done]" in probed and "[find-done]" in probed
        assert "OPENCODE_CONFIG=" in probed
        assert re.search(r"== config\n[\s\S]*repositoryformatversion", probed)
        # and found no remote and no credential in the repository,
        assert not re.search(r"\[remote |remote\.[^\s=]+\.url|\burl\s*=|extraheader", probed, re.I)
        assert re.search(r"== remote\n== where", probed)
        # no secret anywhere it can read: not the installation token, not the key of the model,
        for secret in (TOKEN, REAL_KEY):
            assert secret not in probed, "the agent found a credential"
        files = probed.split("== files holding a secret\n")[1].split("[find-done]")[0]
        assert files.strip() == "", "a file in the agent's container holds a secret"
        # nor on the daemon's side in the definition of its containers (key, token or hand-over),
        assert seen.get("inspected"), "the containers were never inspected"
        for secret in (TOKEN, REAL_KEY):
            assert secret not in seen["inspected"]
        # nor on the volume, which holds the repository of the agent and the mirror of the runner.
        # The capability of the door is the agent's own credential for the door of its job: it may
        # be in the agent's container and nowhere else.
        on_the_volume = files_mentioning(
            turned.workspace.layout.work_dir, TOKEN, REAL_KEY, capability
        )
        assert on_the_volume == [], [str(path) for path in on_the_volume]
