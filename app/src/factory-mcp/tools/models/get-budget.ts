// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { costsService } from "./services.ts";

const usd = (micro: number): number => micro / 1_000_000;

export const getBudget = defineTool({
  name: "get_budget",
  title: "Get the budget and balance",
  description:
    "What the workspace may spend: the plan view (limits and usage of the current period: `kind`, plan label, whether the platform provides the models, run counts, the percentage of the cost limit used) and, while billing is on, the prepaid `balance` with its state, and, for Owners and Admins, the `monthlyLimitCents` and this month's charges. Read only: the monthly limit and top-ups are changed by a person in the web app. Amounts are US dollars (`...Usd`) and micro-dollars (`...MicroUsd`).",
  scope: "factory:read",
  input: {},
  async handler(context) {
    const costs = context.services.use(costsService);
    const plan = await costs.plan();
    if (!(await costs.billingOn())) return { billingEnabled: false, plan };
    const overview = await costs.billing().overview({
      workspaceId: context.workspace.id,
      userId: context.user.id,
      role: context.role,
    });
    if (!overview.ok) return { billingEnabled: true, plan };
    const view = overview.view;
    return {
      billingEnabled: true,
      plan,
      balance: {
        state: view.state,
        balanceMicroUsd: view.balanceMicroUsd,
        balanceUsd: usd(view.balanceMicroUsd),
        heldMicroUsd: view.heldMicroUsd,
        keyMode: view.keyMode,
      },
      ...(view.monthlyLimitCents === null &&
      view.chargedThisMonthMicroUsd === null
        ? {}
        : {
            monthlyLimitCents: view.monthlyLimitCents,
            chargedThisMonthMicroUsd: view.chargedThisMonthMicroUsd,
            chargedThisMonthUsd:
              view.chargedThisMonthMicroUsd === null
                ? null
                : usd(view.chargedThisMonthMicroUsd),
          }),
    };
  },
});
