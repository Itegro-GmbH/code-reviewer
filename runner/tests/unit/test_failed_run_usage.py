# SPDX-License-Identifier: LicenseRef-Proprietary

"""A run that fails after it used the model still reports what it used (#273).

The usage of a failed result is what lets the app count a run that cost something and then failed
(a timeout at the end, an answer the validator refuses, a publish error). Nothing is guessed: the
counters are the run's own, the cost is exact or `null` when any call was unpriced, and a run that
never reached the model reports no usage at all, as before.
"""

import io
import json
import time
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar

import pytest
from test_dynamic_review_run import CAPABILITIES, dynamic_document, dynamic_job

from code_reviewer_runner import runner
from code_reviewer_runner.cache_usage import CacheTally
from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.dynamic_findings import DynamicFindings
from code_reviewer_runner.dynamic_review.adapter import EngineAnswer, EngineError
from code_reviewer_runner.dynamic_review.budget import (
    TOTAL_DEADLINE_SECONDS,
    BudgetLedger,
    DynamicLimits,
    LimitError,
    UnitCosts,
)
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.limits import (
    CheckoutError,
    CheckoutMetrics,
    CheckoutReason,
)
from code_reviewer_runner.dynamic_review.publish import Published, PublishError
from code_reviewer_runner.job import Job
from code_reviewer_runner.lease_check import LeaseState
from code_reviewer_runner.result import ErrorCode, JobResult

HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
ENVIRONMENT = {
    runner.OPENCODE_COMMAND_VARIABLE: "opencode",
    runner.DYNAMIC_CAPABILITIES_VARIABLE: CAPABILITIES,
}
THREE_PRICED = (Decimal("0.001"), Decimal("0.002"), Decimal("0.0005"))


def prepared_content(export: Path) -> PreparedContent:
    return PreparedContent(
        root=export.parent,
        export=export,
        head_sha=HEAD,
        base_sha="b" * 40,
        merge_base_sha="b" * 40,
        previous_sha=None,
        comparison="full",
        files={"src/handler.ts": "x\n"},
        diff="diff --git a/src/handler.ts b/src/handler.ts\n+x\n",
        previous_diff="",
        omissions=(),
        skipped=(),
        metadata="{}",
        prior_state="",
        deadline=0.0,
        metrics=CheckoutMetrics(0, 0, 0, 1, {}, {}),
    )


class FakeServer:
    url = "http://127.0.0.1:1"

    def start(self) -> "FakeServer":
        return self

    def stop(self, drain_seconds: float = 0.0) -> None:
        pass


class FakeAudit:
    def set_export_root(self, root: str) -> None:
        pass


class FakeProxy:
    """Stands in for the loopback model proxy: a unit test opens no socket."""

    def __init__(self, **options: Any) -> None:
        self.audit = FakeAudit()
        self.cache_tally = CacheTally()

    def serve(self, host: str, port: int) -> FakeServer:
        return FakeServer()


def findings() -> DynamicFindings:
    return DynamicFindings(reviewed_sha=HEAD, findings=(), resolved_ids=())


class ScriptedEngine:
    """Makes the model calls of its script through the ledger of the run, then answers.

    A cost of None is a call the provider reported no charge for; the ledger stops the run on it
    like it does for the real proxy, and the engine ends with that error.
    """

    costs: tuple[Decimal | None, ...] = ()
    error: EngineError | None = None
    raises: Exception | None = None

    def __init__(self, job: Job, *, ledger: BudgetLedger, **options: Any) -> None:
        self.ledger = ledger
        self.turn_seconds: list[float] = []
        self.recovery: str | None = None

    def run(self) -> EngineAnswer:
        for cost in self.costs:
            reservation = self.ledger.reserve_call("x" * 400, output_tokens=10)
            try:
                self.ledger.settle_call(
                    reservation, prompt_tokens=100, completion_tokens=10, cost=cost
                )
            except LimitError as error:
                return EngineAnswer(None, EngineError(error.code, error.detail))
        if self.raises is not None:
            raise self.raises
        if self.error is not None:
            return EngineAnswer(None, self.error)
        return EngineAnswer(findings(), None)


@pytest.fixture(autouse=True)
def stubbed_model_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner, "ModelProxy", FakeProxy)
    monkeypatch.setattr(runner, "DynamicEngine", ScriptedEngine)


def script(
    monkeypatch: pytest.MonkeyPatch,
    *,
    costs: tuple[Decimal | None, ...] = (),
    error: EngineError | None = None,
    raises: Exception | None = None,
) -> None:
    monkeypatch.setattr(ScriptedEngine, "costs", costs)
    monkeypatch.setattr(ScriptedEngine, "error", error)
    monkeypatch.setattr(ScriptedEngine, "raises", raises)


def preparing(tmp_path: Path) -> Any:
    @contextmanager
    def prepare(job: Job) -> Generator[PreparedContent]:
        yield prepared_content(tmp_path)

    return prepare


def run(
    tmp_path: Path,
    *,
    publish: Any = None,
    lease: LeaseState = LeaseState.HELD,
    prepare: Any = None,
    started: float = 0.0,
    timeout: float | None = None,
) -> JobResult:
    return runner.run_dynamic_job(
        dynamic_job(),
        None,
        started,
        ENVIRONMENT,
        timeout,
        engines=ALL_ENGINES,
        prepare=prepare or preparing(tmp_path),
        publish=publish or (lambda job, found: Published("https://github.test/c/1", True)),
        lease_check=lambda: lease,
        publish_failure=lambda job, code, reason: None,
    )


ENGINE_STOPPED = EngineError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the cost limit is used up")


# #273-T01
def test_a_dynamic_run_that_fails_after_three_priced_calls_reports_the_tokens_and_the_summed_cost(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script(monkeypatch, costs=THREE_PRICED, error=ENGINE_STOPPED)

    result = run(tmp_path)

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert result.usage is not None
    assert result.usage.ai_calls == 3
    assert result.usage.prompt_tokens == 300
    assert result.usage.completion_tokens == 30
    assert result.usage.total_tokens == 330
    assert result.usage.cost_usd == pytest.approx(0.0035, rel=0, abs=1e-12)
    assert result.to_json()["usage"]["costUsd"] == pytest.approx(0.0035, rel=0, abs=1e-12)


# #273-T01: the failure the runner finds itself after the engine answered carries the usage too.
def test_a_lease_that_is_lost_after_the_calls_still_reports_what_they_cost(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script(monkeypatch, costs=THREE_PRICED)

    result = run(tmp_path, lease=LeaseState.LOST)

    assert result.error_code is ErrorCode.LEASE_LOST
    assert result.usage is not None and result.usage.ai_calls == 3
    assert result.usage.cost_usd == pytest.approx(0.0035, rel=0, abs=1e-12)


# #273-T01
def test_a_summary_that_cannot_be_published_still_reports_what_the_calls_cost(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script(monkeypatch, costs=THREE_PRICED)

    def refused(job: Job, found: DynamicFindings) -> Published:
        raise PublishError(ErrorCode.REVIEW_NOT_PUBLISHED, "the comment was refused")

    result = run(tmp_path, publish=refused)

    assert result.error_code is ErrorCode.REVIEW_NOT_PUBLISHED
    assert result.usage is not None and result.usage.ai_calls == 3
    assert result.usage.cost_usd == pytest.approx(0.0035, rel=0, abs=1e-12)


# #273-T02
def test_one_unpriced_call_makes_the_cost_of_a_failed_run_unknown_but_keeps_the_tokens(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script(monkeypatch, costs=(Decimal("0.001"), None, Decimal("0.0005")))

    result = run(tmp_path)

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    assert result.usage is not None
    assert result.usage.cost_usd is None
    assert result.usage.prompt_tokens == 200
    assert result.usage.completion_tokens == 20
    assert result.to_json()["usage"]["costUsd"] is None


# #273-T02: a call that was reserved and never settled may still have been charged: unknown, not 0.
def test_a_call_that_never_answered_makes_the_cost_unknown(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    class DiesInFlight(ScriptedEngine):
        def run(self) -> EngineAnswer:
            self.ledger.reserve_call("x" * 400, output_tokens=10)
            return EngineAnswer(None, EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "gone"))

    monkeypatch.setattr(runner, "DynamicEngine", DiesInFlight)

    result = run(tmp_path)

    assert result.usage is not None
    assert result.usage.ai_calls == 1
    assert result.usage.cost_usd is None


# #273-T03
def test_a_dynamic_run_that_fails_before_the_first_model_call_reports_no_usage(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script(monkeypatch, error=EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "no engine"))

    result = run(tmp_path)

    assert result.ok is False
    assert result.usage is None
    assert result.to_json()["usage"] is None


# #273-T03
def test_a_checkout_that_fails_reports_no_usage(tmp_path: Path) -> None:
    @contextmanager
    def refusing(job: Job) -> Generator[PreparedContent]:
        raise CheckoutError(CheckoutReason.BUDGET_PREPARATION)
        yield  # pragma: no cover

    result = run(tmp_path, prepare=refusing)

    assert result.error_code is ErrorCode.CHECKOUT_INCOMPLETE
    assert result.usage is None


# #273-T08
def test_a_successful_dynamic_run_reports_its_usage_as_before(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script(monkeypatch, costs=THREE_PRICED)

    result = run(tmp_path)

    assert result.ok is True
    assert result.usage is not None and result.usage.ai_calls == 3
    assert result.usage.cost_usd == pytest.approx(0.0035, rel=0, abs=1e-12)


# #273-T01: the entry point's last resorts. An engine that raises something nobody expected, and
# the watchdog that ends a run that does not stop, both still say what the run used.
def test_an_unexpected_error_after_the_calls_still_reports_what_they_cost(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script(monkeypatch, costs=THREE_PRICED, raises=RuntimeError("engine blew up"))

    def preparer(environment: Mapping[str, str], cancelled: Callable[[], bool]) -> Any:
        return preparing(tmp_path)

    def held(environment: Mapping[str, str], *, required: bool = False) -> Callable[[], LeaseState]:
        return lambda: LeaseState.HELD

    monkeypatch.setattr(runner, "production_preparer", preparer)
    monkeypatch.setattr(runner, "lease_check_from_environment", held)
    for name, value in ENVIRONMENT.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("RUNNER_ADVERTISED_ENGINES", "pr-agent,opencode")
    out = io.StringIO()

    code = runner.main([], stdin=io.StringIO(json.dumps(dynamic_document())), stdout=out)

    result = json.loads(out.getvalue())
    assert code == 1
    assert result["errorCode"] == "runner_error"
    assert result["usage"]["aiCalls"] == 3
    assert result["usage"]["costUsd"] == pytest.approx(0.0035, rel=0, abs=1e-12)


# #273-T01
def test_the_watchdog_reports_what_the_run_used_up_to_then(monkeypatch: pytest.MonkeyPatch) -> None:
    unit_costs = UnitCosts(input_usd_per_mtok=Decimal("0.5"), output_usd_per_mtok=Decimal(2))
    ledger = BudgetLedger(DynamicLimits(), unit_costs=unit_costs)
    reservation = ledger.reserve_call("x" * 400, output_tokens=10)
    ledger.settle_call(reservation, prompt_tokens=100, completion_tokens=10, cost=Decimal("0.01"))
    probe = runner.UsageProbe()
    probe.watch(lambda: ledger.usage("vendor/model"))
    out = io.StringIO()
    channel = runner._ResultChannel(out)  # pyright: ignore[reportPrivateUsage]
    ended: list[int] = []
    monkeypatch.setattr(runner.os, "_exit", ended.append)

    timer = runner._start_watchdog(  # pyright: ignore[reportPrivateUsage]
        60.0, channel, time.monotonic(), None, (), probe
    )
    timer.cancel()
    timer.function()  # the watchdog fires now instead of after the grace period

    result = json.loads(out.getvalue())
    assert ended == [1]
    assert result["errorCode"] == "timeout"
    assert "errorReason" not in result  # the counters were read: nothing is unknown
    assert result["usage"]["aiCalls"] == 1
    assert result["usage"]["costUsd"] == 0.01


# #827-S1: Control that holds 90% of its container's memory ends its own turn, free when the model
# was not billed and charged when it was
@pytest.mark.parametrize("billed", [False, True])
def test_control_that_holds_its_containers_memory_ends_the_turn_by_its_class(
    monkeypatch: pytest.MonkeyPatch, billed: bool
) -> None:
    unit_costs = UnitCosts(input_usd_per_mtok=Decimal("0.5"), output_usd_per_mtok=Decimal(2))
    ledger = BudgetLedger(DynamicLimits(), unit_costs=unit_costs)
    if billed:
        reservation = ledger.reserve_call("x" * 400, output_tokens=10)
        ledger.settle_call(
            reservation, prompt_tokens=100, completion_tokens=10, cost=Decimal("0.01")
        )
    probe = runner.UsageProbe()
    probe.watch(lambda: ledger.usage("vendor/model"))
    out = io.StringIO()
    channel = runner._ResultChannel(out)  # pyright: ignore[reportPrivateUsage]
    ended: list[int] = []
    monkeypatch.setattr(runner.os, "_exit", ended.append)

    runner._end_for_control_memory(  # pyright: ignore[reportPrivateUsage]
        channel, time.monotonic(), ("s3cret",), probe, 700 * 1024 * 1024, 768 * 1024 * 1024
    )

    result = json.loads(out.getvalue())
    assert ended == [1]
    assert result["errorCode"] == ("agent_gave_up" if billed else "runner_error")
    assert (result["usage"] is not None) is billed
    assert "control_memory: " in result["logTail"]
    assert "700 of 768 MiB" in result["logTail"]


# #827-S1: a trip that comes after the turn finished (the watch is closed) must not print over the
# result of the finished turn nor end the process
def test_a_trip_after_the_turn_finished_prints_nothing_and_does_not_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out = io.StringIO()
    channel = runner._ResultChannel(out)  # pyright: ignore[reportPrivateUsage]
    ended: list[int] = []
    monkeypatch.setattr(runner.os, "_exit", ended.append)

    runner._end_for_control_memory(  # pyright: ignore[reportPrivateUsage]
        channel,
        time.monotonic(),
        (),
        None,
        700 * 1024 * 1024,
        768 * 1024 * 1024,
        finished=lambda: True,
    )

    assert out.getvalue() == "" and ended == []
    later = runner._failure(ErrorCode.RUNNER_ERROR, "x", 0.0, None)  # pyright: ignore[reportPrivateUsage]
    assert channel.write(later) is not None, "the line is still free for the turn's own result"


class TripsAtOnce:
    """Stands in for `ControlMemoryWatch`: the container is full the moment it starts."""

    def __init__(self, on_high: Callable[[int, int], None], *args: object, **options: object):
        self._on_high = on_high
        self.closed = False

    def start(self) -> None:
        self._on_high(700 * 1024 * 1024, 768 * 1024 * 1024)

    def close(self) -> None:
        self.closed = True


class CannotStart(TripsAtOnce):
    def start(self) -> None:
        raise RuntimeError("can't start new thread")


def no_seam(*args: object, **options: object) -> None:
    return None


def run_the_implementer(
    monkeypatch: pytest.MonkeyPatch, watch: type[TripsAtOnce]
) -> tuple[JobResult, io.StringIO, list[int]]:
    out = io.StringIO()
    channel = runner._ResultChannel(out)  # pyright: ignore[reportPrivateUsage]
    ended: list[int] = []
    monkeypatch.setattr(runner.os, "_exit", ended.append)
    monkeypatch.setattr(runner, "ControlMemoryWatch", watch)
    monkeypatch.setattr(runner, "lease_check_from_environment", no_seam)
    monkeypatch.setattr(runner, "step_pump_from_environment", no_seam)

    def turn(*args: object, **options: object) -> JobResult:
        raise RuntimeError("the turn did not stop by itself")

    monkeypatch.setattr(runner, "run_implementer_job", turn)
    job = SimpleNamespace(secrets=("s3cret",))
    result, _ = runner._run_implementer(  # pyright: ignore[reportPrivateUsage]
        job,  # type: ignore[arg-type]
        channel,
        time.monotonic(),
        {},
    )
    return result, out, ended


# #827-S1
def test_the_implementer_ends_its_turn_with_the_result_line_when_the_watch_trips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, out, ended = run_the_implementer(monkeypatch, TripsAtOnce)

    line = json.loads(out.getvalue())
    assert ended == [1], "the process exits once the line is out"
    assert line["errorCode"] == "runner_error"
    assert "control_memory: " in line["logTail"] and "700 of 768 MiB" in line["logTail"]


# #827-S1
def test_a_watch_that_cannot_start_still_yields_a_result(monkeypatch: pytest.MonkeyPatch) -> None:
    result, out, ended = run_the_implementer(monkeypatch, CannotStart)

    assert result.error_code is ErrorCode.RUNNER_ERROR
    assert out.getvalue() == "" and ended == []


class WaitsForTheDeadline(ScriptedEngine):
    """Makes one priced model call, then asks for another one only once the deadline has passed."""

    ledgers: ClassVar[list[BudgetLedger]] = []

    def run(self) -> EngineAnswer:
        self.ledgers.append(self.ledger)
        reservation = self.ledger.reserve_call("x" * 400, output_tokens=10)
        self.ledger.settle_call(
            reservation, prompt_tokens=100, completion_tokens=10, cost=Decimal("0.001")
        )
        while self.ledger.remaining_seconds() > 0:
            time.sleep(0.01)
        try:
            self.ledger.reserve_call("x" * 400, output_tokens=10)
        except LimitError as error:
            return EngineAnswer(None, EngineError(error.code, error.detail))
        raise AssertionError("the deadline must have stopped the call")


# #387-T04: the process spent most of its timeout before the ledger started (a cold start), so the
# run gets what is left of it: its deadline ends before the watchdog's and says what it used.
def test_a_dynamic_run_after_a_slow_start_gets_only_the_time_that_is_left_and_reports_its_usage(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(runner, "DynamicEngine", WaitsForTheDeadline)
    WaitsForTheDeadline.ledgers.clear()
    began = time.monotonic()

    # 4 s of a 4.5 s timeout went to the start-up, which is more than the watchdog's grace.
    result = run(tmp_path, started=began - 4.0, timeout=4.5)

    (ledger,) = WaitsForTheDeadline.ledgers
    assert 0 < ledger.limits.deadline_seconds <= 0.5  # not 4.5, and not the 600 s default
    assert result.error_code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert result.usage is not None
    assert result.usage.ai_calls == 1
    assert result.usage.cost_usd == 0.001
    # The run's own deadline is the process' soft timeout: it ends before the hard one would.
    assert time.monotonic() - began < 0.5 + runner.HARD_TIMEOUT_GRACE_SECONDS


def test_a_dynamic_run_keeps_its_own_total_deadline_when_the_timeout_leaves_more_time(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    deadlines: list[float] = []
    real = runner.dynamic_ledger

    def spy(
        capabilities: Any, environment: Mapping[str, str], deadline: float, *rest: Any
    ) -> BudgetLedger:
        deadlines.append(deadline)
        return real(capabilities, environment, deadline, *rest)

    monkeypatch.setattr(runner, "dynamic_ledger", spy)
    script(monkeypatch)

    run(tmp_path, started=time.monotonic() - 100.0, timeout=100_000.0)
    run(tmp_path)  # without a timeout

    assert deadlines == [TOTAL_DEADLINE_SECONDS, TOTAL_DEADLINE_SECONDS]


# #387-T03: a start-up that used up the whole timeout ends the job with the clean timeout result
# before the proxy, the checkout or the engine exists.
def test_a_dynamic_run_whose_timeout_passed_during_the_start_up_never_starts_the_engine(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def never_prepared(job: Job) -> Any:
        raise AssertionError("a run without time must not prepare a checkout")

    class NeverStarted(ScriptedEngine):
        def run(self) -> EngineAnswer:
            raise AssertionError("a run without time must not start the engine")

    monkeypatch.setattr(runner, "DynamicEngine", NeverStarted)

    result = run(tmp_path, prepare=never_prepared, started=time.monotonic() - 10.0, timeout=2.0)

    assert result.ok is False
    assert result.error_code is ErrorCode.TIMEOUT
    assert result.error_reason is None
    assert result.log_tail.startswith("timeout: the command did not finish in time")
    assert result.usage is None
