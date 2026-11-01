// SPDX-License-Identifier: LicenseRef-Proprietary

// The cost limit field of the form (#756): dollars as a person types them, whole cents as the route takes them. The most it can be
// is the lower of the operator's maximum per task and the route's own bound (`REVIEW_SETTING_LIMITS`, $100): the placeholder shows
// that amount, and an amount above it is refused here, before anything is sent, with a sentence that names it. The server checks
// both again.
import { REVIEW_SETTING_LIMITS } from "../../review-settings/settings.ts";

/** Dollars as typed: "2", "1.50", ".5", each with an optional leading "$". */
const DOLLARS = /^\$?(\d+(\.\d{1,2})?|\.\d{1,2})$/;

export type CostLimitCheck =
  /** `cents` is null when the field is empty: no limit of the person's own, the maximum applies. */
  | { ok: true; cents: number | null }
  | { ok: false; code: "invalid" }
  | { ok: false; code: "above_maximum"; maximumCents: number };

/** The most a limit can be: the operator's maximum per task, or the bound of the route if that is lower. */
export function effectiveMaximumCents(operatorMaximumCents: number): number {
  return Math.min(operatorMaximumCents, REVIEW_SETTING_LIMITS.maxCostCents.max);
}

/** What the text means. `operatorMaximumCents` is the operator's maximum per task. */
export function parseCostLimit(
  text: string,
  operatorMaximumCents: number,
): CostLimitCheck {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, cents: null };
  if (!DOLLARS.test(trimmed)) return { ok: false, code: "invalid" };
  const cents = Math.round(Number(trimmed.replace("$", "")) * 100);
  if (cents < REVIEW_SETTING_LIMITS.maxCostCents.min)
    return { ok: false, code: "invalid" };
  const maximumCents = effectiveMaximumCents(operatorMaximumCents);
  if (cents > maximumCents)
    return { ok: false, code: "above_maximum", maximumCents };
  return { ok: true, cents };
}

/** What the empty field means and shows: "Max $5.00". */
export function costLimitPlaceholder(operatorMaximumCents: number): string {
  return `Max $${(effectiveMaximumCents(operatorMaximumCents) / 100).toFixed(2)}`;
}
