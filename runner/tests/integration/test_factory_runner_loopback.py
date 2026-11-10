# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Factory-Runner as a whole, on the loopback (#854, R1b; #974): the CLI registers against a
fake App, `run` announces and claims a turn (the split answer: the job's credential and nothing
secret), starts a real Worker (`local_worker`) that fetches the job over the Worker API, runs it
through the real job host and a stand-in job process, keeps the heartbeat and delivers the result;
a revoked runner stops.

What is a double: the App (`runner_app.py`, which holds every body to the contracts), the machine
(`prepare` is replaced, since this level has no Docker: the self-test has its own tests and lane),
and the job process (a script that prints the result a finished turn prints). The Worker is not a
double: it is the process the dispatcher starts on a real machine. The turn itself, the containers
and the model, are the lane's (`tests/lane`).
"""

import json
import shlex
import sys
import textwrap
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner.app_client import Announcement
from code_reviewer_runner.factory_runner.base import (
    BASE_VERSION,
    EXIT_FAILED,
    EXIT_OK,
    EXIT_REVOKED,
    EXIT_UPDATE_NEEDED,
)
from code_reviewer_runner.factory_runner.cli import CliSeams, main
from code_reviewer_runner.factory_runner.config import RunnerConfig
from code_reviewer_runner.factory_runner.prepare import Prepared
from code_reviewer_runner.factory_runner.selftest import Check, SelfTestResult
from code_reviewer_runner.implementer.docker_api import DockerError
from code_reviewer_runner.job_loop.settings import WorkerSettings
from runner_app import EXAMPLE_JOB, GIT_TOKEN, MODEL_KEY, FakeRunnerApp

pytestmark = pytest.mark.integration


class NothingLeft:
    """A daemon with no container and no network of ours (the loop asks it, a test has none)."""

    def request(self, method: str, path: str, *args: object, **kwargs: object) -> list[object]:
        return []

    def remove_container(self, *args: object, **kwargs: object) -> None:
        raise AssertionError("there was nothing to remove")

    remove_network = remove_container

    def remove_image(self, *args: object, **kwargs: object) -> None:
        return None

    # The lock container of the start: taken, and never seen again by the check at the end.
    def create_container(self, *args: object, **kwargs: object) -> str:
        return "d" * 64

    def inspect_container(self, *args: object, **kwargs: object) -> dict[str, object]:
        raise DockerError(404, "no such container")


JOB = "00000000-0000-4000-8000-0000000000aa"
HEAD = "9" * 40


def report() -> dict[str, object]:
    """What a finished turn reports (`ImplementerResult` of the contract)."""
    return {
        "baseCommit": "1" * 40,
        "headCommit": HEAD,
        "pushed": True,
        "branches": [{"name": "work/b", "head": HEAD, "result": "pushed", "reason": None}],
        "commits": [{"sha": HEAD, "subject": "Add it"}],
        "filesChanged": [{"path": "a.ts", "status": "added"}],
        "summary": "Done.",
        "opencode": {"sessionId": "ses_1", "version": "1.19.0"},
    }


STAND_IN = textwrap.dedent(
    """
    import json, os, sys, time
    raw = sys.stdin.read()
    job = json.loads(raw)
    sleep, seen = float(sys.argv[1]), sys.argv[2]
    report = json.load(open(sys.argv[3]))
    # What a turn makes in the work volume: it refuses folders an earlier turn left (os.mkdir).
    work = os.environ["RUNNER_IMPLEMENTER_WORK_DIR"]
    os.makedirs(work, exist_ok=True)
    for name in ("reserve", "repo", "result"):
        os.mkdir(os.path.join(work, name))
    with open(seen, "w") as handle:
        json.dump({
            "env": sorted(os.environ),
            "git_token": job["git"]["token"],
            "llm_key": job["llm"]["apiKey"],
            "crj_in_job": "crj_" in raw,
            "crc_in_job": "crc_" in raw,
        }, handle)
    time.sleep(sleep)
    print(json.dumps({
        "ok": True, "durationMs": 5, "commentUrl": None, "errorCode": None,
        "logTail": "pushed", "logTruncated": False, "usage": None,
        "implementer": report,
    }))
    """
)


# #879: a turn that takes part in the session snapshot like the real process: the channel the host
# hands it (`RUNNER_SNAPSHOT_FD`) gets this turn's conversation, the file the host downloaded for a
# follow-up turn (`resume-session.gz`) is read, and what it saw is appended to the `seen` file.
SNAPSHOT_STAND_IN = textwrap.dedent(
    """
    import hashlib, json, os, socket, sys
    job = json.loads(sys.stdin.read())
    seen, finished = sys.argv[2], json.load(open(sys.argv[3]))
    work = os.environ["RUNNER_IMPLEMENTER_WORK_DIR"]
    os.makedirs(work, exist_ok=True)
    for name in ("reserve", "repo", "result"):
        os.mkdir(os.path.join(work, name))
    turn = (job["implementer"].get("resume") or {}).get("turn", 1)
    resumed = None
    if os.path.exists("resume-session.gz"):
        resumed = open("resume-session.gz", "rb").read()
    descriptor = os.environ.get("RUNNER_SNAPSHOT_FD")
    if descriptor is not None:
        data = ("the conversation of turn %d" % turn).encode()
        digest = hashlib.sha256(data).hexdigest()
        header = "S %d %d %s 1.19.0\\n" % (len(data), 9 * len(data), digest)
        channel = socket.socket(fileno=int(descriptor))
        channel.sendall(header.encode() + data)
        channel.close()
    with open(seen, "a") as handle:
        handle.write(json.dumps({
            "turn": turn,
            "channel": descriptor is not None,
            "resumed": None if resumed is None else resumed.decode(),
            "state": (os.environ.get("RUNNER_RESUME_SESSION") or "").split(" ")[0] or None,
        }) + "\\n")
    print(json.dumps({
        "ok": True, "durationMs": 5, "commentUrl": None, "errorCode": None,
        "logTail": "pushed", "logTruncated": False, "usage": None,
        "implementer": finished,
    }))
    """
)


@pytest.fixture
def app() -> Iterator[FakeRunnerApp]:
    fake = FakeRunnerApp().start()
    yield fake
    fake.stop()


class Machine:
    """A registered runner, ready to run, whose jobs are the stand-in."""

    def __init__(self, app: FakeRunnerApp, tmp_path: Path, *, sleep: float = 0.0) -> None:
        self.app = app
        tmp_path.mkdir(parents=True, exist_ok=True)
        self.seen = tmp_path / "seen.json"
        self.environment = {
            "FACTORY_RUNNER_HOME": str(tmp_path / "home"),
            "FACTORY_RUNNER_URL": app.url,
            "PATH": "/usr/bin:/bin",
        }
        self.sleep = sleep
        self.work = tmp_path / "work"
        self.stand_in = STAND_IN
        self.script = tmp_path / "stand_in.py"
        self.report_file = tmp_path / "report.json"
        self.report_file.write_text(json.dumps(report()))

    def prepare(self, config: RunnerConfig, _env: object) -> Prepared:
        self.script.write_text(self.stand_in)
        command = shlex.join(
            (
                sys.executable,
                str(self.script),
                str(self.sleep),
                str(self.seen),
                str(self.report_file),
            )
        )
        settings = WorkerSettings(engines=("implementer",), job_timeout=60.0, terminate_grace=2.0)
        result = SelfTestResult(
            (Check("docker", True), Check("canned-turn", True)), "runc", "1.19.0"
        )
        return Prepared(
            settings,
            {
                "PATH": "/usr/bin:/bin",
                "HOME": str(self.seen.parent),
                "RUNNER_IMPLEMENTER_WORK_DIR": str(self.work),
                "RUNNER_JOB_TIMEOUT_SECONDS": "60",
                "PR_AGENT_COMMAND": command,
            },
            Announcement(
                config.labels,
                BASE_VERSION,
                {"harnesses": [{"harness": "opencode", "version": "1.19.0", "auth": "app-key"}]},
                {"cpus": 1, "parallelRuns": 1},
            ),
            result,
        )

    def cli(self, *argv: str) -> int:
        seams = CliSeams(prepare=self.prepare, docker=NothingLeft)  # type: ignore[arg-type]
        return main(list(argv), environment=self.environment, seams=seams)

    def register(self) -> None:
        code = self.cli(
            "register", "--token", self.app.new_registration_token(), "--name", "box",
            "--labels", "linux,itegro-claude",
        )  # fmt: skip
        assert code == EXIT_OK


def test_a_registered_runner_announces_claims_and_its_worker_fetches_runs_and_delivers_the_turn(
    app: FakeRunnerApp, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    machine = Machine(app, tmp_path, sleep=2.5)
    machine.register()
    app.queue_job(JOB).heartbeat_seconds = 1

    code = machine.cli("run", "--once", "--wait", "30")

    assert code == EXIT_OK
    assert app.violations == []
    # Order: the registration, the announcement of what the self-test proved, then the claim.
    paths = [(r.method, r.path) for r in app.requests]
    assert paths[0] == ("POST", "/api/runners/v1/register")
    assert paths.index(("PUT", "/api/runners/v1/self")) < paths.index(
        ("POST", "/api/runners/v1/claim")
    )
    assert app.announcements[-1]["manifest"]["harnesses"][0]["harness"] == "opencode"
    assert app.announcements[-1]["labels"] == ["linux", "itegro-claude"]
    # #974-T02: the Worker fetched the job over the Worker API with the credential of the claim,
    # kept the heartbeat while the turn ran and delivered one result; the result is the last call.
    credential = app.job(JOB).credential
    assert credential.startswith("crj_")
    worker_calls = [r for r in app.requests if r.path.startswith("/api/workers/")]
    assert worker_calls[0].method == "GET" and worker_calls[0].path == f"/api/workers/v1/jobs/{JOB}"
    assert all(r.authorization == f"Bearer {credential}" for r in worker_calls)
    assert len(app.heartbeats) >= 1
    assert len(app.completions) == 1
    assert app.completions[0]["ok"] is True
    assert app.completions[0]["implementer"]["headCommit"] == report()["headCommit"]
    assert paths[-1] == ("POST", f"/api/workers/v1/jobs/{JOB}/result")
    # The Worker said what it reads of a job (the features of the hosted Worker).
    assert "implementer_environment" in app.job(JOB).fetches[0]["features"].split(",")
    # The dispatcher's own calls carried the runner's credential, and none of them was a call about
    # the running job but the claim and the state; it never touched the Worker API.
    dispatcher_calls = [
        r for r in app.requests[1:] if r.authorization and r.authorization.startswith("Bearer crc_")
    ]
    assert dispatcher_calls and all(
        not r.path.startswith("/api/workers/") for r in dispatcher_calls
    )
    assert all(
        r.path in ("/api/runners/v1/self", "/api/runners/v1/claim")
        or r.path == f"/api/runners/v1/jobs/{JOB}"
        for r in dispatcher_calls
    )
    # The job process had the job (fetched by the Worker) and none of the runner's secrets, and not
    # the Worker's credential either; the dispatcher's log has none of them.
    seen = json.loads(machine.seen.read_text())
    assert not any(name.startswith("FACTORY_RUNNER") for name in seen["env"])
    assert seen["git_token"] == GIT_TOKEN and seen["llm_key"] == MODEL_KEY
    assert seen["crj_in_job"] is False and seen["crc_in_job"] is False
    runner_credential = json.loads((tmp_path / "home" / "config.json").read_text())["credential"]
    captured = capsys.readouterr()
    for secret in (runner_credential, credential, GIT_TOKEN, MODEL_KEY):
        assert secret not in captured.err + captured.out


# #854-B1
def test_two_runs_in_a_row_on_one_work_volume_each_set_up_their_turn(
    app: FakeRunnerApp, tmp_path: Path
) -> None:
    machine = Machine(app, tmp_path)
    machine.register()
    app.queue_job(JOB)
    app.queue_job(JOB.replace("aa", "ab"))

    first = machine.cli("run", "--once", "--wait", "30")
    second = machine.cli("run", "--once", "--wait", "30")

    # The stand-in job makes the turn's three folders with `os.mkdir`, which refuses leftovers.
    assert (first, second) == (EXIT_OK, EXIT_OK)
    assert [c["ok"] for c in app.completions] == [True, True]
    assert list(machine.work.iterdir()) == []


# #854-B1
def test_a_machine_the_last_run_left_dirty_is_cleaned_before_the_first_claim(
    app: FakeRunnerApp, tmp_path: Path
) -> None:
    machine = Machine(app, tmp_path)
    machine.register()
    (machine.work / "repo").mkdir(parents=True)  # a runner that was killed during a turn
    app.queue_job(JOB)

    assert machine.cli("run", "--once", "--wait", "30") == EXIT_OK

    assert [c["ok"] for c in app.completions] == [True]


def test_a_runner_without_a_job_ends_the_once_mode_with_zero_and_a_clear_line(
    app: FakeRunnerApp, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    machine = Machine(app, tmp_path)
    machine.register()

    code = machine.cli("run", "--once", "--wait", "0")

    assert code == EXIT_OK
    assert "nothing to do" in capsys.readouterr().err
    assert [r.path for r in app.requests].count("/api/runners/v1/claim") == 1


def test_a_runner_a_vm_starts_with_only_the_environment_takes_a_job_and_ends(
    app: FakeRunnerApp, tmp_path: Path
) -> None:
    # Someone registered it earlier; the VM only gets the credential and the address.
    elsewhere = Machine(app, tmp_path / "elsewhere")
    elsewhere.register()
    credential = json.loads((tmp_path / "elsewhere" / "home" / "config.json").read_text())[
        "credential"
    ]
    vm = Machine(app, tmp_path / "vm")
    vm.environment = {
        "FACTORY_RUNNER_HOME": str(tmp_path / "vm-home"),
        "FACTORY_RUNNER_URL": app.url,
        "FACTORY_RUNNER_CREDENTIAL": credential,
        "FACTORY_RUNNER_LABELS": "itegro-claude",
        "PATH": "/usr/bin:/bin",
    }
    app.queue_job(JOB)

    code = vm.cli("run", "--once", "--wait", "30")

    assert code == EXIT_OK
    assert len(app.completions) == 1
    assert not (tmp_path / "vm-home").exists()  # a VM writes no configuration
    assert app.announcements[-1]["labels"] == ["itegro-claude"]
    # The runner credential from the environment never reached the Worker or the job.
    seen = json.loads(vm.seen.read_text())
    assert not any(name.startswith("FACTORY_RUNNER") for name in seen["env"])


def test_a_revoked_runner_stops_with_its_own_exit_code(app: FakeRunnerApp, tmp_path: Path) -> None:
    machine = Machine(app, tmp_path)
    machine.register()
    app.revoke_all()

    assert machine.cli("run") == EXIT_REVOKED
    assert app.completions == []


def test_a_runner_revoked_while_a_turn_runs_loses_it_and_then_stops(
    app: FakeRunnerApp, tmp_path: Path
) -> None:
    machine = Machine(app, tmp_path, sleep=20.0)  # longer than the test lets it run
    machine.register()
    app.queue_job(JOB).heartbeat_seconds = 1
    original = app._worker_call  # pyright: ignore[reportPrivateUsage]

    def revoke_at_the_first_heartbeat(*args: Any) -> tuple[int, object]:
        answer = original(*args)
        if args[2] == "heartbeat":
            threading.Thread(target=app.revoke_all).start()
        return answer

    app._worker_call = revoke_at_the_first_heartbeat  # type: ignore[method-assign,assignment]  # pyright: ignore[reportPrivateUsage]

    code = machine.cli("run", "--once", "--wait", "30")

    assert code == EXIT_FAILED  # the turn was lost: the app ended it with the runner
    assert app.completions == []  # and the Worker did not report: it can no longer
    assert machine.cli("run") == EXIT_REVOKED  # the next start is told at once


def test_an_app_that_requires_a_newer_base_ends_the_once_mode_with_its_exit_code(
    app: FakeRunnerApp, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    machine = Machine(app, tmp_path)
    machine.register()
    app.min_base_version = "9.0.0"

    code = machine.cli("run", "--once")

    assert code == EXIT_UPDATE_NEEDED
    assert "update needed" in capsys.readouterr().err


def follow_up_input(turn: int) -> dict[str, object]:
    """The input of a follow-up turn that has a conversation to continue (`implementer.resume`)."""
    job = json.loads(json.dumps(EXAMPLE_JOB))
    job["implementer"]["resume"] = {
        "turn": turn,
        "branches": [],
        "checkout": None,
        "snapshot": True,
    }
    return job


def turns_seen(machine: Machine) -> list[dict[str, object]]:
    return [json.loads(line) for line in machine.seen.read_text().splitlines()]


# #879-T10
def test_a_follow_up_turn_continues_from_the_snapshot_the_first_turn_stored(
    app: FakeRunnerApp, tmp_path: Path
) -> None:
    machine = Machine(app, tmp_path)
    machine.stand_in = SNAPSHOT_STAND_IN
    machine.register()
    app.queue_job(JOB)
    app.queue_job(JOB.replace("aa", "ab"), follow_up_input(2))

    first = machine.cli("run", "--once", "--wait", "30")
    second = machine.cli("run", "--once", "--wait", "30")

    assert (first, second) == (EXIT_OK, EXIT_OK)
    assert app.violations == []
    # Turn 1 had the channel and nothing to resume; turn 2 had the file of turn 1.
    assert turns_seen(machine) == [
        {"turn": 1, "channel": True, "resumed": None, "state": None},
        {"turn": 2, "channel": True, "resumed": "the conversation of turn 1", "state": "file"},
    ]
    # #974: through the Worker API only, with the credential of each claim, before each result.
    session_paths = [
        r.path for r in app.requests if r.path.endswith(("/session", "/resume-session"))
    ]
    assert session_paths == [
        f"/api/workers/v1/jobs/{JOB}/session",
        f"/api/workers/v1/jobs/{JOB.replace('aa', 'ab')}/resume-session",
        f"/api/workers/v1/jobs/{JOB.replace('aa', 'ab')}/session",
    ]
    assert not any(
        r.path.startswith("/api/runners/v1/jobs/") and "/session" in r.path for r in app.requests
    )
    # For every job, all of its snapshot parts are in before its result is.
    for job in (JOB, JOB.replace("aa", "ab")):
        calls = [
            (r.method, r.path.rsplit("/", 1)[1])
            for r in app.requests
            if r.path.startswith(f"/api/workers/v1/jobs/{job}/")
        ]
        puts = [index for index, call in enumerate(calls) if call == ("PUT", "session")]
        assert puts and ("POST", "result") in calls
        assert max(puts) < calls.index(("POST", "result"))


# #879-T11
def test_an_app_that_does_not_list_the_snapshot_gets_a_turn_without_it_and_with_the_old_fallback(
    app: FakeRunnerApp, tmp_path: Path
) -> None:
    # The Worker's feature is not listed: the host opens no channel, and the turns run as before.
    app.features = ["worker_api", "implementer_steps"]
    machine = Machine(app, tmp_path)
    machine.stand_in = SNAPSHOT_STAND_IN
    machine.register()
    app.queue_job(JOB)
    app.queue_job(JOB.replace("aa", "ab"), follow_up_input(2))

    first = machine.cli("run", "--once", "--wait", "30")
    second = machine.cli("run", "--once", "--wait", "30")

    assert (first, second) == (EXIT_OK, EXIT_OK)
    # Nothing is uploaded (no channel); the follow-up turn may ask for a stored session and is told
    # there is none (204), as the hosted Worker does.
    assert [c.method for c in app.session_calls] == ["GET"]
    assert app.session_calls[0].status == 204 and app.violations == []
    assert [t["channel"] for t in turns_seen(machine)] == [False, False]
    assert [t["resumed"] for t in turns_seen(machine)] == [None, None]
    assert [c["ok"] for c in app.completions] == [True, True]
