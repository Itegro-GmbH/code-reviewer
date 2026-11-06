// SPDX-License-Identifier: LicenseRef-Proprietary

// What a run consumed, as the facts of the Runs pages say it (the detail page of a workspace and the job view of
// the admin portal): the model, the tokens and calls, the cost (not on a managed quality level, #283) and why a
// Dynamic Review stopped early. Plain data in, rows for a description list out; no state, so a server component
// can use it.
import type { ReactNode } from "react";
import type { StoppedEarly } from "../../runner-api/contract.ts";
import type { RunDetailView, RunUsageView } from "../run-view.ts";

const COST = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const COUNT = new Intl.NumberFormat("en-US");
/** The smallest cost the display can tell from zero; a real cost below it must not read as $0. */
const COST_PRECISION = 0.0001;

/** A cost in US dollars as the Runs pages write it: `$0.42`, and `Less than $0.0001` for a real cost below the display. */
export function costText(costUsd: number): string {
  return costUsd > 0 && costUsd < COST_PRECISION
    ? `Less than ${COST.format(COST_PRECISION)}`
    : COST.format(costUsd);
}

/** What a Dynamic Review that was wrapped up at a limit says about itself (#293). */
export const STOPPED_EARLY_TEXT: Record<StoppedEarly, string> = {
  cost_limit:
    "The review reached the cost limit and was wrapped up; it may be incomplete.",
  project_cost_limit:
    "The review reached the cost limit set for this project and was wrapped up; it may be incomplete. You can change the limit under Limits in the project settings.",
  time_limit:
    "The review reached its time limit and was wrapped up; it may be incomplete.",
  token_limit:
    "The review reached the token limit and was wrapped up; it may be incomplete.",
};

/**
 * The cost of a run. A turn on a customer's subscription (#856) was not billed: it reads "≈ $0.42 through a subscription" (Claude Code's
 * estimate at API prices, with a line that says so), or "No estimate, through a subscription"; any other run shows what it cost.
 */
function costDescription(usage: RunUsageView): ReactNode {
  // Beside a cost the basis is not read: a billed number must never read "not billed".
  if (usage.costBasis === "subscription" && usage.costUsd === null) {
    const estimate = usage.estimatedCostUsd ?? null;
    return (
      <span className="flex flex-col">
        <span data-slot="run-cost-subscription">
          {estimate === null
            ? "No estimate, through a subscription"
            : `≈ ${costText(estimate)} through a subscription`}
        </span>
        <span className="text-xs text-muted-foreground">
          Estimate at API prices, not billed
        </span>
      </span>
    );
  }
  return usage.costUsd === null ? (
    <span className="text-muted-foreground">Not available</span>
  ) : (
    costText(usage.costUsd)
  );
}

/** The model, tokens, calls and cost the runner reported; a text from outside is rendered as text. */
export function usageItems(
  run: Pick<RunDetailView, "usage" | "costHidden" | "status">,
) {
  const usage = run.usage;
  if (usage === null) return { model: [], consumption: [] };
  const calls = usage.aiCalls === 1 ? "model call" : "model calls";
  return {
    model:
      usage.model === null
        ? []
        : [
            {
              term: "Model",
              description: (
                <span data-slot="run-model" className="break-words">
                  {usage.model}
                </span>
              ),
            },
          ],
    consumption: [
      {
        term: "Usage",
        description: `${COUNT.format(usage.totalTokens)} tokens in ${COUNT.format(usage.aiCalls)} ${calls}`,
      },
      // A run on a managed quality level shows no cost: with the tokens it would tell the model (#283).
      ...(run.costHidden
        ? []
        : [
            {
              term: "Cost",
              description: costDescription(usage),
            },
          ]),
      // Only a delivered review was wrapped up; a failed run at its cost limit is explained by its failure text.
      ...(usage.stoppedEarly === null || run.status !== "succeeded"
        ? []
        : [
            {
              term: "Stopped early",
              description: STOPPED_EARLY_TEXT[usage.stoppedEarly],
            },
          ]),
    ],
  };
}
