// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira connection assembled over a database (#1037): the repository of a workspace, the Atlassian client made from the settings, the
// token handling and the service. The wiring of the running server is `shared.ts`; tests call this with their own database, fake
// Atlassian and clock. Server code only.
import type { Kysely } from "kysely";
import { createJiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import type { Database } from "../db/schema.ts";
import { createSignedStates } from "../signed-state/state.ts";
import {
  createAtlassianClient,
  type AtlassianClient,
  type FetchLike,
} from "./client.ts";
import type { AtlassianConfig } from "./config.ts";
import { createJiraService, type JiraService } from "./service.ts";
import { createJiraTokens, type JiraTokens } from "./tokens.ts";

export type AssembledJira = {
  service: JiraService;
  /** Tokens and calls of the connections of ONE workspace. */
  tokensFor(workspaceId: string): JiraTokens;
};

export type JiraAssemblyOptions = {
  db: Kysely<Database>;
  appSecret: string;
  publicUrl: string;
  /** The Atlassian settings, read on every call. */
  config: () => AtlassianConfig;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
};

export function assembleJira({
  db,
  appSecret,
  publicUrl,
  config,
  fetchImpl,
  timeoutMs,
  now = () => new Date(),
  log,
}: JiraAssemblyOptions): AssembledJira {
  // The client holds the client id and secret of the moment: it is made per call from the settings, so a changed variable counts at once.
  const clientNow = (): AtlassianClient => {
    const current = config();
    if (!current.configured)
      throw new Error("The Atlassian settings are not configured.");
    return createAtlassianClient({
      clientId: current.clientId,
      clientSecret: current.clientSecret,
      authBaseUrl: current.authBaseUrl,
      apiBaseUrl: current.apiBaseUrl,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  };
  const lateClient: AtlassianClient = {
    authorizeUrl: (input) => clientNow().authorizeUrl(input),
    exchangeCode: (code, redirectUri) =>
      clientNow().exchangeCode(code, redirectUri),
    refresh: (refreshToken) => clientNow().refresh(refreshToken),
    sites: (accessToken) => clientNow().sites(accessToken),
    account: (accessToken) => clientNow().account(accessToken),
    jiraBase: (cloudId) => clientNow().jiraBase(cloudId),
    send: (url, accessToken, init) => clientNow().send(url, accessToken, init),
  };
  return {
    service: createJiraService({
      db,
      signedStates: createSignedStates({ db, appSecret, now }),
      rateLimits: createRateLimitsRepository(db, now),
      client: lateClient,
      config,
      publicUrl,
      appSecret,
      now,
      ...(log === undefined ? {} : { log }),
    }),
    tokensFor: (workspaceId) =>
      createJiraTokens({
        repository: createJiraConnectionsRepository(db, workspaceId, now),
        client: lateClient,
        appSecret,
        now,
        ...(log === undefined ? {} : { log }),
      }),
  };
}
