// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira Cloud connection assembled for integration tests (src/jira/): a real database, the fake Atlassian on a loopback port as both
// auth.atlassian.com and api.atlassian.com (it registers the exact callback address and checks what a real consent page checks), the real
// service, token handling and route handlers, and a clock the test moves. `walk` does what a person does: presses "Connect Jira", goes to
// Atlassian's consent page, and comes back to the callback.
import {
  startAtlassianFake,
  type AtlassianFake,
  type AtlassianFakeOptions,
} from "../../../fakes/atlassian/server.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { WorkspaceRole } from "../db/workspace-roles.ts";
import { assembleJira } from "../jira/assemble.ts";
import { jiraCallbackUrl, readAtlassianConfig } from "../jira/config.ts";
import {
  createJiraRouteHandlers,
  type JiraRouteDependencies,
  type JiraRouteHandlers,
} from "../jira/http.ts";
import type { JiraActor } from "../jira/service.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import { cleanUpAfterTest, createTestDatabase } from "./test-database.ts";
import { sessionUser } from "./session-lookup.ts";
import { insertUser } from "./users.ts";

export const JIRA_TEST_PUBLIC_URL = "https://factory.example.test";
export const JIRA_TEST_SECRET = "a-master-key-of-the-jira-tests-32-chars!";

export type JiraHarnessOptions = {
  atlassian?: AtlassianFake | AtlassianFakeOptions;
  /** Leave the client id and secret out of the settings: the feature is off. */
  unconfigured?: boolean;
};

export async function createJiraHarness(options: JiraHarnessOptions = {}) {
  const { db } = await createTestDatabase();
  const atlassian =
    options.atlassian !== undefined && "baseUrl" in options.atlassian
      ? options.atlassian
      : await startAtlassianFake({
          redirectUris: [jiraCallbackUrl(JIRA_TEST_PUBLIC_URL)],
          ...options.atlassian,
        });
  cleanUpAfterTest(() => atlassian.close());
  const clock = { time: Date.parse("2026-11-14T10:00:00.000Z") };
  const now = () => new Date(clock.time);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const env =
    options.unconfigured === true
      ? {}
      : {
          ATLASSIAN_CLIENT_ID: atlassian.clientId,
          ATLASSIAN_CLIENT_SECRET: atlassian.clientSecret,
          ATLASSIAN_AUTH_BASE_URL: atlassian.baseUrl,
          ATLASSIAN_API_BASE_URL: atlassian.baseUrl,
          ALLOW_TEST_ATLASSIAN_ENDPOINTS: "true",
        };
  const jira = assembleJira({
    db,
    appSecret: JIRA_TEST_SECRET,
    publicUrl: JIRA_TEST_PUBLIC_URL,
    config: () => readAtlassianConfig(env),
    timeoutMs: 5000,
    now,
    log,
  });
  const workspaces = createWorkspacesRepository(db, now);

  async function workspace(slug: string) {
    return workspaces.create({
      name: `Workspace ${slug}`,
      slug,
      createdBy: null,
    });
  }

  /** A signed in person: the account (once) and, if asked, a membership. */
  async function person(
    id: string,
    membership?: { workspaceId: string; role: WorkspaceRole },
    session = `session-${id}`,
  ): Promise<JiraActor> {
    const exists = await db
      .selectFrom("users")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (exists === undefined) await insertUser(db, { id, emailVerified: true });
    if (membership !== undefined)
      await workspaces.addMember(membership.workspaceId, id, membership.role);
    return { id, sessionId: session };
  }

  function accessOf(
    actor: JiraActor,
    value: Awaited<ReturnType<typeof workspace>>,
    role: WorkspaceRole,
  ): WorkspaceAccess {
    return { user: sessionUser(actor.id), workspace: value, role };
  }

  function handlers(
    actor: JiraActor | null,
    overrides: Partial<JiraRouteDependencies> = {},
  ): JiraRouteHandlers {
    return createJiraRouteHandlers({
      service: jira.service,
      sessionId: async () => actor?.sessionId ?? null,
      session: async () =>
        actor === null
          ? null
          : { userId: actor.id, sessionId: actor.sessionId },
      workspaceSlug: async (id) => (await workspaces.get(id))?.slug ?? null,
      ...overrides,
    });
  }

  const json = (body: unknown) =>
    new Request("https://factory.example.test/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /**
   * What a person does: "Connect Jira" (a new connection, or a reconnect), the consent page, back to the callback. `tamper` changes the
   * query of the callback; the answer is the page the browser lands on.
   */
  async function walk(
    actor: JiraActor,
    value: Awaited<ReturnType<typeof workspace>>,
    role: WorkspaceRole,
    step: {
      connectionId?: string;
      tamper?: (query: URLSearchParams) => void;
      /** The person who comes back to the callback, when it is not the one who started. */
      returningAs?: JiraActor;
    } = {},
  ): Promise<{ landing: string; consent: string }> {
    const start = await handlers(actor).connect(
      json(
        step.connectionId === undefined
          ? {}
          : { connectionId: step.connectionId },
      ),
      accessOf(actor, value, role),
    );
    const body = (await start.json()) as { url?: string; error?: string };
    if (body.url === undefined)
      throw new Error(
        `Connect Jira was refused: ${body.error ?? start.status}`,
      );
    const consent = await fetch(body.url, { redirect: "manual" });
    const location = consent.headers.get("location");
    if (location === null)
      throw new Error(`The consent page did not redirect (${consent.status}).`);
    const back = new URL(location);
    step.tamper?.(back.searchParams);
    const landed = await handlers(step.returningAs ?? actor).callback(
      new Request(back.toString()),
    );
    return { landing: landed.headers.get("location") ?? "", consent: body.url };
  }

  return {
    db,
    atlassian,
    clock,
    now,
    logs,
    jira,
    workspaces,
    workspace,
    person,
    accessOf,
    handlers,
    json,
    walk,
  };
}
