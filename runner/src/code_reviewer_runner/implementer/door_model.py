# SPDX-License-Identifier: LicenseRef-Proprietary

"""The ledger Control keeps when the model proxy is a door of its own (#745, step 3): the limits
of the turn by the same rules the door's ledger is made by, in the class that reads the door."""

import time
from collections.abc import Callable, Mapping

from code_reviewer_runner.dynamic_review.budget import (
    effective_cost_limit,
    operator_cost_limit,
)
from code_reviewer_runner.dynamic_review.job_model_entry import JobModelEntry
from code_reviewer_runner.dynamic_review.passthrough.cost_policy import (
    CostPolicy,
    build_native_ledger,
)
from code_reviewer_runner.job import LlmAccess

from .door_ledger import DoorLedger
from .limits import agent_limits

# `native_job._MAX_COST_VARIABLE`, which the door's ledger reads the same way.
_MAX_COST_VARIABLE = "RUNNER_DYNAMIC_MAX_COST_USD"


def build_door_ledger(
    entry: JobModelEntry,
    cost: CostPolicy,
    llm: LlmAccess,
    *,
    deadline: float,
    environment: Mapping[str, str],
    clock: Callable[[], float] = time.monotonic,
) -> DoorLedger:
    """What `native_job.build_native` makes of the ledger, as a `DoorLedger`: the clock and the
    tool counts are this process's, the cost and the model calls are the door's."""
    limit = entry.model["limit"]
    max_cost, reason = effective_cost_limit(
        operator_cost_limit(environment.get(_MAX_COST_VARIABLE), llm.operator_max_cost_usd),
        llm.max_cost_usd,
    )
    ledger = build_native_ledger(
        cost,
        agent_limits(deadline, max_cost, reason),
        window_tokens=int(limit["context"]),
        output_tokens=int(limit["output"]),
        reasoning=entry.model["reasoning"] is True,
        clock=clock,
        ledger_type=DoorLedger,
    )
    assert isinstance(ledger, DoorLedger)
    return ledger
