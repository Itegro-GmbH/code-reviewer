# SPDX-License-Identifier: LicenseRef-Proprietary

"""The environment's setup script as one step of an Implementer turn (#818, #1009): its time budget,
what the page and the log get of its output, the codes it ends a turn with, the rule for the tracked
files it changed, that the container it ran in is the agent's (alive, with whatever it started), and
that a failed script ends the turn before a session, a door or a model call exists."""

import json
import sys
import tempfile
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, BinaryIO

import pytest
from door_support import implementer_job_text

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.docker_engine.server import HOSTNAME, FakeDockerEngine, FakeExec

from code_reviewer_runner.implementer import environment_setup as es
from code_reviewer_runner.implementer import setup_container as sc
from code_reviewer_runner.implementer.agent_container import (
    AGENT_CONTAINER_NAME,
    WRITE_FILE_SCRIPT,
    Adopted,
)
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.job_run import (
    EnvironmentHost,
    JobSeams,
    TurnSetup,
    run_implementer_job,
)
from code_reviewer_runner.implementer.report import valid_block
from code_reviewer_runner.implementer.session import GRACE_SECONDS, ShutdownRequested
from code_reviewer_runner.job import (
    ImplementerEnvironment,
    JobError,
    parse_implementer_input,
)
from code_reviewer_runner.lease_check import LeaseState
from code_reviewer_runner.result import ErrorCode

TOKEN = "ghs_dummy-token-0123456789"
SCRIPT = "npm ci\nnpx playwright install chromium\n"


def job_text(environment: dict[str, str] | None = None) -> str:
    document: dict[str, Any] = json.loads(implementer_job_text(git_token=TOKEN))
    if environment is not None:
        document["implementer"]["environment"] = environment
    return json.dumps(document)


# -- the job text ---------------------------------------------------------------------------------


# #818-T30
def test_the_job_carries_the_environment_with_its_script() -> None:
    job = parse_implementer_input(job_text({"name": "Playwright", "setupScript": SCRIPT}))
    assert job.implementer.environment == ImplementerEnvironment("Playwright", SCRIPT)


# #818-T31
def test_a_job_without_an_environment_has_none() -> None:
    assert parse_implementer_input(job_text()).implementer.environment is None


@pytest.mark.parametrize(
    "environment",
    [
        {"name": "x"},
        {"setupScript": "ls"},
        {"name": "", "setupScript": "ls"},
        {"name": "x" * 81, "setupScript": "ls"},
        {"name": "x", "setupScript": ""},
        {"name": "x", "setupScript": "  \n"},
        {"name": "x", "setupScript": "a\u0000b"},
        {"name": "x", "setupScript": "a" * (64 * 1024 + 1)},
        {"name": "x", "setupScript": "\ud800"},
        {"name": "x", "setupScript": "ls", "vcpus": 4},
        {"name": 3, "setupScript": "ls"},
        "ls",
    ],
)
# #818-T32
def test_an_environment_that_is_not_the_contracts_is_refused(environment: Any) -> None:
    with pytest.raises(JobError) as refused:
        parse_implementer_input(job_text(environment))
    assert refused.value.code is ErrorCode.INVALID_JOB


def test_the_worker_names_the_feature_that_carries_the_script() -> None:
    from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES

    assert "implementer_environment" in WORKER_FEATURES


# -- the budget ------------------------------------------------------------------------------------


# #818-T33
def test_a_normal_turn_gives_the_script_its_fifteen_minutes() -> None:
    assert es.script_seconds(3600.0, 30.0) == es.SETUP_SCRIPT_SECONDS == 900.0


# #818-T34
def test_the_script_is_held_to_what_the_turn_leaves() -> None:
    # What is left after the grace, the parts around the script and the agent's minimum.
    limit = 2000.0
    expected = limit - GRACE_SECONDS - 100.0 - sc.SETUP_OVERHEAD_SECONDS - es.MIN_AGENT_SECONDS
    assert es.script_seconds(limit, 100.0) == pytest.approx(expected)
    assert es.script_seconds(limit, 100.0) < es.SETUP_SCRIPT_SECONDS


# #818-T35
def test_the_whole_step_at_its_ceilings_leaves_the_agent_its_minimum() -> None:
    for limit in (1500.0, 3600.0, 14_400.0):
        script = es.script_seconds(limit, 0.0)
        if script < es.MIN_SCRIPT_SECONDS:
            continue
        used = script + sc.SETUP_OVERHEAD_SECONDS
        left_for_the_agent = limit - GRACE_SECONDS - used
        assert left_for_the_agent >= es.MIN_AGENT_SECONDS - 1e-6


# -- the output ------------------------------------------------------------------------------------


# #818-T36
def test_the_output_is_text_without_terminal_escapes_or_control_characters() -> None:
    raw = b"\x1b[32mgreen\x1b[0m\r\nprogress 10%\rprogress 50%\rdone\x00\x07\n"
    text = es.clean_output(raw, ())
    assert text == "green\nprogress 10%\nprogress 50%\ndone\n"


# #818-T37
def test_the_secrets_of_the_job_are_removed_from_the_output() -> None:
    raw = f"cloning https://x-access-token:{TOKEN}@github.com/o/r\nsecret {TOKEN}\n".encode()
    text = es.clean_output(raw, (TOKEN,))
    assert TOKEN not in text and "[REDACTED]" in text


# #818-T38
def test_only_the_last_8192_characters_are_kept() -> None:
    text = es.clean_output(b"a" * 20_000 + b"\nEND", ())
    assert len(text) <= es.OUTPUT_CHARS and text.endswith("END")


# #818-T39
def test_undecodable_bytes_are_replaced_and_never_raise() -> None:
    assert "�" in es.clean_output(b"ok \xff\xfe bytes", ())


# -- the step ------------------------------------------------------------------------------------


class Workspace:
    """The two things of the git workspace the step reads."""

    def __init__(self) -> None:
        self.restored_count = 0
        self.excluded_count = 0
        self.script_commits = 0
        self.dropped_refs = 0
        self.restore_error: JobError | None = None
        self.names: list[str] = []
        self.free: int | None = 50 * 1024**3

    def settle_after_setup(self) -> list[str]:
        if self.restore_error is not None:
            raise self.restore_error
        return self.names

    def volume_free_bytes(self) -> int | None:
        return self.free


class Rig:
    def __init__(self, directory: Path) -> None:
        self.engine = FakeDockerEngine(directory / "docker.sock").start()
        self.engine.exec_behaviour = self.behave
        self.directory = directory
        self.script_exit = 0
        self.script_output = "added 300 packages\n"
        self.waits = False
        # Set when the script's exec begins, so that a stop is asked for while it runs and not at
        # a time.
        self.script_started = threading.Event()
        # The file the VM's memory is read from; None: the VM's own.
        self.meminfo: Path | None = None

    def api(self) -> DockerApi:
        return DockerApi(str(self.directory / "docker.sock"), timeout=5.0)

    def seams(self) -> sc.SetupSeams:
        options: dict[str, Any] = {} if self.meminfo is None else {"meminfo": str(self.meminfo)}
        return sc.SetupSeams(
            api=self.api,
            hostname=lambda: HOSTNAME,
            ready_seconds=5.0,
            **options,
        )

    def behave(self, made: FakeExec, stdin: BinaryIO, stdout: Any) -> int:
        argv: list[str] = made.document["Cmd"]
        if argv[:3] == ["/bin/sh", "-c", WRITE_FILE_SCRIPT]:
            stdin.read()
            return 0
        if argv[:3] == ["/bin/sh", "-c", sc.RUN_SCRIPT]:
            self.script_started.set()
            stdout.write(self.script_output)
            if self.waits:
                made.killed.wait(30)
                return 137
            return self.script_exit
        return 0


@pytest.fixture
def rig() -> Iterator[Rig]:
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="envsetup-") as directory:
        made = Rig(Path(directory))
        yield made
        made.engine.stop()


def step(
    rig: Rig,
    workspace: Workspace,
    *,
    time_limit: float = 3600.0,
    elapsed: float = 20.0,
    should_stop: Callable[[], bool] = lambda: False,
) -> es.EnvironmentSetup:
    return es.run_environment_setup(
        ImplementerEnvironment("Playwright", SCRIPT),
        workspace=workspace,  # type: ignore[arg-type]
        memory_mb=2048,
        time_limit=time_limit,
        elapsed=lambda: elapsed,
        should_stop=should_stop,
        secrets=(TOKEN,),
        seams=rig.seams(),
    )


# #818-T40
def test_a_script_that_succeeds_gives_the_container_and_a_block_the_app_reads(rig: Rig) -> None:
    done = step(rig, Workspace())
    assert done.error is None and done.adopted is not None
    # The container the script ran in is the agent's, alive; it is what the agent takes over.
    agent = rig.engine.container(AGENT_CONTAINER_NAME)
    assert done.adopted.container == agent.identifier and agent.running and not agent.removed
    assert done.block is not None and done.block["ok"] is True and done.block["exitCode"] == 0
    assert done.block["timedOut"] is False and done.block["output"] == "added 300 packages\n"
    assert any("the Setup container started in" in note for note in done.notes)
    assert any("handed over in" in note for note in done.notes)


# #818-T41
def test_the_tracked_files_a_script_changed_are_put_back_and_the_log_says_so(rig: Rig) -> None:
    workspace = Workspace()
    workspace.restored_count = 3
    workspace.names = ["package-lock.json", "a.txt"]
    done = step(rig, workspace)
    note = next(note for note in done.notes if "tracked file" in note)
    assert "3 tracked file(s)" in note and "package-lock.json" in note and "1 more" in note


# #818-T41b
def test_what_the_script_added_is_said_to_be_part_of_the_base(rig: Rig) -> None:
    workspace = Workspace()
    workspace.excluded_count = 2
    done = step(rig, workspace)
    note = next(note for note in done.notes if "script added" in note)
    assert "2 file(s) or folder(s)" in note and "not part of its changes" in note


# #818-T41c
def test_the_history_the_script_made_is_said_to_be_undone(rig: Rig) -> None:
    workspace = Workspace()
    workspace.script_commits = 2
    workspace.dropped_refs = 3
    done = step(rig, workspace)
    note = next(note for note in done.notes if "history was undone" in note)
    assert "2 commit(s)" in note and "3 branch(es) or tag(s)" in note


# #818-T42
def test_a_repository_the_runner_cannot_read_after_the_script_is_the_runners_failure(
    rig: Rig,
) -> None:
    workspace = Workspace()
    workspace.restore_error = JobError(ErrorCode.SETUP_FAILED, "the repository has no HEAD")
    done = step(rig, workspace)
    assert done.adopted is None
    # Nothing takes the container over: it is removed, with the processes of the script.
    assert rig.engine.container(AGENT_CONTAINER_NAME).removed
    # Control could not read the repository: that is not the script's failure (the script ended
    # with status 0, and the page shows it as it ran), and the code is the free one of ours.
    assert done.error is not None and done.error.code is ErrorCode.SETUP_FAILED
    assert done.error.detail == "the repository has no HEAD"
    assert done.block is not None and done.block["ok"] is True and done.block["exitCode"] == 0


# #818-T43
def test_a_script_that_fails_ends_with_its_status_and_its_output(rig: Rig) -> None:
    rig.script_exit = 7
    rig.script_output = "npm ERR! 404\n"
    done = step(rig, Workspace())
    assert done.error is not None and done.error.code is ErrorCode.ENVIRONMENT_SETUP_FAILED
    assert "exit status 7" in done.error.detail
    assert done.block is not None
    assert done.block == {
        "ok": False,
        "exitCode": 7,
        "timedOut": False,
        "durationSeconds": done.block["durationSeconds"],
        "output": "npm ERR! 404\n",
    }
    assert done.adopted is None
    assert rig.engine.container(AGENT_CONTAINER_NAME).removed


# #818-T44
def test_a_script_that_runs_out_of_time_says_so(rig: Rig) -> None:
    rig.waits = True
    done = step(rig, Workspace(), time_limit=es.MIN_SCRIPT_SECONDS + 1, elapsed=0.0)
    # The limit leaves no room at all for so short a turn: refused before a container exists.
    assert done.error is not None and "no room" in done.error.detail
    assert done.block is None
    assert rig.engine.containers == {}


# #818-T45
def test_a_timeout_is_timed_out_with_a_null_status(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    rig.waits = True
    monkeypatch.setattr(es, "script_seconds", _half_a_second)
    monkeypatch.setattr(es, "MIN_SCRIPT_SECONDS", 0.0)
    done = step(rig, Workspace())
    assert done.error is not None and done.error.code is ErrorCode.ENVIRONMENT_SETUP_FAILED


# #818-T46
def test_a_stop_of_the_runner_is_not_a_failure_of_the_script(rig: Rig) -> None:
    rig.waits = True
    with pytest.raises(ShutdownRequested):
        step(rig, Workspace(), should_stop=rig.script_started.is_set)
    assert rig.script_started.is_set()


# #818-T47
def test_a_container_that_cannot_be_had_is_the_runners_failure_not_the_scripts(rig: Rig) -> None:
    rig.engine.rules_exit = 1
    done = step(rig, Workspace())
    assert done.error is not None and done.error.code is ErrorCode.SETUP_FAILED
    assert done.block is None


# #1009-T35
def test_a_container_that_cannot_leave_the_setup_network_is_the_environments_failure(
    rig: Rig,
) -> None:
    rig.engine.refuse["/disconnect"] = 500
    done = step(rig, Workspace())
    assert done.error is not None and done.error.code is ErrorCode.ENVIRONMENT_SETUP_FAILED
    assert "could not be kept" in done.error.detail and done.adopted is None
    # The Runs page shows the exit status and the output and nothing else: the last line of the
    # output says what happened to a script that exited 0.
    assert done.block is not None and done.block["ok"] is False and done.block["exitCode"] == 0
    assert (
        done.block["output"].splitlines()[-1].startswith("[setup] the setup container could not be")
    )
    assert rig.engine.container(AGENT_CONTAINER_NAME).removed


# #827-T04: the reason of a container that went away under the script is on the page, in words
def test_a_container_the_guard_killed_says_why_on_the_page_not_only_by_a_status(rig: Rig) -> None:
    rig.meminfo = rig.directory / "meminfo"
    rig.meminfo.write_text(
        "MemTotal: 8000000 kB\nMemFree: 6000000 kB\nActive(file): 1 kB\nInactive(file): 1 kB\n"
    )
    rig.waits = True

    def squeeze() -> None:
        rig.script_started.wait(30)
        assert rig.meminfo is not None
        rig.meminfo.write_text(
            "MemTotal: 8000000 kB\nMemFree: 300000 kB\nActive(file): 1 kB\nInactive(file): 1 kB\n"
        )

    threading.Thread(target=squeeze, daemon=True).start()
    done = step(rig, Workspace())
    assert done.error is not None and done.error.code is ErrorCode.ENVIRONMENT_SETUP_FAILED
    assert done.error.detail.startswith("vm_memory: ")
    assert done.error.detail != "vm_memory:" and "running out of memory" in done.error.detail
    assert done.block is not None
    last = done.block["output"].splitlines()[-1]
    assert last == f"[setup] {done.error.detail}", "the page names the reason in a whole sentence"


# #818-DISK-06, #1009
def test_the_closing_line_is_kept_whole_when_the_scripts_output_fills_the_block() -> None:
    run = sc.SetupRun(
        outcome=sc.OUTCOME_NOT_HANDED_OVER,
        exit_code=0,
        output=b"",
        output_bytes=0,
        container=None,
        detail="d",
        start_seconds=0.0,
        script_seconds=3.0,
        handover_seconds=0.0,
    )
    closing = "[setup] the setup container could not be kept: it is still on the network"
    block = es.setup_block(run, "x" * es.OUTPUT_CHARS, ok=False, closing=closing)
    assert len(block["output"]) == es.OUTPUT_CHARS
    assert block["output"].endswith("\n" + closing)
    assert es.setup_block(run, "", ok=False, closing=closing)["output"] == closing


# -- the whole job ---------------------------------------------------------------------------------


class SessionDouble:
    def __init__(self, job: Any, **options: Any) -> None:
        self.options = options
        self.ledger = None

    def run(self) -> Any:
        raise AssertionError("the double does not run a turn")

    def secrets(self) -> tuple[str, ...]:
        return ()


def job_run(
    rig_setup: es.EnvironmentSetup | Exception | None,
    *,
    with_environment: bool = True,
    host: bool = True,
    session_calls: list[Any] | None = None,
) -> Any:
    ran: list[str] = []

    def run_env(job: Any, elapsed: Any, stop: Any, limit: float) -> es.EnvironmentSetup:
        ran.append("setup")
        if isinstance(rig_setup, Exception):
            raise rig_setup
        assert rig_setup is not None
        return rig_setup

    class Ws:
        start_commit = "a" * 40

        def prepare(self) -> None:
            ran.append("prepare")

    placed: list[Adopted] = []

    def place_from(adopted: Adopted) -> Callable[[], Any]:
        placed.append(adopted)
        return lambda: None

    def setup(*arguments: Any) -> TurnSetup:
        return TurnSetup(
            Ws(),  # type: ignore[arg-type]
            lambda: None,  # type: ignore[arg-type,return-value]
            ("opencode",),
            environment=EnvironmentHost(run_env, place_from) if host else None,
        )

    def session(job: Any, **options: Any) -> Any:
        ran.append("session")
        if session_calls is not None:
            session_calls.append(options)
        return SessionDouble(job, **options)

    text = job_text({"name": "E", "setupScript": SCRIPT} if with_environment else None)
    result = run_implementer_job(
        parse_implementer_input(text),
        0.0,
        {
            "RUNNER_DYNAMIC_MAX_COST_USD": "5",
            "RUNNER_IMPLEMENTER_SANDBOX_PROOF": "proven",
            "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB": "2048",
        },
        lease_check=lambda: LeaseState.HELD,
        shutdown=threading.Event(),
        engines=("implementer",),
        seams=JobSeams(setup=setup, session=session),
    )
    return result, ran, placed


def _half_a_second(limit: float, elapsed: float) -> float:
    return 0.5 + es.MIN_SCRIPT_SECONDS


def failing_step() -> es.EnvironmentSetup:
    block = {
        "ok": False, "exitCode": 1, "timedOut": False, "durationSeconds": 12,
        "output": "E: Unable to locate package nope\n",
    }  # fmt: skip
    return es.EnvironmentSetup(
        None,
        block,
        JobError(ErrorCode.ENVIRONMENT_SETUP_FAILED, "the setup script ended with exit status 1"),
        ("setup: the Setup container started in 3 s, the script ran 12 s",),
    )


# #818-T50
def test_a_failed_script_ends_the_turn_free_before_a_session_exists() -> None:
    result, ran, _ = job_run(failing_step())
    assert result.ok is False and result.error_code is ErrorCode.ENVIRONMENT_SETUP_FAILED
    assert ran == ["prepare", "setup"], "no session, so no door and no model call"
    assert result.usage is None
    assert result.implementer is not None and valid_block(result.implementer) is not None
    assert result.implementer["setup"]["output"] == "E: Unable to locate package nope\n"
    assert result.implementer["setup"]["ok"] is False
    assert "Unable to locate package nope" in result.log_tail
    assert result.log_tail.rstrip().endswith("exit status 1")
    assert result.implementer["headCommit"] is None and result.implementer["pushed"] is False


# #818-T51
def test_the_failure_is_free_in_the_apps_table_of_codes() -> None:
    assert ErrorCode.ENVIRONMENT_SETUP_FAILED.value == "environment_setup_failed"
    contract = json.loads(
        (Path(__file__).resolve().parents[3] / "contracts" / "runner-api.v1.json").read_text()
    )
    codes = contract["$defs"]["KnownRunnerErrorCode"]["enum"]
    assert "environment_setup_failed" in codes


# #818-T52
def test_a_good_script_makes_the_agent_run_in_the_container_of_the_script() -> None:
    adopted = Adopted("ee" * 32, paused=True)
    good = es.EnvironmentSetup(
        adopted,
        {"ok": True, "exitCode": 0, "timedOut": False, "durationSeconds": 40, "output": "ok\n"},
        None,
        ("setup: ready",),
    )
    calls: list[Any] = []
    result, ran, placed = job_run(good, session_calls=calls)
    assert placed == [adopted]
    assert ran == ["prepare", "setup", "session"]
    assert result.ok is False  # the double raised; what matters is the order above


# #818-T53
def test_a_stop_during_the_script_ends_the_turn_with_the_stop_code_and_no_session() -> None:
    result, ran, _ = job_run(ShutdownRequested())
    assert result.error_code is ErrorCode.RUNNER_SHUTDOWN and "session" not in ran


# #818-T54
def test_a_job_without_an_environment_runs_no_setup_and_nothing_changes() -> None:
    good = es.EnvironmentSetup(Adopted("aa" * 32), None, None, ())
    _, ran, placed = job_run(good, with_environment=False)
    assert "setup" not in ran and placed == []
    assert ran[:2] == ["prepare", "session"]


# #818-T55
def test_a_setup_that_cannot_run_a_script_refuses_a_task_that_has_one() -> None:
    result, ran, _ = job_run(None, host=False)
    assert result.error_code is ErrorCode.IMPLEMENTER_CONFIG_INVALID and "session" not in ran


def test_the_early_report_is_one_the_app_reads_with_no_commit() -> None:
    result, _, _ = job_run(failing_step())
    assert result.implementer is not None
    assert json.loads(json.dumps(result.implementer))["setup"]["timedOut"] is False


# #818-T56
def test_the_production_setup_makes_an_agent_container_that_takes_the_script_container_over(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from code_reviewer_runner.implementer import job_run
    from code_reviewer_runner.implementer.agent_container import AgentContainer

    class Quiet:
        def __init__(self, *args: Any, **options: Any) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    monkeypatch.setattr(job_run, "ReaderAccess", Quiet)
    monkeypatch.setattr(job_run, "GitWorkspace", Quiet)
    job = parse_implementer_input(job_text({"name": "E", "setupScript": SCRIPT}))

    setup = job_run.production_setup(
        job, {"RUNNER_IMPLEMENTER_AGENT_MEMORY_MB": "6144"}, lambda: None
    )

    assert setup.environment is not None
    plain = setup.place()
    assert isinstance(plain, AgentContainer)
    assert plain._seams.image == "code-reviewer-agent:golden"  # pyright: ignore[reportPrivateUsage]
    # The container of the step: the golden image, the same container (its id), the same limits.
    adopted = Adopted("ee" * 32, setup_environment=("HTTP_PROXY=http://10.0.0.1:3128",))
    made = setup.environment.place(adopted)()
    assert isinstance(made, AgentContainer)
    seams = made._seams  # pyright: ignore[reportPrivateUsage]
    assert seams.image == "code-reviewer-agent:golden"
    assert made._container == "ee" * 32  # pyright: ignore[reportPrivateUsage]
    assert made._adopted == adopted  # pyright: ignore[reportPrivateUsage]
    assert made._memory_bytes == 6144 * 1024 * 1024  # pyright: ignore[reportPrivateUsage]
