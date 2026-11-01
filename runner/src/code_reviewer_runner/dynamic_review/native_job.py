# SPDX-License-Identifier: LicenseRef-Proprietary

"""The native path of one Dynamic job (#578, design #544): claim, entry, passthrough proxy, engine.

A job whose claim carries a per-job model entry (`dynamic.modelEntry`, #548) and a cost policy
(`dynamic.cost`, #553) runs here instead of through the legacy proxy. The pieces already exist and
are tested apart; this module is the one place that joins them, so the runner's own flow keeps its
shape:

1. `build_native_job` (before anything is prepared): the target and the upstream from the entry, the
   ledger and the proxy from the policy (`build_native_run`, so the two agree on whose key pays),
   a fresh capability. An upstream address the guard refuses ends the job here, before the engine.
2. `run_native_engine` (inside the preparation): the loopback server on the slot's port, the engine
   configuration of the entry (only the chosen model, the capability, no key, no upstream address),
   `DynamicEngine(plain_final=True, ...)`, and the log line of the finalization.

The real key (`llm.apiKey`) is given to the proxy and to nothing else; the engine is handed the
capability, which is worthless anywhere but at the proxy of this job. Nothing here sets or removes
`cache_control` (caching comes from the engine), steers the model or limits its steps: the cost
limit is the only brake, and the final-call exemption of the ledger makes a run end with a review
rather than with the cost guard's refusal (#542, #552).
"""

import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from code_reviewer_runner.dynamic_review import findings_schema
from code_reviewer_runner.dynamic_review.adapter import DynamicEngine, EngineAnswer
from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    DynamicLimits,
    LimitError,
    effective_cost_limit,
    operator_cost_limit,
)
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.config import (
    build_native_engine_config,
    new_proxy_capability,
)
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.finalization_log import finalization_line
from code_reviewer_runner.dynamic_review.inputs import review_inputs
from code_reviewer_runner.dynamic_review.job_model_entry import (
    JobModelEntry,
    native_model_reference,
    native_provider_config,
)
from code_reviewer_runner.dynamic_review.passthrough.address import UpstreamRefused
from code_reviewer_runner.dynamic_review.passthrough.admission import target_from_entry
from code_reviewer_runner.dynamic_review.passthrough.cost_policy import CostPolicy
from code_reviewer_runner.dynamic_review.passthrough.destination import key_destination
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.dynamic_review.passthrough.native_run import NativeRun, build_native_run
from code_reviewer_runner.dynamic_review.passthrough.server import PassthroughServer
from code_reviewer_runner.dynamic_review.passthrough.upstream import HttpsUpstream, Upstream
from code_reviewer_runner.dynamic_review.prompts import compose_system_prompt
from code_reviewer_runner.job import Job, LlmAccess
from code_reviewer_runner.result import ErrorCode
from code_reviewer_runner.supersede_timing import SUPERSEDED_DRAIN_SECONDS

# Where the upstream of a job comes from: the production one speaks https to a public address and
# refuses anything else; a test puts a double behind the same seam.
UpstreamFactory = Callable[[str], Upstream]
EngineFactory = Callable[..., DynamicEngine]


@dataclass(frozen=True)
class NativeSeams:
    """What the tests of the wiring replace; production leaves the defaults."""

    upstream_for: UpstreamFactory = HttpsUpstream
    engine_factory: EngineFactory = DynamicEngine


class NativeStartError(Exception):
    """The native run could not start. Carries a stable code and a sentence of ours only."""

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class NativeJob:
    entry: JobModelEntry
    run: NativeRun
    capability: str

    @property
    def ledger(self) -> BudgetLedger:
        return self.run.ledger


@dataclass(frozen=True)
class NativeOutcome:
    answer: EngineAnswer
    turn_note: str
    recovery_note: str | None
    cache_line: str | None
    # The one line of the finalization (`finalization_log.py`); None if the engine never got there.
    finalization: str | None


def _limit_of(entry: JobModelEntry, key: str) -> int:
    limit = entry.model["limit"]
    value = limit[key]
    assert isinstance(value, int)  # the entry was read strictly (`parse_job_model_entry`)
    return value


def build_native_job(
    job: Job,
    *,
    deadline: float,
    environment: Mapping[str, str],
    superseded: Callable[[], bool] = lambda: False,
    upstream_for: UpstreamFactory = HttpsUpstream,
    clock: Callable[[], float] = time.monotonic,
) -> NativeJob:
    """The ledger, the proxy and the capability of a native job. Raises `LimitError`
    (`dynamic_config_invalid`) for an entry the proxy cannot serve, an address the guard refuses or
    a policy the ledger cannot carry."""
    dynamic = job.dynamic
    assert dynamic is not None and dynamic.model_entry is not None and dynamic.cost is not None
    return build_native(
        dynamic.model_entry,
        dynamic.cost,
        job.llm,
        deadline=deadline,
        environment=environment,
        superseded=superseded,
        upstream_for=upstream_for,
        clock=clock,
    )


def build_native(
    entry: JobModelEntry,
    cost: CostPolicy,
    llm: LlmAccess,
    *,
    deadline: float,
    environment: Mapping[str, str],
    superseded: Callable[[], bool] = lambda: False,
    upstream_for: UpstreamFactory = HttpsUpstream,
    clock: Callable[[], float] = time.monotonic,
    limits: Callable[[Decimal, str], DynamicLimits] | None = None,
) -> NativeJob:
    """`build_native_job` for any job that carries a model entry, a cost policy and the model
    access (#764: the Implementer's turn is one). `limits`, when given, makes the ledger's limits
    from the cost limit and its stop reason; the default is the Dynamic envelope with `deadline`."""
    try:
        # The key goes only where `key_destination` says (`parse_job` checked it too): the
        # registry's address for a registry provider, the entry's plain public https address for
        # any other provider of the catalog (#555); nothing is prepared for any other address.
        destination = key_destination(llm.provider, entry)
        target = target_from_entry(entry)
        upstream = upstream_for(destination)
    except (ValueError, UpstreamRefused):
        # Neither the entry's address nor the text of the refusal is shown.
        raise LimitError(
            ErrorCode.DYNAMIC_CONFIG_INVALID, "the model provider of the job cannot be used"
        ) from None
    capability = new_proxy_capability()
    max_cost, stop_reason = effective_cost_limit(
        operator_cost_limit(environment.get(_MAX_COST_VARIABLE), llm.operator_max_cost_usd),
        llm.max_cost_usd,
    )
    ledger_limits = (
        DynamicLimits(
            deadline_seconds=deadline, max_cost_usd=max_cost, cost_stop_reason=stop_reason
        )
        if limits is None
        else limits(max_cost, stop_reason)
    )
    made = build_native_run(
        cost,
        ledger_limits,
        window_tokens=_limit_of(entry, "context"),
        output_tokens=_limit_of(entry, "output"),
        target=target,
        upstream=upstream,
        upstream_api_key=llm.api_key,
        capability=capability,
        reasoning=entry.model["reasoning"] is True,
        superseded=superseded,
        clock=clock,
    )
    return NativeJob(entry, made, capability)


# `runner.DYNAMIC_MAX_COST_VARIABLE`, named here to keep this module independent of the runner.
_MAX_COST_VARIABLE = "RUNNER_DYNAMIC_MAX_COST_USD"


def _turn_note(turn_seconds: list[float]) -> str:
    if not turn_seconds:
        return ""
    return "engine message call: " + ", ".join(f"{seconds:.1f} s" for seconds in turn_seconds)


def run_native_engine(
    native: NativeJob,
    job: Job,
    *,
    command: list[str],
    content: PreparedContent,
    launch: EngineLaunch | None,
    node_bin: str | None,
    ripgrep: Path | None,
    superseded: Callable[[], bool],
    engine_factory: EngineFactory = DynamicEngine,
) -> NativeOutcome:
    """Serve the proxy, run the engine to its answer and stop the server. Never raises for a
    failed review (the answer holds the code); raises `NativeStartError` if nothing could start."""
    dynamic = job.dynamic
    base = job.base
    assert dynamic is not None and base is not None
    entry, proxy = native.entry, native.run.proxy
    # With the dedicated engine user the proxy listens on the slot's fixed port: that user's static
    # network rules name it. Somebody else holding it is a slot that is not clean.
    try:
        server = PassthroughServer(proxy, "127.0.0.1", launch.proxy_port if launch else 0).start()
    except OSError:
        raise NativeStartError(
            ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED,
            "the model proxy port of the slot is not free",
        ) from None
    try:
        prompt = compose_system_prompt(dynamic.skill, base.head_sha)
        family = WireFamily(entry.family)
        config = build_native_engine_config(
            provider=native_provider_config(
                entry,
                base_url=spec_of(family).proxy_base_url(server.url),
                api_key=native.capability,
            ),
            model_reference=native_model_reference(entry),
            system_prompt=prompt,
            family=family,
            proxy_url=server.url,
            capability=native.capability,
        )
        engine = engine_factory(
            job,
            ledger=native.ledger,
            command=command,
            directory=str(content.export),
            proxy_url=server.url,
            proxy_capability=native.capability,
            agent_prompt=prompt,
            model_schema=findings_schema(),
            inputs=review_inputs(job.pr_url, content),
            exported_paths=frozenset(content.files),
            launch=launch,
            node_bin=node_bin,
            ripgrep=ripgrep,
            superseded=superseded,
            plain_final=True,
            engine_config=config,
            provider_id=entry.provider_id,
            provider_error=lambda: proxy.last_upstream_error,
            wait_idle=proxy.wait_idle,
        )
        answer = engine.run()
        record = engine.finalization
        return NativeOutcome(
            answer=answer,
            turn_note=_turn_note(engine.turn_seconds),
            recovery_note=engine.recovery,
            cache_line=proxy.cache_tally.describe(),
            finalization=None
            if record is None
            else finalization_line(
                record, wrap_up=native.ledger.stopped_early, trace=native.ledger.trace.to_json()
            ),
        )
    finally:
        # A request the engine had in flight when the run ended is waited for if the run was
        # superseded: its answer is measured, so the cost is known instead of lost (#396).
        server.stop(drain_seconds=SUPERSEDED_DRAIN_SECONDS if superseded() else 0.0)
