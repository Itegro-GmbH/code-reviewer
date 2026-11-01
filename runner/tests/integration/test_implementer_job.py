# SPDX-License-Identifier: LicenseRef-Proprietary

"""A whole Implementer job through the runner's entry point, in process (#765).

`runner.main` reads the job from stdin and prints one result line; everything between is the
production code: the entry point, the job glue, the session, the push ticker, the push loop and the
`push()` of the git workspace with the lease gate in front of it. Only two things are doubles: the
engine (`FakeAgent` stands in for the OpenCode process, which the engine lane proves) and the git
commands behind `push()` (`FakeGit` records the push instead of running git; the real git paths are
the tests of #762). The lease answers come over a real socket pair, the way the job host gives them,
and a SIGTERM is a real signal to this process.
"""

import io
import json
import os
import signal
import socket
import threading
import time
from collections.abc import Callable, Iterator
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
from code_reviewer_runner.dynamic_review.static_isolation import ImplementerNetwork
from code_reviewer_runner.implementer import session as session_module
from code_reviewer_runner.implementer.agent import AgentTurn
from code_reviewer_runner.implementer.egress_config import EgressSettings
from code_reviewer_runner.implementer.git_workspace import (
    AgentUser,
    GitIdentity,
    GitWorkspace,
    PushOutcome,
    PushResult,
    RepositoryUnusable,
    WorkspaceLayout,
    WorkspaceSpec,
)
from code_reviewer_runner.implementer.history import ChangeKind, CommitInfo, FileChange
from code_reviewer_runner.implementer.job_run import (
    SIGTERM_BACKSTOP_SECONDS,
    JobSeams,
    TurnSetup,
    run_implementer_job,
)
from code_reviewer_runner.implementer.session import SessionSeams, agent_limits
from code_reviewer_runner.job import JobError
from code_reviewer_runner.job_loop.settings import WorkerSettings
from code_reviewer_runner.lease_check import LEASE_CHECK_FD_VARIABLE
from code_reviewer_runner.result import ErrorCode

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "contracts" / "examples" / "implementer" / "RunnerJobInput.json"
SCHEMA = json.loads((ROOT / "contracts" / "runner-api.v1.json").read_text(encoding="utf-8"))
TOKEN = "ghs_dummy-installation-token-0123456789"
KEY = "sk-or-v1-" + "dummykey0123456789abcdef"  # built, so the secret scan sees no key
START = "1" * 40
TIP = "2" * 40
SECOND = "3" * 40


def job_text() -> str:
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    document["git"]["token"] = TOKEN
    document["llm"]["apiKey"] = KEY
    return json.dumps(document)


def valid_result(line: dict[str, Any]) -> bool:
    validator = Draft202012Validator({"$ref": "#/$defs/RunnerResult", "$defs": SCHEMA["$defs"]})
    return bool(validator.is_valid(line))  # pyright: ignore[reportUnknownMemberType]


# -- the doubles ----------------------------------------------------------------------------------


class FakeGit(GitWorkspace):
    """The real `GitWorkspace` (its `push()` with the lease gate, its paths, its identity) with the
    commands behind it replaced by a script the test controls. `pushes` are the tips `_push` was
    asked to push; `events` is the order of everything that matters."""

    def __init__(self, base: Path, before_push: Callable[[], None] | None) -> None:
        super().__init__(
            WorkspaceSpec(
                "https://github.com/acme/widgets.git", TOKEN, "main", "implementer/a1b2c3"
            ),
            WorkspaceLayout(agent_home=base / "home", work_dir=base / "work", run_dir=base / "run"),
            AgentUser(os.geteuid() or 1, os.getegid() or 1),
            GitIdentity("code-reviewer Implementer", "i@example.invalid"),
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
        self._prepare_error: JobError | None = None

    def fail_prepare(self, error: JobError) -> None:
        """`prepare` fails with `error`; before a clone there is no start commit to report."""
        self._prepare_error = error
        cloned = error.code not in (ErrorCode.CLONE_FAILED, ErrorCode.BASE_BRANCH_NOT_FOUND)
        self._start = START if cloned else None

    def prepare(self, *, self_test: bool = True) -> None:
        if self._prepare_error is not None:
            raise self._prepare_error
        self.prepared = True

    def commit(self, sha: str, subject: str = "Add it") -> None:
        self.tip = sha
        self.commits = [*self.commits, CommitInfo(sha, subject)]
        self.files = [FileChange("src/a.ts", ChangeKind.ADDED)]

    def agent_tip(self) -> str | None:
        return self.tip

    def spool_signalled(self) -> bool:
        return False

    def dirty(self) -> bool:
        if self.dirty_error is not None:
            raise self.dirty_error
        return self.is_dirty

    def commit_all(self, message: str = "") -> str | None:
        self.events.append("commit_all")
        self.commit(SECOND, "Implementer: uncommitted changes of the turn")
        self.is_dirty = False
        return SECOND

    def commits_since_start(self) -> list[CommitInfo]:
        return list(self.commits)

    def changed_files(self) -> list[FileChange]:
        return list(self.files)

    def engine_inputs_present(self) -> list[str]:
        return []

    def _push(self) -> PushResult:
        self.push_calls += 1
        if self.tip is None or (self.tip == self._start and self._pushed is None):
            return PushResult(PushOutcome.NOTHING_TO_PUSH, None)
        if self.tip == self._pushed:
            return PushResult(PushOutcome.UP_TO_DATE, self._pushed)
        self.events.append("push")
        self.pushes.append(self.tip)
        self._pushed = self.tip
        return PushResult(PushOutcome.PUSHED, self.tip)


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

    @property
    def ledger(self) -> Any:
        return self.options["ledger"]

    def start(self) -> None:
        self.events.append("agent.start")
        self.session_id = "ses_fake"

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
        self.events.append("stop(quick)" if quick else "stop")
        self.stopped.append(quick)
        return True


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
    ) -> Turn:
        events: list[str] = []
        made: list[FakeGit] = []
        agents: list[FakeAgent] = []
        hard_stops: list[int] = []
        lease = LeaseChannel(answers) if answers is not None else None
        if lease is not None:
            channels.append(lease)
            monkeypatch.setenv(LEASE_CHECK_FD_VARIABLE, str(lease.fd()))
        if engines is not None:
            monkeypatch.setenv(ENGINES_VARIABLE, engines)

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
            return TurnSetup(
                git, None, ("opencode",), None, EgressSettings(ImplementerNetwork.NONE, None)
            )

        def agent_factory(**options: Any) -> FakeAgent:
            agent = FakeAgent(script, events, made[0], options)
            agents.append(agent)
            return agent

        monkeypatch.setattr(session_module, "ImplementerAgent", agent_factory)
        seams = JobSeams(
            setup=setup,
            session_seams=SessionSeams(
                upstream_for=lambda _url: cast("Any", object()),
                tick_seconds=0.05,
                push_interval=0.05,
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
        code = runner.main([], stdin=io.StringIO(job_text()), stdout=output)
        git = made[0] if made else FakeGit(tmp_path, None)
        return Turn(
            git, agents[0] if agents else None, lease, code, output.getvalue(), events, hard_stops
        )

    yield run
    for channel in channels:
        channel.close()


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
    assert turn.events == ["agent.start", "turn", "stop", "push"]
    assert turn.git.prepared


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
        "commits": [],
        "filesChanged": [],
        "summary": "",
        "opencode": None,
    }


# -- the money is spent: never a free code --------------------------------------------------------


# #765
def test_an_unusable_repository_after_the_agent_ran_is_the_charged_code(play: Any) -> None:
    turn = play(commits_then_ends(), dirty_error=RepositoryUnusable("git status failed"))

    result = turn.result
    assert result["errorCode"] == "branch_violation"
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
        egress = EgressSettings(ImplementerNetwork.NONE, None)
        return TurnSetup(git, None, ("opencode",), None, egress)

    seams = JobSeams(setup=setup, session=SpentSession)
    monkeypatch.setattr(runner, "run_implementer_job", partial(run_implementer_job, seams=seams))
    output = io.StringIO()

    code = runner.main([], stdin=io.StringIO(job_text()), stdout=output)

    result = json.loads(output.getvalue())
    assert code == 1
    assert result["errorCode"] == "agent_gave_up"
    assert result["usage"]["aiCalls"] == 1
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
    assert turn.git.pushes == [] and turn.git.push_calls == 0
    assert turn.agent is not None and turn.agent.stopped  # the engine was ended
    assert turn.events[-1] != "push" and "push" not in turn.events
    assert result["implementer"]["pushed"] is False
    assert result["implementer"]["headCommit"] == TIP
    assert "commit_all" not in turn.git.events


# #765-T05
def test_nothing_is_pushed_after_the_lease_was_lost_even_if_the_agent_commits_again(
    play: Any,
) -> None:
    def first_held_then_lost(number: int) -> str:
        return "held" if number == 1 else "lost"

    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        git = agent.git
        make_commit(agent, TIP)
        assert wait_for(lambda: git.pushes == [TIP]), "the first push was not made"
        make_commit(agent, SECOND)
        end = time.monotonic() + 10
        while time.monotonic() < end:
            check()
            time.sleep(0.02)
        return "worked"

    turn = play(script, answers=first_held_then_lost)

    assert turn.result["errorCode"] == "lease_lost"
    assert turn.git.pushes == [TIP]  # the second commit never reached the provider
    assert turn.result["implementer"]["headCommit"] == SECOND
    assert turn.result["implementer"]["pushed"] is False


# #765-T05
def test_a_lease_that_cannot_be_confirmed_is_no_lease(play: Any) -> None:
    turn = play(commits_and_waits_for(never_done), answers=unconfirmed)

    assert turn.result["errorCode"] == "lease_lost"
    assert turn.git.pushes == []


# #765-T05
def test_a_process_started_without_the_lease_channel_never_pushes(play: Any) -> None:
    turn = play(commits_then_ends(), answers=None)

    assert turn.result["errorCode"] == "lease_lost"
    assert turn.git.pushes == []


# #765-T05
def test_the_lease_is_asked_before_every_push_not_once(play: Any) -> None:
    def script(agent: FakeAgent, check: Callable[[], None]) -> str:
        agent.use_the_model()
        git = agent.git
        make_commit(agent, TIP)
        assert wait_for(lambda: git.pushes == [TIP])
        return "done"

    turn = play(script)

    assert turn.result["ok"] is True
    assert turn.git.pushes == [TIP]  # the ticker's push is the one; the final one finds it pushed
    assert turn.lease is not None and turn.lease.asked >= 2  # asked before each of two pushes


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
    assert turn.events == ["agent.start", "turn", "stop(quick)", "push"]
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
    assert WorkerSettings().terminate_grace > SIGTERM_BACKSTOP_SECONDS
    assert SIGTERM_BACKSTOP_SECONDS == runner.IMPLEMENTER_SIGTERM_BACKSTOP_SECONDS


# -- T07: the secrets -----------------------------------------------------------------------------


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
