# SPDX-License-Identifier: LicenseRef-Proprietary

"""A whole Implementer job through the runner's entry point, in process (#765): the glue, not the
agent.

`runner.main` reads the job from stdin and prints one result line; everything between is the
production code: the entry point, the job glue, the session, the lease gate, the push loop and the
leftover handling of the git workspace. Three things are doubles, and each is proven somewhere
else: the engine and the agent's container (`FakeAgent` and `FakePlace` stand in for OpenCode in
its container; `tests/lane` runs the real agent image with the pinned OpenCode, the real reader and
the real door code on a real Docker daemon, and a VM with Sysbox runs the same), the model door
(`FakeDoor`, a door with nothing behind it; the door's own tests are in `tests/unit`), and the git
commands behind the push (`FakeGit` records the push instead of running git; the real git paths
are the tests of #762). The lease answers come over a real socket pair, the way the job host gives
them, and a SIGTERM is a real signal to this process. So this file holds the cases that need a
scripted engine to be forced (a lease lost at a given moment, a stop in the middle of a turn, a
container that is not confirmed gone); it is not the proof that a turn works end to end.
"""

import io
import json
import os
import queue
import signal
import socket
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from functools import partial
from pathlib import Path
from typing import Any, cast

import pytest
from jsonschema import Draft202012Validator

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import (
    ENGINE_DIFF,
    ENGINE_DYNAMIC,
    ENGINE_IMPLEMENTER,
    ENGINES_VARIABLE,
)
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, UnitCosts
from code_reviewer_runner.dynamic_review.engine_events import EventReader
from code_reviewer_runner.dynamic_review.tool_part_audit import ToolPartAudit
from code_reviewer_runner.implementer import session as session_module
from code_reviewer_runner.implementer.agent import AgentTurn, CommandOutcome
from code_reviewer_runner.implementer.door_state import DoorState
from code_reviewer_runner.implementer.git_workspace import (
    BranchPush,
    GitIdentity,
    GitWorkspace,
    PushReport,
    WorkspaceLayout,
    WorkspaceSpec,
    _Progress,  # pyright: ignore[reportPrivateUsage]
)
from code_reviewer_runner.implementer.history import ChangeKind, CommitInfo, FileChange
from code_reviewer_runner.implementer.job_run import (
    SIGTERM_BACKSTOP_SECONDS,
    JobSeams,
    TurnSetup,
    run_implementer_job,
)
from code_reviewer_runner.implementer.limits import agent_limits
from code_reviewer_runner.implementer.session import SessionSeams
from code_reviewer_runner.implementer.session_export import ExportFailed, ExportReason
from code_reviewer_runner.implementer.step_feed import StepFeeder
from code_reviewer_runner.implementer.step_records import StepConverter
from code_reviewer_runner.job import JobError
from code_reviewer_runner.job_loop.host import IMPLEMENTER_TERMINATE_GRACE_SECONDS
from code_reviewer_runner.job_loop.settings import WorkerSettings
from code_reviewer_runner.lease_check import LEASE_CHECK_FD_VARIABLE
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode
from code_reviewer_runner.snapshot_wire import SNAPSHOT_FD_VARIABLE
from code_reviewer_runner.step_wire import STEPS_FD_VARIABLE
from snapshot_support import SnapshotHost, snapshot_of
from step_support import HostEnd, say

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "contracts" / "examples" / "implementer" / "RunnerJobInput.json"
SCHEMA = json.loads((ROOT / "contracts" / "runner-api.v1.json").read_text(encoding="utf-8"))
TOKEN = "ghs_dummy-installation-token-0123456789"
KEY = "sk-or-v1-" + "dummykey0123456789abcdef"  # built, so the secret scan sees no key
START = "1" * 40
TIP = "2" * 40
SECOND = "3" * 40


def job_text(*, cost_limit: bool = True, profile: dict[str, Any] | None = None) -> str:
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    if profile is not None:
        document["implementer"]["profile"] = profile
    document["git"]["token"] = TOKEN
    document["llm"]["apiKey"] = KEY
    if cost_limit:
        # The app sends the limits with the claim features (`cost_limit`, `operator_cost_limit`).
        document["llm"]["maxCostUsd"] = 2.5
    return json.dumps(document)


def valid_result(line: dict[str, Any]) -> bool:
    validator = Draft202012Validator({"$ref": "#/$defs/RunnerResult", "$defs": SCHEMA["$defs"]})
    return bool(validator.is_valid(line))  # pyright: ignore[reportUnknownMemberType]


# -- the doubles ----------------------------------------------------------------------------------


class FakeGit(GitWorkspace):
    """The real `GitWorkspace` (its lease questions, its paths, its identity) with the commands
    behind it replaced by a script the test controls. `pushes` are the tips `push_all` pushed;
    `events` is the order of everything that matters."""

    def __init__(self, base: Path, before_push: Callable[[], None] | None) -> None:
        super().__init__(
            WorkspaceSpec(
                "https://github.com/acme/widgets.git", TOKEN, "main", "implementer/a1b2c3"
            ),
            WorkspaceLayout(work_dir=base / "work", run_dir=base / "run"),
            GitIdentity("code-reviewer Implementer", "i@example.invalid"),
            cast("Any", None),  # the reader: every command that would use it is replaced below
            before_push=before_push,
        )
        self._start: str | None = START
        self.tip: str | None = None
        self.commits: list[CommitInfo] = []
        self.files: list[FileChange] = []
        self.is_dirty = False
        self.dirty_error: Exception | None = None
        self.pushes: list[str] = []
        self.push_calls = 0
        self.events: list[str] = []
        self.prepared = False
        self.other_branches: dict[str, str] = {}
        self.rejected: dict[str, str] = {}
        # The task's branch was looked at and not taken over: (reason, head or None).
        self.form_rejected: tuple[str, str | None] | None = None
        self.rescue_name: str | None = None
        self.readers_quiet = True
        self.dropped: tuple[int, int] = (0, 0)
        self.form_gone = False
        # What the volume of the VM has left, as the workspace would say (None: it cannot say).
        self.volume_free: int | None = None
        self._prepare_error: JobError | None = None

    def fail_prepare(self, error: JobError) -> None:
        """`prepare` fails with `error`; before a clone there is no start commit to report."""
        self._prepare_error = error
        cloned = error.code not in (ErrorCode.CLONE_FAILED, ErrorCode.BASE_BRANCH_NOT_FOUND)
        self._start = START if cloned else None

    def prepare(self) -> None:
        if self._prepare_error is not None:
            raise self._prepare_error
        self.prepared = True

    def commit(self, sha: str, subject: str = "Add it") -> None:
        self.tip = sha
        self.commits = [*self.commits, CommitInfo(sha, subject)]
        self.files = [FileChange("src/a.ts", ChangeKind.ADDED)]

    def volume_free_bytes(self) -> int | None:
        return self.volume_free

    def dirty(self) -> bool:
        if self.dirty_error is not None:
            raise self.dirty_error
        return self.is_dirty

    def commit_all(self, message: str = "", *, seconds: float = 0.0) -> str | None:
        self.events.append("commit_all")
        self.commit(SECOND, "Implementer: uncommitted changes of the turn")
        self.is_dirty = False
        return SECOND

    def commits_since_start(self) -> list[CommitInfo]:
        return list(self.commits) if self._progress.form_ref is not None else []

    def changed_files(self) -> list[FileChange]:
        return list(self.files) if self._progress.form_ref is not None else []

    def rescue_detached_head(self) -> str | None:
        self.events.append("rescue")
        return self.rescue_name

    def quiet_readers(self, *, seconds: float) -> bool:
        self.events.append("quiet")
        return self.readers_quiet

    def push_all(
        self, *, seconds: float, confirm_seconds: float = 0.0, confirm_pause: float = 0.0
    ) -> Any:
        """What the real one does around git: the lease is asked before the listing and before
        every push, the form's branch comes first, one branch refused does not stop the others."""
        self.push_calls += 1
        self._progress = _Progress()
        deadline = self._clock() + seconds
        self._ask_lease(deadline, confirm_seconds, confirm_pause)
        mine = self._progress
        mine.invalid, mine.overflow = self.dropped
        mine.form_listed = not self.form_gone
        if self.form_rejected is not None:
            reason, head = self.form_rejected
            mine.branches.append(BranchPush(self.spec.branch, head, False, reason))
            mine.form_head = head
        elif self.tip is not None and self.tip != self._start:
            mine.form_head = self.tip
            mine.form_ref = "refs/runner/in/0"
            self._ask_lease(deadline, confirm_seconds, confirm_pause)
            self.events.append("push")
            self.pushes.append(self.tip)
            mine.branches.append(BranchPush(self.spec.branch, self.tip, True, None))
        for name, sha in sorted(self.other_branches.items()):
            self._ask_lease(deadline, confirm_seconds, confirm_pause)
            if name in self.rejected:
                mine.branches.append(BranchPush(name, sha, False, self.rejected[name]))
                continue
            self.pushes.append(sha)
            mine.branches.append(BranchPush(name, sha, True, None))
        return self.push_report()


@dataclass
class FakePlace:
    """The agent's container of the test: it exists and goes away, and holds nothing. `remove`
    notes the events of the turn as they were when it was asked to."""

    events: list[str] = field(default_factory=lambda: [])
    removals: list[tuple[str, ...]] = field(default_factory=lambda: [])

    def create(self) -> tuple[str, ...]:
        return ()

    def write_files(self, files: Mapping[str, tuple[bytes, int]]) -> None:
        return None

    def run_command(
        self, argv: list[str], environment: Mapping[str, str], timeout: float
    ) -> CommandOutcome:
        return CommandOutcome(0, "")

    def start_engine(self, argv: list[str], environment: Mapping[str, str]) -> str:
        return "http://127.0.0.1:4096"

    def engine_running(self) -> bool:
        return True

    def settle(self, seconds: float) -> None:
        return None

    def engine_end_note(self) -> str | None:
        return None

    def stop(self) -> bool:
        return True

    def remove(self) -> None:
        self.removals.append(tuple(self.events))


def fake_door(**options: Any) -> "FakeDoor":
    return FakeDoor()


class FakeDoor:
    """The model door of the test: what `RunningDoor` offers the session, with nothing behind it."""

    def __init__(self) -> None:
        self.state = DoorState()
        self.url = "http://10.213.77.2:10180"

    def stop(self) -> None:
        return None


@dataclass
class FakeAgent:
    """The engine of the test: `script(agent, check)` plays one turn."""

    script: Callable[["FakeAgent", Callable[[], None]], str]
    events: list[str]
    git: FakeGit
    options: dict[str, Any] = field(default_factory=lambda: {})
    session_id: str | None = None
    stopped: list[bool] = field(default_factory=lambda: [])
    texts: list[str] = field(default_factory=lambda: [])
    ends_clean: bool = True
    notes: tuple[str, ...] = ()
    notes_fail: bool = False
    # The step feeder of the session, made at start and only with a redactor, as the real agent's.
    steps: StepFeeder | None = None
    # The export of the engine's session (#839): what `export_session` returns or raises, and the
    # budgets it was asked for.
    export: Any = None
    exports: list[float] = field(default_factory=lambda: [])

    @property
    def ledger(self) -> Any:
        return self.options["ledger"]

    def start(self, port: int = 0) -> None:
        self.events.append("agent.start")
        self.session_id = "ses_fake"
        redactor = self.options.get("redactor")
        if redactor is not None:
            self.steps = StepFeeder("ses_fake", redactor)
            self.steps.feed(
                {
                    "type": "message.updated",
                    "properties": {
                        "sessionID": "ses_fake",
                        "info": {"id": "msg_a", "role": "assistant"},
                    },
                }
            )

    def use_the_model(self) -> None:
        """One call that was billed: from now on the turn has cost money."""
        reservation = self.ledger.reserve_call("x" * 400)
        self.ledger.settle_call(
            reservation, prompt_tokens=100, completion_tokens=10, cost=Decimal("0.001")
        )

    def capability(self) -> str:
        config = self.options["make_config"]("/instructions.md")
        return cast("str", config["provider"][self.options["provider_id"]]["options"]["apiKey"])

    def turn(self, text: str, *, check: Callable[[], None] = lambda: None) -> AgentTurn:
        self.texts.append(text)
        self.events.append("turn")
        return AgentTurn(text=self.script(self, check), note="end")

    def stop(self, *, quick: bool = False) -> bool:
        self.events.append("stop")
        self.stopped.append(quick)
        return self.ends_clean

    def export_session(self, redactor: Any, seconds: float) -> Any:
        self.events.append("export")
        self.exports.append(seconds)
        if isinstance(self.export, Exception):
            raise self.export
        return self.export if self.export is not None else snapshot_of()

    def step_notes(self) -> tuple[str, ...]:
        if self.notes_fail:
            raise RuntimeError("a bug in the live view")
        return self.notes


class LeaseChannel:
    """The job host's end of the lease question: answers each `check` from `answers`."""

    def __init__(self, answers: Callable[[int], str]) -> None:
        self.asked = 0
        self._answers = answers
        process_end, host_end = socket.socketpair()
        self.process_end = process_end
        self._host_end = host_end
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        reader = self._host_end.makefile("rb")
        while reader.readline() == b"check\n":
            self.asked += 1
            self._host_end.sendall(self._answers(self.asked).encode() + b"\n")

    def fd(self) -> int:
        return self.process_end.detach()

    def close(self) -> None:
        self._host_end.close()


@dataclass
class Turn:
    """One job run through `runner.main`, with what the test needs to look at afterwards."""

    git: FakeGit
    agent: FakeAgent | None
    lease: LeaseChannel | None
    exit_code: int
    output: str
    events: list[str]
    hard_stops: list[int]
    # The events of the turn at the time the agent's container was asked to be removed, per request.
    removals: list[tuple[str, ...]] = field(default_factory=lambda: [])

    @property
    def lines(self) -> list[str]:
        return [line for line in self.output.splitlines() if line.strip()]

    @property
    def result(self) -> dict[str, Any]:
        assert len(self.lines) == 1, "the result is written exactly once"
        return cast("dict[str, Any]", json.loads(self.lines[0]))


def held(_: int) -> str:
    return "held"


def lost(_: int) -> str:
    return "lost"


def unconfirmed(_: int) -> str:
    return "unconfirmed"


def never_commits(agent: FakeAgent, check: Callable[[], None]) -> str:
    return "I could not do it."


def never_done(git: FakeGit) -> bool:
    return False


@pytest.fixture
def environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for name in list(os.environ):
        if name.startswith("RUNNER_"):
            monkeypatch.delenv(name)
    monkeypatch.setenv(ENGINES_VARIABLE, f"{ENGINE_DIFF},{ENGINE_DYNAMIC},{ENGINE_IMPLEMENTER}")
    monkeypatch.setenv("RUNNER_JOB_TIMEOUT_SECONDS", "600")
    monkeypatch.setenv("RUNNER_IMPLEMENTER_SANDBOX_PROOF", "proven")
    monkeypatch.setenv("RUNNER_IMPLEMENTER_AGENT_MEMORY_MB", "2560")
    yield


@pytest.fixture
def play(
    environment: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Iterator[Callable[..., Turn]]:
    channels: list[LeaseChannel] = []

    def run(
        script: Callable[[FakeAgent, Callable[[], None]], str],
        *,
        answers: Callable[[int], str] | None = held,
        setup_error: Exception | None = None,
        prepare_error: JobError | None = None,
        engines: str | None = None,
        dirty_error: Exception | None = None,
        dirty: bool = False,
        configure: Callable[[FakeGit], None] | None = None,
        session_error: Exception | None = None,
        cost_limit: bool = True,
        confirm_seconds: float = 0.3,
        ends_clean: bool = True,
        steps: HostEnd | None = None,
        steps_flush_seconds: float = 2.0,
        snapshot: SnapshotHost | None = None,
        export: Any = None,
        profile: dict[str, Any] | None = None,
    ) -> Turn:
        events: list[str] = []
        removals: list[tuple[str, ...]] = []
        made: list[FakeGit] = []
        agents: list[FakeAgent] = []
        hard_stops: list[int] = []
        lease = LeaseChannel(answers) if answers is not None else None
        if lease is not None:
            channels.append(lease)
            monkeypatch.setenv(LEASE_CHECK_FD_VARIABLE, str(lease.fd()))
        if engines is not None:
            monkeypatch.setenv(ENGINES_VARIABLE, engines)
        if steps is not None:
            monkeypatch.setenv(STEPS_FD_VARIABLE, str(steps.process_end.detach()))
        if snapshot is not None:
            monkeypatch.setenv(SNAPSHOT_FD_VARIABLE, str(snapshot.process_end.detach()))

        def setup(job: Any, env: Any, gate: Callable[[], None]) -> TurnSetup:
            if setup_error is not None:
                raise setup_error
            git = FakeGit(tmp_path, gate)
            git.events = events
            git.dirty_error = dirty_error
            git.is_dirty = dirty
            if prepare_error is not None:
                git.fail_prepare(prepare_error)
            if configure is not None:
                configure(git)
            made.append(git)
            return TurnSetup(git, lambda: FakePlace(events, removals), ("opencode",))

        def agent_factory(**options: Any) -> FakeAgent:
            agent = FakeAgent(
                script, events, made[0], options, ends_clean=ends_clean, export=export
            )
            agents.append(agent)
            return agent

        monkeypatch.setattr(session_module, "ImplementerAgent", agent_factory)
        monkeypatch.setattr(session_module, "start_door", fake_door)
        seams = JobSeams(
            setup=setup,
            session_seams=SessionSeams(
                confirm_seconds=confirm_seconds,
                confirm_pause=0.05,
                lease_poll_seconds=0.05,
                steps_flush_seconds=steps_flush_seconds,
                stop_steps_flush_seconds=steps_flush_seconds,
            ),
        )
        if session_error is not None:
            error = session_error

            def broken_session(job: Any, **options: Any) -> Any:
                raise error

            seams = JobSeams(setup=setup, session=broken_session)
        monkeypatch.setattr(
            runner, "run_implementer_job", partial(run_implementer_job, seams=seams)
        )
        monkeypatch.setattr(runner, "_stop_hard", lambda: hard_stops.append(1))
        output = io.StringIO()
        code = runner.main(
            [], stdin=io.StringIO(job_text(cost_limit=cost_limit, profile=profile)), stdout=output
        )
        git = made[0] if made else FakeGit(tmp_path, None)
        return Turn(
            git,
            agents[0] if agents else None,
            lease,
            code,
            output.getvalue(),
            events,
            hard_stops,
            removals,
        )

    yield run
    for channel in channels:
        channel.close()


def says_then_commits(count: int, sha: str = TIP) -> Callable[[FakeAgent, Callable[[], None]], str]:
    """A turn whose engine reported `count` finished answers, then committed."""

    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        if agent.steps is not None:  # a turn without a channel has no feeder
            for number in range(count):
                say(agent.steps, number, f"answer {number}")
        make_commit(agent, sha)
        return "Added the greeting."

    return script


def commits_then_ends(sha: str = TIP) -> Callable[[FakeAgent, Callable[[], None]], str]:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        make_commit(agent, sha)
        return "Added the greeting."

    return script


def make_commit(agent: FakeAgent, sha: str) -> None:
    agent.git.commit(sha)


def wait_for(condition: Callable[[], bool], seconds: float = 5.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.01)
    return condition()


# -- T04: job in, result out ----------------------------------------------------------------------


# #765-T04
def test_a_job_in_and_a_valid_result_out_with_the_commit_pushed_once(play: Any) -> None:
    turn = play(commits_then_ends())

    result = turn.result
    assert turn.exit_code == 0, turn.output
    assert result["ok"] is True and result["errorCode"] is None
    assert valid_result(result)
    assert result["implementer"]["pushed"] is True
    assert result["implementer"]["baseCommit"] == START
    assert result["implementer"]["headCommit"] == TIP
    assert result["implementer"]["commits"] == [{"sha": TIP, "subject": "Add it"}]
    assert result["implementer"]["summary"] == "Added the greeting."
    assert result["implementer"]["opencode"]["sessionId"] == "ses_fake"
    assert result["usage"]["aiCalls"] >= 1
    assert turn.git.pushes == [TIP]
    assert turn.events == ["agent.start", "turn", "stop", "quiet", "rescue", "push"]
    assert turn.git.prepared


# #745-T22: the container is killed before anything is read and removed after the push
def test_the_agents_container_is_removed_after_the_push_not_before(play: Any) -> None:
    turn = play(commits_then_ends())

    assert wait_for(lambda: bool(turn.removals)), "the container is taken away in the end"
    assert turn.removals[0][-1] == "push" and "stop" in turn.removals[0]
    assert turn.events[:3] == ["agent.start", "turn", "stop"]


# #765-T04: the result is the last thing a turn does, and it is written exactly once.
def test_the_result_is_one_line_and_the_exit_code_is_the_workers_one(play: Any) -> None:
    ok = play(commits_then_ends())
    gave_up = play(never_commits)

    assert len(ok.lines) == 1 and ok.exit_code == 0
    assert len(gave_up.lines) == 1 and gave_up.exit_code == 1


# #765-T04
def test_an_agent_that_did_nothing_gave_up_and_still_reports_where_it_started(play: Any) -> None:
    turn = play(never_commits)

    result = turn.result
    assert result["ok"] is False and result["errorCode"] == "agent_gave_up", turn.output
    assert valid_result(result)
    assert result["implementer"]["headCommit"] is None
    assert result["implementer"]["pushed"] is False
    assert result["implementer"]["baseCommit"] == START
    assert turn.git.pushes == []


# #765-T04
def test_a_dirty_tree_is_committed_by_the_system_and_pushed(play: Any) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        return "Wrote files, did not commit."

    turn = play(script, dirty=True)

    assert turn.result["ok"] is True
    assert turn.git.events.count("commit_all") == 1
    assert turn.git.pushes == [SECOND]


# #818-PROMPT-04
def test_a_turn_without_an_environment_is_not_told_what_a_setup_left(play: Any) -> None:
    turn = play(commits_then_ends())

    assert turn.agent is not None
    _, text = turn.agent.options["instructions"]
    assert "Rules of this workplace" in text
    assert "environment's setup left" not in text and "git add -f" not in text


# #765-T04
def test_a_job_the_runner_did_not_advertise_is_refused_before_anything_is_touched(
    play: Any,
) -> None:
    turn = play(commits_then_ends(), engines=f"{ENGINE_DIFF},{ENGINE_DYNAMIC}", setup_error=None)

    result = turn.result
    assert turn.exit_code == 1
    assert result["errorCode"] == "implementer_engine_unavailable"
    assert "implementer" not in result
    assert valid_result(result)
    assert turn.agent is None and turn.git.pushes == []
    assert turn.git.prepared is False  # nothing of the setup ran


# #765-T04
@pytest.mark.parametrize("code", [ErrorCode.CLONE_FAILED, ErrorCode.BASE_BRANCH_NOT_FOUND])
def test_a_clone_that_failed_has_no_repository_and_so_no_implementer_key(
    play: Any, code: ErrorCode
) -> None:
    turn = play(
        commits_then_ends(), prepare_error=JobError(code, "the base branch cannot be cloned")
    )

    result = turn.result
    assert result["errorCode"] == code.value
    assert "implementer" not in result  # never null: the app refuses a null
    assert valid_result(result)


# #765-T04
def test_a_setup_that_fails_before_any_clone_has_no_key_either(play: Any) -> None:
    turn = play(
        commits_then_ends(),
        setup_error=JobError(ErrorCode.SETUP_FAILED, "the engine user is not usable"),
    )

    result = turn.result
    assert result["errorCode"] == "setup_failed"
    assert "implementer" not in result
    assert result["usage"] is None


# #765-T04
def test_a_setup_that_fails_after_the_clone_reports_the_base_commit_and_nothing_else(
    play: Any,
) -> None:
    turn = play(
        commits_then_ends(),
        prepare_error=JobError(ErrorCode.SETUP_FAILED, "the agent repository cannot be cloned"),
    )

    result = turn.result
    assert result["errorCode"] == "setup_failed"
    assert result["usage"] is None  # nothing was spent: the free code
    assert valid_result(result)
    assert result["implementer"] == {
        "baseCommit": START,
        "headCommit": None,
        "pushed": False,
        "branches": [],
        "branchesDropped": {"invalid": 0, "overflow": 0},
        "commits": [],
        "filesChanged": [],
        "summary": "",
        "opencode": None,
    }


# -- the money is spent: never a free code --------------------------------------------------------


# #765
def test_a_repository_that_cannot_be_read_after_the_agent_ran_is_a_charged_push_rejected(
    play: Any,
) -> None:
    def unreadable(git: FakeGit) -> None:
        git.push_all = lambda **_: PushReport(listed=False)  # type: ignore[method-assign]
        git.push_report = lambda: PushReport(listed=False)  # type: ignore[method-assign]

    turn = play(commits_then_ends(), configure=unreadable)

    result = turn.result
    assert result["errorCode"] == "push_rejected"
    assert result["errorCode"] not in ("setup_failed", "runner_error")
    assert result["usage"]["aiCalls"] >= 1
    assert valid_result(result)


# #765
def test_an_engine_that_crashes_after_it_used_the_model_is_not_a_runner_error(play: Any) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        raise RuntimeError("the engine's own bug")

    turn = play(script)

    assert turn.result["errorCode"] == "agent_gave_up"
    assert turn.result["usage"]["aiCalls"] >= 1


# #765
def test_an_engine_that_crashes_before_the_model_is_a_runner_error_and_costs_nothing(
    play: Any,
) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        raise RuntimeError("the engine's own bug")

    turn = play(script)

    assert turn.result["errorCode"] == "runner_error"
    assert turn.result["usage"] is None


# #765
def test_a_bug_of_the_session_before_any_model_call_is_a_free_runner_error(play: Any) -> None:
    turn = play(commits_then_ends(), session_error=RuntimeError("a bug"))

    assert turn.result["errorCode"] == "runner_error"
    assert turn.result["usage"] is None


class SpentSession:
    """A session that used the model and then failed in a way nobody expected."""

    def __init__(self, job: Any, **options: Any) -> None:
        limits = agent_limits(600.0, Decimal("5"), "cost_limit")
        prices = UnitCosts(input_usd_per_mtok=Decimal(3), output_usd_per_mtok=Decimal(15))
        self.ledger = BudgetLedger(limits, unit_costs=prices, clock=time.monotonic)

    def run(self) -> Any:
        reservation = self.ledger.reserve_call("x" * 400)
        self.ledger.settle_call(
            reservation, prompt_tokens=100, completion_tokens=10, cost=Decimal("0.001")
        )
        raise RuntimeError("a bug after the money was spent")

    def secrets(self) -> tuple[str, ...]:
        return ()


# #765
def test_a_bug_after_the_model_was_used_is_never_the_free_runner_error(
    environment: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def setup(job: Any, env: Any, gate: Callable[[], None]) -> TurnSetup:
        git = FakeGit(tmp_path, gate)
        return TurnSetup(git, FakePlace, ("opencode",))

    seams = JobSeams(setup=setup, session=SpentSession)
    monkeypatch.setattr(runner, "run_implementer_job", partial(run_implementer_job, seams=seams))
    output = io.StringIO()

    code = runner.main([], stdin=io.StringIO(job_text()), stdout=output)

    result = json.loads(output.getvalue())
    assert code == 1
    assert result["errorCode"] == "agent_gave_up"
    assert result["usage"]["aiCalls"] == 1
    assert valid_result(result)


# #765-R7
def test_a_job_without_any_cost_limit_does_not_start(play: Any) -> None:
    turn = play(commits_then_ends(), cost_limit=False)

    result = turn.result
    assert turn.exit_code == 1
    assert result["errorCode"] == "implementer_config_invalid"
    assert "implementer" not in result and result["usage"] is None
    assert turn.agent is None and turn.git.prepared is False
    assert valid_result(result)


# -- T05: the lease -------------------------------------------------------------------------------


def commits_and_waits_for(
    condition: Callable[[FakeGit], bool], sha: str = TIP
) -> Callable[[FakeAgent, Callable[[], None]], str]:
    """The agent commits, then keeps working until `condition` holds or its watch ends the turn."""

    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        git = agent.git
        make_commit(agent, sha)
        end = time.monotonic() + 10
        while time.monotonic() < end and not condition(git):
            check()
            time.sleep(0.02)
        return "worked"

    return script


# #765-T05
def test_a_lease_lost_during_the_turn_aborts_the_engine_and_pushes_nothing(play: Any) -> None:
    turn = play(commits_and_waits_for(never_done), answers=lost)

    result = turn.result
    assert turn.exit_code == 1
    assert result["errorCode"] == "lease_lost"
    assert valid_result(result)
    assert turn.git.pushes == []
    assert turn.agent is not None and turn.agent.stopped  # the engine was ended
    assert turn.events[-1] != "push" and "push" not in turn.events
    assert result["implementer"]["pushed"] is False
    assert result["implementer"]["branches"] == []
    assert "commit_all" not in turn.git.events


# #765-T05
def test_nothing_is_pushed_after_the_lease_was_lost_even_if_the_agent_commits_again(
    play: Any,
) -> None:
    def first_held_then_lost(number: int) -> str:
        return "held" if number == 1 else "lost"

    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        make_commit(agent, TIP)
        end = time.monotonic() + 10
        while time.monotonic() < end:
            check()
            time.sleep(0.02)
        return "worked"

    turn = play(script, answers=first_held_then_lost)

    assert turn.result["errorCode"] == "lease_lost"
    assert turn.git.pushes == []  # no commit reached the provider
    assert turn.result["implementer"]["pushed"] is False


# #765-T05
def test_a_lease_that_cannot_be_confirmed_is_no_lease(play: Any) -> None:
    turn = play(commits_and_waits_for(never_done), answers=unconfirmed)

    assert turn.result["errorCode"] == "lease_lost"
    assert turn.git.pushes == []


# #765-R2: one unanswered question while the agent works is a "not now", not the end of the turn.
def test_an_app_that_is_silent_once_does_not_end_the_turn(play: Any) -> None:
    asked: list[int] = []

    def silent_first(number: int) -> str:
        asked.append(number)
        return "unconfirmed" if number <= 2 else "held"

    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        make_commit(agent, TIP)
        end = time.monotonic() + 5
        while time.monotonic() < end and len(asked) < 3:
            check()  # the watch asks the host every few hundredths of a second in this test
            time.sleep(0.02)
        return "done"

    turn = play(script, answers=silent_first, confirm_seconds=5.0)

    assert len(asked) >= 3, "the watch asked while the agent worked"
    assert turn.result["ok"] is True
    assert turn.result["implementer"]["pushed"] is True
    assert turn.git.pushes == [TIP]


# #765-R2: the last push asks again within its window and pushes when the app answers in time.
def test_the_last_push_asks_again_and_pushes_when_the_app_answers_in_time(play: Any) -> None:
    def silent_then_held(number: int) -> str:
        return "unconfirmed" if number == 1 else "held"

    turn = play(commits_then_ends(), answers=silent_then_held, confirm_seconds=5.0)

    assert turn.result["ok"] is True
    assert turn.git.pushes == [TIP]


# #765-R2: a lost lease is final, however long the window.
def test_a_lost_lease_is_not_asked_again(play: Any) -> None:
    turn = play(commits_and_waits_for(never_done), answers=lost, confirm_seconds=5.0)

    assert turn.result["errorCode"] == "lease_lost"
    assert turn.git.pushes == []
    assert turn.lease is not None and turn.lease.asked <= 3


# #765-T05
def test_a_process_started_without_the_lease_channel_never_pushes(play: Any) -> None:
    turn = play(commits_then_ends(), answers=None)

    assert turn.result["errorCode"] == "lease_lost"
    assert turn.git.pushes == []


# #765-T05
def test_the_lease_is_asked_before_the_listing_and_before_every_push_not_once(play: Any) -> None:
    def configure(git: FakeGit) -> None:
        git.other_branches = {"second": SECOND}

    turn = play(commits_then_ends(), configure=configure)

    assert turn.result["ok"] is True
    assert turn.git.pushes == [TIP, SECOND]
    assert (
        turn.lease is not None and turn.lease.asked >= 3
    )  # the listing, the form's push, one more


# -- the report names every branch --------------------------------------------------------------


# #git-free
def test_every_pushed_branch_is_in_the_report_and_the_form_branch_has_the_commits(
    play: Any,
) -> None:
    def configure(git: FakeGit) -> None:
        git.other_branches = {"experiment/two": SECOND}

    turn = play(commits_then_ends(), configure=configure)

    block = turn.result["implementer"]
    assert turn.result["ok"] is True and valid_result(turn.result)
    assert block["branches"] == [
        {"name": "implementer/a1b2c3", "head": TIP, "result": "pushed", "reason": None},
        {"name": "experiment/two", "head": SECOND, "result": "pushed", "reason": None},
    ]
    assert block["headCommit"] == TIP and block["pushed"] is True
    assert block["commits"] == [{"sha": TIP, "subject": "Add it"}]


# #git-free
def test_a_rejected_branch_is_reported_with_its_reason_and_the_turn_still_succeeds(
    play: Any,
) -> None:
    def configure(git: FakeGit) -> None:
        git.other_branches = {"main": SECOND}
        git.rejected = {"main": "non_fast_forward"}

    turn = play(commits_then_ends(), configure=configure)

    block = turn.result["implementer"]
    assert turn.result["ok"] is True, turn.output
    assert {"name": "main", "head": SECOND, "result": "rejected", "reason": "non_fast_forward"} in (
        block["branches"]
    )
    assert block["pushed"] is True


# #git-free
def test_a_form_branch_that_is_rejected_ends_the_turn_push_rejected_and_keeps_the_others(
    play: Any,
) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        return "worked on another branch only"

    def configure(git: FakeGit) -> None:
        git.tip = TIP
        git.commits = [CommitInfo(TIP, "Add it")]
        git.other_branches = {"second": SECOND}
        git.rejected = {"implementer/a1b2c3": "non_fast_forward"}

    # The fake rejects only the other branches by name; the form's branch is rejected by making
    # its push fail through the same list.
    original = FakeGit.push_all

    def push_all(self: FakeGit, **options: Any) -> Any:
        report = original(self, **options)
        rejected = BranchPush(self.spec.branch, TIP, False, "non_fast_forward")
        self._progress.branches[:] = [  # pyright: ignore[reportPrivateUsage]
            rejected if entry.name == self.spec.branch else entry for entry in report.branches
        ]
        return self.push_report()

    FakeGit.push_all = push_all  # type: ignore[method-assign]
    try:
        turn = play(script, configure=configure)
    finally:
        FakeGit.push_all = original  # type: ignore[method-assign]

    block = turn.result["implementer"]
    assert turn.result["errorCode"] == "push_rejected"
    assert block["pushed"] is False and block["headCommit"] == TIP
    assert [b["name"] for b in block["branches"] if b["result"] == "pushed"] == ["second"]


# #git-free
def test_work_only_on_another_branch_is_a_success_with_no_form_head(play: Any) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        return "worked elsewhere"

    def configure(git: FakeGit) -> None:
        git.other_branches = {"elsewhere": SECOND}

    turn = play(script, configure=configure)

    block = turn.result["implementer"]
    assert turn.result["ok"] is True
    assert block["headCommit"] is None and block["pushed"] is False
    assert block["branches"] == [
        {"name": "elsewhere", "head": SECOND, "result": "pushed", "reason": None}
    ]


# -- T06: SIGTERM ---------------------------------------------------------------------------------


def sends_sigterm_after_committing(
    agent: FakeAgent, check: Callable[[], None], sha: str = TIP
) -> str:
    agent.use_the_model()
    make_commit(agent, sha)
    os.kill(os.getpid(), signal.SIGTERM)
    end = time.monotonic() + 10
    while time.monotonic() < end:
        check()  # raises the stop within the watch interval
        time.sleep(0.02)
    return "never reached"


# #765-T06
def test_sigterm_ends_the_engine_pushes_what_is_committed_and_reports_runner_shutdown(
    play: Any,
) -> None:
    turn = play(sends_sigterm_after_committing, dirty=True)

    result = turn.result
    assert result["errorCode"] == "runner_shutdown"
    assert result["ok"] is False and turn.exit_code == 1
    assert turn.git.pushes == [TIP]
    # The engine first (quickly: seconds, not minutes), then the push, nothing in between: the
    # leftover is not committed on a stop.
    assert turn.events == ["agent.start", "turn", "stop", "quiet", "rescue", "push"]
    assert result["implementer"]["pushed"] is True
    assert result["implementer"]["headCommit"] == TIP
    assert valid_result(result)


# #765-T06
def test_a_stop_does_not_push_for_a_job_that_is_not_ours_any_more(play: Any) -> None:
    turn = play(sends_sigterm_after_committing, answers=lost)

    assert turn.result["errorCode"] == "runner_shutdown"  # the first end counts
    assert turn.git.pushes == []


# #765-T06
def test_the_handler_arms_a_backstop_that_ends_a_turn_stuck_where_the_watch_cannot_reach(
    play: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(runner, "IMPLEMENTER_SIGTERM_BACKSTOP_SECONDS", 0.05)

    def stuck(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(0.5)  # not looking at the watch
        return "late"

    turn = play(stuck)

    assert turn.hard_stops == [
        1
    ]  # `_stop_hard` ran once: the engines are ended and the process exits


# #765-T06
def test_the_process_leaves_itself_less_time_than_the_host_gives_it() -> None:
    spec = json.loads(
        (
            ROOT / "contracts" / "examples" / "worker-container" / "ImplementerContainerSpec.json"
        ).read_text(encoding="utf-8")
    )

    # The process ends itself first, the host kills it after, the container's stop is above both.
    assert (
        SIGTERM_BACKSTOP_SECONDS < IMPLEMENTER_TERMINATE_GRACE_SECONDS < spec["stopTimeoutSeconds"]
    )
    assert SIGTERM_BACKSTOP_SECONDS == runner.IMPLEMENTER_SIGTERM_BACKSTOP_SECONDS
    # A default Diff or Dynamic job keeps the grace it had.
    assert WorkerSettings().terminate_grace == 5.0


# -- T07: the secrets -----------------------------------------------------------------------------


# #765-T07
def test_the_capability_is_in_no_text_of_the_report_subjects_and_paths_included(
    play: Any,
) -> None:
    capabilities: list[str] = []

    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        capability = agent.capability()
        capabilities.append(capability)
        agent.git.commit(TIP, f"uses {capability}")
        agent.git.files = [FileChange(f"src/{capability}.ts", ChangeKind.ADDED)]
        return "done"

    turn = play(script)

    line = turn.lines[0]
    assert capabilities[0] not in line
    assert turn.result["ok"] is True
    assert turn.result["implementer"]["headCommit"] == TIP
    assert valid_result(turn.result)


# #765-T07
def test_the_token_the_key_and_the_capability_are_in_no_output_of_the_turn(
    play: Any, capfd: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    capabilities: list[str] = []

    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        capability = agent.capability()
        capabilities.append(capability)
        make_commit(agent, TIP)
        return f"leaked {TOKEN} and {KEY} and {capability}"

    turn = play(script)

    out, err = capfd.readouterr()
    everything = turn.output + out + err + caplog.text
    assert capabilities and capabilities[0]
    for secret in (TOKEN, KEY, capabilities[0]):
        assert secret not in everything, "a secret reached an output"
    assert turn.result["ok"] is True
    assert "leaked" in turn.result["implementer"]["summary"]


# -- review of #815: what the turn says about the task's branch and the work it saved --------------


@pytest.mark.parametrize("reason", ["unreadable", "not_a_commit", "timed_out"])
def test_a_task_branch_that_was_not_taken_over_is_not_a_success_whatever_else_was_pushed(
    play: Any, reason: str
) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        return "worked"

    def configure(git: FakeGit) -> None:
        git.form_rejected = (reason, None)
        git.other_branches = {"second": SECOND}

    turn = play(script, configure=configure)

    block = turn.result["implementer"]
    assert turn.result["errorCode"] == "push_rejected", turn.output
    assert valid_result(turn.result)
    assert [(b["name"], b["result"], b["reason"]) for b in block["branches"]] == [
        ("implementer/a1b2c3", "rejected", reason),
        ("second", "pushed", None),
    ]


def test_a_task_branch_that_is_verifiably_empty_does_not_stop_another_branch_from_succeeding(
    play: Any,
) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        return "worked elsewhere"

    def configure(git: FakeGit) -> None:
        git.other_branches = {"elsewhere": SECOND}

    assert play(script, configure=configure).result["ok"] is True


def test_a_task_branch_that_is_gone_is_not_verifiably_empty_so_another_branch_is_no_success(
    play: Any,
) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        return "worked elsewhere"

    def configure(git: FakeGit) -> None:
        git.form_gone = True
        git.other_branches = {"elsewhere": SECOND}

    turn = play(script, configure=configure)

    assert turn.result["errorCode"] == "push_rejected", turn.output
    assert [b["name"] for b in turn.result["implementer"]["branches"]] == ["elsewhere"]


def test_the_counts_of_the_branches_that_were_left_out_are_in_the_report(play: Any) -> None:
    def configure(git: FakeGit) -> None:
        git.dropped = (3, 7)

    turn = play(commits_then_ends(), configure=configure)

    assert turn.result["implementer"]["branchesDropped"] == {"invalid": 3, "overflow": 7}
    assert valid_result(turn.result)


def test_work_saved_from_a_detached_head_is_in_the_summary_and_the_notes(play: Any) -> None:
    def configure(git: FakeGit) -> None:
        git.rescue_name = "implementer/a1b2c3-leftover-1234abcd"

    turn = play(commits_then_ends(), configure=configure)

    assert "implementer/a1b2c3-leftover-1234abcd" in turn.result["implementer"]["summary"]
    assert turn.events[:5] == ["agent.start", "turn", "stop", "quiet", "rescue"]


# #745-T27: a disk that is full is said, not hidden
def test_a_branch_that_found_no_room_is_named_and_the_disk_is_said_to_be_full(play: Any) -> None:
    def configure(git: FakeGit) -> None:
        git.other_branches = {"experiment/big": "b" * 40}
        git.rejected = {"experiment/big": "out_of_space"}
        git.volume_free = 10 * 1024**2

    turn = play(commits_then_ends(), configure=configure)

    log = turn.result["logTail"]
    assert "experiment/big: rejected (out_of_space)" in log
    assert "the disk of the workspace had no room" in log
    assert "the VM's disk had 10 MB left at the end" in log
    assert turn.result["implementer"]["pushed"] is True, "the work that arrived is still reported"


def test_a_disk_with_room_adds_no_note(play: Any) -> None:
    def configure(git: FakeGit) -> None:
        git.volume_free = 50 * 1024**3

    turn = play(commits_then_ends(), configure=configure)

    assert "disk" not in turn.result["logTail"]


def test_the_leftover_is_committed_after_the_agents_container_is_gone_and_before_the_push(
    play: Any,
) -> None:
    turn = play(commits_then_ends(), dirty=True)

    assert turn.events == [
        "agent.start",
        "turn",
        "turn",
        "stop",
        "quiet",
        "rescue",
        "commit_all",
        "quiet",
        "push",
    ]


# #745: a process a filter left in a reader must not live on into the commit or the push
def test_a_clean_tree_needs_one_quiet_and_none_for_a_commit_that_is_not_made(
    play: Any,
) -> None:
    turn = play(commits_then_ends(), dirty=False)

    assert turn.events.count("quiet") == 1 and "commit_all" not in turn.events
    assert turn.events.index("quiet") < turn.events.index("rescue")


def test_readers_that_cannot_be_made_quiet_are_said_and_the_end_goes_on(play: Any) -> None:
    def configure(git: Any) -> None:
        git.readers_quiet = False

    turn = play(commits_then_ends(), dirty=True, configure=configure)

    assert "could not be made quiet" in turn.result["logTail"]
    assert turn.git.pushes, "the push is still tried; it fails closed on a reader it cannot use"


def test_when_the_agents_container_is_not_confirmed_gone_nothing_is_committed(
    play: Any,
) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        make_commit(agent, TIP)
        return "done"

    turn = play(script, dirty=True, ends_clean=False)

    assert "commit_all" not in turn.events and "rescue" not in turn.events
    assert turn.git.pushes == [TIP], "what was committed is still pushed"
    assert "were not looked for" in turn.result["implementer"]["summary"]


# -- the step records ride on the event stream and change nothing (#745) -------------------------


# #745-L12
def test_what_the_live_view_lost_is_in_the_notes_of_the_turn(play: Any) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        make_commit(agent, TIP)
        agent.notes = ("the live view dropped 7 step records that were not taken in time",)
        return "done"

    turn = play(script)

    assert turn.exit_code == 0, turn.output
    assert "the live view dropped 7 step records" in turn.result["logTail"]


# #745-L12: the notes of the live view are read in the cleanup of the turn; a bug there must not
# replace the turn's outcome or keep the doors from closing.
def test_a_live_view_that_fails_at_the_end_changes_nothing_of_the_turn(play: Any) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        make_commit(agent, TIP)
        agent.notes_fail = True
        return "done"

    turn = play(script)

    assert turn.exit_code == 0, turn.output
    assert turn.git.pushes == [TIP]


class ScriptedEvents:
    """The engine's event stream of the test: `send` queues an event for the reader's thread."""

    def __init__(self) -> None:
        self.lines: queue.Queue[bytes] = queue.Queue()

    def send(self, event: dict[str, Any]) -> None:
        self.lines.put(f"data: {json.dumps(event)}\n".encode())
        self.lines.put(b"\n")

    def readline(self, limit: int = -1, /) -> bytes:
        return self.lines.get(timeout=5)

    def close(self) -> None:
        self.lines.put(b"")


def tool_part_event(identity: str, status: str) -> dict[str, Any]:
    state: dict[str, Any] = {"status": status, "input": {"command": "x"}, "time": {"start": 1}}
    if status == "completed":
        state.update({"output": "ok", "title": "x", "metadata": {}, "time": {"start": 1, "end": 2}})
    part = {
        "id": f"prt_{identity}",
        "type": "tool",
        "callID": identity,
        "tool": "bash",
        "state": state,
    }
    return {
        "type": "message.part.updated",
        "properties": {"sessionID": "ses_fake", "part": part, "time": 5},
    }


def plays_with_steps(steps: Callable[[], Any]) -> Callable[[FakeAgent, Callable[[], None]], str]:
    """A turn whose events go through a real `EventReader` with the audit and `steps` after it."""

    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        events = ScriptedEvents()
        reader = EventReader(
            lambda: events,
            [ToolPartAudit(agent.ledger, "ses_fake", export_root="/work/repo"), steps()],
            agent.ledger,
        )
        events.send({"type": "server.connected", "properties": {}})
        reader.start(5.0)
        for identity in ("call_1", "call_2"):
            events.send(tool_part_event(identity, "running"))
            events.send(tool_part_event(identity, "completed"))
        assert wait_for(lambda: agent.ledger.tool_calls == 2)
        reader.stop()
        agent.use_the_model()
        make_commit(agent, TIP)
        return "Added the greeting."

    return script


def what_the_turn_did(turn: Turn) -> dict[str, Any]:
    ledger = turn.agent.ledger if turn.agent else None
    result = turn.result
    return {
        "exit": turn.exit_code,
        "ok": result["ok"],
        "errorCode": result["errorCode"],
        "implementer": result["implementer"],
        "usage": result["usage"],
        "pushes": turn.git.pushes,
        "events": turn.events,
        "toolCalls": None if ledger is None else ledger.tool_calls,
        "returnedBytes": None if ledger is None else ledger.returned_bytes,
        "failure": None if ledger is None else ledger.failure,
    }


# #745-L11
def test_a_step_feeder_that_throws_changes_neither_the_ledger_nor_the_outcome_nor_the_push(
    play: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    def make_steps() -> StepFeeder:
        return StepFeeder("ses_fake", Redactor([TOKEN]))

    baseline = play(plays_with_steps(make_steps))

    def explode(self: StepConverter, event: Any) -> Any:
        raise RuntimeError("a bug in the converter")

    monkeypatch.setattr(StepConverter, "convert", explode)
    broken = play(plays_with_steps(make_steps))

    assert baseline.exit_code == 0 and broken.exit_code == 0, broken.output
    assert what_the_turn_did(broken) == what_the_turn_did(baseline)
    assert broken.git.pushes == [TIP]
    assert what_the_turn_did(broken)["toolCalls"] == 2
    assert what_the_turn_did(broken)["failure"] is None


# -- the step records leave the process over the steps channel (#745, PR 3) -----------------------


def sigterm_after_saying(
    count: int,
) -> Callable[[FakeAgent, Callable[[], None]], str]:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        assert agent.steps is not None
        for number in range(count):
            say(agent.steps, number)
        return sends_sigterm_after_committing(agent, check)

    return script


# #745-L22
def test_the_records_reach_the_host_in_order_and_the_turn_did_exactly_what_it_did_without(
    play: Any,
) -> None:
    without = play(says_then_commits(5))
    host = HostEnd()

    watched = play(says_then_commits(5), steps=host)

    assert watched.exit_code == 0, watched.output
    assert [record["text"] for record in host.records] == [f"answer {n}" for n in range(5)]
    assert [record["seq"] for record in host.records] == [1, 2, 3, 4, 5]
    assert len(host.flushes) == 1, "the last flush came once, before the result"
    assert what_the_turn_did(watched) == what_the_turn_did(without)
    assert watched.result["logTail"] == without.result["logTail"], "nothing was lost, no note"
    host.close()


# #745-L23
def test_a_host_that_never_reads_costs_the_flush_budget_and_changes_nothing_else(
    play: Any,
) -> None:
    without = play(says_then_commits(5))
    host = HostEnd(reads=False)
    began = time.monotonic()

    watched = play(says_then_commits(5), steps=host, steps_flush_seconds=1.2)

    assert time.monotonic() - began < 6
    assert watched.exit_code == 0, watched.output
    assert what_the_turn_did(watched) == what_the_turn_did(without)
    assert "the live view could not" in watched.result["logTail"]
    host.close()


# #745-L25
def test_a_host_that_does_not_answer_the_flush_changes_nothing_and_leaves_one_note(
    play: Any,
) -> None:
    without = play(says_then_commits(3))
    host = HostEnd(answers=False)

    watched = play(says_then_commits(3), steps=host, steps_flush_seconds=1.2)

    assert what_the_turn_did(watched) == what_the_turn_did(without)
    assert "could not confirm that its last step records arrived" in watched.result["logTail"]
    host.close()


# #745-L25
def test_what_the_host_could_not_send_is_one_line_in_the_notes_of_the_turn(play: Any) -> None:
    host = HostEnd(unsent=4)

    watched = play(says_then_commits(6), steps=host)

    assert watched.exit_code == 0, watched.output
    assert "the live view could not send 4 step records to the app" in watched.result["logTail"]
    assert "not taken in time" not in watched.result["logTail"], "counted once, not twice"
    host.close()


# #745-L24
def test_a_host_that_has_gone_changes_nothing_about_the_turn(play: Any) -> None:
    without = play(says_then_commits(5))
    host = HostEnd()
    host.close()  # the host closed its end before the turn began

    watched = play(says_then_commits(5), steps=host)

    assert what_the_turn_did(watched) == what_the_turn_did(without)
    assert watched.git.pushes == [TIP]


# #745-L26
def test_a_turn_without_a_channel_has_no_feeder_so_nothing_is_queued_or_lost(play: Any) -> None:
    turn = play(commits_then_ends())

    assert turn.agent is not None
    assert turn.agent.options["redactor"] is None
    assert turn.agent.steps is None
    assert "live view" not in turn.result["logTail"]


# #745-L25
def test_a_stop_flushes_too_and_still_ends_runner_shutdown_with_the_commits_pushed(
    play: Any,
) -> None:
    host = HostEnd()

    turn = play(sigterm_after_saying(4), steps=host, dirty=True)

    assert turn.result["errorCode"] == "runner_shutdown"
    assert turn.git.pushes == [TIP]
    assert len(host.records) == 4 and len(host.flushes) == 1
    host.close()


# -- the engine's session leaves for the app at the end of the turn (#839, PR 7) -------------------


def what_a_snapshot_changes(turn: Turn) -> dict[str, Any]:
    """The turn's outcome, without the one event the export adds."""
    did = what_the_turn_did(turn)
    return {**did, "events": [event for event in did["events"] if event != "export"]}


# #839-T16
def test_the_session_is_exported_before_the_container_is_killed_and_handed_to_the_host(
    play: Any,
) -> None:
    without = play(commits_then_ends())
    host = SnapshotHost()

    turn = play(commits_then_ends(), snapshot=host)

    assert turn.exit_code == 0, turn.output
    assert turn.events.index("export") < turn.events.index("stop"), "read from the running engine"
    assert turn.agent is not None and turn.agent.exports == [5.0]
    assert host.wait()
    assert host.header is not None and host.header.version == "1.19.0"
    assert host.data == snapshot_of().data
    assert what_a_snapshot_changes(turn) == what_a_snapshot_changes(without)
    assert turn.result["logTail"] == without.result["logTail"], "nothing to say about a success"
    host.close()


# #839-T16
def test_a_stop_takes_the_export_in_two_seconds_and_still_ends_runner_shutdown(play: Any) -> None:
    host = SnapshotHost()

    turn = play(sends_sigterm_after_committing, snapshot=host, dirty=True)

    assert turn.result["errorCode"] == "runner_shutdown"
    assert turn.agent is not None and turn.agent.exports == [2.0]
    assert turn.git.pushes == [TIP]
    assert host.wait() and host.data == snapshot_of().data
    host.close()


# #839-T17
@pytest.mark.parametrize(
    ("export", "word"),
    [
        (ExportFailed(ExportReason.TOO_LARGE), "too_large"),
        (ExportFailed(ExportReason.OUT_OF_TIME), "out_of_time"),
        (ExportFailed(ExportReason.UNREACHABLE), "engine_unreachable"),
        (RuntimeError("a bug in the export"), "export_failed"),
    ],
)
def test_an_export_that_fails_is_one_note_and_changes_nothing_about_the_turn(
    play: Any, export: Exception, word: str
) -> None:
    without = play(commits_then_ends())
    host = SnapshotHost()

    turn = play(commits_then_ends(), snapshot=host, export=export)

    assert what_a_snapshot_changes(turn) == what_a_snapshot_changes(without)
    assert f"the session was not saved for a follow-up turn: {word}" in turn.result["logTail"]
    assert "a bug in the export" not in turn.result["logTail"], "a reason word, never the text"
    assert host.wait() and host.data == b"", "the channel is closed with nothing in it"
    host.close()


# #839-T17
def test_a_host_that_never_reads_costs_the_budget_and_changes_nothing_else(play: Any) -> None:
    without = play(commits_then_ends())
    host = SnapshotHost(reads=False)
    big = snapshot_of(b"\x1f\x8b" + os.urandom(8_000_000))

    began = time.monotonic()
    turn = play(commits_then_ends(), snapshot=host, export=big)

    assert time.monotonic() - began < 15
    assert what_a_snapshot_changes(turn) == what_a_snapshot_changes(without)
    assert "not handed to the host" in turn.result["logTail"]
    host.close()


# #839-T17
def test_a_snapshot_host_that_has_gone_changes_nothing_about_the_turn(play: Any) -> None:
    without = play(commits_then_ends())
    host = SnapshotHost()
    host.close()  # the host closed its end before the turn began

    turn = play(commits_then_ends(), snapshot=host)

    assert what_a_snapshot_changes(turn) == what_a_snapshot_changes(without)
    assert turn.git.pushes == [TIP]


# #839-T18
def test_a_turn_without_a_channel_exports_nothing(play: Any) -> None:
    turn = play(commits_then_ends())

    assert turn.agent is not None and turn.agent.exports == []
    assert "export" not in turn.events
    assert "follow-up" not in turn.result["logTail"]


# #839-T18
def test_a_lost_lease_exports_nothing_and_closes_the_channel(play: Any) -> None:
    host = SnapshotHost()

    def asks_the_lease(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        time.sleep(0.1)  # the watch asks every 0.05 s in this test
        check()
        return "unreachable"

    turn = play(asks_the_lease, snapshot=host, answers=lost)

    assert turn.result["errorCode"] == "lease_lost"
    assert turn.agent is not None and turn.agent.exports == []
    assert host.wait() and host.data == b""
    host.close()


# #839-T18
def test_the_session_is_exported_when_the_turn_ended_badly_too(play: Any) -> None:
    host = SnapshotHost()

    turn = play(never_commits, snapshot=host)

    assert turn.result["ok"] is False
    assert turn.agent is not None and turn.agent.exports == [5.0], (
        "the conversation is worth keeping"
    )
    assert host.wait() and host.data == snapshot_of().data
    host.close()


# -- #843: the profile of a turn ------------------------------------------------------------------

NO_PUSH = {"name": "reviewer", "version": 3, "canPush": False, "instructions": "Review only."}
MAY_PUSH = {"name": "writer", "version": 2, "canPush": True}


# #843-T200
def test_a_profile_without_the_right_to_push_pushes_nothing_though_the_agent_committed(
    play: Any,
) -> None:
    turn = play(commits_then_ends(), profile=NO_PUSH)

    result = turn.result
    assert turn.exit_code == 0, turn.output
    assert result["ok"] is True and result["errorCode"] is None
    assert valid_result(result)
    assert turn.git.push_calls == 0 and turn.git.pushes == []
    assert "push" not in turn.events
    block = result["implementer"]
    assert block["pushed"] is False
    assert block["headCommit"] is None
    assert block["branches"] == [] and block["commits"] == [] and block["filesChanged"] == []
    assert block["branchesDropped"] == {"invalid": 0, "overflow": 0}
    assert block["baseCommit"] == START
    assert block["summary"] == "Added the greeting."
    assert block["opencode"]["sessionId"] == "ses_fake"
    assert result["usage"]["aiCalls"] >= 1


# #843-T201
def test_a_profile_without_the_right_to_push_is_a_success_though_the_agent_made_no_commit(
    play: Any,
) -> None:
    turn = play(never_commits, profile=NO_PUSH)

    result = turn.result
    assert result["ok"] is True and result["errorCode"] is None, turn.output
    assert valid_result(result)
    assert result["implementer"]["summary"] == "I could not do it."
    assert result["implementer"]["pushed"] is False
    assert turn.git.push_calls == 0


# #843-T202
def test_a_profile_without_the_right_to_push_does_not_commit_the_leftovers_either(
    play: Any,
) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        return "Looked around."

    turn = play(script, dirty=True, profile=NO_PUSH)

    assert turn.result["ok"] is True
    assert turn.git.events.count("commit_all") == 0
    assert turn.git.push_calls == 0
    # Nothing is collected from the tree, so a dirty tree is no reason for a second, paid message.
    assert turn.events.count("turn") == 1


# #843-T203
def test_a_profile_without_the_right_to_push_asks_the_lease_no_more_than_it_needs(
    play: Any,
) -> None:
    turn = play(commits_then_ends(), profile=NO_PUSH)

    assert turn.lease is not None
    # No listing and no push to guard: the lease is asked at most by the watch during the turn.
    assert turn.git.push_calls == 0
    assert turn.result["ok"] is True


# #843-T204
def test_a_profile_with_the_right_to_push_is_todays_implementer(play: Any) -> None:
    turn = play(commits_then_ends(), profile=MAY_PUSH)

    result = turn.result
    assert result["ok"] is True and valid_result(result)
    assert result["implementer"]["pushed"] is True
    assert result["implementer"]["headCommit"] == TIP
    assert turn.git.pushes == [TIP]
    assert turn.events == ["agent.start", "turn", "stop", "quiet", "rescue", "push"]


# #843-T205
def test_the_agent_gets_the_text_of_the_profile_after_the_rules_of_the_workplace(
    play: Any,
) -> None:
    turn = play(commits_then_ends(), profile={**MAY_PUSH, "instructions": "Use tabs.\nNo emoji."})

    assert turn.agent is not None
    _, text = turn.agent.options["instructions"]
    assert text.index("Rules of this workplace") < text.index("Use tabs.")
    assert text.endswith("Use tabs.\nNo emoji.")


# #843-T206
def test_a_profile_that_may_push_and_has_no_text_gives_the_agent_the_text_of_before(
    play: Any,
) -> None:
    plain = play(commits_then_ends())
    profiled = play(commits_then_ends(), profile=MAY_PUSH)

    assert plain.agent is not None and profiled.agent is not None
    assert profiled.agent.options["instructions"] == plain.agent.options["instructions"]


# #843-T207
def test_a_profile_without_the_right_to_push_tells_the_agent_nothing_leaves_the_container(
    play: Any,
) -> None:
    turn = play(commits_then_ends(), profile=NO_PUSH)

    assert turn.agent is not None
    _, text = turn.agent.options["instructions"]
    assert "Nothing you commit leaves this container" in text
    assert "the system pushes everything" not in text
    assert text.endswith("Review only.")


# #843-T208
def test_a_stop_of_a_profile_without_the_right_to_push_pushes_nothing_either(play: Any) -> None:
    turn = play(commits_then_ends(), profile=NO_PUSH, answers=lost)

    assert turn.git.push_calls == 0 and turn.git.pushes == []


# #839-T18
def test_a_profile_that_may_not_push_still_saves_the_session(play: Any) -> None:
    host = SnapshotHost()

    turn = play(commits_then_ends(), snapshot=host, profile=NO_PUSH)

    assert turn.agent is not None and turn.agent.exports == [5.0]
    assert host.wait() and host.data == snapshot_of().data
    assert turn.git.pushes == []
    host.close()
