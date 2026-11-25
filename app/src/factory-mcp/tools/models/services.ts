// SPDX-License-Identifier: LicenseRef-Proprietary

// The services of the model and cost tools (#1147): the SAME ones the routes `GET /implementer/models`, `GET /plan` and `GET /billing/*` use,
// for the workspace of the token. Reading only: the monthly limit and top-ups stay with a person.
import type { Kysely } from "kysely";
import { isBillingOn } from "../../../billing/enabled.ts";
import { getWorkspaceBillingService } from "../../../billing/shared.ts";
import type { WorkspaceBillingService } from "../../../billing/workspace-page.ts";
import type { Database } from "../../../db/schema.ts";
import { implementerModelsFor } from "../../../implementer/shared.ts";
import type { ImplementerModels } from "../../../implementer/models.ts";
import { planViewFor } from "../../../usage/shared.ts";
import type { PlanView } from "../../../usage/plan-view.ts";
import type { ServiceFactory } from "../services.ts";

/** The models a lane step or task can be sent to, as the model picker reads them. */
export const modelsService: ServiceFactory<ImplementerModels> = ({ access }) =>
  implementerModelsFor(access.workspace.id);

export type CostsService = {
  /** What the workspace may use and has used in the period (the plan page). */
  plan(): Promise<PlanView>;
  /** Whether billing is on in this deployment: with it off there is no balance and no journal. */
  billingOn(): Promise<boolean>;
  billing(): WorkspaceBillingService;
};

export const costsService: ServiceFactory<CostsService> = ({
  access,
  database,
}) => {
  const db = (): Kysely<Database> => database();
  return {
    plan: () => planViewFor(access.workspace.id),
    billingOn: () => isBillingOn(db()),
    billing: () => getWorkspaceBillingService(),
  };
};
