# SPDX-License-Identifier: LicenseRef-Proprietary

"""The door's ledger says so when a call is reserved or settled (#745, step 3).

The proxy settles into a `BudgetLedger`. The door used to look at it every 0.1 s, so a call that was
reserved and billed inside that window, followed by the loss of the door, left Control with a ledger
that never saw the model used: the free `runner_error` for a turn that cost money. This subclass
calls `announce` after every change a call makes to the ledger (reserve, settle, a recorded
failure), outside the ledger's lock, so the door reports the state while the call is still being
answered. The poll stays as the safety net for what is not a call (the clock, a deadline)."""

import logging
from collections.abc import Callable
from typing import Any

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, LimitError, Reservation

_log = logging.getLogger(__name__)


class AnnouncingLedger(BudgetLedger):
    announce: Callable[[], None] | None = None

    def _announced(self) -> None:
        """Say so, and never let the saying change what the call does: the callers run this from a
        `finally`, so an exception here (the pipe to Control is gone) would replace the
        `LimitError` of a refused call, or leave a reservation open that its caller never got."""
        announce = self.announce
        if announce is None:
            return
        try:
            announce()
        except Exception:
            _log.warning("the model door could not announce its ledger")

    def reserve_call(self, *args: Any, **kwargs: Any) -> Reservation:
        try:
            return super().reserve_call(*args, **kwargs)
        finally:
            self._announced()

    def settle_call(self, *args: Any, **kwargs: Any) -> None:
        try:
            super().settle_call(*args, **kwargs)
        finally:
            self._announced()

    def settle_unbilled(self, reservation: Reservation) -> None:
        try:
            super().settle_unbilled(reservation)
        finally:
            self._announced()

    def settle_unknown(self, reservation: Reservation, *, worst_case: bool = True) -> bool:
        try:
            return super().settle_unknown(reservation, worst_case=worst_case)
        finally:
            self._announced()

    def record_failure(self, error: LimitError) -> None:
        super().record_failure(error)
        self._announced()
