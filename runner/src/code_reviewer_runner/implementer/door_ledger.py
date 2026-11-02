# SPDX-License-Identifier: LicenseRef-Proprietary

"""The ledger of an Implementer turn whose model proxy is a door of its own (#745, step 3).

Money is counted at the door, where the calls are: `BudgetLedger` there is the one the proxy
settles into and the one that refuses a call over the limit. Control keeps a ledger of this class
for what only it sees: the clock of the turn and the tool calls of the agent (`ToolPartAudit`).
What the door counted is read from `DoorState`:

* `failure`: the door's recorded stop (the cost limit, the output cap, a refusal of the provider)
  or, failing that, the loss of the door itself, then Control's own (a bound of the audit);
* `model_used`: the door's word;
* `usage`: the door's tokens and cost with the tool calls of Control's own trace added to the
  door's model calls; the cost is unknown (None) when the door was lost with a call open.

The class is the type the agent and the audit already take; nothing in them changes.
"""

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, LimitError
from code_reviewer_runner.result import Usage

from .door_state import DoorState


class DoorLedger(BudgetLedger):
    _door: DoorState | None = None

    def attach(self, door: DoorState) -> None:
        self._door = door

    @property
    def failure(self) -> LimitError | None:
        door = self._door
        return (door.failure() if door is not None else None) or super().failure

    @property
    def model_used(self) -> bool:
        door = self._door
        return (door is not None and door.model_used) or super().model_used

    def usage(self, model: str | None) -> Usage:
        door = self._door
        status = None if door is None else door.status
        local = super().usage(model)
        if door is None or status is None:
            return local
        given = status.usage
        tools = (local.call_trace or {}).get("toolCalls", [])
        trace = None
        if status.model_calls or tools:
            trace = {
                "truncated": status.truncated or bool((local.call_trace or {}).get("truncated")),
                "modelCalls": list(status.model_calls),
                "toolCalls": list(tools),
            }
        return Usage(
            model=model,
            prompt_tokens=int(given["promptTokens"]),
            completion_tokens=int(given["completionTokens"]),
            total_tokens=int(given["totalTokens"]),
            ai_calls=int(given["aiCalls"]),
            fallback_used=False,
            cost_usd=None if door.cost_unknown else given["costUsd"],
            stopped_early=given.get("stoppedEarly"),
            limit_exceeded_by=given.get("limitExceededBy"),
            call_trace=trace,
        )
