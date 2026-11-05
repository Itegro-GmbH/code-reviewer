# SPDX-License-Identifier: LicenseRef-Proprietary

"""The loop of the Factory-Runner (#854, R1b) with doubles: what it announces, what a claim's
failure means, the once mode a VM runs, the renewal of the credential and the stop."""

import asyncio
import logging
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import pytest
from loop_support import (
    FakeApi,
    FakeLauncher,
    FakeProcess,
    ManualClock,
    make_settings,
    outcome,
    run,
)
from test_implementer_job_host import implementer_claim, line

from code_reviewer_runner.factory_runner import service as service_module
from code_reviewer_runner.factory_runner.app_client import (
    Announced,
    Announcement,
    Revoked,
    UpdateNeeded,
)
from code_reviewer_runner.factory_runner.base import (
    EXIT_APP_UNREACHABLE,
    EXIT_FAILED,
    EXIT_NOT_READY,
    EXIT_OK,
    EXIT_REVOKED,
    EXIT_SHARED_DAEMON,
    EXIT_UPDATE_NEEDED,
)
from code_reviewer_runner.factory_runner.config import (
    RunnerConfig,
    load_config,
    save_config,
)
from code_reviewer_runner.factory_runner.prepare import Prepared
from code_reviewer_runner.factory_runner.selftest import Check, SelfTestResult
from code_reviewer_runner.factory_runner.service import (
    POLL_SECONDS,
    RENEW_AFTER_SECONDS,
    TIDY_RETRY_SECONDS,
    RunnerService,
    Seams,
)
from code_reviewer_runner.implementer.docker_api import DockerError
from code_reviewer_runner.implementer.result_channel import make_result_directory
from code_reviewer_runner.implementer.role_labels import ROLE_LABEL, RUNNER_LABEL
from code_reviewer_runner.job import IMPLEMENTER_WORK_DIR_VARIABLE
from code_reviewer_runner.job_loop.api import ApiUnavailable, ClaimedJob

pytestmark = pytest.mark.unit

CREDENTIAL = "crc_" + "A" * 43
RENEWED = "crc_" + "R" * 43


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
        self.claims: list[ClaimedJob | Exception | None] = []
        self.claim_calls = 0
        self.announced: list[Announcement] = []
        self.announce_error: Exception | None = None
        self.answer = Announced(None, False)
        self.renewals = 0
        self.credentials: list[str] = []

    def claim(self) -> ClaimedJob | None:
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


class FakeJobApi(FakeApi):
    def __init__(self) -> None:
        super().__init__()
        self.held: list[tuple[str, str]] = []
        self.forgotten: list[str] = []
        self.credentials: list[str] = []

    def hold(self, job_id: str, lease_token: str) -> None:
        self.held.append((job_id, lease_token))

    def forget(self, job_id: str) -> None:
        self.forgotten.append(job_id)

    def use_credential(self, credential: str) -> None:
        self.credentials.append(credential)


class AutoLauncher(FakeLauncher):
    """Every job process ends at once with `result`."""

    def __init__(self, result: Any = None) -> None:
        super().__init__()
        self.result = result

    async def start(self, spec: Any) -> FakeProcess:
        process: FakeProcess = await super().start(spec)  # type: ignore[assignment]
        process.finish(self.result if self.result is not None else outcome(stdout=line()))
        return process


class FakeDaemon:
    """The daemon's list of what carries the role label, and the removals asked of it."""

    def __init__(self) -> None:
        self.containers: list[str] = []
        self.networks: list[str] = []
        self.removed: list[str] = []
        self.listing_fails = False
        self.filters: list[str] = []
        # The running containers of Control that the check for another runner is shown.
        self.running: list[dict[str, Any]] = []

    def request(self, method: str, path: str, *args: Any, **kwargs: Any) -> Any:
        assert method == "GET"
        if self.listing_fails:
            raise DockerError(500, "no")
        if "running" in path:
            return self.running
        self.filters.append(path)
        found = self.containers if path.startswith("/containers/json") else self.networks
        return [{"Id": identifier} for identifier in found]

    def remove_container(self, container: str, **_kwargs: Any) -> None:
        self.containers.remove(container)
        self.removed.append(container)

    def remove_network(self, network: str) -> None:
        self.networks.remove(network)
        self.removed.append(network)


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
    ) -> None:
        self.client = FakeClient()
        self.api = FakeJobApi()
        self.clock = clock or FastClock()
        self.daemon = FakeDaemon()
        self.work = tmp_path / "work"
        self.work.mkdir()
        self.launcher = launcher or AutoLauncher()
        self.environment = {"FACTORY_RUNNER_HOME": str(tmp_path / "home")}
        self.config = RunnerConfig(
            url="https://app.example", credential=CREDENTIAL, labels=("linux",)
        )
        self.service = RunnerService(
            self.config,
            self.environment,
            prepared(ready=ready, work=self.work),
            self.client,  # type: ignore[arg-type]
            self.api,  # type: ignore[arg-type]
            seams=Seams(
                clock=self.clock,
                wall=self.clock.wall,
                launcher=lambda _grace: self.launcher,
                docker=lambda: self.daemon,  # type: ignore[arg-type,return-value]
            ),
        )

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


def test_once_takes_one_job_runs_it_and_ends(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    claimed = implementer_claim()
    rig.client.claims = [claimed, implementer_claim(2)]

    code = rig.go(once=True, wait=0)

    assert code == EXIT_OK
    assert rig.client.claim_calls == 1  # the second job stays in the queue for someone else
    assert rig.api.held == [(claimed.id, claimed.lease_token)]
    assert rig.api.forgotten == [claimed.id]
    assert [(job, token) for job, token, _ in rig.api.completions] == [
        (claimed.id, claimed.lease_token)
    ]
    assert rig.api.completions[0][2]["ok"] is True


def test_a_failed_job_is_exit_code_one_in_the_once_mode(tmp_path: Path) -> None:
    rig = Rig(tmp_path, launcher=AutoLauncher(outcome(exit_code=1, stdout=b"")))
    rig.client.claims = [implementer_claim()]

    assert rig.go(once=True) == EXIT_FAILED


def test_the_job_process_never_sees_the_credential(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.client.claims = [implementer_claim()]
    rig.go(once=True)

    spec = rig.launcher.processes[0].spec
    assert CREDENTIAL not in "".join(spec.env.values())
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
    rig.client.claims = [ApiUnavailable("down"), ApiUnavailable("down"), implementer_claim()]

    assert rig.go(once=True, wait=600) == EXIT_OK

    assert rig.clock.slept[:2] == [5.0, 10.0]
    assert rig.api.completions  # and then it took the job


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
    rig.client.claims = [implementer_claim()]

    assert rig.go(once=True) == EXIT_OK
    assert rig.api.completions


# -- ready or not ------------------------------------------------------------------------------


def test_a_runner_whose_base_is_not_proven_announces_and_takes_no_job(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path, ready=False)
    rig.client.claims = [implementer_claim()]

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
            credential_renewed_at=1_800_000_000.0 - RENEW_AFTER_SECONDS - 1,
        ),
        rig.environment,
    )
    rig.service._config = load_config(rig.environment)  # pyright: ignore[reportPrivateUsage]

    rig.go(once=True)

    assert rig.client.renewals == 1
    assert rig.client.credentials == [RENEWED] == rig.api.credentials
    assert load_config(rig.environment).credential == RENEWED


def test_a_recent_credential_is_left_alone(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    save_config(
        RunnerConfig(
            url="https://app.example", credential=CREDENTIAL, credential_renewed_at=1_800_000_000.0
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


def old_file(rig: Rig, **changes: Any) -> None:
    save_config(
        RunnerConfig(
            url="https://file.example",
            name="from-file",
            labels=("file-label",),
            credential=CREDENTIAL,
            credential_renewed_at=1_800_000_000.0 - RENEW_AFTER_SECONDS - 1,
            **changes,
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

    assert rig.client.credentials == [] and rig.api.credentials == []  # the new one was not used
    assert "cannot be written" in caplog.text
    assert RENEWED not in caplog.text


def test_the_credential_is_masked_in_the_log(tmp_path: Path) -> None:
    rig = Rig(tmp_path)

    assert CREDENTIAL not in rig.service._masker.redact(f"x {CREDENTIAL} y")  # pyright: ignore[reportPrivateUsage]


# -- the stop ----------------------------------------------------------------------------------


def test_a_stop_gives_the_running_job_back_and_ends_the_loop(tmp_path: Path) -> None:
    rig = Rig(tmp_path, launcher=FakeLauncher(), clock=ManualClock())  # time stands still
    rig.client.claims = [implementer_claim()]

    async def scenario() -> None:
        task = asyncio.create_task(rig.service.run(once=False))
        await until(lambda: bool(rig.launcher.running))  # the job is running
        rig.service.stop()
        assert await asyncio.wait_for(task, 5) == EXIT_OK

    run(scenario)
    assert rig.api.completions
    assert rig.api.completions[0][2]["errorCode"] == "runner_shutdown"


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
    rig.client.claims = [implementer_claim(), implementer_claim(2)]
    (rig.work / "other-volume-file").write_text("not a folder of a turn")

    async def scenario() -> None:
        task = asyncio.create_task(rig.service.run(once=False))
        await until(lambda: len(rig.api.completions) == 2)
        rig.service.stop()
        assert await asyncio.wait_for(task, 5) == EXIT_OK

    run(scenario)

    # `make_result_directory` and the mkdirs of the turn refuse leftovers: the second turn only
    # started because the first one's work was gone.
    assert launcher.turns == 2
    assert [result["ok"] for _, _, result in rig.api.completions] == [True, True]
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
    claim = rig.client.claim

    def watching() -> ClaimedJob | None:
        seen.append((list(rig.daemon.containers), list(rig.daemon.networks)))
        return claim()

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
    rig.client.claims = [implementer_claim()]

    rig.go(once=True)

    assert rig.daemon.containers == []  # the door with the key did not outlive the job
    assert list(rig.work.iterdir()) == []


# #854-S1
def test_a_runner_that_cannot_be_tidied_claims_nothing_and_says_why(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    rig.daemon.listing_fails = True
    rig.client.claims = [implementer_claim()]

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
    rig.client.claims = [implementer_claim()]
    waited: list[float] = []
    sleep = rig.clock.sleep

    async def sleeping(seconds: float) -> None:
        waited.append(seconds)
        rig.daemon.listing_fails = False  # the daemon is back
        await sleep(seconds)

    rig.clock.sleep = sleeping  # type: ignore[method-assign]

    async def scenario() -> None:
        task = asyncio.create_task(rig.service.run(once=False))
        await until(lambda: bool(rig.api.completions))
        rig.service.stop()
        assert await asyncio.wait_for(task, 5) == EXIT_OK

    run(scenario)

    assert waited[0] == TIDY_RETRY_SECONDS
    assert rig.api.completions  # and then it took the job


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


# #854-R1
def test_a_running_container_of_another_runner_ends_the_start_before_any_claim(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    rig = Rig(tmp_path)
    rig.daemon.running = [{"Id": container_id("f"), "Labels": {ROLE_LABEL: "agent"}}]
    rig.client.claims = [implementer_claim()]

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        assert rig.go(once=True) == EXIT_SHARED_DAEMON

    assert rig.client.claim_calls == 0 and rig.client.announced == []
    assert rig.daemon.removed == []  # and nothing of the other runner is touched
    assert "another factory-runner uses this Docker daemon" in caplog.text


# #854-R1
def test_a_running_container_of_this_runner_is_not_another_runner(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    own = rig.service._tidy.runner_id  # pyright: ignore[reportPrivateUsage]
    rig.daemon.running = [{"Id": container_id("f"), "Labels": {ROLE_LABEL: "a", RUNNER_LABEL: own}}]

    assert rig.go(once=True) == EXIT_OK
    assert rig.client.claim_calls == 1


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
    rig.client.claims = [implementer_claim()]

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
