// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira connection on the running server (#1037): the real database, the master key and the public address from the environment, the
// Atlassian settings read from the environment on every call, and the route handlers. Server code only.
import "server-only";
import { loadAuthConfig } from "../auth/config.ts";
import { lookupSessionId } from "../auth/session.ts";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { sessionOfRequest } from "../github-signin/shared.ts";
import { assembleJira, type AssembledJira } from "./assemble.ts";
import { readAtlassianConfig, type AtlassianConfig } from "./config.ts";
import { createJiraRouteHandlers, type JiraRouteHandlers } from "./http.ts";

function appSecret(): string {
  const resolved = resolveAppSecret(process.env);
  // The server does not start without it (src/auth/startup.ts); this is the second line.
  if (!resolved.ok) throw new Error(resolved.problem);
  return resolved.secret;
}

/** The Atlassian settings of this server, read from the environment now. */
export function getAtlassianConfig(): AtlassianConfig {
  return readAtlassianConfig(process.env);
}

/** Whether "Connect Jira" is offered: the client id and secret of the Atlassian app are set. */
export function isJiraConfigured(): boolean {
  return getAtlassianConfig().configured;
}

export function getJira(): AssembledJira {
  return assembleJira({
    db: getDatabase(),
    appSecret: appSecret(),
    publicUrl: loadAuthConfig(process.env).baseUrl,
    config: getAtlassianConfig,
  });
}

export function getJiraRouteHandlers(): JiraRouteHandlers {
  const db = getDatabase();
  return createJiraRouteHandlers({
    service: getJira().service,
    sessionId: lookupSessionId,
    session: sessionOfRequest,
    workspaceSlug: async (workspaceId) =>
      (await createWorkspacesRepository(db).get(workspaceId))?.slug ?? null,
  });
}
