# SPDX-License-Identifier: LicenseRef-Proprietary

"""The cost policy of a native job (#553): whose key pays, what prices the ledger uses, and what
bounds a run whose price is not known.

The claim sends it as `dynamic.cost` (`contracts/runner-api.v1.json`, `DynamicCostPolicy`), only to
a runner that advertised the feature `dynamic_cost_policy`, and only for a job that runs through the
passthrough proxy. A job without it is a job of today and nothing here applies to it.

- **Managed key (we pay).** The claim carries the confirmed price book (`app/src/model-prices/`).
  It is the runner's only price source: never the engine's own `cost`, never models.dev. A cost that
  is not known (a call whose usage was not read, one the book cannot price) is `unknown` and ends
  the run with `dynamic_accounting_failed`, which billing treats as our fault. There is no token
  cap: the dollar limit of #540 binds, and the book is complete.
- **Own key (the user pays the provider).** Choosing a model is free, so a price may be missing.
  The book is the catalog's price when there is one, else none. An unknown cost does not end the
  run: it is bound by `maxTotalTokens` and the clock, and the result reports `costUsd: null`, which
  billing charges as minutes only. A call that stated no usage at all still fails the run (the cap
  cannot be applied to it).

The book of a claim is read strictly (`parse_price_book`) and with `strict_cache_read`: a cache read
without a read price is not priced as input (N4 of the review of PR #569). The claim refuses such a
model on the managed key before the job starts; the runner makes the call unpriced if one slips by,
rather than billing a member for a price that nobody confirmed.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from typing import Any, Final

from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    DynamicLimits,
    LimitError,
    UnitCosts,
)
from code_reviewer_runner.dynamic_review.passthrough.price_book import PriceBook, parse_price_book
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

# The default token cap of an own key. The app's instance setting starts here
# (`app/src/native-cost/token-cap.ts`); the claim always sends the value, so this is only the
# documented default and what a test pins.
DEFAULT_OWN_KEY_MAX_TOTAL_TOKENS: Final = 4_000_000
# The widest cap the runner accepts. The app bounds the setting far below it.
MAX_TOTAL_TOKENS_LIMIT: Final = 10_000_000_000
# The most the pinned engine asks of one call: `min(limit.output, 32000)` (spike #546). The ledger
# holds a call to it and reserves with it.
NATIVE_OUTPUT_CAP: Final = 32_000
_KEYS: Final = {"keyMode", "priceBook", "maxTotalTokens"}

# The runner's own code for a policy that is not one; the job is refused with it.
COST_POLICY_INVALID: Final = "cost_policy_invalid"


class KeyMode(StrEnum):
    MANAGED = "managed"
    OWN = "own"


class CostPolicyError(ValueError):
    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.code = COST_POLICY_INVALID
        self.detail = detail


@dataclass(frozen=True)
class CostPolicy:
    key_mode: KeyMode
    # The confirmed book (managed), the catalog's price (own, when it states one) or None.
    book: PriceBook | None
    # The tokens an own key's run may use in all; None for the managed key.
    max_total_tokens: int | None

    @property
    def unknown_cost_ends_run(self) -> bool:
        """Whether a call whose cost is unknown ends the run: the managed key's rule."""
        return self.key_mode is KeyMode.MANAGED

    @property
    def priced(self) -> bool:
        return self.book is not None


def _invalid(detail: str) -> CostPolicyError:
    return CostPolicyError(detail)


def parse_cost_policy(document: object) -> CostPolicy:
    """The policy of this JSON, or `CostPolicyError`. Closed, and strict about what binds a run."""
    given = as_object(document)
    if given is None or set(given) != _KEYS:
        raise _invalid("dynamic.cost must be an object with keyMode, priceBook and maxTotalTokens")
    try:
        mode = KeyMode(given["keyMode"])
    except ValueError:
        raise _invalid("dynamic.cost.keyMode must be managed or own") from None
    raw_book = given.get("priceBook")
    book: PriceBook | None = None
    if raw_book is not None:
        book = parse_price_book(raw_book, strict_cache_read=True)
        if book is None:
            raise _invalid("dynamic.cost.priceBook is not a price book")
    cap: Any = given.get("maxTotalTokens")
    if mode is KeyMode.MANAGED:
        if book is None:
            raise _invalid("a managed key needs the confirmed price book")
        if cap is not None:
            raise _invalid("a managed key has no token cap")
        return CostPolicy(KeyMode.MANAGED, book, None)
    if isinstance(cap, bool) or not isinstance(cap, int) or not 1 <= cap <= MAX_TOTAL_TOKENS_LIMIT:
        raise _invalid("an own key needs maxTotalTokens, a whole number of tokens")
    return CostPolicy(KeyMode.OWN, book, cap)


def unit_costs_of(book: PriceBook | None) -> UnitCosts:
    """The prices a reservation is made with: the base level of the book, or none at all.

    A reservation is an expectation (#540); what a call costs is always the book applied to the
    usage. A model with tiers can therefore settle above its reservation, which the final-call
    exemption of the ledger already bounds. With no book every price is zero: the dollar guard is
    inert, the ledger does not count dollars (`priced=False`) and the token cap binds instead.
    """
    if book is None:
        return UnitCosts(input_usd_per_mtok=Decimal(0), output_usd_per_mtok=Decimal(0))

    def usd(micro: int | None) -> Decimal | None:
        return None if micro is None else Decimal(micro) / 1_000_000

    level = book.base
    return UnitCosts(
        input_usd_per_mtok=Decimal(level.input) / 1_000_000,
        output_usd_per_mtok=Decimal(level.output) / 1_000_000,
        cache_read_usd_per_mtok=usd(level.cache_read),
        cache_write_usd_per_mtok=usd(level.cache_write_5m),
        cache_write_1h_usd_per_mtok=usd(level.cache_write_1h),
    )


def build_native_ledger(
    policy: CostPolicy,
    limits: DynamicLimits,
    *,
    window_tokens: int,
    output_tokens: int,
    reasoning: bool = False,
    clock: Callable[[], float] = time.monotonic,
    ledger_type: type[BudgetLedger] = BudgetLedger,
) -> BudgetLedger:
    """The ledger of a native job (`ledger_type`: the Implementer's Control container reads the
    cost from its model door and so counts with a subclass, #745). `output_tokens` is the cap the
    engine really sends (`min(limit.output, NATIVE_OUTPUT_CAP)`), `reasoning` the catalog's flag
    for the model: a model that thinks spends output tokens nobody can predict, so every call
    reserves at least `REASONING_OUTPUT_FLOOR_TOKENS` (#548, the reasoning flag changes the
    request and so the reservation)."""
    if policy.key_mode is KeyMode.MANAGED and policy.book is None:
        raise LimitError(ErrorCode.DYNAMIC_CONFIG_INVALID, "a managed key has no price book")
    if policy.key_mode is KeyMode.OWN and policy.max_total_tokens is None:
        raise LimitError(ErrorCode.DYNAMIC_CONFIG_INVALID, "an own key has no token cap")
    return ledger_type(
        limits,
        window_tokens=window_tokens,
        output_tokens=min(output_tokens, NATIVE_OUTPUT_CAP),
        unit_costs=unit_costs_of(policy.book),
        book=policy.book,
        priced=policy.priced,
        unknown_cost_tolerated=not policy.unknown_cost_ends_run,
        max_total_tokens=policy.max_total_tokens,
        reserve_full_output=reasoning,
        clock=clock,
    )
