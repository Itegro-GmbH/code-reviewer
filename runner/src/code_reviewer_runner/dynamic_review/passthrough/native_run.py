# SPDX-License-Identifier: LicenseRef-Proprietary

"""The ledger and the proxy of one native job, made from one policy (#553).

The two must agree on whose key the job runs on: the proxy decides whether an unknown cost ends the
run and the ledger whether it can carry one (and books it by tokens). Built apart they could drift;
built here from the same `CostPolicy` they cannot. This is the one place the wiring of a native job
asks for them.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits
from code_reviewer_runner.dynamic_review.passthrough.admission import PassthroughTarget
from code_reviewer_runner.dynamic_review.passthrough.cost_policy import (
    CostPolicy,
    build_native_ledger,
)
from code_reviewer_runner.dynamic_review.passthrough.proxy import (
    CALL_TIMEOUT_SECONDS,
    PassthroughProxy,
)
from code_reviewer_runner.dynamic_review.passthrough.upstream import Upstream


@dataclass(frozen=True)
class NativeRun:
    ledger: BudgetLedger
    proxy: PassthroughProxy
    upstream: Upstream


def build_native_run(
    policy: CostPolicy,
    limits: DynamicLimits,
    *,
    window_tokens: int,
    output_tokens: int,
    target: PassthroughTarget,
    upstream: Upstream,
    upstream_api_key: str,
    capability: str,
    reasoning: bool = False,
    superseded: Callable[[], bool] = lambda: False,
    call_timeout: float = CALL_TIMEOUT_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    ledger_type: type[BudgetLedger] = BudgetLedger,
) -> NativeRun:
    """The ledger of the policy and the proxy that settles into it. Raises `LimitError`
    (`dynamic_config_invalid`) for a policy the ledger cannot carry."""
    ledger = build_native_ledger(
        policy,
        limits,
        window_tokens=window_tokens,
        output_tokens=output_tokens,
        reasoning=reasoning,
        clock=clock,
        ledger_type=ledger_type,
    )
    proxy = PassthroughProxy(
        ledger=ledger,
        target=target,
        upstream=upstream,
        upstream_api_key=upstream_api_key,
        capability=capability,
        prices=policy.book,
        superseded=superseded,
        call_timeout=call_timeout,
        unknown_cost_ends_run=policy.unknown_cost_ends_run,
    )
    return NativeRun(ledger, proxy, upstream)
