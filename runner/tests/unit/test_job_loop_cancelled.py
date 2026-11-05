# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the job host does when the app says that a member asked for a run to stop (#891).

A heartbeat answer with `cancelRequested` ends the turn the way a stop of the Worker does (the
process gets SIGTERM, pushes what is committed and prints its result), but the host reports the end
as `cancelled` with what the process printed (the usage, the block with the head and the summary),
delivers it with `complete` instead of giving the job back, and the lease check before a push still
says `held`. A run that finished by itself first stays what it was."""

import json

import pytest
from loop_support import Harness, make_claim, outcome, run, settle
from test_implementer_job_host import (
    USAGE,
    advertising_harness,
    implementer_claim,
    line,
    report,
)

from code_reviewer_runner.job_loop.api import HeartbeatReply, parse_heartbeat
from code_reviewer_runner.job_loop.host import JobEnd
from code_reviewer_runner.job_loop.http import Reply
from code_reviewer_runner.lease_check import LeaseState
from code_reviewer_runner.result import NO_RESULT_REASON


# #891-T10
@pytest.mark.parametrize(
    ("value", "expected"),
    [(True, True), ("true", False), (1, False), (None, False), ("yes", False), ([True], False)],
)
def test_only_the_boolean_true_means_cancel_requested(value: object, expected: bool) -> None:
    body = {"version": 1, "job": {"id": "j-1", "cancelRequested": value}}
    reply = Reply(200, {"content-type": "application/json"}, json.dumps(body).encode())

    assert parse_heartbeat(reply, "j-1").cancel_requested is expected


# #891-T10
def test_an_answer_without_the_field_is_not_a_cancel() -> None:
    body = {"version": 1, "job": {"id": "j-1"}}
    reply = Reply(200, {"content-type": "application/json"}, json.dumps(body).encode())

    assert parse_heartbeat(reply, "j-1").cancel_requested is False


# #891-T11
def test_a_cancelled_turn_is_ended_and_reports_cancelled_with_what_it_pushed_and_cost() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        harness.api.cancel_from = 2
        await harness.start()
        process = harness.launcher.processes[0]
        # What the process prints on SIGTERM: the stop's own code, the block and the usage.
        process.printed_on_terminate = line(
            ok=False, errorCode="runner_shutdown", usage=USAGE, implementer=report()
        )

        await harness.clock.advance(30)  # first heartbeat: nothing yet
        assert not process.terminated
        await harness.clock.advance(30)  # second: a member asked for the stop
        await settle()

        assert process.terminated
        assert harness.end is JobEnd.CANCELLED
        assert len(harness.api.completions) == 1
        result = harness.api.completions[0][2]
        assert result["ok"] is False and result["errorCode"] == "cancelled"
        assert result["implementer"] == report()
        assert result["usage"]["aiCalls"] == 3 and result["usage"]["costUsd"] == 0.0123
        # Delivered, not given back: nothing was queued again.
        assert not process.superseded_notices

    run(scenario)


# #891-T11
def test_a_cancelled_turn_without_a_printed_result_reports_the_bare_cancelled() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        harness.api.cancel_from = 1
        await harness.start()

        await harness.clock.advance(30)
        await settle()

        assert harness.end is JobEnd.CANCELLED
        result = harness.api.completions[0][2]
        assert result["errorCode"] == "cancelled"
        assert "implementer" not in result and result["usage"] is None

    run(scenario)


# #891-T15
def test_a_cancelled_turn_that_left_no_result_is_reported_as_no_result_so_its_cost_is_counted() -> (
    None
):
    # Killed after the grace, or ended by a failing terminate: the model may have been used and
    # nobody can say how much, so the app must not void it (`settlementOfOutcome`).
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        harness.api.cancel_from = 1
        await harness.start()

        await harness.clock.advance(30)
        await settle()

        result = harness.api.completions[0][2]
        assert result["errorCode"] == "cancelled"
        assert result["errorReason"] == NO_RESULT_REASON

    run(scenario)


# #891-T15
def test_a_cancelled_turn_whose_process_could_not_be_ended_cleanly_is_no_result_too() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        harness.api.cancel_from = 1
        await harness.start()
        process = harness.launcher.processes[0]

        async def failing() -> None:
            process.terminated = True
            raise OSError("no such process")

        process.terminate = failing  # type: ignore[method-assign]

        await harness.clock.advance(30)
        await settle()

        result = harness.api.completions[0][2]
        assert result["errorCode"] == "cancelled"
        assert result["errorReason"] == NO_RESULT_REASON

    run(scenario)


# #891-T15
def test_a_cancelled_turn_that_printed_its_usage_has_no_failure_reason() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        harness.api.cancel_from = 1
        await harness.start()
        harness.launcher.processes[0].printed_on_terminate = line(
            ok=False, errorCode="runner_shutdown", usage=USAGE, implementer=report()
        )

        await harness.clock.advance(30)
        await settle()

        assert "errorReason" not in harness.api.completions[0][2]

    run(scenario)


# #891-T16
def test_the_lease_is_kept_alive_while_a_cancelled_turn_is_ending() -> None:
    # The stop has up to 120 s; the lease is 120 s. The heart keeps beating until the report goes
    # out, or the sweep would end the job and lose the report and the head of the session.
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        harness.api.cancel_from = 2
        await harness.start()
        process = harness.launcher.processes[0]
        process.hang_on_terminate = True

        await harness.clock.advance(60)  # the second heartbeat learns of the cancel
        assert process.terminated
        beats = len(harness.api.heartbeats)

        await harness.clock.advance(90)  # the process is still pushing

        assert len(harness.api.heartbeats) == beats + 3
        process.finish(
            outcome(
                exit_code=-15,
                stdout=line(
                    ok=False, errorCode="runner_shutdown", usage=USAGE, implementer=report()
                ),
            )
        )
        await settle()
        assert harness.end is JobEnd.CANCELLED
        assert harness.api.completions[0][2]["implementer"] == report()

    run(scenario)


# #891-T12
def test_a_turn_that_finished_before_the_stop_took_effect_stays_a_success() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()
        process = harness.launcher.processes[0]

        # The turn ends by itself in the same moment the answer would ask for the stop.
        process.finish(outcome(stdout=line(usage=USAGE)))
        harness.api.cancel_from = 1
        await harness.clock.advance(30)
        await settle()

        assert harness.end is JobEnd.OK
        assert harness.api.completions[0][2]["errorCode"] is None

    run(scenario)


# #891-T13
def test_the_lease_check_before_a_push_still_says_held_while_a_stop_is_asked_for() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        harness.api.cancel_from = 1
        await harness.start()
        spec = harness.launcher.processes[0].spec
        assert spec.lease_check is not None

        state = await spec.lease_check()

        assert state is LeaseState.HELD
        await harness.stop()

    run(scenario)


# #891-T14
def test_a_review_job_a_stop_is_asked_for_ends_cancelled_too() -> None:
    # The path is the host's, not the Implementer's: any job a member stops ends the same way.
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.cancel_from = 1
        await harness.start()

        await harness.clock.advance(30)
        await settle()

        assert harness.end is JobEnd.CANCELLED
        assert harness.api.completions[0][2]["errorCode"] == "cancelled"

    run(scenario)


def test_the_reply_type_defaults_to_no_cancel() -> None:
    assert HeartbeatReply().cancel_requested is False
