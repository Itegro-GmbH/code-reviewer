# SPDX-License-Identifier: LicenseRef-Proprietary

"""The envelope of the ledger of one Implementer turn (#764), in a module of its own so that the
model door (#745, step 3), which counts the cost, builds the same ledger as the session does
without importing the session."""

from decimal import Decimal

from code_reviewer_runner.dynamic_review.budget import MAX_REQUEST_BYTES, DynamicLimits

# What the ledger holds the results of tools to. There is no bound on a single result: the owner's
# rule is that the cost limit is the only brake, and a normal `grep` or `bash` result is larger than
# the 64 KiB a review is held to (a grep over 300 files answers 200 KB; the engine's own cut does
# not apply to it). The cumulative bound is a sanity bound above what any turn the cost limit allows
# can read; a single result cannot pass it either.
MAX_RETURNED_BYTES = 256 * 1024 * 1024
MAX_TOOL_RESULT_BYTES = MAX_RETURNED_BYTES
# A conversation of a coding agent is larger than a review's: the model's window bounds a request
# (`BudgetLedger.reserve_call`), this byte bound is only a backstop above it.
MAX_AGENT_REQUEST_BYTES = 8 * MAX_REQUEST_BYTES


def agent_limits(deadline: float, max_cost: Decimal, stop_reason: str) -> DynamicLimits:
    """The envelope of the ledger of one turn: the Dynamic one with the clock and cost limit of the
    turn and the bounds a coding agent needs (see the constants above)."""
    return DynamicLimits(
        deadline_seconds=deadline,
        max_cost_usd=max_cost,
        cost_stop_reason=stop_reason,
        max_tool_result_bytes=MAX_TOOL_RESULT_BYTES,
        max_returned_bytes=MAX_RETURNED_BYTES,
        max_request_bytes=MAX_AGENT_REQUEST_BYTES,
    )
