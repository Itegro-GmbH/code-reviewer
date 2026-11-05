# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the job host does for a follow-up turn's stored session (#840): it downloads it, because
the process holds no credential, and hands the process the file and one word about it. Nothing the
download does can fail the job: the process reads the word and the turn goes on from a summary."""

import hashlib
from typing import Any

import pytest
from loop_support import Harness, run, settle
from test_implementer_job_host import advertising_harness, implementer_claim, implementer_input

from code_reviewer_runner.job_loop.process import ProcessSpec
from code_reviewer_runner.job_loop.resume_download import ResumeFile, ResumeUnavailable
from code_reviewer_runner.resume_wire import (
    RESUME_FILE_NAME,
    RESUME_STATE_VARIABLE,
    ResumeReason,
    failed_state,
    file_state,
    parse_state,
)
from code_reviewer_runner.snapshot_wire import SnapshotHeader

pytestmark = pytest.mark.unit

SHA = "a" * 40
DATA = b"\x1f\x8bthe session"
HEADER = SnapshotHeader(len(DATA), 123, hashlib.sha256(DATA).hexdigest(), "1.19.0")


def follow_up_claim(*, snapshot: bool = True) -> Any:
    claim = implementer_claim()
    document = implementer_input()
    document["implementer"]["resume"] = {
        "turn": 2,
        "branches": [{"name": "implementer/a1b2c3", "head": SHA}],
        "checkout": None,
        "snapshot": snapshot,
    }
    return type(claim)(
        id=claim.id,
        lease_token=claim.lease_token,
        heartbeat_interval=claim.heartbeat_interval,
        input=document,
    )


def with_download(harness: Harness, result: ResumeFile | Exception) -> list[str]:
    """Give the harness's API the download; the list collects the job ids it was asked for."""
    asked: list[str] = []

    async def resume_session(job_id: str) -> ResumeFile:
        asked.append(job_id)
        if isinstance(result, Exception):
            raise result
        return result

    api: Any = harness.api
    api.resume_session = resume_session
    return asked


async def first_spec(harness: Harness) -> ProcessSpec:
    await harness.start()
    spec = harness.launcher.processes[0].spec
    harness.launcher.processes[0].finish()
    await settle()
    return spec


# #840-T110
def test_a_follow_up_turn_gets_the_file_and_the_description_of_it() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        asked = with_download(harness, ResumeFile(HEADER, DATA))
        harness.api.claims = [follow_up_claim()]

        spec = await first_spec(harness)

        assert asked == [follow_up_claim().id]
        assert spec.files == {RESUME_FILE_NAME: DATA}
        assert spec.env[RESUME_STATE_VARIABLE] == file_state(HEADER)
        assert parse_state(spec.env[RESUME_STATE_VARIABLE]).header == HEADER

    run(scenario)


# #840-T111
@pytest.mark.parametrize("reason", list(ResumeReason))
def test_a_download_that_fails_is_a_word_for_the_process_and_not_the_jobs_failure(
    reason: ResumeReason,
) -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        with_download(harness, ResumeUnavailable(reason))
        harness.api.claims = [follow_up_claim()]

        spec = await first_spec(harness)

        assert spec.files == {}
        assert spec.env[RESUME_STATE_VARIABLE] == failed_state(reason)

    run(scenario)


# #840-T112
def test_a_download_that_breaks_in_any_other_way_is_a_failed_download() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        with_download(harness, RuntimeError("secret-in-the-message"))
        harness.api.claims = [follow_up_claim()]

        spec = await first_spec(harness)

        assert spec.env[RESUME_STATE_VARIABLE] == failed_state(ResumeReason.DOWNLOAD_FAILED)
        assert "secret-in-the-message" not in str(spec.env)

    run(scenario)


# #840-T113
def test_an_api_without_the_download_hands_over_a_failed_download() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [follow_up_claim()]

        spec = await first_spec(harness)

        assert spec.files == {}
        assert spec.env[RESUME_STATE_VARIABLE] == failed_state(ResumeReason.DOWNLOAD_FAILED)

    run(scenario)


# #840-T114
def test_a_turn_the_app_says_has_no_conversation_downloads_nothing() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        asked = with_download(harness, ResumeFile(HEADER, DATA))
        harness.api.claims = [follow_up_claim(snapshot=False)]

        spec = await first_spec(harness)

        assert asked == []
        assert spec.files == {}
        assert RESUME_STATE_VARIABLE not in spec.env

    run(scenario)


# #840-T115
def test_a_first_turn_and_a_review_job_download_nothing() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        asked = with_download(harness, ResumeFile(HEADER, DATA))
        harness.api.claims = [implementer_claim()]

        spec = await first_spec(harness)

        assert asked == []
        assert spec.files == {}
        assert RESUME_STATE_VARIABLE not in spec.env

    run(scenario)
