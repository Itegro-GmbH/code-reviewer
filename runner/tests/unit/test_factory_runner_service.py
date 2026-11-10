# SPDX-License-Identifier: LicenseRef-Proprietary

"""The local dispatcher of the Factory-Runner (#854, R1b; #974) with doubles: what it announces,
what a claim's failure means, the Worker it starts for a claim and gives the claim back for, the
once mode a VM runs, the renewal of the credential and the stop. The job itself (fetch, heartbeat,
result) is the Worker's and has its own tests."""

import asyncio
import json
import logging
import sys
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import pytest
from loop_support import (
    FakeLauncher,
    FakeProcess,
    ManualClock,
    make_settings,
    outcome,
    run,
    settle,
)
from release_support import DIGEST, MANIFEST_URL, REPOSITORY, SIGNATURE_URL, Release, fetcher

from code_reviewer_runner.factory_runner import service as service_module
from code_reviewer_runner.factory_runner.app_client import (
    Announced,
    Announcement,
    ClaimedWorker,
    JobAccess,
    Revoked,
    UpdateNeeded,
)
from code_reviewer_runner.factory_runner.base import (
    EXIT_APP_UNREACHABLE,
    EXIT_CONFIG,
    EXIT_FAILED,
    EXIT_NOT_READY,
    EXIT_OK,
    EXIT_REVOKED,
    EXIT_SHARED_DAEMON,
    EXIT_UPDATE_NEEDED,
    EXIT_UPDATED,
)
from code_reviewer_runner.factory_runner.config import (
    RunnerConfig,
    load_config,
    save_config,
)
from code_reviewer_runner.factory_runner.prepare import Prepared
from code_reviewer_runner.factory_runner.sandbox import WORKER_MODULE
from code_reviewer_runner.factory_runner.selftest import Check, SelfTestResult
from code_reviewer_runner.factory_runner.service import (
    POLL_SECONDS,
    RENEW_AFTER_SECONDS,
    TIDY_RETRY_SECONDS,
    RunnerService,
    Seams,
)
from code_reviewer_runner.factory_runner.update import (
    CURRENT_REFERENCE,
    IMAGE_TAG_VARIABLE,
    PREVIOUS_REFERENCE,
    RELEASE_LABEL,
    rollback,
)
from code_reviewer_runner.implementer.docker_api import DockerError
from code_reviewer_runner.implementer.result_channel import make_result_directory
from code_reviewer_runner.implementer.role_labels import ROLE_LABEL, RUNNER_LABEL
from code_reviewer_runner.job import IMPLEMENTER_WORK_DIR_VARIABLE
from code_reviewer_runner.job_loop.api import ApiUnavailable
from code_reviewer_runner.job_loop.http import ApiError

pytestmark = pytest.mark.unit

CREDENTIAL = "crc_" + "A" * 43
RENEWED = "crc_" + "R" * 43
# What only the Worker may hold: the dispatcher must never meet either.
GIT_TOKEN = "ghs_" + "G" * 36
MODEL_KEY = "sk-or-" + "M" * 40


def claim(number: int = 1, *, access: JobAccess | None = None) -> ClaimedWorker:
    """What a claim hands the dispatcher: the job and the credential of its Worker, nothing else."""
    return ClaimedWorker(
        job_id=f"00000000-0000-4000-8000-{number:012d}",
        credential="crj_" + str(number) * 43,
        access=access,
    )


class FastClock:
    """Time that only moves when something sleeps: a loop that waits ends at once."""

    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def wall(self) -> float:
        return 1_800_000_000.0 + self.now

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds
        await asyncio.sleep(0)


class FakeClient:
    def __init__(self) -> None:
        self.claims: list[ClaimedWorker | Exception | None] = []
        self.claim_calls = 0
        self.announced: list[Announcement] = []
        self.announce_error: Exception | None = None
        self.answer = Announced(None, False)
        self.renewals = 0
        self.credentials: list[str] = []
        # The claims given back: (job id, credential, reason); what the app answers to a release.
        self.releases: list[tuple[str, str, str]] = []
        self.release_answer: str | Exception = "released"
        # What the app says about a job (`GET /jobs/{id}`); a list is the sequence of answers.
        self.states: list[str | Exception | None] = []
        self.state_calls: list[str] = []

    def claim(self) -> ClaimedWorker | None:
        self.claim_calls += 1
        item = self.claims.pop(0) if self.claims else None
        if isinstance(item, Exception):
            raise item
        return item

    def announce(self, announcement: Announcement) -> Announced:
        self.announced.append(announcement)
        if self.announce_error is not None:
            raise self.announce_error
        return self.answer

    def renew(self) -> str:
        self.renewals += 1
        return RENEWED

    def use_credential(self, credential: str) -> None:
        self.credentials.append(credential)

    def release(self, job_id: str, credential: str, reason: str) -> str:
        self.releases.append((job_id, credential, reason))
        if isinstance(self.release_answer, Exception):
            raise self.release_answer
        return self.release_answer

    def job_state(self, job_id: str) -> str | None:
        self.state_calls.append(job_id)
        item = (
            self.states.pop(0)
            if len(self.states) > 1
            else (self.states[0] if self.states else "running")
        )
        if isinstance(item, Exception):
            raise item
        return item


class AutoLauncher(FakeLauncher):
    """Every Worker process ends at once with `result` (exit code 0 without one)."""

    def __init__(self, result: Any = None) -> None:
        super().__init__()
        self.result = result

    async def start(self, spec: Any) -> FakeProcess:
        process: FakeProcess = await super().start(spec)  # type: ignore[assignment]
        process.finish(self.result if self.result is not None else outcome(stdout=b""))
        return process


class FakeDaemon:
    """The daemon's list of what carries the role label, the lock container and the removals asked
    of it."""

    def __init__(self) -> None:
        self.containers: list[str] = []
        self.networks: list[str] = []
        self.removed: list[str] = []
        self.listing_fails = False
        self.images_removed: list[str] = []
        self.filters: list[str] = []
        # What the check for another runner is shown (every state, containers and networks).
        self.foreign: list[dict[str, Any]] = []
        # The labels of the lock container, if there is one, and every request made about it.
        self.lock: dict[str, str] | None = None
        self.lock_calls: list[str] = []

    def request(self, method: str, path: str, *args: Any, **kwargs: Any) -> Any:
        assert method == "GET"
        if self.listing_fails:
            raise DockerError(500, "no")
        labels = json.loads(parse_qs(urlsplit(path).query)["filters"][0])["label"]
        if len(labels) == 1:  # the role label alone: the check for another runner
            return self.foreign if path.startswith("/containers") else []
        self.filters.append(path)
        found = self.containers if path.startswith("/containers/json") else self.networks
        return [{"Id": identifier} for identifier in found]

    def create_container(self, document: dict[str, Any], name: str) -> str:
        assert name == "code-reviewer-runner-lock"
        self.lock_calls.append("create")
        if self.lock is not None:
            raise DockerError(409, "name in use")
        self.lock = document["Labels"]
        return container_id("9")

    def inspect_container(self, name: str) -> dict[str, Any]:
        assert name == "code-reviewer-runner-lock"
        if self.lock is None:
            raise DockerError(404, "no such container")
        return {"Config": {"Labels": self.lock}}

    def remove_container(self, container: str, **_kwargs: Any) -> None:
        if container == "code-reviewer-runner-lock":
            self.lock_calls.append("remove")
            self.lock = None
            return
        self.containers.remove(container)
        self.removed.append(container)

    def remove_network(self, network: str) -> None:
        self.networks.remove(network)
        self.removed.append(network)

    def remove_image(self, reference: str) -> None:
        self.images_removed.append(reference)


def container_id(letter: str) -> str:
    return letter * 64


class TurnLauncher(AutoLauncher):
    """A job process that makes what a turn makes in the work volume, with the code of a turn: the
    result directory (`make_result_directory` refuses one that exists), the mirror, the agent's
    repository with a read-only object and a link out of the volume, and a container that stays."""

    def __init__(self, work: Path, daemon: FakeDaemon, *, outside: Path) -> None:
        super().__init__()
        self.work = work
        self.daemon = daemon
        self.outside = outside
        self.turns = 0

    async def start(self, spec: Any) -> FakeProcess:
        self.turns += 1
        (self.work / "reserve" / "mirror.git" / "objects").mkdir(parents=True)
        object_file = self.work / "reserve" / "mirror.git" / "objects" / "pack"
        object_file.write_text("x")
        object_file.chmod(0o444)
        (self.work / "reserve" / "mirror.git" / "objects").chmod(0o555)
        (self.work / "repo").mkdir()
        (self.work / "repo" / "out").symlink_to(self.outside)
        make_result_directory(self.work)
        self.daemon.containers.append(container_id("d"))  # the door the turn did not remove
        return await super().start(spec)


def prepared(*, ready: bool = True, work: Path | None = None) -> Prepared:
    result = SelfTestResult(
        (Check("docker", True), Check("agent-container", ready, "" if ready else "did not start")),
        "runc",
        "1.19.0",
    )
    return Prepared(
        make_settings(engines=("implementer",), job_command=("job",)),
        {
            "PATH": "/usr/bin",
            "RUNNER_IMPLEMENTER_SANDBOX_PROOF": "proven",
            **({} if work is None else {IMPLEMENTER_WORK_DIR_VARIABLE: str(work)}),
        },
        Announcement(("linux",), "1.0.0", {}, {}),
        result,
    )


class Rig:
    def __init__(
        self,
        tmp_path: Path,
        *,
        launcher: FakeLauncher | None = None,
        ready: bool = True,
        clock: Any = None,
        environment: dict[str, str] | None = None,
        auto_update: bool = True,
        channel: Any = None,
        fetch: Any = None,
        reap_check_seconds: float | None = None,
    ) -> None:
        self.client = FakeClient()
        self.clock = clock or FastClock()
        self.daemon = FakeDaemon()
        self.work = tmp_path / "work"
        self.work.mkdir()
        self.launcher = launcher or AutoLauncher()
        self.environment = {"FACTORY_RUNNER_HOME": str(tmp_path / "home"), **(environment or {})}
        self.config = RunnerConfig(
            url="https://app.example",
            credential=CREDENTIAL,
            labels=("linux",),
            auto_update=auto_update,
        )
        self.service = RunnerService(
            self.config,
            self.environment,
            prepared(ready=ready, work=self.work),
            self.client,  # type: ignore[arg-type]
            seams=Seams(
                clock=self.clock,
                wall=self.clock.wall,
                launcher=lambda _grace: self.launcher,
                docker=lambda: self.daemon,  # type: ignore[arg-type,return-value]
                hostname=lambda: "runner-container",
                **({} if channel is None else {"channel": channel, "fetch": fetch}),
                **(
                    {} if reap_check_seconds is None else {"reap_check_seconds": reap_check_seconds}
                ),
            ),
        )

    @property
    def started(self) -> list[str]:
        """The jobs a Worker was started for, in order (from the start documents it was given)."""
        return [json.loads(process.spec.stdin)["jobId"] for process in self.launcher.processes]

    def go(self, *, once: bool, wait: float = 0.0) -> int:
        codes: list[int] = []

        async def scenario() -> None:
            codes.append(await self.service.run(once=once, wait_seconds=wait))

        run(scenario)
        return codes[0]


# -- the once mode -----------------------------------------------------------------------------


def test_once_without_a_job_ends_with_exit_code_zero_and_says_so(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        code = rig.go(once=True, wait=0)

    assert code == EXIT_OK
    assert "no job for the labels of this runner" in caplog.text
    assert rig.client.claim_calls == 1


def test_once_waits_for_a_job_up_to_the_deadline_and_then_ends_with_zero(tmp_path: Path) -> None:
    rig = Rig(tmp_path)

    code = rig.go(once=True, wait=100)

    assert code == EXIT_OK
    # Claims every poll interval (with jitter), not in a tight loop, and not past the deadline.
    assert 3 <= rig.client.claim_calls <= 5
    assert all(0.7 * POLL_SECONDS <= pause <= 1.3 * POLL_SECONDS for pause in rig.clock.slept)


def test_once_takes_one_job_starts_its_worker_and_ends(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    claimed = claim()
    rig.client.claims = [claimed, claim(2)]

    code = rig.go(once=True, wait=0)

    assert code == EXIT_OK
    assert rig.client.claim_calls == 1  # the second job stays in the queue for someone else
    # One Worker, started the way a Worker is: the module, and the start document on its stdin.
    assert rig.started == [claimed.job_id]
    spec = rig.launcher.processes[0].spec
    assert spec.argv == (sys.executable, "-m", WORKER_MODULE)
    assert json.loads(spec.stdin) == {
        "appUrl": "https://app.example",
        "jobId": claimed.job_id,
        "credential": claimed.credential,
    }
    assert rig.client.releases == []  # the Worker ended well: nothing to give back


def test_a_job_that_asks_for_nothing_of_the_device_gets_no_local_credential(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    rig.client.claims = [claim(access=JobAccess("opencode", "app-key"))]

    assert rig.go(once=True) == EXIT_OK

    assert "localEnvironment" not in json.loads(rig.launcher.processes[0].spec.stdin)


def test_a_worker_that_ends_with_an_error_is_exit_code_one_and_the_claim_is_given_back(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path, launcher=AutoLauncher(outcome(exit_code=1, stdout=b"", stderr=b"boom\n")))
    claimed = claim()
    rig.client.claims = [claimed]

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_FAILED

    # The app answers "ended" to a claim whose result was delivered, and counts an attempt if not.
    assert rig.client.releases == [(claimed.job_id, claimed.credential, "worker_exited")]
    assert "the Worker ended with exit code 1" in caplog.text
    assert "worker: boom" in caplog.text  # the Worker's own words, in the dispatcher's log


def test_a_worker_that_cannot_be_started_gives_the_claim_back_as_launch_failed(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    launcher = FakeLauncher()
    launcher.fail_with = OSError("no such file: " + CREDENTIAL)
    rig = Rig(tmp_path, launcher=launcher)
    claimed = claim()
    rig.client.claims = [claimed]

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_FAILED

    assert rig.client.releases == [(claimed.job_id, claimed.credential, "launch_failed")]
    assert "could not be started (OSError)" in caplog.text
    assert CREDENTIAL not in caplog.text  # the class of the error, never its text


def test_a_claim_that_cannot_be_given_back_is_said_and_does_not_stop_the_runner(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path, launcher=AutoLauncher(outcome(exit_code=2, stdout=b"")))
    rig.client.release_answer = ApiUnavailable("down")
    rig.client.claims = [claim()]

    with caplog.at_level(logging.WARNING, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_FAILED

    assert "could not be given back now (ApiUnavailable)" in caplog.text


def test_the_worker_never_sees_the_runners_credential(tmp_path: Path) -> None:
    rig = Rig(
        tmp_path,
        environment={"FACTORY_RUNNER_CREDENTIAL": CREDENTIAL, "FACTORY_RUNNER_URL": "https://x"},
    )
    rig.client.claims = [claim()]
    rig.go(once=True)

    spec = rig.launcher.processes[0].spec
    assert CREDENTIAL not in "".join(spec.env.values())
    assert not any(name.startswith("FACTORY_RUNNER") for name in spec.env)
    assert CREDENTIAL.encode() not in spec.stdin


# -- what a claim's failure means --------------------------------------------------------------


def test_a_revoked_runner_stops_for_good_with_its_own_exit_code(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.client.claims = [Revoked("revoked", 401)]

    assert rig.go(once=False) == EXIT_REVOKED
    assert rig.client.claim_calls == 1


def test_a_revoked_runner_is_also_told_at_the_announcement(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.client.announce_error = Revoked("revoked", 401)

    assert rig.go(once=False) == EXIT_REVOKED
    assert rig.client.claim_calls == 0


def test_an_update_the_app_requires_ends_the_once_mode_with_its_exit_code(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    rig.client.claims = [UpdateNeeded("1.4.0")]

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_UPDATE_NEEDED

    assert "update needed" in caplog.text
    assert "1.4.0" in caplog.text


def test_an_app_that_cannot_be_reached_is_tried_again_with_a_growing_pause(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.client.claims = [ApiUnavailable("down"), ApiUnavailable("down"), claim()]

    assert rig.go(once=True, wait=600) == EXIT_OK

    assert rig.clock.slept[:2] == [5.0, 10.0]
    assert len(rig.started) == 1  # and then it took the job


# #854-N3
def test_the_once_mode_tells_an_unreachable_app_from_no_job_by_its_exit_code(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    rig.client.claims = [ApiUnavailable("down")] * 50

    assert rig.go(once=True, wait=20) == EXIT_APP_UNREACHABLE != EXIT_OK
    assert rig.client.claim_calls < 10


def test_a_failed_announcement_does_not_stop_the_runner(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.client.announce_error = ApiUnavailable("down")
    rig.client.claims = [claim()]

    assert rig.go(once=True) == EXIT_OK
    assert len(rig.started) == 1


# -- ready or not ------------------------------------------------------------------------------


def test_a_runner_whose_base_is_not_proven_announces_and_takes_no_job(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path, ready=False)
    rig.client.claims = [claim()]

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_NOT_READY

    assert rig.client.announced  # the app learns that it is not ready
    assert rig.client.claim_calls == 0
    assert "agent-container" in caplog.text


# -- the credential ----------------------------------------------------------------------------


def test_an_old_credential_in_the_file_is_renewed_between_jobs_and_saved_first(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    save_config(
        RunnerConfig(
            url="https://app.example",
            credential=CREDENTIAL,
            runner_id="r1",
            credential_renewed_at=1_800_000_000.0 - RENEW_AFTER_SECONDS - 1,
        ),
        rig.environment,
    )
    rig.service._config = load_config(rig.environment)  # pyright: ignore[reportPrivateUsage]

    rig.go(once=True)

    assert rig.client.renewals == 1
    assert rig.client.credentials == [RENEWED]
    assert load_config(rig.environment).credential == RENEWED


def test_a_recent_credential_is_left_alone(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    save_config(
        RunnerConfig(
            url="https://app.example",
            credential=CREDENTIAL,
            runner_id="r1",
            credential_renewed_at=1_800_000_000.0,
        ),
        rig.environment,
    )
    rig.service._config = load_config(rig.environment)  # pyright: ignore[reportPrivateUsage]

    rig.go(once=True)

    assert rig.client.renewals == 0


def test_a_credential_from_the_environment_is_not_renewed_because_it_is_not_ours(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)  # no file in the home

    rig.go(once=True)

    assert rig.client.renewals == 0


def old_file(rig: Rig, *, runner_id: str = "r1") -> None:
    save_config(
        RunnerConfig(
            url="https://file.example",
            name="from-file",
            labels=("file-label",),
            credential=CREDENTIAL,
            runner_id=runner_id,
            credential_renewed_at=1_800_000_000.0 - RENEW_AFTER_SECONDS - 1,
        ),
        rig.environment,
    )


# #854-S2
def test_a_credential_from_the_environment_is_never_renewed_even_when_a_file_exists(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    old_file(rig)  # an old credential in the file, as an earlier `register` left it
    path = tmp_path / "home" / "config.json"
    before = path.read_bytes()
    other = "crc_" + "E" * 43
    rig.environment["FACTORY_RUNNER_CREDENTIAL"] = other
    rig.service._config = load_config(rig.environment)  # pyright: ignore[reportPrivateUsage]
    assert rig.service._config.credential == other  # pyright: ignore[reportPrivateUsage]

    rig.go(once=True)

    assert rig.client.renewals == 0 and rig.client.credentials == []
    assert path.read_bytes() == before  # the file was not touched


# #854-S2
def test_a_renewal_writes_the_credential_into_the_file_and_nothing_the_environment_overrides(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    old_file(rig)
    rig.environment.update(
        {
            "FACTORY_RUNNER_URL": "https://env.example",
            "FACTORY_RUNNER_NAME": "from-env",
            "FACTORY_RUNNER_LABELS": "env-label",
            "FACTORY_RUNNER_CPUS": "7",
        }
    )
    rig.service._config = load_config(rig.environment)  # pyright: ignore[reportPrivateUsage]

    rig.go(once=True)

    assert rig.client.renewals == 1
    stored = load_config({"FACTORY_RUNNER_HOME": rig.environment["FACTORY_RUNNER_HOME"]})
    assert stored.credential == RENEWED
    assert (stored.url, stored.name, stored.labels) == (
        "https://file.example",
        "from-file",
        ("file-label",),
    )
    assert stored.limits.cpus is None


# #854-S2
def test_a_renewal_that_cannot_be_saved_keeps_the_old_credential_in_use(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    old_file(rig)
    rig.service._config = load_config(rig.environment)  # pyright: ignore[reportPrivateUsage]

    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(service_module, "update_credential", refuse)

    with caplog.at_level(logging.WARNING, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_OK

    assert rig.client.credentials == []  # the new one was not used
    assert "cannot be written" in caplog.text
    assert RENEWED not in caplog.text


def test_the_credential_is_masked_in_the_log(tmp_path: Path) -> None:
    rig = Rig(tmp_path)

    assert CREDENTIAL not in rig.service._masker.redact(f"x {CREDENTIAL} y")  # pyright: ignore[reportPrivateUsage]


LOGIN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"
SUBSCRIPTION = JobAccess("claude-code", "subscription", "claude-sonnet-5-5")


def with_token_file(rig: Rig, tmp_path: Path, *, mode: int = 0o600) -> Path:
    path = tmp_path / "claude-code-token"
    path.write_text(LOGIN + "\n")
    path.chmod(mode)
    rig.environment["FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE"] = str(path)
    return path


# #856-L02, #974-T05
def test_a_job_that_asks_for_a_subscription_gets_the_login_of_the_device_on_the_workers_stdin(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    with_token_file(rig, tmp_path)
    claimed = claim(access=SUBSCRIPTION)
    rig.client.claims = [claimed]

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_OK

    spec = rig.launcher.processes[0].spec
    # The dispatcher read the token file and handed that one credential over, on stdin.
    assert json.loads(spec.stdin)["localEnvironment"] == {"CLAUDE_CODE_OAUTH_TOKEN": LOGIN}
    # Not in the Worker's environment, not in an argument, not in the log; masked if it ever were.
    assert LOGIN not in "".join(spec.env.values()) + " ".join(spec.argv)
    assert "FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE" not in spec.env
    assert LOGIN not in caplog.text
    assert LOGIN not in rig.service._masker.redact(f"x {LOGIN} y")  # pyright: ignore[reportPrivateUsage]


# #974-T05
def test_a_job_that_does_not_ask_for_the_subscription_never_gets_the_login(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    with_token_file(rig, tmp_path)
    rig.client.claims = [claim(access=JobAccess("opencode", "app-key")), claim(2)]

    rig.go(once=True)
    rig.go(once=True)

    for process in rig.launcher.processes:
        assert LOGIN.encode() not in process.spec.stdin


# #974-T05
def test_a_login_that_cannot_be_used_is_said_in_words_and_no_credential_is_handed(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    with_token_file(rig, tmp_path, mode=0o644)  # readable by others: refused, root or not
    rig.client.claims = [claim(access=SUBSCRIPTION)]

    with caplog.at_level(logging.WARNING, logger="code_reviewer_runner.loop"):
        rig.go(once=True)

    assert "localEnvironment" not in json.loads(rig.launcher.processes[0].spec.stdin)
    assert "no usable login" in caplog.text and "can be read by others" in caplog.text
    assert LOGIN not in caplog.text


# -- the stop ----------------------------------------------------------------------------------


def test_a_stop_ends_the_running_worker_and_the_loop(tmp_path: Path) -> None:
    rig = Rig(tmp_path, launcher=FakeLauncher(), clock=ManualClock())  # time stands still
    claimed = claim()
    rig.client.claims = [claimed]

    async def scenario() -> None:
        task = asyncio.create_task(rig.service.run(once=False))
        await until(lambda: bool(rig.launcher.running))  # the Worker is running
        rig.service.stop()
        # The Worker is asked to stop (a real one gives the job back itself); the loop ends too.
        assert await asyncio.wait_for(task, 5) == EXIT_OK

    run(scenario)
    assert rig.launcher.processes[0].terminated
    # This double dies of the signal before it can report anything: the claim goes back, as it does
    # for a Worker that was killed after its grace.
    assert rig.client.releases == [(claimed.job_id, claimed.credential, "worker_exited")]


def test_a_stop_ends_the_wait_between_claims(tmp_path: Path) -> None:
    rig = Rig(tmp_path, clock=ManualClock())  # time stands still: the wait would never end

    async def scenario() -> None:
        task = asyncio.create_task(rig.service.run(once=False))
        await until(lambda: rig.client.claim_calls >= 1)
        await asyncio.sleep(0.05)
        rig.service.stop()
        assert await asyncio.wait_for(task, 5) == EXIT_OK

    run(scenario)


async def until(condition: Callable[[], bool], seconds: float = 3.0) -> None:
    """The claim runs on a thread, so the loop needs real time to get to a job."""
    for _ in range(int(seconds / 0.01)):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the condition did not become true")


# -- the machine between jobs (B1, S1) ------------------------------------------------------------


# #854-B1
def test_two_jobs_in_a_row_each_find_the_work_volume_empty(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("not the volume's")
    rig = Rig(tmp_path, clock=ManualClock())  # time stands still: the wait after job 2 never ends
    launcher = TurnLauncher(rig.work, rig.daemon, outside=outside)
    rig.launcher = launcher
    rig.client.claims = [claim(), claim(2)]
    (rig.work / "other-volume-file").write_text("not a folder of a turn")

    async def scenario() -> None:
        task = asyncio.create_task(rig.service.run(once=False))
        await until(lambda: launcher.turns == 2 and not launcher.running)
        rig.service.stop()
        assert await asyncio.wait_for(task, 5) == EXIT_OK

    run(scenario)

    # `make_result_directory` and the mkdirs of the turn refuse leftovers: the second turn only
    # started because the first one's work was gone.
    assert launcher.turns == 2
    assert rig.started == [claim(1).job_id, claim(2).job_id]
    assert sorted(path.name for path in rig.work.iterdir()) == ["other-volume-file"]
    assert (outside / "keep.txt").read_text() == "not the volume's"  # a link is not followed


# #854-S1
def test_what_a_killed_run_left_in_the_daemon_is_removed_before_the_first_claim(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    rig.daemon.containers = [container_id("a"), container_id("b")]
    rig.daemon.networks = [container_id("c")]
    seen: list[tuple[list[str], list[str]]] = []
    real_claim = rig.client.claim

    def watching() -> ClaimedWorker | None:
        seen.append((list(rig.daemon.containers), list(rig.daemon.networks)))
        return real_claim()

    rig.client.claim = watching  # type: ignore[method-assign]

    rig.go(once=True)

    assert seen == [([], [])]
    assert rig.daemon.removed == [container_id("a"), container_id("b"), container_id("c")]
    assert all(ROLE_LABEL in path for path in rig.daemon.filters)  # only what is labelled ours


# #854-S1
def test_the_containers_a_job_leaves_are_removed_right_after_it(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    rig = Rig(tmp_path)
    rig.launcher = TurnLauncher(rig.work, rig.daemon, outside=outside)
    rig.client.claims = [claim()]

    rig.go(once=True)

    assert rig.daemon.containers == []  # the door with the key did not outlive the job
    assert list(rig.work.iterdir()) == []


# #854-S1
def test_a_runner_that_cannot_be_tidied_claims_nothing_and_says_why(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    rig.daemon.listing_fails = True
    rig.client.claims = [claim()]

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_FAILED

    assert rig.client.claim_calls == 0
    assert "cannot be cleaned" in caplog.text


# #854-S1
def test_a_runner_that_cannot_be_tidied_tries_again_and_then_takes_the_job(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    rig.daemon.listing_fails = True
    rig.client.claims = [claim()]
    waited: list[float] = []
    sleep = rig.clock.sleep

    async def sleeping(seconds: float) -> None:
        waited.append(seconds)
        rig.daemon.listing_fails = False  # the daemon is back
        await sleep(seconds)

    rig.clock.sleep = sleeping  # type: ignore[method-assign]

    async def scenario() -> None:
        task = asyncio.create_task(rig.service.run(once=False))
        await until(lambda: bool(rig.started))
        rig.service.stop()
        assert await asyncio.wait_for(task, 5) == EXIT_OK

    run(scenario)

    assert waited[0] == TIDY_RETRY_SECONDS
    assert len(rig.started) == 1  # and then it took the job


# -- one runner per daemon (R1) -------------------------------------------------------------------


# #854-R1
def test_the_sweep_asks_for_the_id_of_this_runner_and_no_other_label_value(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.service._tidy = replace(  # pyright: ignore[reportPrivateUsage]
        rig.service._tidy,  # pyright: ignore[reportPrivateUsage]
        runner_id="runner-1",
    )

    rig.go(once=True)

    assert rig.daemon.filters
    assert all(f"{RUNNER_LABEL}=runner-1" in unquote(path) for path in rig.daemon.filters)


# #854-R1
def test_without_an_id_in_the_config_the_runner_is_named_by_a_digest_of_its_credential(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)

    rig.go(once=True)

    assert all(f"{RUNNER_LABEL}=credential-" in unquote(path) for path in rig.daemon.filters)
    assert CREDENTIAL not in "".join(rig.daemon.filters)


def foreign_container(
    name: str = "code-reviewer-agent", runner: str | None = None
) -> dict[str, Any]:
    return {
        "Id": container_id("f"),
        "Names": [f"/{name}"],
        "Labels": {ROLE_LABEL: "agent", **({} if runner is None else {RUNNER_LABEL: runner})},
    }


# #854-R1
def test_a_container_of_another_runner_ends_the_start_before_any_claim(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    rig.daemon.foreign = [foreign_container()]
    rig.client.claims = [claim()]

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_SHARED_DAEMON

    assert rig.client.claim_calls == 0 and rig.client.announced == []
    assert rig.daemon.removed == []  # and nothing of the other runner is touched
    assert "another factory-runner uses this Docker daemon" in caplog.text


# #854-S4
def test_the_log_of_exit_nine_names_the_first_hit(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    rig.daemon.foreign = [foreign_container("code-reviewer-door"), foreign_container("second-hit")]

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_SHARED_DAEMON

    assert "container code-reviewer-door (role agent, runner none)" in caplog.text
    assert "second-hit" not in caplog.text


# #854-S4
def test_the_log_names_the_runner_id_of_the_other_one(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    rig.daemon.foreign = [foreign_container(runner="runner-2")]

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_SHARED_DAEMON

    assert "(role agent, runner runner-2)" in caplog.text


# #854-R1
def test_a_container_of_this_runner_is_not_another_runner(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    own = rig.service._tidy.runner_id  # pyright: ignore[reportPrivateUsage]
    rig.daemon.foreign = [foreign_container(runner=own)]

    assert rig.go(once=True) == EXIT_OK
    assert rig.client.claim_calls == 1


# #854-S1
def test_the_runner_holds_the_lock_while_it_runs_and_removes_it_at_the_end(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    seen: list[dict[str, str] | None] = []
    real = rig.client.claim

    def claim() -> Any:
        seen.append(rig.daemon.lock)
        return real()

    rig.client.claim = claim  # type: ignore[method-assign]

    assert rig.go(once=True) == EXIT_OK

    own = rig.service._tidy.runner_id  # pyright: ignore[reportPrivateUsage]
    assert seen == [{"code-reviewer.runner-lock": own}]
    assert rig.daemon.lock is None


# #854-S1
def test_a_second_runner_that_finds_the_lock_taken_ends_with_exit_nine_and_leaves_it(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    rig.daemon.lock = {"code-reviewer.runner-lock": "runner-2"}

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_SHARED_DAEMON

    assert rig.client.claim_calls == 0 and rig.client.announced == []
    assert "held by runner runner-2" in caplog.text
    assert rig.daemon.lock == {"code-reviewer.runner-lock": "runner-2"}  # and it is still theirs


# #854-S1
def test_the_lock_is_given_back_when_another_runner_was_found(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.daemon.foreign = [foreign_container()]

    assert rig.go(once=True) == EXIT_SHARED_DAEMON

    assert rig.daemon.lock is None


# #854-S1
def test_the_lock_is_removed_when_the_run_ends_by_a_revoked_credential(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.client.claims = [Revoked("revoked", 401)]

    assert rig.go(once=True) == EXIT_REVOKED

    assert rig.daemon.lock is None


# #854-N4
def test_a_runner_with_no_identity_ends_with_a_configuration_error_and_sweeps_nothing(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    rig.service._tidy = replace(  # pyright: ignore[reportPrivateUsage]
        rig.service._tidy,  # pyright: ignore[reportPrivateUsage]
        runner_id="",
    )
    rig.daemon.containers = [container_id("a")]

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_CONFIG

    assert "no identity" in caplog.text
    assert rig.daemon.removed == [] and rig.daemon.filters == [] and rig.daemon.lock_calls == []
    assert rig.client.claim_calls == 0


# #854-N3
def test_the_once_mode_that_was_answered_once_and_then_lost_the_app_is_no_job_not_unreachable(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    rig.client.claims = [None, *[ApiUnavailable("down")] * 50]

    assert rig.go(once=True, wait=100) == EXIT_OK


# #854-R2
def test_the_work_volume_stays_as_it_is_when_a_container_could_not_be_removed(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    (rig.work / "repo").mkdir()
    rig.daemon.listing_fails = True
    rig.client.claims = [claim()]

    assert rig.go(once=True) == EXIT_FAILED

    assert rig.client.claim_calls == 0
    assert (rig.work / "repo").is_dir()


# #854-F6
def test_a_credential_file_of_another_runner_is_not_overwritten_by_a_renewal(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path)
    old_file(rig, runner_id="runner-2")  # registered again meanwhile, as another runner
    rig.service._config = replace(  # pyright: ignore[reportPrivateUsage]
        load_config(rig.environment), runner_id="runner-1"
    )

    rig.go(once=True)

    assert rig.client.renewals == 1 and rig.client.credentials == []  # the old one stays in use
    stored = load_config(rig.environment)
    assert (stored.runner_id, stored.credential) == ("runner-2", CREDENTIAL)


# -- the update between jobs (#855) -----------------------------------------------------------


class ImageDaemon(FakeDaemon):
    """A daemon that also knows images: the one this container runs (release 1) and, once the
    digest of the release is pulled, that image (with the number it carries)."""

    def __init__(self, *, label: int) -> None:
        super().__init__()
        self.label = label
        self.images: dict[str, dict[str, Any]] = {
            "sha256:own": {"Id": "sha256:own", "Config": {"Labels": {RELEASE_LABEL: "1"}}},
            CURRENT_REFERENCE: {"Id": "sha256:own"},
        }
        self.pulls = 0
        # The image id the container of the service runs.
        self.own = "sha256:own"
        # What `GET /images/json` lists, and the references asked to be removed.
        self.listing: list[dict[str, Any]] = []
        self.deleted: list[str] = []

    def inspect_container(self, name: str) -> dict[str, Any]:
        if name == "runner-container":
            return {"Image": self.own}
        return super().inspect_container(name)

    def inspect_image(self, reference: str) -> dict[str, Any]:
        if reference not in self.images:
            raise DockerError(404, "no such image")
        return self.images[reference]

    def request(self, method: str, path: str, *args: Any, **kwargs: Any) -> Any:
        if not path.startswith("/images/"):
            return super().request(method, path, *args, **kwargs)
        if path.startswith("/images/json"):
            return self.listing
        if method == "DELETE":
            self.deleted.append(path.removeprefix("/images/"))
            return None
        if path.startswith("/images/create"):
            self.pulls += 1
            self.images[f"{REPOSITORY}@{DIGEST}"] = {
                "Id": "sha256:new",
                "Config": {"Labels": {RELEASE_LABEL: str(self.label)}},
            }
        elif "/tag?" in path and path.endswith("repo=factory-runner&tag=current"):
            self.images[CURRENT_REFERENCE] = self.images[
                path.split("/images/")[1].split("/tag?")[0]
            ]
        return None


class UpdateRig(Rig):
    def __init__(self, tmp_path: Path, *, offered: int = 2, **kwargs: Any) -> None:
        self.release = Release(release=offered)
        self.served = self.release.served()
        self.fetched: list[str] = []
        super().__init__(
            tmp_path,
            environment={IMAGE_TAG_VARIABLE: CURRENT_REFERENCE},
            channel=self.release.channel,
            fetch=self._fetch,
            **kwargs,
        )
        self.daemon = ImageDaemon(label=offered)

    def _fetch(self, url: str) -> bytes:
        self.fetched.append(url)
        return fetcher(self.served)(url)


def test_a_staged_image_is_switched_to_between_jobs_and_nothing_is_claimed_first(
    tmp_path: Path,
) -> None:
    rig = UpdateRig(tmp_path)
    rig.daemon.images[CURRENT_REFERENCE] = {"Id": "sha256:new"}  # `factory-runner update` did it
    rig.client.claims = [claim()]

    assert rig.go(once=False) == EXIT_UPDATED
    assert rig.client.claim_calls == 0


def test_a_job_that_is_running_is_never_interrupted_by_an_update(tmp_path: Path) -> None:
    rig = UpdateRig(tmp_path)
    daemon = rig.daemon

    class Staging(AutoLauncher):
        async def start(self, spec: Any) -> Any:
            daemon.images[CURRENT_REFERENCE] = {"Id": "sha256:new"}  # staged during the job
            return await super().start(spec)

    rig.launcher = Staging()
    rig.client.claims = [claim(), claim(2)]

    assert rig.go(once=False) == EXIT_UPDATED
    assert rig.client.claim_calls == 1
    assert rig.client.releases == []  # the Worker ended well and its job was not given back


def test_the_once_mode_and_a_runner_without_a_supervisor_never_switch(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    once = UpdateRig(tmp_path / "a")
    once.daemon.images[CURRENT_REFERENCE] = {"Id": "sha256:new"}
    assert once.go(once=True, wait=0) == EXIT_OK

    # No FACTORY_RUNNER_IMAGE_TAG: somebody's `docker run`, nobody would start it again.
    free = Rig(tmp_path / "b")
    assert free.go(once=True, wait=0) == EXIT_OK


def test_the_first_look_for_a_release_comes_minutes_after_the_start_not_at_it(
    tmp_path: Path,
) -> None:
    rig = UpdateRig(tmp_path)
    rig.client.claims = [*([None] * 30), Revoked("no", 401)]

    assert rig.go(once=False) == EXIT_UPDATED  # the release 2 behind `stable` was staged
    # 30 s polls: the check was due after 600 s, i.e. after about 20 of them.
    assert 15 <= rig.client.claim_calls <= 25
    assert rig.daemon.pulls == 1
    assert rig.fetched == [MANIFEST_URL, SIGNATURE_URL]


def test_a_runner_with_automatic_updates_off_does_not_look_by_itself(tmp_path: Path) -> None:
    rig = UpdateRig(tmp_path, auto_update=False)
    rig.client.claims = [*([None] * 30), Revoked("no", 401)]

    assert rig.go(once=False) == EXIT_REVOKED
    assert rig.daemon.pulls == 0


def test_update_needed_looks_at_once_even_with_automatic_updates_off(tmp_path: Path) -> None:
    rig = UpdateRig(tmp_path, auto_update=False)
    rig.client.claims = [UpdateNeeded("1.4.0")]

    assert rig.go(once=False) == EXIT_UPDATED
    assert rig.daemon.pulls == 1


def test_an_update_needed_that_cannot_be_met_is_said_and_waits_as_before(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = UpdateRig(tmp_path)
    forged = Release(release=2)  # somebody else's key signs what the channel's address serves
    rig.served = {MANIFEST_URL: forged.manifest(), SIGNATURE_URL: forged.signature()}
    rig.client.claims = [UpdateNeeded("1.4.0"), Revoked("no", 401)]

    with caplog.at_level(logging.WARNING):
        assert rig.go(once=False) == EXIT_REVOKED

    assert "no update: the signature of the release manifest is not valid" in caplog.text
    assert rig.daemon.pulls == 0
    assert CURRENT_REFERENCE in rig.daemon.images and rig.daemon.images[CURRENT_REFERENCE] == {
        "Id": "sha256:own"
    }


# #855-F1 (B1): a rollback is not undone by the service ten minutes later.
@pytest.mark.parametrize(("offered", "switches"), [(2, False), (3, True)])
def test_a_rolled_back_release_is_not_taken_again_until_a_higher_one_comes(
    tmp_path: Path, offered: int, switches: bool
) -> None:
    rig = UpdateRig(tmp_path, offered=offered)
    daemon = rig.daemon
    # Release 2 ran and was bad; the operator rolled back, and the service starts on release 1.
    daemon.images["sha256:bad"] = {"Id": "sha256:bad", "Config": {"Labels": {RELEASE_LABEL: "2"}}}
    daemon.images["sha256:own"]["Config"] = {"Labels": {RELEASE_LABEL: "1"}}
    daemon.images[CURRENT_REFERENCE] = daemon.images["sha256:bad"]
    daemon.images[PREVIOUS_REFERENCE] = daemon.images["sha256:own"]
    assert rollback(daemon, tmp_path / "home") == 2  # type: ignore[arg-type]
    assert daemon.images[CURRENT_REFERENCE]["Id"] == "sha256:own"
    rig.client.claims = [*([None] * 30), Revoked("no", 401)]

    assert rig.go(once=False) == (EXIT_UPDATED if switches else EXIT_REVOKED)

    assert daemon.pulls == (1 if switches else 0)
    assert (daemon.images[CURRENT_REFERENCE]["Id"] == "sha256:new") is switches


# #855-F1 (S7): a runner that is not ready waits before it ends, so the unit does not restart it
# every ten seconds.
def test_a_service_that_is_not_ready_waits_before_it_ends_and_the_once_mode_does_not(
    tmp_path: Path,
) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    service = Rig(tmp_path / "a", ready=False)
    assert service.go(once=False) == EXIT_NOT_READY
    assert sum(service.clock.slept) >= 300

    once = Rig(tmp_path / "b", ready=False)
    assert once.go(once=True) == EXIT_NOT_READY
    assert once.clock.slept == []


# #855-F1 (S6): the references of releases before `current` and `previous` go at the start.
def test_the_digest_references_of_old_releases_are_removed_at_the_start(tmp_path: Path) -> None:
    rig = UpdateRig(tmp_path)
    daemon = rig.daemon
    keep, old = f"{REPOSITORY}@sha256:" + "a" * 64, f"{REPOSITORY}@sha256:" + "b" * 64
    foreign = "other.example/thing@sha256:" + "c" * 64
    daemon.images[CURRENT_REFERENCE] = {"Id": "sha256:own", "RepoDigests": [keep]}
    daemon.listing = [
        {"Id": "sha256:own", "RepoDigests": [keep]},
        {"Id": "sha256:older", "RepoDigests": [old]},
        {"Id": "sha256:other", "RepoDigests": [foreign]},
        {"Id": "sha256:none", "RepoDigests": None},
    ]
    rig.client.claims = [Revoked("no", 401)]

    assert rig.go(once=False) == EXIT_REVOKED

    assert daemon.deleted == [old]


# -- the local reaper (#974 review, tested in #978) ----------------------------------------------


class HangingLauncher(FakeLauncher):
    """A Worker that never ends by itself: only the reaper or a stop ends it."""


def reaped_scenario(rig: Rig, *, seconds: float, step: float) -> int:
    """Run `once` with a Worker that hangs, move the clock `seconds` in `step`s (waiting for the
    reaper's thread to ask the app each time), then end whatever still runs and return the code."""
    codes: list[int] = []

    async def scenario() -> None:
        task = asyncio.create_task(rig.service.run(once=True, wait_seconds=0))
        await until(lambda: bool(rig.launcher.processes))
        for number in range(1, int(seconds / step) + 1):
            await rig.clock.advance(step)
            await until(lambda n=number: len(rig.client.state_calls) >= n)
            await settle()
        for process in rig.launcher.processes:
            process.finish()
        codes.append(await asyncio.wait_for(task, 5))

    run(scenario)
    return codes[0]


# #978-T10
def test_a_worker_that_outlives_its_ended_job_is_stopped_after_the_grace(tmp_path: Path) -> None:
    rig = Rig(tmp_path, launcher=HangingLauncher(), clock=ManualClock(), reap_check_seconds=10.0)
    rig.client.claims = [claim()]
    rig.client.states = ["ended"]
    process_before_grace: list[bool] = []

    async def scenario() -> None:
        task = asyncio.create_task(rig.service.run(once=True, wait_seconds=0))
        await until(lambda: bool(rig.launcher.processes))
        for number in range(1, 6):  # 10 s .. 50 s: over since 10 s, 40 s of the 45 s of grace
            await rig.clock.advance(10)
            await until(lambda n=number: len(rig.client.state_calls) >= n)
            await settle()
        process_before_grace.append(rig.launcher.processes[0].terminated)
        await rig.clock.advance(10)  # 60 s: 50 s over, the grace is gone
        assert await asyncio.wait_for(task, 5) == EXIT_FAILED

    run(scenario)

    assert process_before_grace == [False]
    assert rig.launcher.processes[0].terminated is True
    # The app ended the job: there is no claim to give back.
    assert rig.client.releases == []


# #978-T10
def test_a_worker_whose_job_is_still_running_is_left_alone(tmp_path: Path) -> None:
    rig = Rig(tmp_path, launcher=HangingLauncher(), clock=ManualClock(), reap_check_seconds=10.0)
    rig.client.claims = [claim()]
    rig.client.states = ["running"]

    code = reaped_scenario(rig, seconds=200, step=10)

    assert code == EXIT_OK
    assert rig.launcher.processes[0].terminated is False


# #978-T10
def test_a_superseded_job_is_still_live_and_its_worker_is_left_alone(tmp_path: Path) -> None:
    rig = Rig(tmp_path, launcher=HangingLauncher(), clock=ManualClock(), reap_check_seconds=10.0)
    rig.client.claims = [claim()]
    rig.client.states = ["superseded"]

    reaped_scenario(rig, seconds=120, step=10)

    assert rig.launcher.processes[0].terminated is False


# #978-T10
def test_a_job_that_was_over_and_is_live_again_starts_the_grace_over(tmp_path: Path) -> None:
    rig = Rig(tmp_path, launcher=HangingLauncher(), clock=ManualClock(), reap_check_seconds=10.0)
    rig.client.claims = [claim()]
    # over at 10 s and 20 s, live at 30 s (the grace is reset), over again from 40 s on
    rig.client.states = ["ended", "ended", "running", "ended", "running"]

    reaped_scenario(rig, seconds=50, step=10)

    assert rig.launcher.processes[0].terminated is False


# #978-T10
def test_a_check_the_app_cannot_answer_is_ignored_and_never_ends_the_worker(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path, launcher=HangingLauncher(), clock=ManualClock(), reap_check_seconds=10.0)
    rig.client.claims = [claim()]
    rig.client.states = [
        ApiUnavailable("app down"),
        Revoked("revoked", 401),
        ApiError("500", 500),
        "running",
    ]

    code = reaped_scenario(rig, seconds=120, step=10)

    assert code == EXIT_OK
    assert rig.launcher.processes[0].terminated is False
