// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the GitHub connectors in tests that have no project (#1035): the ticket actions act through the ticket provider on the
// connection and repository the git target of the run names, which is what the running server does for a lane without a project.
import type {
  TicketProviderRegistry,
  TicketProvider,
} from "../integrations/ticket-provider.ts";
import type { ActionCall } from "../workflow-runs/connectors.ts";
import type {
  GithubActionTarget,
  GithubConnectorDeps,
} from "../workflow-runs/github-connectors.ts";

/** `deps` with a `ticketTargetOf` that uses `provider` (or the GitHub one of `tickets`) on the repository `targetOf` finds. */
export function withGithubTickets(
  deps: Omit<GithubConnectorDeps, "ticketTargetOf"> & {
    targetOf(call: ActionCall): Promise<GithubActionTarget | undefined>;
  },
  tickets: TicketProvider | (() => TicketProviderRegistry | undefined),
): GithubConnectorDeps {
  return {
    ...deps,
    async ticketTargetOf(call) {
      const target = await deps.targetOf(call);
      const provider =
        typeof tickets === "function" ? tickets()?.get("github") : tickets;
      if (target === undefined || provider === undefined) return undefined;
      return {
        provider,
        scope: { integration: target.integration, repo: target.repo },
      };
    },
  };
}
