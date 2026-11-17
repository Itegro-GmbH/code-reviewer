// SPDX-License-Identifier: LicenseRef-Proprietary

// Which ticket provider a ticket action acts through (#1035): the one the ticket source of the run's project names, not the git provider of
// the run's repository. A lane without a project, and a project whose source is GitHub (the only one so far), act through the GitHub
// ticket provider on the repository of the run, exactly as before. Pure: the database reads are handed in.
import type {
  TicketProvider,
  TicketProviderRegistry,
  TicketScope,
} from "../integrations/ticket-provider.ts";
import type { ActionCall } from "./connectors.ts";

/** The provider of a ticket source that names none, and of a lane that has no project. */
export const DEFAULT_TICKET_PROVIDER = "github";

/** What a ticket action acts on: the provider and where its tickets are. */
export type TicketTarget = {
  provider: TicketProvider;
  scope: TicketScope;
};

/** What the resolver needs to know about a run: an action call and a run of the ask channel both have it. */
export type TicketTargetCall = Pick<ActionCall, "workspaceId" | "runId"> & {
  repository: Pick<ActionCall["repository"], "id">;
};

export type TicketTargetDependencies = {
  tickets: TicketProviderRegistry;
  /** The provider the ticket source of the run's project names; undefined where nothing says (a lane without a project). */
  sourceProviderOf(call: TicketTargetCall): Promise<string | undefined>;
  /** The connection and container the provider's tickets of this run are in; undefined when there is none (no active connection). */
  scopeOf(
    provider: string,
    call: TicketTargetCall,
  ): Promise<TicketScope | undefined>;
};

export function createTicketTargetResolver(
  deps: TicketTargetDependencies,
): (call: TicketTargetCall) => Promise<TicketTarget | undefined> {
  return async (call) => {
    const id = (await deps.sourceProviderOf(call)) ?? DEFAULT_TICKET_PROVIDER;
    const provider = deps.tickets.get(id);
    if (provider === undefined) return undefined;
    const scope = await deps.scopeOf(id, call);
    return scope === undefined ? undefined : { provider, scope };
  };
}
