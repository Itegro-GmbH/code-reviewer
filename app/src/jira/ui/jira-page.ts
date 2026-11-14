// SPDX-License-Identifier: LicenseRef-Proprietary

// The data of the Jira card of the Integrations tab (#1037): the connections of the workspace, the sites of the person's waiting grant and
// what a flow that just ended said (the `jira` code in the address, from our own list). Gathered from the service, which a test hands in
// over a test database. Server code only: the card itself (jira-section.tsx) gets the data and never a token.
// The card exists only in a deployment with the capability `implementer` (the factory) AND with the Atlassian app's client id and secret
// set: without either, nothing is read from the database and the data says "not configured" (the page then shows no card).
import type { JiraActor, JiraService } from "../service.ts";
import type { JiraSectionData } from "./jira-section.tsx";
import { describeJiraResult } from "./messages.ts";

export async function loadJiraSection({
  service,
  workspaceId,
  actor,
  canManage,
  implementer,
  query,
}: {
  service: JiraService;
  workspaceId: string;
  /** The person and the session of the page, or null when the session could not be read. */
  actor: JiraActor | null;
  canManage: boolean;
  /** Whether the deployment has the capability `implementer`. */
  implementer: boolean;
  query: { jira?: unknown };
}): Promise<JiraSectionData> {
  if (!implementer || !service.available())
    return { configured: false, connections: [], choices: null, notice: null };
  const [connections, choices] = await Promise.all([
    service.list(workspaceId),
    canManage && actor !== null
      ? service.readChoice(actor, workspaceId)
      : Promise.resolve(null),
  ]);
  return {
    configured: service.available(),
    connections,
    choices,
    notice: describeJiraResult(query.jira),
  };
}
