# SPDX-License-Identifier: LicenseRef-Proprietary

"""The gate of the Implementer's sandbox (#745, step 4): a turn does not start on a snapshot
whose Sysbox is not proven or on a VM that leaves the agent's container too little, and says so
with a code of its own that does not bill. Reviews never read it."""

import threading
from collections.abc import Mapping
from typing import Any

import pytest
from door_support import implementer_job_text

from code_reviewer_runner.implementer.job_run import (
    MIN_AGENT_MEMORY_MB,
    JobSeams,
    check_sandbox,
    run_implementer_job,
)
from code_reviewer_runner.job import parse_implementer_input
from code_reviewer_runner.lease_check import LeaseState
from code_reviewer_runner.result import ErrorCode

PROOF = "RUNNER_IMPLEMENTER_SANDBOX_PROOF"
MEMORY = "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB"


def environment(proof: str | None = "proven", memory: str | None = "2560") -> dict[str, str]:
    return {
        **({} if proof is None else {PROOF: proof}),
        **({} if memory is None else {MEMORY: memory}),
    }


# #745-T25
def test_a_proven_snapshot_and_a_vm_with_room_pass() -> None:
    assert check_sandbox(environment()) is None
    assert check_sandbox(environment(memory=str(MIN_AGENT_MEMORY_MB))) is None


# #745-T25
def test_a_verdict_that_was_never_recorded_is_not_a_refusal_yet() -> None:
    assert check_sandbox(environment("unrecorded")) is None


# #745-T25
@pytest.mark.parametrize("proof", ["unproven", "", "PROVEN", "yes", None])
def test_anything_but_proven_or_unrecorded_is_the_free_sandbox_unproven(proof: str | None) -> None:
    refused = check_sandbox(environment(proof))

    assert refused is not None and refused.code is ErrorCode.SANDBOX_UNPROVEN
    assert "not proven" in refused.detail


# #745-T26
@pytest.mark.parametrize(
    "memory", ["0", "512", str(MIN_AGENT_MEMORY_MB - 1), "-3", "lots", "", None]
)
def test_a_vm_that_leaves_too_little_is_the_free_sandbox_size_unsupported(
    memory: str | None,
) -> None:
    refused = check_sandbox(environment(memory=memory))

    assert refused is not None and refused.code is ErrorCode.SANDBOX_SIZE_UNSUPPORTED


# #745-T25
def test_the_proof_is_judged_before_the_size() -> None:
    refused = check_sandbox(environment("unproven", "0"))

    assert refused is not None and refused.code is ErrorCode.SANDBOX_UNPROVEN


def run(env: Mapping[str, str]) -> Any:
    touched: list[str] = []

    def setup(*arguments: Any) -> Any:
        touched.append("setup")
        raise AssertionError("nothing is set up for a refused turn")

    job = parse_implementer_input(implementer_job_text())
    result = run_implementer_job(
        job,
        0.0,
        {"RUNNER_DYNAMIC_MAX_COST_USD": "5", **env},
        lease_check=lambda: LeaseState.HELD,
        shutdown=threading.Event(),
        engines=("implementer",),
        seams=JobSeams(setup=setup),
    )
    assert touched == []
    return result


# #745-T25
def test_a_refused_turn_ends_before_anything_is_set_up_and_is_free() -> None:
    result = run(environment("unproven"))

    assert result.ok is False and result.error_code is ErrorCode.SANDBOX_UNPROVEN
    assert result.usage is None, "the model was never used"
    assert result.implementer is None, "no repository was cloned"


# #745-T26
def test_a_turn_on_a_vm_that_is_too_small_ends_the_same_way() -> None:
    result = run(environment(memory="512"))

    assert result.error_code is ErrorCode.SANDBOX_SIZE_UNSUPPORTED
