// SPDX-License-Identifier: LicenseRef-Proprietary

// The resolver of the ticket target the running server uses (#1035): a run names its lane, the lane its project, the project's ticket source
// the provider. Every missing link (no run, no lane, a lane without a project, a deleted project) means GitHub on the run's repository, as it
// was before the ticket provider existed. The repositories are handed in so the chain is tested without a database; `shared.ts` wires the
// real ones.
import {
  jiraSourceOf,
  type ProjectsRepository,
  type StoredProject,
} from "../db/repositories/projects-repository.ts";
import type { WorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import type { WorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import type {
  TicketProviderRegistry,
  TicketScope,
} from "../integrations/ticket-provider.ts";
import {
  createTicketTargetResolver,
  type TicketTargetCall,
} from "./ticket-target.ts";

export type RunTicketTargetDependencies = {
  tickets: TicketProviderRegistry;
  runs(workspaceId: string): Pick<WorkflowRunsRepository, "getRun">;
  workflows(workspaceId: string): Pick<WorkflowsRepository, "get">;
  projects(workspaceId: string): Pick<ProjectsRepository, "getById">;
  /** The connection and repository the git target of the repository names; undefined without an active connection. */
  gitScopeOf(
    workspaceId: string,
    repositoryId: string,
  ): Promise<TicketScope | undefined>;
};

export function createRunTicketTargets(deps: RunTicketTargetDependencies) {
  /** The project the lane of a run belongs to, whose ticket source says where the tickets of the run are; undefined for a lane without one. */
  async function projectOfRun(
    call: Pick<TicketTargetCall, "workspaceId" | "runId">,
  ): Promise<StoredProject | undefined> {
    const run = await deps.runs(call.workspaceId).getRun(call.runId);
    if (run === undefined) return undefined;
    const workflow = await deps.workflows(call.workspaceId).get(run.workflowId);
    if (workflow?.workflow.projectId == null) return undefined;
    return deps.projects(call.workspaceId).getById(workflow.workflow.projectId);
  }

  const ticketTargetOf = createTicketTargetResolver({
    tickets: deps.tickets,
    async sourceProviderOf(call) {
      return (await projectOfRun(call))?.ticketSource.provider;
    },
    // The GitHub issues of the run's repository, or the Jira project of the project's source (#1039): there the repository stays the one the
    // code lives in, and `jira` names where the tickets are.
    async scopeOf(provider, call) {
      if (provider === "github")
        return deps.gitScopeOf(call.workspaceId, call.repository.id);
      if (provider !== "jira") return undefined;
      const project = await projectOfRun(call);
      const jira =
        project === undefined ? null : jiraSourceOf(project.ticketSource);
      if (jira === null) return undefined;
      const git = await deps.gitScopeOf(call.workspaceId, call.repository.id);
      return git === undefined ? undefined : { ...git, jira };
    },
  });

  return { projectOfRun, ticketTargetOf };
}
