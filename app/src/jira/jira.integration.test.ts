// SPDX-License-Identifier: LicenseRef-Proprietary

// "Connect Jira" of a workspace (#1037) against a real Postgres and the fake Atlassian: the OAuth round trip and what it refuses, the
// choice of a site, the refresh of the rotating token pair before a call, a refused refresh, removing a connection, and that no token
// ever leaves the server. The route handlers and the service are the real ones.
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoRef } from "../integrations/types.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createJiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createJiraHarness } from "../test-support/jira-harness.ts";
import { JIRA_SCOPES, jiraCallbackUrl } from "./config.ts";
import { loadJiraSection } from "./ui/jira-page.ts";
import { PENDING_GRANT_TTL_MS } from "./service.ts";
import { createJiraTokens, REFRESH_MARGIN_MS } from "./tokens.ts";

const HOUR = 60 * 60 * 1000;
const SITE_A = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  url: "https://acme.atlassian.net",
  name: "acme",
};
const SITE_B = {
  id: "bbbbbbbb-0000-0000-0000-000000000002",
  url: "https://beta.atlassian.net",
  name: "beta",
};

async function setup(options: Parameters<typeof createJiraHarness>[0] = {}) {
  const h = await createJiraHarness(options);
  const ws = await h.workspace("acme");
  const owner = await h.person("owner", {
    workspaceId: ws.id,
    role: "owner",
  });
  return { h, ws, owner };
}

/** The connection a person made with one site, ready to use. */
async function connected() {
  const { h, ws, owner } = await setup({
    atlassian: { sites: [SITE_A], accessTokenSeconds: 3600 },
  });
  await h.walk(owner, ws, "owner");
  const [connection] = await h.jira.service.list(ws.id);
  if (connection === undefined) throw new Error("not connected");
  return { h, ws, owner, connection, tokens: h.jira.tokensFor(ws.id) };
}

describe("Connect Jira", () => {
  afterEach(() => vi.restoreAllMocks());

  // #1037-T01
  it("saves a connection with its site after the round trip, and sends Atlassian what a real consent page checks", async () => {
    const { h, ws, owner } = await setup({ atlassian: { sites: [SITE_A] } });

    const { landing, consent } = await h.walk(owner, ws, "owner");

    expect(landing).toBe("/w/acme/settings/integrations?jira=connected");
    const list = await h.jira.service.list(ws.id);
    expect(list).toEqual([
      expect.objectContaining({
        cloudId: SITE_A.id,
        siteUrl: SITE_A.url,
        siteName: "acme",
        accountName: "Ada Lovelace",
        status: "connected",
        errorCode: null,
      }),
    ]);
    // The consent request: the scopes, the exact callback, the audience, a state.
    const url = new URL(consent);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...JIRA_SCOPES]);
    expect(url.searchParams.get("redirect_uri")).toBe(
      jiraCallbackUrl("https://factory.example.test"),
    );
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBeTruthy();
    const exchange = h.atlassian
      .requests()
      .find((r) => r.grantType === "authorization_code");
    expect(exchange).toMatchObject({ clientAuthenticated: true, status: 200 });
    // The tokens work: the pair in the row is the one Atlassian issued.
    const call = await h.jira
      .tokensFor(ws.id)
      .request(list[0]?.id ?? "", "/rest/api/3/myself");
    expect(call.ok && call.response.status).toBe(200);
  });

  // #1037-T01
  it("refuses a wrong state before anything is asked of Atlassian, a used state, and a state of another person or session", async () => {
    const { h, ws, owner } = await setup({ atlassian: { sites: [SITE_A] } });
    const other = await h.person("other-admin", {
      workspaceId: ws.id,
      role: "admin",
    });

    const forged = await h.walk(owner, ws, "owner", {
      tamper: (q) => q.set("state", `${q.get("state") ?? ""}x`),
    });
    expect(forged.landing).toBe("/");
    const missing = await h.walk(owner, ws, "owner", {
      tamper: (q) => q.delete("state"),
    });
    expect(missing.landing).toBe("/");
    const foreign = await h.walk(owner, ws, "owner", { returningAs: other });
    expect(foreign.landing).toBe("/");
    const otherSession = await h.walk(owner, ws, "owner", {
      returningAs: { id: owner.id, sessionId: "another-browser" },
    });
    expect(otherSession.landing).toBe("/");

    expect(await h.jira.service.list(ws.id)).toEqual([]);
    expect(
      h.atlassian.requests().filter((r) => r.path === "/oauth/token"),
    ).toEqual([]);
    expect(
      h.logs.filter((line) => line.includes("state_invalid")),
    ).toHaveLength(4);

    // A state works once: replaying the callback of a finished flow does nothing more.
    let replayed = "";
    const first = await h.walk(owner, ws, "owner", {
      tamper: (q) => {
        replayed = q.toString();
      },
    });
    expect(first.landing).toContain("jira=connected");
    const again = await h
      .handlers(owner)
      .callback(
        new Request(
          `https://factory.example.test/api/jira/callback?${replayed}`,
        ),
      );
    expect(again.headers.get("location")).toBe("/");
  });

  // #1037-T01
  it("ends without a connection when the person says no, Atlassian refuses the code, is down, or the grant covers no Jira site", async () => {
    const { h, ws, owner } = await setup({ atlassian: { sites: [SITE_A] } });

    h.atlassian.denyNextConsent();
    expect((await h.walk(owner, ws, "owner")).landing).toContain(
      "jira=access_denied",
    );

    h.atlassian.failNext("/oauth/token", {
      status: 403,
      body: { error: "invalid_grant" },
    });
    expect((await h.walk(owner, ws, "owner")).landing).toContain(
      "jira=jira_authorization_refused",
    );

    h.atlassian.failNext("/oauth/token", { status: 503 });
    expect((await h.walk(owner, ws, "owner")).landing).toContain(
      "jira=jira_unreachable",
    );

    h.atlassian.setSites([]);
    expect((await h.walk(owner, ws, "owner")).landing).toContain(
      "jira=jira_no_site",
    );

    expect(await h.jira.service.list(ws.id)).toEqual([]);
  });

  // #1037-T01
  it("lets the person choose among several sites, once, for their own grant, within the wait", async () => {
    const { h, ws, owner } = await setup({
      atlassian: { sites: [SITE_A, SITE_B] },
    });
    const admin = await h.person("admin", {
      workspaceId: ws.id,
      role: "admin",
    });

    const { landing } = await h.walk(owner, ws, "owner");
    expect(landing).toBe(
      "/w/acme/settings/integrations?jira=site_choice_ready",
    );
    expect(await h.jira.service.list(ws.id)).toEqual([]);
    expect(await h.jira.service.readChoice(owner, ws.id)).toEqual([
      { cloudId: SITE_A.id, siteUrl: SITE_A.url, siteName: "acme" },
      { cloudId: SITE_B.id, siteUrl: SITE_B.url, siteName: "beta" },
    ]);
    // Another person sees no list and cannot choose from it.
    expect(await h.jira.service.readChoice(admin, ws.id)).toBeNull();
    expect(
      await h.jira.service.choose(admin, ws.id, { cloudId: SITE_A.id }),
    ).toEqual({
      ok: false,
      error: "jira_choice_invalid",
    });
    // A site that is not in the list.
    expect(
      await h.jira.service.choose(owner, ws.id, { cloudId: "elsewhere" }),
    ).toEqual({
      ok: false,
      error: "jira_choice_invalid",
    });
    expect(
      await h.jira.service.choose(owner, ws.id, { cloudId: SITE_B.id }),
    ).toEqual({ ok: true });
    expect(await h.jira.service.list(ws.id)).toEqual([
      expect.objectContaining({ cloudId: SITE_B.id, siteName: "beta" }),
    ]);
    // The grant is used up.
    expect(
      await h.jira.service.choose(owner, ws.id, { cloudId: SITE_A.id }),
    ).toEqual({
      ok: false,
      error: "jira_choice_invalid",
    });
    expect(await h.jira.service.readChoice(owner, ws.id)).toBeNull();
  });

  // #1037-T01
  it("forgets a grant that waited for the choice too long", async () => {
    const { h, ws, owner } = await setup({
      atlassian: { sites: [SITE_A, SITE_B] },
    });
    await h.walk(owner, ws, "owner");

    h.clock.time += PENDING_GRANT_TTL_MS + 1000;

    // Reading it removes it: nothing stays behind in the secrets.
    expect(await h.jira.service.readChoice(owner, ws.id)).toBeNull();
    expect(
      await h.db.selectFrom("workspace_secrets").select("name").execute(),
    ).toEqual([]);
    expect(
      await h.jira.service.choose(owner, ws.id, { cloudId: SITE_A.id }),
    ).toEqual({
      ok: false,
      error: "jira_choice_invalid",
    });
  });

  // #1037-T01
  it("stores the rotating pair of a grant in one connection only when the choice is sent twice at once", async () => {
    const { h, ws, owner } = await setup({
      atlassian: { sites: [SITE_A, SITE_B] },
    });
    await h.walk(owner, ws, "owner");

    const answers = await Promise.all([
      h.jira.service.choose(owner, ws.id, { cloudId: SITE_A.id }),
      h.jira.service.choose(owner, ws.id, { cloudId: SITE_B.id }),
      h.jira.service.choose(owner, ws.id, { cloudId: SITE_A.id }),
    ]);

    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.filter((a) => !a.ok)).toEqual([
      { ok: false, error: "jira_choice_invalid" },
      { ok: false, error: "jira_choice_invalid" },
    ]);
    // One pair, one row: the other site would have shared a refresh token that dies with the first use.
    expect(await h.jira.service.list(ws.id)).toHaveLength(1);
    expect(
      await h.db.selectFrom("workspace_secrets").select("name").execute(),
    ).toEqual([]);
  });

  // #1037-T01
  it("keeps the waiting grant when the connection could not be stored", async () => {
    const { h, ws, owner } = await setup({
      atlassian: { sites: [SITE_A, SITE_B] },
    });
    await h.walk(owner, ws, "owner");
    const failing = vi.spyOn(h.db, "insertInto").mockImplementationOnce(() => {
      throw new Error("database down");
    });

    await expect(
      h.jira.service.choose(owner, ws.id, { cloudId: SITE_A.id }),
    ).rejects.toThrow("database down");
    failing.mockRestore();

    expect(await h.jira.service.readChoice(owner, ws.id)).toHaveLength(2);
    expect(
      await h.jira.service.choose(owner, ws.id, { cloudId: SITE_A.id }),
    ).toEqual({ ok: true });
  });

  // #1037-T01
  it("connects a site again in place, and mends a broken connection by reconnecting it", async () => {
    const { h, ws, owner, connection, tokens } = await connected();
    h.atlassian.revokeGrants();
    h.clock.time += 2 * HOUR;
    expect(await tokens.use(connection.id)).toMatchObject({
      ok: false,
      brokenCode: "jira_refresh_refused",
    });

    // Reconnect names the connection; the grant must cover its site.
    h.atlassian.setSites([SITE_B]);
    expect(
      (await h.walk(owner, ws, "owner", { connectionId: connection.id }))
        .landing,
    ).toContain("jira=jira_site_mismatch");
    expect((await h.jira.service.list(ws.id))[0]?.status).toBe("broken");

    h.atlassian.setSites([SITE_A]);
    expect(
      (await h.walk(owner, ws, "owner", { connectionId: connection.id }))
        .landing,
    ).toContain("jira=reconnected");
    const [mended] = await h.jira.service.list(ws.id);
    expect(mended).toMatchObject({
      id: connection.id,
      status: "connected",
      errorCode: null,
    });
    const call = await tokens.request(connection.id, "/rest/api/3/myself");
    expect(call.ok && call.response.status).toBe(200);

    // Connecting the same site without naming the connection renews it as well, and makes no second one.
    expect((await h.walk(owner, ws, "owner")).landing).toContain(
      "jira=connected",
    );
    expect(await h.jira.service.list(ws.id)).toHaveLength(1);

    expect(
      await h.jira.service.startConnect(owner, ws.id, {
        connectionId: "unknown",
      }),
    ).toEqual({ ok: false, error: "jira_connection_not_found" });
  });

  // #1037
  it("lets only an Owner or Admin connect, also when the role is lost on the way, and is off without the settings", async () => {
    const { h, ws, owner } = await setup({ atlassian: { sites: [SITE_A] } });
    const member = await h.person("member", {
      workspaceId: ws.id,
      role: "member",
    });

    const asMember = await h
      .handlers(member)
      .connect(h.json({}), h.accessOf(member, ws, "member"));
    expect(asMember.status).toBe(403);
    expect(await h.jira.service.startConnect(member, ws.id)).toEqual({
      ok: false,
      error: "workspace_role_required",
    });

    // The role is read again at the callback: a person who stopped being an admin in the meantime connects nothing.
    const demoted = await h.person("soon-member", {
      workspaceId: ws.id,
      role: "admin",
    });
    const started = await h.jira.service.startConnect(demoted, ws.id);
    if (!started.ok) throw new Error("not started");
    const back =
      (await fetch(started.url, { redirect: "manual" })).headers.get(
        "location",
      ) ?? "";
    await h.db
      .deleteFrom("workspace_members")
      .where("user_id", "=", demoted.id)
      .execute();
    const landed = await h.handlers(demoted).callback(new Request(back));
    expect(landed.headers.get("location")).toBe("/");
    expect(await h.jira.service.list(ws.id)).toEqual([]);
    expect(
      h.atlassian.requests().filter((r) => r.path === "/oauth/token"),
    ).toEqual([]);
    void owner;

    const off = await createJiraHarness({ unconfigured: true });
    const offWs = await off.workspace("off");
    const offOwner = await off.person("o", {
      workspaceId: offWs.id,
      role: "owner",
    });
    const refused = await off
      .handlers(offOwner)
      .connect(off.json({}), off.accessOf(offOwner, offWs, "owner"));
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "jira_not_configured" });
  });
});

describe("a connection's tokens", () => {
  // #1037-T02
  it("refreshes an access token that ends soon before the call, and stores the rotated pair", async () => {
    const { h, ws, connection, tokens } = await connected();
    const before = await createJiraConnectionsRepository(
      h.db,
      ws.id,
    ).readTokens(connection.id);

    // Still good: no refresh.
    h.clock.time += HOUR - REFRESH_MARGIN_MS - 1000;
    expect((await tokens.request(connection.id, "/rest/api/3/myself")).ok).toBe(
      true,
    );
    expect(h.atlassian.refreshes()).toBe(0);

    // Inside the margin: renewed first, then the call goes out with the new token.
    h.clock.time += 2000;
    const call = await tokens.request(connection.id, "/rest/api/3/myself");
    expect(call.ok && call.response.status).toBe(200);
    expect(h.atlassian.refreshes()).toBe(1);
    const after = await createJiraConnectionsRepository(h.db, ws.id).readTokens(
      connection.id,
    );
    expect(after?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1);
    expect(after?.sealed.ciphertext).not.toBe(before?.sealed.ciphertext);
    expect(after?.connection.accessExpiresAt).toBe(
      new Date(h.clock.time + HOUR).toISOString(),
    );
    expect(after?.connection.status).toBe("connected");

    // The new pair lasts: the next call does not refresh again.
    expect((await tokens.request(connection.id, "/rest/api/3/myself")).ok).toBe(
      true,
    );
    expect(h.atlassian.refreshes()).toBe(1);
    const calls = h.atlassian
      .requests()
      .filter((r) => r.path.startsWith("/ex/jira/"));
    expect(calls.every((r) => r.bearerLive === true && r.status === 200)).toBe(
      true,
    );
  });

  // #1037-T02
  it("renews a token Atlassian ended early and repeats the call once", async () => {
    const { h, connection, tokens } = await connected();

    h.atlassian.expireAccessTokens();
    const call = await tokens.request(connection.id, "/rest/api/3/myself");

    expect(call.ok && call.response.status).toBe(200);
    expect(h.atlassian.refreshes()).toBe(1);
    const jiraCalls = h.atlassian
      .requests()
      .filter((r) => r.path.startsWith("/ex/jira/"));
    expect(jiraCalls.map((r) => r.status)).toEqual([401, 200]);
  });

  // #1037-T02
  it("marks the connection broken with a stable code when the refresh is refused, and calls Atlassian no more", async () => {
    const { h, ws, connection, tokens } = await connected();
    h.atlassian.revokeGrants();
    h.clock.time += 2 * HOUR;

    const refused = await tokens.request(connection.id, "/rest/api/3/myself");

    expect(refused).toEqual({
      ok: false,
      error: "jira_connection_broken",
      brokenCode: "jira_refresh_refused",
    });
    expect(await h.jira.service.list(ws.id)).toEqual([
      expect.objectContaining({
        id: connection.id,
        status: "broken",
        errorCode: "jira_refresh_refused",
      }),
    ]);
    expect(h.logs.join("\n")).toContain("jira_refresh_refused");
    const tokenCalls = h.atlassian
      .requests()
      .filter((r) => r.grantType === "refresh_token").length;
    expect(
      await tokens.request(connection.id, "/rest/api/3/myself"),
    ).toMatchObject({
      ok: false,
      error: "jira_connection_broken",
    });
    expect(
      h.atlassian.requests().filter((r) => r.grantType === "refresh_token"),
    ).toHaveLength(tokenCalls);
  });

  // #1037-T02
  it("keeps the connection when the refresh could not be made, and tries again at the next call", async () => {
    const { h, ws, connection, tokens } = await connected();
    h.clock.time += 2 * HOUR;

    h.atlassian.failNext("/oauth/token", { status: 503 });
    expect(await tokens.request(connection.id, "/rest/api/3/myself")).toEqual({
      ok: false,
      error: "jira_unavailable",
    });
    expect((await h.jira.service.list(ws.id))[0]?.status).toBe("connected");

    expect((await tokens.request(connection.id, "/rest/api/3/myself")).ok).toBe(
      true,
    );
  });

  // #1037-T02
  it("does not break the connection when two calls refresh at the same time: the first pair wins", async () => {
    const { h, ws, connection, tokens } = await connected();
    h.clock.time += 2 * HOUR;

    const results = await Promise.all([
      tokens.request(connection.id, "/rest/api/3/myself"),
      tokens.request(connection.id, "/rest/api/3/myself"),
      tokens.request(connection.id, "/rest/api/3/myself"),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect((await h.jira.service.list(ws.id))[0]).toMatchObject({
      status: "connected",
      errorCode: null,
    });
  });

  // #1037-T02
  it("does not break a connection a process with another APP_SECRET cannot read, and says so to the operator", async () => {
    const { h, ws, connection, tokens } = await connected();
    const other = createJiraTokens({
      repository: createJiraConnectionsRepository(h.db, ws.id),
      client: {} as never,
      appSecret: "another-master-key-of-at-least-32-chars!!",
      now: h.now,
      log: h.logs.push.bind(h.logs),
    });

    expect(await other.use(connection.id)).toEqual({
      ok: false,
      error: "jira_unavailable",
    });

    expect((await h.jira.service.list(ws.id))[0]).toMatchObject({
      status: "connected",
      errorCode: null,
    });
    expect(h.logs.join("\n")).toContain("JIRA_TOKENS_UNREADABLE");
    expect(h.logs.join("\n")).not.toContain("JIRA_CONNECTION_BROKEN");
    // The process with the right key still uses it.
    expect((await tokens.use(connection.id)).ok).toBe(true);
  });

  // #1037-T02
  it("does not break any connection when the operator set a wrong client secret, and tells the operator", async () => {
    const { h, ws, connection, tokens } = await connected();
    h.clock.time += 2 * HOUR;
    h.env.ATLASSIAN_CLIENT_SECRET = "a-wrong-secret-of-the-operator";

    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(await tokens.request(connection.id, "/rest/api/3/myself")).toEqual(
        { ok: false, error: "jira_unavailable" },
      );

    expect((await h.jira.service.list(ws.id))[0]).toMatchObject({
      status: "connected",
      errorCode: null,
    });
    const log = h.logs.join("\n");
    expect(log).toContain("JIRA_TOKEN_ENDPOINT_REJECTED");
    expect(log).not.toContain("JIRA_CONNECTION_BROKEN");
    expect(log).not.toContain("a-wrong-secret-of-the-operator");
    // The setting is mended: the same pair works, nothing had been used up.
    h.env.ATLASSIAN_CLIENT_SECRET = h.atlassian.clientSecret;
    expect((await tokens.request(connection.id, "/rest/api/3/myself")).ok).toBe(
      true,
    );
  });

  // #1037-T02
  it("refreshes one at a time: a call that waits for the refresh in progress uses the pair it stored", async () => {
    const { h, ws, connection, tokens } = await connected();
    h.clock.time += 2 * HOUR;
    const hold = h.atlassian.holdNextRefresh();
    const refreshRequests = () =>
      h.atlassian.requests().filter((r) => r.grantType === "refresh_token");
    const waitingForRowLock = async () =>
      (
        await sql<{ n: number }>`
          select count(*)::int as n from pg_stat_activity
          where pid <> pg_backend_pid() and datname = current_database()
            and wait_event_type = 'Lock' and query like '%jira_connections%'`.execute(
          h.db,
        )
      ).rows[0]?.n ?? 0;

    // The first call refreshes; Atlassian has used its refresh token up but its answer is held back.
    const winner = tokens.request(connection.id, "/rest/api/3/myself");
    await hold.arrived;
    // The second call needs a refresh too: it waits for the first (without the lock it would send the used-up token, be refused, and
    // the connection would be marked broken).
    const loser = tokens.request(connection.id, "/rest/api/3/myself");
    await vi.waitFor(
      async () =>
        expect(
          (await waitingForRowLock()) > 0 || refreshRequests().length > 1,
        ).toBe(true),
      { timeout: 5000, interval: 25 },
    );
    hold.release();

    const [first, second] = await Promise.all([winner, loser]);

    expect(first.ok && first.response.status).toBe(200);
    expect(second.ok && second.response.status).toBe(200);
    expect(refreshRequests()).toHaveLength(1);
    expect((await h.jira.service.list(ws.id))[0]).toMatchObject({
      status: "connected",
      errorCode: null,
    });
    expect(h.logs.join("\n")).not.toContain("JIRA_CONNECTION_BROKEN");
    const calls = h.atlassian
      .requests()
      .filter((r) => r.path.startsWith("/ex/jira/"));
    expect(calls.map((r) => r.status)).toEqual([200, 200]);
    expect(h.atlassian.refreshes()).toBe(1);
  });

  // #1037-T02
  it("refuses a connection of another workspace as not found", async () => {
    const { h, connection } = await connected();
    const other = await h.workspace("other");

    expect(await h.jira.tokensFor(other.id).use(connection.id)).toEqual({
      ok: false,
      error: "jira_connection_not_found",
    });
  });
});

describe("removing a connection", () => {
  async function projectUsing(
    h: Awaited<ReturnType<typeof setup>>["h"],
    workspaceId: string,
    connectionId: string,
    fullName: string,
  ) {
    const integration = await createIntegrationsRepository(
      h.db,
      workspaceId,
    ).create({
      type: "github_app",
      displayName: "acme",
      externalId: `ext-${fullName}`,
      config: {},
    });
    const remote: RepoRef = {
      integrationId: integration.id,
      externalId: fullName,
      fullName,
      url: `https://github.test/${fullName}`,
    };
    const repositories = createRepositoriesRepository(h.db, workspaceId);
    await repositories.reconcile(integration.id, [remote]);
    const [repository] = await repositories.list();
    if (repository === undefined) throw new Error("seeding failed");
    const activated = await createProjectsRepository(
      h.db,
      workspaceId,
    ).activate(repository.id);
    if (activated.kind !== "activated") throw new Error("seeding failed");
    await h.db
      .updateTable("projects")
      .set({
        ticket_source: JSON.stringify({
          provider: "jira",
          connectionId,
          jiraProject: "CR",
        }),
      })
      .where("id", "=", activated.project.id)
      .execute();
    return activated.project.id;
  }

  // #1037-T03
  it("is refused while a project uses the connection, with the project named, and works once it does not", async () => {
    const { h, ws, owner, connection } = await connected();
    const projectId = await projectUsing(h, ws.id, connection.id, "acme/api");
    const access = h.accessOf(owner, ws, "owner");

    const refused = await h
      .handlers(owner)
      .remove(
        new Request("https://factory.example.test/x", { method: "DELETE" }),
        access,
        connection.id,
      );

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "jira_connection_in_use",
      projects: [{ id: projectId, name: "acme/api" }],
    });
    expect(await h.jira.service.list(ws.id)).toHaveLength(1);

    await h.db
      .updateTable("projects")
      .set({ ticket_source: null })
      .where("id", "=", projectId)
      .execute();
    const removed = await h
      .handlers(owner)
      .remove(
        new Request("https://factory.example.test/x", { method: "DELETE" }),
        access,
        connection.id,
      );
    expect(removed.status).toBe(200);
    expect(await h.jira.service.list(ws.id)).toEqual([]);
    expect(
      await h
        .handlers(owner)
        .remove(
          new Request("https://factory.example.test/x", { method: "DELETE" }),
          access,
          connection.id,
        ),
    ).toMatchObject({ status: 404 });
  });

  // #1037-T03
  it("is for an Owner or Admin and for the workspace's own connections only", async () => {
    const { h, ws, connection } = await connected();
    const member = await h.person("member", {
      workspaceId: ws.id,
      role: "member",
    });
    const other = await h.workspace("other");
    const stranger = await h.person("stranger", {
      workspaceId: other.id,
      role: "owner",
    });
    const request = () =>
      new Request("https://factory.example.test/x", { method: "DELETE" });

    expect(
      (
        await h
          .handlers(member)
          .remove(request(), h.accessOf(member, ws, "member"), connection.id)
      ).status,
    ).toBe(403);
    expect(
      (
        await h
          .handlers(stranger)
          .remove(
            request(),
            h.accessOf(stranger, other, "owner"),
            connection.id,
          )
      ).status,
    ).toBe(404);
    expect(await h.jira.service.list(ws.id)).toHaveLength(1);
  });
});

describe("secrets", () => {
  // #1037-T04
  it("never leave the server: no answer, redirect, row, state or log line holds a token, the code or the client secret", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (name) => vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    const { h, ws, owner } = await setup({
      atlassian: { sites: [SITE_A, SITE_B] },
    });
    const seen: string[] = [];
    const record = async (response: Response) => {
      seen.push(
        JSON.stringify([...response.headers.entries()]),
        await response.clone().text(),
      );
      return response;
    };

    // The whole life of a connection: connect, choose, call, refresh, break, reconnect, list, remove.
    const start = await record(
      await h
        .handlers(owner)
        .connect(h.json({}), h.accessOf(owner, ws, "owner")),
    );
    const url = ((await start.json()) as { url: string }).url;
    seen.push(url);
    const consent = await fetch(url, { redirect: "manual" });
    const callbackUrl = consent.headers.get("location") ?? "";
    seen.push(
      (
        await record(await h.handlers(owner).callback(new Request(callbackUrl)))
      ).headers.get("location") ?? "",
    );
    await record(
      await h
        .handlers(owner)
        .choose(h.json({ cloudId: SITE_A.id }), h.accessOf(owner, ws, "owner")),
    );
    const listed = await record(
      await h
        .handlers(owner)
        .list(
          new Request("https://factory.example.test/x"),
          h.accessOf(owner, ws, "owner"),
        ),
    );
    const id =
      ((await listed.json()) as { connections: { id: string }[] })
        .connections[0]?.id ?? "";
    const tokens = h.jira.tokensFor(ws.id);
    seen.push(JSON.stringify(await tokens.use(id)));
    h.clock.time += 2 * HOUR;
    await tokens.request(id, "/rest/api/3/myself");
    h.atlassian.revokeGrants();
    h.clock.time += 2 * HOUR;
    seen.push(JSON.stringify(await tokens.request(id, "/rest/api/3/myself")));
    await record(
      await h
        .handlers(owner)
        .list(
          new Request("https://factory.example.test/x"),
          h.accessOf(owner, ws, "owner"),
        ),
    );
    // A refusal and a replayed callback too.
    await record(
      await h
        .handlers(owner)
        .choose(h.json({ cloudId: "none" }), h.accessOf(owner, ws, "owner")),
    );
    seen.push(
      (await h.handlers(owner).callback(new Request(callbackUrl))).headers.get(
        "location",
      ) ?? "",
    );

    // What the server keeps: every column of every Jira row and state row, and the secrets table.
    const rows = await sql`select * from jira_connections`.execute(h.db);
    const states = await sql`select * from signed_states`.execute(h.db);
    const secrets = await sql`select * from workspace_secrets`.execute(h.db);
    seen.push(JSON.stringify([rows.rows, states.rows, secrets.rows]));
    seen.push(...h.logs);
    for (const spy of spies) seen.push(JSON.stringify(spy.mock.calls));

    const text = seen.join("\n");
    const secretsOfTheRun = [
      ...h.atlassian.issuedTokens(),
      h.atlassian.clientSecret,
      new URL(callbackUrl).searchParams.get("code") ?? "no-code",
    ];
    expect(h.atlassian.issuedTokens().length).toBeGreaterThanOrEqual(4);
    for (const secret of secretsOfTheRun) expect(text).not.toContain(secret);
    // The start of the address of a state is ours to show, the value of a use of a connection prints as a placeholder.
    expect(seen.join("")).toContain("[secret]");
  });
});

describe("the Jira card's data", () => {
  // #1037
  it("holds the connections, the waiting choice for the person who made it, and the notice of the flow that just ended", async () => {
    const { h, ws, owner } = await setup({
      atlassian: { sites: [SITE_A, SITE_B] },
    });
    const admin = await h.person("admin", {
      workspaceId: ws.id,
      role: "admin",
    });
    await h.walk(owner, ws, "owner");
    const load = (
      actor: typeof owner | null,
      canManage: boolean,
      jira?: string,
    ) =>
      loadJiraSection({
        service: h.jira.service,
        workspaceId: ws.id,
        actor,
        canManage,
        implementer: true,
        query: { jira },
      });

    const mine = await load(owner, true, "site_choice_ready");
    expect(mine.configured).toBe(true);
    expect(mine.connections).toEqual([]);
    expect(mine.choices?.map((c) => c.siteName)).toEqual(["acme", "beta"]);
    expect(mine.notice?.tone).toBe("info");
    // Another admin, a member and a page without a session see no choice; an unknown code says nothing.
    expect((await load(admin, true)).choices).toBeNull();
    expect((await load(owner, false)).choices).toBeNull();
    expect((await load(null, true)).choices).toBeNull();
    expect((await load(owner, true, "<script>")).notice).toBeNull();
    // Nothing in the data is a token.
    expect(JSON.stringify(mine)).not.toMatch(/token/i);
  });

  // #1037
  it("says the feature is not configured where the Atlassian settings are missing", async () => {
    const off = await createJiraHarness({ unconfigured: true });
    const ws = await off.workspace("off");

    const data = await loadJiraSection({
      service: off.jira.service,
      workspaceId: ws.id,
      actor: null,
      canManage: true,
      implementer: true,
      query: {},
    });

    expect(data).toMatchObject({
      configured: false,
      connections: [],
      choices: null,
    });
  });

  // #1037
  it("reads nothing where the deployment has no implementer capability or no Atlassian settings", async () => {
    const { h, ws, owner } = await setup({
      atlassian: { sites: [SITE_A, SITE_B] },
    });
    await h.walk(owner, ws, "owner");
    const list = vi.spyOn(h.jira.service, "list");
    const readChoice = vi.spyOn(h.jira.service, "readChoice");

    const withoutCapability = await loadJiraSection({
      service: h.jira.service,
      workspaceId: ws.id,
      actor: owner,
      canManage: true,
      implementer: false,
      query: { jira: "site_choice_ready" },
    });
    expect(withoutCapability).toEqual({
      configured: false,
      connections: [],
      choices: null,
      notice: null,
    });

    const off = await createJiraHarness({ unconfigured: true });
    const offList = vi.spyOn(off.jira.service, "list");
    await loadJiraSection({
      service: off.jira.service,
      workspaceId: ws.id,
      actor: owner,
      canManage: true,
      implementer: true,
      query: {},
    });

    expect(list).not.toHaveBeenCalled();
    expect(readChoice).not.toHaveBeenCalled();
    expect(offList).not.toHaveBeenCalled();
  });
});
