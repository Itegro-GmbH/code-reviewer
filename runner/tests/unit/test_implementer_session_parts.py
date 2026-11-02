# SPDX-License-Identifier: LicenseRef-Proprietary

"""The parts of an Implementer turn that need no engine (#764): the summary, the bounds on tool
results, and the codes a turn can end with."""

import time
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from code_reviewer_runner.dynamic_review.adapter import EngineError
from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    LimitError,
    Reservation,
    UnitCosts,
)
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.static_isolation import ImplementerNetwork
from code_reviewer_runner.dynamic_review.tool_part_audit import ToolPartAudit
from code_reviewer_runner.implementer.egress_config import EgressSettings
from code_reviewer_runner.implementer.git_workspace import DIRTY_TIMEOUT, REPORT_READ_TIMEOUT
from code_reviewer_runner.implementer.job_run import SIGTERM_BACKSTOP_SECONDS
from code_reviewer_runner.implementer.session import (
    COST_LIMIT_DETAIL,
    DEADLINE_DETAIL,
    ENGINE_STOP_SECONDS,
    FINAL_PUSH_SECONDS,
    GRACE_SECONDS,
    LEFTOVER_SECONDS,
    MAX_RETURNED_BYTES,
    STOP_PUSH_SECONDS,
    TOKEN_CAP_DETAIL,
    ImplementerSession,
    agent_limits,
    classify,
    deadline_seconds,
)
from code_reviewer_runner.implementer.turn_result import MAX_SUMMARY_CHARS, clip_summary
from code_reviewer_runner.job import JobError, parse_implementer_input
from code_reviewer_runner.redaction import REDACTED
from code_reviewer_runner.result import ErrorCode

EXAMPLE = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "examples"
    / "implementer"
    / "RunnerJobInput.json"
)
PRICES = UnitCosts(input_usd_per_mtok=Decimal(3), output_usd_per_mtok=Decimal(15))
TOKEN = "ghs_dummy-installation-token-0123456789"
KEY = "sk-or-v1-" + "dummykey0123456789abcdef"  # built, so the secret scan sees no key


def make_ledger(
    *,
    max_cost: str = "5",
    deadline: float = 600.0,
    clock: Callable[[], float] = time.monotonic,
) -> BudgetLedger:
    limits = agent_limits(deadline, Decimal(max_cost), "cost_limit")
    return BudgetLedger(limits, unit_costs=PRICES, clock=clock)


# -- the summary --------------------------------------------------------------------------------


# #764-T13
def test_the_summary_is_cut_at_the_bound_of_the_contract() -> None:
    summary = clip_summary("x" * (MAX_SUMMARY_CHARS * 3), [])

    assert len(summary) == MAX_SUMMARY_CHARS == 8192
    assert summary.endswith("[...]")


# #764-T13
def test_a_short_summary_is_kept_as_it_is() -> None:
    assert clip_summary("  Done.\n", []) == "Done."


# #764-T13
def test_the_secrets_of_the_job_are_gone_before_the_cut_so_a_cut_cannot_split_one() -> None:
    padding = "p" * (MAX_SUMMARY_CHARS - 10)
    text = f"{padding}{TOKEN} and later {KEY}"

    summary = clip_summary(text, [TOKEN, KEY])

    assert TOKEN not in summary and KEY not in summary
    assert TOKEN[:12] not in summary, "not even the start of one"
    assert REDACTED[:4] in summary, "the marker may be cut, the secret is not there to be cut"


# #764-T13
def test_a_secret_in_its_encoded_forms_is_gone_too() -> None:
    assert TOKEN not in clip_summary(f"token={TOKEN}", [TOKEN])
    assert clip_summary("Authorization: Bearer abcdef0123456789", []).count("abcdef") == 0


# #764-R11
def test_a_note_is_appended_after_the_text_and_the_cut_leaves_room_for_it() -> None:
    note = "[Not made: opencode.json]"

    short = clip_summary("Done.", [], tail=note)
    long = clip_summary("x" * (MAX_SUMMARY_CHARS * 2), [], tail=note)

    assert short == "Done.\n\n" + note
    assert len(long) == MAX_SUMMARY_CHARS and long.endswith(note)
    assert clip_summary("", [], tail=note) == note, "a turn with no text still says it"


# -- the bounds on tool results ----------------------------------------------------------------


def tool_event(identity: str, output: str, name: str = "bash") -> dict[str, object]:
    return {
        "type": "message.part.updated",
        "properties": {
            "sessionID": "ses_1",
            "part": {
                "type": "tool",
                "callID": identity,
                "tool": name,
                "state": {"status": "completed", "input": {"command": "x"}, "output": output},
            },
        },
    }


# #764-R1
def test_a_result_over_64_kib_does_not_end_the_turn() -> None:
    ledger = make_ledger()
    audit = ToolPartAudit(ledger, "ses_1", export_root="/work/repo")

    audit.feed(tool_event("call_1", "o" * 204_000, "grep"))
    audit.feed(tool_event("call_2", "é" * 300_000))  # about 600 KB of multibyte text

    assert ledger.returned_bytes == 204_000 + 600_000


# #764-T11
def test_the_cumulative_bound_of_the_results_still_ends_the_turn() -> None:
    ledger = make_ledger()
    chunk = MAX_RETURNED_BYTES // 4

    for _ in range(4):
        ledger.add_result_bytes(chunk)
    with pytest.raises(LimitError) as refused:
        ledger.add_result_bytes(1)

    assert refused.value.detail == "the cumulative content bound is used up"
    assert classify(refused.value)[0] is ErrorCode.RUNNER_ERROR


# #764-T11
def test_a_single_result_cannot_pass_the_cumulative_bound_either() -> None:
    ledger = make_ledger()

    with pytest.raises(LimitError):
        ledger.add_result_bytes(MAX_RETURNED_BYTES + 1)


# #764-R10
@pytest.mark.parametrize(
    ("limit", "elapsed", "left"),
    [
        (3600, 0.0, 3420.0),  # the last three minutes are kept back
        (3600, 100.0, 3320.0),  # and what the job spent before the turn
        (60, 0.0, 40.0),  # a short limit keeps a third
        (14_400, 0.0, 14_220.0),
        (120, 30.0, 50.0),
    ],
)
def test_the_clock_of_the_turn_keeps_the_grace_back(
    limit: int, elapsed: float, left: float
) -> None:
    assert deadline_seconds(limit, elapsed) == pytest.approx(left)
    assert GRACE_SECONDS == 180.0


# -- the codes ----------------------------------------------------------------------------------


# #764-T06
def test_the_ledgers_words_for_the_cost_limit_and_the_clock_are_the_ones_classify_reads() -> None:
    cheap = make_ledger(max_cost="0.0000001")
    with pytest.raises(LimitError) as cost:
        cheap.reserve_call("x" * 4000)
    expired = make_ledger(deadline=0.0)
    with pytest.raises(LimitError) as clock:
        expired.check_deadline()

    assert cost.value.detail == COST_LIMIT_DETAIL
    assert clock.value.detail == DEADLINE_DETAIL
    assert classify(cost.value) == (
        ErrorCode.COST_LIMIT_REACHED,
        "the cost limit of the turn was reached",
    )
    assert classify(clock.value)[0] is ErrorCode.TIME_LIMIT_REACHED


# #764-T06
def test_the_token_cap_of_an_own_key_is_the_cost_limit() -> None:
    error = LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, TOKEN_CAP_DETAIL)

    assert classify(error)[0] is ErrorCode.COST_LIMIT_REACHED


# #764-T12
@pytest.mark.parametrize(
    ("error", "code"),
    [
        (
            LimitError(ErrorCode.LLM_AUTH, "the model provider refused the request"),
            ErrorCode.LLM_AUTH,
        ),
        (
            LimitError(ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "a cost"),
            ErrorCode.DYNAMIC_ACCOUNTING_FAILED,
        ),
        (LimitError(ErrorCode.DYNAMIC_CONFIG_INVALID, "no"), ErrorCode.IMPLEMENTER_CONFIG_INVALID),
        (JobError(ErrorCode.PUSH_REJECTED, "refused"), ErrorCode.PUSH_REJECTED),
        (JobError(ErrorCode.LEASE_LOST, "not ours"), ErrorCode.LEASE_LOST),
        (JobError(ErrorCode.RUNNER_SHUTDOWN, "stop"), ErrorCode.RUNNER_SHUTDOWN),
    ],
)
@pytest.mark.parametrize("used_model", [False, True])
def test_what_ends_a_turn_has_a_stable_code_whether_or_not_the_model_was_used(
    error: BaseException, code: ErrorCode, used_model: bool
) -> None:
    assert classify(error, used_model=used_model)[0] is code


# #765: `setup_failed` is the free code of a turn that never started. After the model was used,
# whatever is wrong with the set-up is the charged `agent_gave_up`.
@pytest.mark.parametrize(
    "error",
    [
        IsolationError("the engine ports are not the ones the network rules allow"),
        JobError(ErrorCode.SETUP_FAILED, "git status failed"),
    ],
)
def test_setup_failed_is_free_before_the_model_and_agent_gave_up_after(
    error: BaseException,
) -> None:
    assert classify(error, used_model=False)[0] is ErrorCode.SETUP_FAILED
    assert classify(error, used_model=True)[0] is ErrorCode.AGENT_GAVE_UP


# #765
def test_runner_error_never_ends_a_turn_that_used_the_model() -> None:
    for error in (RuntimeError("anything"), JobError(ErrorCode.RUNNER_ERROR, "a bug")):
        assert classify(error, used_model=False)[0] is ErrorCode.RUNNER_ERROR
        assert classify(error, used_model=True)[0] is ErrorCode.AGENT_GAVE_UP


# The engine's death and a bound of the audit are the runner's own failures. They are free before
# the first model call, and the charged `agent_gave_up` once the model was called (#764-R3).
ENGINE_AND_BOUNDS: list[BaseException] = [
    LimitError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine's event stream ended"),
    EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "engine_exited: gone"),
    LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the cumulative content bound is used up"),
    EngineError(ErrorCode.RUNNER_ERROR, "the engine returned no session id"),
    OSError("disk"),
]


# #764-R3
@pytest.mark.parametrize("error", ENGINE_AND_BOUNDS)
def test_an_engine_death_or_a_bound_is_free_before_the_model_and_charged_after(
    error: BaseException,
) -> None:
    assert classify(error, used_model=False)[0] is ErrorCode.RUNNER_ERROR
    assert classify(error, used_model=True)[0] is ErrorCode.AGENT_GAVE_UP


# #764-T12
def test_the_sentence_of_a_classified_error_never_carries_the_text_of_an_unknown_exception() -> (
    None
):
    assert classify(RuntimeError("secret-from-the-repo"))[1] == "the turn could not be run"


# -- the model was used, or only reserved (#764, second review) ----------------------------------


def reservation_of(ledger: BudgetLedger) -> Reservation:
    return ledger.reserve_call("x" * 400)


# #764-R12
def test_a_reserved_call_is_not_a_use_of_the_model() -> None:
    ledger = make_ledger()

    reservation_of(ledger)

    assert ledger.model_calls == 1 and ledger.model_used is False


# #764-R12
def test_a_call_the_provider_turned_away_or_that_never_left_costs_nothing_and_is_no_use() -> None:
    ledger = make_ledger()
    for _ in range(3):
        ledger.settle_unbilled(reservation_of(ledger))

    assert ledger.model_calls == 3 and ledger.model_used is False


# #764-R12
def test_a_call_whose_usage_was_read_is_a_use() -> None:
    ledger = make_ledger()

    ledger.settle_call(
        reservation_of(ledger), prompt_tokens=100, completion_tokens=10, cost=Decimal("0.001")
    )

    assert ledger.model_used is True


# #764-R12
def test_a_call_that_was_sent_and_whose_usage_was_never_seen_may_have_been_billed() -> None:
    ledger = make_ledger()

    ledger.settle_unknown(reservation_of(ledger))

    assert ledger.model_used is True


PROVIDER_FAILURES = [ErrorCode.LLM_UNAVAILABLE, ErrorCode.LLM_TIMEOUT]
ENGINE_GAVE_UP = EngineError(
    ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine ended its turn with an error (error=APIError)"
)


# #764-R12
@pytest.mark.parametrize("failure", PROVIDER_FAILURES)
@pytest.mark.parametrize("used_model", [False, True])
def test_an_engine_that_gave_up_after_the_provider_failed_is_an_outage_whatever_was_billed(
    failure: ErrorCode, used_model: bool
) -> None:
    code, _ = classify(ENGINE_GAVE_UP, used_model=used_model, provider_error=failure)

    assert code is failure


# #764-R12
def test_a_killed_engine_is_charged_only_after_the_model_was_used() -> None:
    killed = EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "engine_exited: gone")

    assert classify(killed, used_model=False)[0] is ErrorCode.RUNNER_ERROR
    assert classify(killed, used_model=True)[0] is ErrorCode.AGENT_GAVE_UP


# #764-R12
def test_a_failure_of_the_provider_does_not_hide_a_bound_or_a_refusal_of_ours() -> None:
    bound = LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the cumulative content bound is used up")
    refused = JobError(ErrorCode.PUSH_REJECTED, "the provider did not take the push")

    assert classify(bound, provider_error=ErrorCode.LLM_UNAVAILABLE)[0] is ErrorCode.RUNNER_ERROR
    assert classify(refused, provider_error=ErrorCode.LLM_UNAVAILABLE)[0] is ErrorCode.PUSH_REJECTED


# -- the session reads the ledger and the proxy, not the reservations (#764-R12) -------------------


class FakeProxy:
    def __init__(self, failed: ErrorCode | None) -> None:
        self.last_upstream_error = failed


def session_that_ended(ledger: BudgetLedger, failed: ErrorCode | None) -> ImplementerSession:
    """A session as far as `_stopped_by` needs it: the ledger and the proxy of its native job."""
    job = parse_implementer_input(EXAMPLE.read_text(encoding="utf-8"))
    session = ImplementerSession(
        job,
        workspace=None,  # type: ignore[arg-type]  # not read by _stopped_by
        command=["opencode"],
        egress=EgressSettings(ImplementerNetwork.NONE, None),
        environment={},
    )
    session._native = SimpleNamespace(  # type: ignore[assignment]  # pyright: ignore[reportPrivateUsage]
        ledger=ledger, run=SimpleNamespace(proxy=FakeProxy(failed))
    )
    return session


def ended_with(session: ImplementerSession, error: BaseException) -> ErrorCode | None:
    session._stopped_by(error)  # pyright: ignore[reportPrivateUsage]
    return session._error[0] if session._error else None  # pyright: ignore[reportPrivateUsage]


# #764-R12
def test_reservations_that_cost_nothing_do_not_make_a_killed_engine_a_charged_give_up() -> None:
    ledger = make_ledger()
    for _ in range(4):
        ledger.settle_unbilled(reservation_of(ledger))

    code = ended_with(session_that_ended(ledger, None), ENGINE_GAVE_UP)

    assert code is ErrorCode.RUNNER_ERROR


# #764-R12
def test_a_billed_call_makes_the_same_end_a_charged_give_up() -> None:
    ledger = make_ledger()
    ledger.settle_call(
        reservation_of(ledger), prompt_tokens=100, completion_tokens=10, cost=Decimal("0.001")
    )

    code = ended_with(session_that_ended(ledger, None), ENGINE_GAVE_UP)

    assert code is ErrorCode.AGENT_GAVE_UP


# #764-R12
@pytest.mark.parametrize("failure", PROVIDER_FAILURES)
def test_the_session_names_the_outage_the_proxy_kept(failure: ErrorCode) -> None:
    ledger = make_ledger()
    ledger.settle_call(
        reservation_of(ledger), prompt_tokens=100, completion_tokens=10, cost=Decimal("0.001")
    )

    assert ended_with(session_that_ended(ledger, failure), ENGINE_GAVE_UP) is failure


# The one final push has to fit the end of the turn, at a normal end and at a stop.
def test_the_end_of_a_turn_fits_the_grace_and_a_stop_fits_the_sigterm_backstop() -> None:
    reads = 2 * REPORT_READ_TIMEOUT
    normal = ENGINE_STOP_SECONDS + DIRTY_TIMEOUT + LEFTOVER_SECONDS + FINAL_PUSH_SECONDS + reads
    stop = ENGINE_STOP_SECONDS + STOP_PUSH_SECONDS + reads

    assert normal <= GRACE_SECONDS
    assert stop <= SIGTERM_BACKSTOP_SECONDS
