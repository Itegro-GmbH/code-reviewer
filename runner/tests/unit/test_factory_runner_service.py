# SPDX-License-Identifier: LicenseRef-Proprietary

"""The loop of the Factory-Runner (#854, R1b) with doubles: what it announces, what a claim's failure
means, the once mode a VM runs, the renewal of the credential and the stop."""

import asyncio
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

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

from code_reviewer_runner.factory_runner.app_client import (
    Announced,
    Announcement,
    Revoked,
    UpdateNeeded,
)
from code_reviewer_runner.factory_runner.base import (
    EXIT_FAILED,
    EXIT_NOT_READY,
    EXIT_OK,
    EXIT_REVOKED,
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
    RunnerService,
    Seams,
)
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


def prepared(*, ready: bool = True) -> Prepared:
    result = SelfTestResult(
        (Check("docker", True), Check("agent-container", ready, "" if ready else "did not start")),
        "runc",
        "1.19.0",
    )
    return Prepared(
        make_settings(engines=("implementer",), job_command=("job",)),
        {"PATH": "/usr/bin", "RUNNER_IMPLEMENTER_SANDBOX_PROOF": "proven"},
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
        self.launcher = launcher or AutoLauncher()
        self.environment = {"FACTORY_RUNNER_HOME": str(tmp_path / "home")}
        self.config = RunnerConfig(
            url="https://app.example", credential=CREDENTIAL, labels=("linux",)
        )
        self.service = RunnerService(
            self.config,
            self.environment,
            prepared(ready=ready),
            self.client,  # type: ignore[arg-type]
            self.api,  # type: ignore[arg-type]
            seams=Seams(
                clock=self.clock, wall=self.clock.wall, launcher=lambda _grace: self.launcher
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


# -- what a claim's failure means -----------------------------------------------------------------


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


def test_the_once_mode_gives_up_quietly_when_the_app_stays_away(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.client.claims = [ApiUnavailable("down")] * 50

    assert rig.go(once=True, wait=20) == EXIT_OK
    assert rig.client.claim_calls < 10


def test_a_failed_announcement_does_not_stop_the_runner(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.client.announce_error = ApiUnavailable("down")
    rig.client.claims = [implementer_claim()]

    assert rig.go(once=True) == EXIT_OK
    assert rig.api.completions


# -- ready or not -----------------------------------------------------------------------------------


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


# -- the credential -------------------------------------------------------------------------------


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


def test_the_credential_is_masked_in_the_log(tmp_path: Path) -> None:
    rig = Rig(tmp_path)

    assert CREDENTIAL not in rig.service._masker.redact(f"x {CREDENTIAL} y")  # pyright: ignore[reportPrivateUsage]


# -- the stop ---------------------------------------------------------------------------------------


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
