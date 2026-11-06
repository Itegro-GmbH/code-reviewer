# SPDX-License-Identifier: LicenseRef-Proprietary

"""The profile version a turn was started with, as the runner reads it (#843): closed, bounded, and
absent for a turn without one (the platform's defaults, as every turn ran before profiles)."""

import json
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner import job as runner_job
from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES
from code_reviewer_runner.result import ErrorCode

EXAMPLE = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "examples"
    / "implementer"
    / "RunnerJobInput.json"
)


def job_with(profile: Any) -> str:
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    if profile is not None:
        document["implementer"]["profile"] = profile
    return json.dumps(document)


# #843-R01
def test_a_turn_without_a_profile_has_none() -> None:
    assert runner_job.parse_implementer_input(job_with(None)).implementer.profile is None


# #843-R02
def test_a_profile_is_read_as_sent_and_missing_instructions_are_empty() -> None:
    with_text = runner_job.parse_implementer_input(
        job_with({"name": "reviewer", "version": 3, "canPush": False, "instructions": "Read."})
    ).implementer.profile
    without = runner_job.parse_implementer_input(
        job_with({"name": "writer", "version": 1, "canPush": True})
    ).implementer.profile

    assert with_text is not None and without is not None
    assert (with_text.name, with_text.version, with_text.can_push) == ("reviewer", 3, False)
    assert with_text.instructions == "Read."
    assert (without.name, without.version, without.can_push, without.instructions) == (
        "writer",
        1,
        True,
        "",
    )


@pytest.mark.parametrize(
    "profile",
    [
        "reviewer",
        {"name": "r", "version": 1, "canPush": True, "extra": None},
        [],
        {"name": "r", "version": 1},
        {"version": 1, "canPush": True},
        {"name": "r", "canPush": True},
        {"name": "r", "version": 1, "canPush": 1},
        {"name": "r", "version": 1, "canPush": "true"},
        {"name": "r", "version": True, "canPush": True},
        {"name": "r", "version": 0, "canPush": True},
        {"name": "r", "version": 1.0, "canPush": True},
        {"name": "R", "version": 1, "canPush": True},
        {"name": "", "version": 1, "canPush": True},
        {"name": "x" * 65, "version": 1, "canPush": True},
        {"name": "r", "version": 1, "canPush": True, "instructions": ""},
        {"name": "r", "version": 1, "canPush": True, "instructions": 3},
        {"name": "r", "version": 1, "canPush": True, "instructions": "x" * 20_001},
        {"name": "r", "version": 1, "canPush": True, "model": "m"},
        {"name": "r", "version": 1, "canPush": True, "costLimit": 1},
    ],
)
# #843-R03
def test_a_profile_that_is_not_the_closed_shape_is_refused_as_an_invalid_job(profile: Any) -> None:
    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_implementer_input(job_with(profile))

    assert refused.value.code is ErrorCode.INVALID_JOB
    # The refusal names the field and never a value.
    assert "implementer.profile" in str(refused.value.detail)


# #843-R04
def test_a_refusal_does_not_repeat_the_text_of_the_instructions() -> None:
    secret = "do-not-echo-this-text"
    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_implementer_input(
            job_with({"name": "r", "version": 1, "canPush": "yes", "instructions": secret})
        )

    assert secret not in str(refused.value.detail) and secret not in str(refused.value)


# #843-R05
def test_the_worker_names_the_feature_that_reads_the_profile() -> None:
    assert "implementer_profile" in WORKER_FEATURES


# #909-T13
def test_the_worker_names_the_feature_that_reads_the_start_branch() -> None:
    assert "implementer_start_branch" in WORKER_FEATURES
