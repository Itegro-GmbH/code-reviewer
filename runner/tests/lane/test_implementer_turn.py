# SPDX-License-Identifier: LicenseRef-Proprietary

"""A whole Implementer turn on a real Docker daemon (#745, step 4): the real agent image with the
pinned OpenCode, the real reader, the real door code and the production session, against a scripted
model and a bare repository standing in for GitHub (`lane_support`). The journeys of the plan's
table that still mean something with the agent in a container of its own: E01, E03, E04, E05, E12
and E09 here, E06 and E07 in `test_implementer_git.py`, E15 in `test_reader_hostile.py`."""

import copy
import gzip
import hashlib
import json
import re
import shutil
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from fakes.wire.formats import Turn
from lane_support import (
    BRANCH,
    INSTRUCTION,
    Turned,
    bash,
    commit,
    docker,
    lane_turn,
    says,
    write_file,
)
from opencode_native import REAL_KEY

from code_reviewer_runner.implementer.agent_container import (
    AGENT_CONTAINER_NAME,
    AGENT_HOME,
    AGENT_TMP,
    OPENCODE,
)
from code_reviewer_runner.implementer.config import implementer_environment
from code_reviewer_runner.implementer.git_workspace import LEFTOVER_MESSAGE
from code_reviewer_runner.implementer.prompts import LEFTOVER_PROMPT
from code_reviewer_runner.implementer.reader import (
    READER_CONTAINER_NAME,
    READER_WRITER_CONTAINER_NAME,
)
from code_reviewer_runner.implementer.resume_session import resume_input
from code_reviewer_runner.implementer.snapshot_pump import SnapshotPump
from code_reviewer_runner.job import ImplementerResume, ResumeBranch
from code_reviewer_runner.result import ErrorCode
from code_reviewer_runner.resume_wire import (
    RESUME_FILE_NAME,
    RESUME_STATE_VARIABLE,
    ResumeReason,
    file_state,
)
from code_reviewer_runner.snapshot_wire import SnapshotHeader
from git_support import TOKEN, Origin, files_mentioning, raw
from snapshot_support import SnapshotHost

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


# #745-E17: the agent's container is killed in the middle of the turn (memory, a crash, the daemon)
def test_a_container_killed_mid_turn_ends_the_turn_named_and_what_was_committed_arrives(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "one.txt"),
            commit("Add one"),
            write_file(repo, "two.txt"),
            commit("Add two"),
            bash("sleep 600"),
        ]

    def kill_after_two_commits() -> None:
        while not stop.is_set():
            counted = docker(
                "exec", AGENT_CONTAINER_NAME, "git", "-C", "/work/repo", "rev-list", "--count",
                "main..HEAD", check=False,
            )  # fmt: skip
            # The clone has the whole history (#909): the agent's commits are the ones after `main`.
            if counted.returncode == 0 and int(counted.stdout.strip() or 0) >= 2:
                docker("kill", AGENT_CONTAINER_NAME, check=False)
                return
            stop.wait(0.3)

    stop = threading.Event()
    killer = threading.Thread(target=kill_after_two_commits, daemon=True)
    killer.start()
    try:
        with lane_turn(tmp_path, script) as turned:
            result = turned.result

            assert result.error_code is ErrorCode.AGENT_GAVE_UP, (result.error_code, result.notes)
            assert "the agent's container ended during the turn" in (result.error_detail or "")
            assert [c.subject for c in result.commits] == ["Add one", "Add two"]
            assert result.pushed and turned.origin_tip() == result.head_commit
    finally:
        stop.set()
        killer.join(10.0)


def texts_of(document: Mapping[str, Any]) -> str:
    """Every text part of an export, in one string."""
    return "\n".join(
        str(part.get("text", ""))
        for message in document["messages"]
        for part in message.get("parts", [])
        if part.get("type") == "text"
    )


# #839-E20
def test_the_session_of_a_turn_is_exported_from_the_real_engine_and_the_pinned_engine_imports_it(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [write_file(repo, "hello.txt"), commit("Add hello"), says(CLOSING)]

    host = SnapshotHost()
    with lane_turn(tmp_path, script, snapshot=SnapshotPump(host.process_end)) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert not any("not saved" in note for note in result.notes), result.notes
        assert host.wait(60), "the process closed the channel"
        header = host.header
        assert header is not None and header.version == "1.19.0"
        packed = host.data
        assert len(packed) == header.size
        document = json.loads(gzip.decompress(packed))
        assert document["info"]["id"] == result.opencode_session_id
        texts = texts_of(document)
        assert INSTRUCTION in texts and CLOSING in texts, "the conversation is in the file"
        assert REAL_KEY not in json.dumps(document)

        # The pinned engine reads the file as the next turn's VM will: `opencode import`, before
        # any engine is started, in a container that has nothing else (no network).
        resume = tmp_path / "resume.json"
        resume.write_bytes(gzip.decompress(packed))
        resume.chmod(0o644)
        environment = implementer_environment(home=AGENT_HOME, scratch_dir=AGENT_TMP)
        flags = [item for name, value in environment.items() for item in ("-e", f"{name}={value}")]
        done = docker(
            "run", "--rm", "--network", "none", "--memory", "1g",
            "--entrypoint", OPENCODE,
            "-v", f"{resume}:/resume.json:ro",
            *flags, turned.config.agent_image, "import", "/resume.json",
            timeout=180.0,
        )  # fmt: skip
        assert "Imported session" in done.stdout + done.stderr, done.stdout + done.stderr
        assert str(result.opencode_session_id) in done.stdout + done.stderr
    host.close()


# -- a follow-up turn on a new sandbox (#840, part of #745) -------------------------------------

CLOSING_TWO = "I added goodbye.txt and committed it."
INSTRUCTION_TWO = "Now add a goodbye file and commit it."
SUMMARY_OF_ONE = "SUMMARY-OF-TURN-ONE: the greeting file exists."


@dataclass
class FirstTurn:
    """What turn one leaves for the next: the origin with its pushed branch, the engine's session
    as the process hands it to the job host, and the result."""

    origin: Origin
    result: Any
    packed: bytes
    header: SnapshotHeader


@pytest.fixture(scope="module")
def first_turn(tmp_path_factory: pytest.TempPathFactory) -> FirstTurn:
    scratch = tmp_path_factory.mktemp("turn-one")
    host = SnapshotHost()

    def script(repo: Path) -> list[Turn]:
        return [write_file(repo, "hello.txt"), commit("Add hello"), says(CLOSING)]

    with lane_turn(scratch, script, snapshot=SnapshotPump(host.process_end)) as turned:
        assert turned.result.ok, (turned.result.error_code, turned.result.notes)
        assert host.wait(60), "the process closed the channel"
        header = host.header
        assert header is not None
        return FirstTurn(turned.origin, turned.result, host.data, header)


def second_turn_script(repo: Path) -> list[Turn]:
    return [write_file(repo, "goodbye.txt"), commit("Add goodbye"), says(CLOSING_TWO)]


def copy_of(origin: Origin, where: Path) -> Origin:
    """The origin as turn one left it, for a test of its own: a turn pushes."""
    where.mkdir(parents=True, exist_ok=True)
    clone = copy.copy(origin)
    clone.path = where / "origin.git"
    shutil.copytree(origin.path, clone.path)
    return clone


def stored_session(first: FirstTurn, directory: Path, data: bytes, header: SnapshotHeader) -> Any:
    """What the job process makes of the file the job host downloaded: the host's file and word in
    `directory`, read the way `runner.py` reads them."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / RESUME_FILE_NAME).write_bytes(data)
    follow_up = ImplementerResume(
        turn=2,
        branches=(ResumeBranch(BRANCH, first.result.head_commit),),
        checkout=None,
        snapshot=True,
    )
    return resume_input(follow_up, {RESUME_STATE_VARIABLE: file_state(header)}, directory)


def follow_up_job(first: FirstTurn) -> dict[str, Any]:
    return {
        "turn": 2,
        "branches": [{"name": BRANCH, "head": first.result.head_commit}],
        "checkout": None,
        "snapshot": True,
        "previousSummary": SUMMARY_OF_ONE,
        "digest": "Turn 1 (instruction): " + INSTRUCTION,
    }


def damaged(first: FirstTurn) -> tuple[bytes, SnapshotHeader]:
    """The engine's own export with one required key of its first message taken out: gzip, the
    digest and the envelope are fine, and the engine's import refuses it."""
    document = json.loads(gzip.decompress(first.packed))
    del document["messages"][0]["info"]["role"]
    raw = json.dumps(document).encode()
    data = gzip.compress(raw, mtime=0)
    return data, SnapshotHeader(len(data), len(raw), hashlib.sha256(data).hexdigest(), "1.19.0")


# #840-E21
def test_a_follow_up_turn_continues_the_conversation_of_the_first_in_a_new_sandbox(
    tmp_path: Path, first_turn: FirstTurn
) -> None:
    stored = stored_session(first_turn, tmp_path / "host", first_turn.packed, first_turn.header)
    assert stored.reason is None, "the file the first turn left is one the job process accepts"

    with lane_turn(
        tmp_path / "two",
        second_turn_script,
        instruction=INSTRUCTION_TWO,
        origin_of_earlier_turn=copy_of(first_turn.origin, tmp_path / "origin"),
        resume=follow_up_job(first_turn),
        resume_input=stored,
    ) as second:
        result = second.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert result.resume == {"mode": "imported"}
        assert result.opencode_session_id == first_turn.result.opencode_session_id
        # The message the runner sent is the preface in a part of its own, then the instruction.
        (_, parts), *_ = second.message_parts
        assert [part.get("synthetic") for part in parts] == [True, None]
        assert parts[1]["text"] == INSTRUCTION_TWO
        assert "NEW sandbox" in parts[0]["text"] and BRANCH in parts[0]["text"]
        # The strict model saw the first turn's conversation in its first request of this turn.
        asked = json.dumps(second.requests[0])
        assert INSTRUCTION in asked and CLOSING in asked and "hello.txt" in asked
        assert INSTRUCTION_TWO in asked and "NEW sandbox" in asked
        assert SUMMARY_OF_ONE not in asked, "the summary is for the fallback only"
        # And the branch moved on from the first turn's tip.
        assert [c.subject for c in result.commits][-1:] == ["Add goodbye"]
        assert second.origin_tip() == result.head_commit != first_turn.result.head_commit


# #840-E22
def test_a_corrupt_snapshot_falls_back_to_a_summary_and_the_turn_goes_on(
    tmp_path: Path, first_turn: FirstTurn
) -> None:
    corrupt = first_turn.packed[:5] + b"\x01" + first_turn.packed[6:]
    stored = stored_session(first_turn, tmp_path / "host", corrupt, first_turn.header)
    assert stored.snapshot is None and stored.reason is ResumeReason.SNAPSHOT_UNREADABLE

    with lane_turn(
        tmp_path / "two",
        second_turn_script,
        instruction=INSTRUCTION_TWO,
        origin_of_earlier_turn=copy_of(first_turn.origin, tmp_path / "origin"),
        resume=follow_up_job(first_turn),
        resume_input=stored,
    ) as second:
        result = second.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert result.resume == {"mode": "summary_only", "reason": "snapshot_unreadable"}
        assert result.opencode_session_id != first_turn.result.opencode_session_id
        (_, parts), *_ = second.message_parts
        assert [part.get("synthetic") for part in parts] == [True, True, None]
        asked = json.dumps(second.requests[0])
        assert SUMMARY_OF_ONE in asked and "NEW sandbox" in asked
        assert CLOSING not in asked, "the old conversation did not come back"
        assert second.origin_tip() == result.head_commit != first_turn.result.head_commit


# #840-E23
def test_a_snapshot_the_engine_refuses_to_import_falls_back_to_a_summary_too(
    tmp_path: Path, first_turn: FirstTurn
) -> None:
    data, header = damaged(first_turn)
    stored = stored_session(first_turn, tmp_path / "host", data, header)
    assert stored.snapshot is not None, "the envelope is fine: only the engine can tell"

    with lane_turn(
        tmp_path / "two",
        second_turn_script,
        instruction=INSTRUCTION_TWO,
        origin_of_earlier_turn=copy_of(first_turn.origin, tmp_path / "origin"),
        resume=follow_up_job(first_turn),
        resume_input=stored,
    ) as second:
        result = second.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert result.resume == {"mode": "summary_only", "reason": "import_failed"}
        assert any("continues from a summary" in note for note in result.notes), result.notes
        asked = json.dumps(second.requests[0])
        assert SUMMARY_OF_ONE in asked and CLOSING not in asked
        assert second.origin_tip() == result.head_commit
