// SPDX-License-Identifier: LicenseRef-Proprietary

// What other modules want to know about projects. The jobs module (CR-27) implements
// `onProjectDeactivated` to discard the project's waiting (unclaimed) jobs; this module has no idea
// what a job is.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";

export type ProjectDeactivatedEvent = {
  projectId: string;
  repositoryId: string;
};

export type ProjectActivatedEvent = {
  projectId: string;
  repositoryId: string;
};

export interface ProjectHooks {
  /**
   * Called after a project was created or switched on again (not when it was on already), outside the transaction: what it does must
   * never fail the activation, so a rejection is logged and dropped. The ticket mirror starts its first full sync here (#923).
   */
  onProjectActivated?(event: ProjectActivatedEvent): Promise<void>;

  /**
   * Called in the transaction that switched the project off, so everything it writes commits or
   * rolls back together with the deactivation. Use `executor` for every query, never the outer
   * connection (see src/db/README.md). A rejection rolls the deactivation back: the project stays
   * active and the caller gets the error.
   *
   * It runs on every deactivation of a repository that has a project, also when the project was off
   * already, so it must be idempotent. That lets a repeated click finish what a crashed earlier call
   * left. Running jobs are not touched: they finish.
   */
  onProjectDeactivated(
    event: ProjectDeactivatedEvent,
    executor: Kysely<Database>,
  ): Promise<void>;
}

/** The default until the jobs module plugs in. */
export const noopProjectHooks: ProjectHooks = {
  async onProjectDeactivated() {
    // Nothing to clean up yet.
  },
};
