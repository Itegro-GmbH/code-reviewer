// SPDX-License-Identifier: LicenseRef-Proprietary

// The routes of the binding through the real services over a real Postgres database and the fake GitHub
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.9): how a request is read (same site, JSON only,
// a size limit, read once), who may use each route, that a Member is refused, that the two redirects of GitHub
// end on fixed pages whatever the query says, and that the counters limit every route that starts a flow or
// takes a callback.
import { describe, expect, it } from "vitest";
import {
  createBindingHarness,
  type BindingHarness,
} from "../test-support/binding-harness.ts";
import { BINDING_REQUEST_MAX_BYTES } from "./http.ts";
import type { BindingActor } from "./service.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;

function json(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://reviews.example.test/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function scene(options: Parameters<typeof createBindingHarness>[0] = {}) {
  const h = await createBindingHarness(options);
  const a = await h.workspace("a");
  const owner = await h.person("owner-a", { workspaceId: a.id, role: "owner" });
  const admin = await h.person("admin-a", { workspaceId: a.id, role: "admin" });
  const member = await h.person("member-a", {
    workspaceId: a.id,
    role: "member",
  });
  h.githubUser(1001, "octo");
  h.github.addOrgMember("acme", "octo", "active", "admin");
  h.install({ id: 4242, account: ACME }, ["acme/widgets"]);
  return { h, a, owner, admin, member };
}

async function body(response: Response): Promise<unknown> {
  return response.json();
}

async function statesIssued(h: BindingHarness): Promise<number> {
  return (await h.db.selectFrom("signed_states").selectAll().execute()).length;
}

describe("how a request is read", () => {
  // #103-IB-16
  it.each([
    [
      "a request from another site",
      { "sec-fetch-site": "cross-site" },
      403,
      "cross_site_request",
    ],
    [
      "a request from a sibling site",
      { "sec-fetch-site": "same-site" },
      403,
      "cross_site_request",
    ],
    [
      "a form encoded body",
      { "content-type": "application/x-www-form-urlencoded" },
      415,
      "unsupported_content_type",
    ],
    [
      "a plain text body",
      { "content-type": "text/plain" },
      415,
      "unsupported_content_type",
    ],
  ] as const)(
    "refuses %s for every route that reads a body, before anything is done",
    async (_name, headers, status, code) => {
      const { h, a, owner } = await scene();
      const handlers = h.handlers(owner);
      const access = h.accessOf(owner, a, "owner");

      for (const call of [
        () => handlers.connect(json({}, headers), access),
        () => handlers.startPicker(json({}, headers), access),
        () =>
          handlers.choose(
            json({ picker: "x", installationId: "4242" }, headers),
            access,
          ),
      ]) {
        const response = await call();
        expect(response.status).toBe(status);
        expect(await body(response)).toEqual({ error: code });
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      expect(await statesIssued(h)).toBe(0);
    },
  );

  // #103-IB-16
  it("refuses a body that is too large, not JSON, or not an object", async () => {
    const { h, a, owner } = await scene();
    const handlers = h.handlers(owner);
    const access = h.accessOf(owner, a, "owner");

    const tooLarge = await handlers.connect(
      json({ padding: "x".repeat(BINDING_REQUEST_MAX_BYTES) }),
      access,
    );
    const notJson = await handlers.connect(json("{nope"), access);
    const notAnObject = await handlers.connect(json("[1]"), access);

    expect(tooLarge.status).toBe(413);
    expect(await body(tooLarge)).toEqual({ error: "body_too_large" });
    expect(notJson.status).toBe(422);
    expect(notAnObject.status).toBe(422);
    expect(await statesIssued(h)).toBe(0);
  });

  // #103-IB-16
  it("refuses the end of a connection from another site", async () => {
    const { h, a, owner } = await scene();
    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });
    const [integration] = await h.integrationRows();

    const response = await h.handlers(owner).disconnect(
      new Request("https://reviews.example.test/api/x", {
        method: "DELETE",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      h.accessOf(owner, a, "owner"),
      integration?.id ?? "",
    );

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ error: "cross_site_request" });
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);
  });
});

describe("the routes that start a flow", () => {
  // #103-IB-02
  it("answers the address of the installation page of the App with a signed state, for an Owner and for an Admin", async () => {
    const { h, a, owner, admin } = await scene();

    for (const [actor, role] of [
      [owner, "owner"],
      [admin, "admin"],
    ] as const) {
      const response = await h
        .handlers(actor)
        .connect(json({}), h.accessOf(actor, a, role));
      const answer = (await body(response)) as { ok: boolean; url: string };

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const url = new URL(answer.url);
      expect(url.origin).toBe(h.github.baseUrl);
      expect(url.pathname).toBe("/apps/code-reviewer-test/installations/new");
      expect(url.searchParams.get("state")).toMatch(/^[\w-]+\.[\w-]+$/);
      // The state carries no address, and nothing else is in the query.
      expect([...url.searchParams.keys()]).toEqual(["state"]);
    }
  });

  // #103-IB-15
  it("refuses a Member on every route of the binding, and starts, links and ends nothing", async () => {
    const { h, a, owner, member } = await scene();
    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });
    const [integration] = await h.integrationRows();
    const handlers = h.handlers(member);
    const access = h.accessOf(member, a, "member");
    const before = await statesIssued(h);

    const answers = [
      await handlers.connect(json({}), access),
      await handlers.startPicker(json({}), access),
      await handlers.choose(
        json({ picker: "x", installationId: "4242" }),
        access,
      ),
      await handlers.disconnect(
        new Request("https://reviews.example.test/api/x", { method: "DELETE" }),
        access,
        integration?.id ?? "",
      ),
      await handlers.syncWorkspace(json({}), access),
    ];

    for (const response of answers) {
      expect(response.status).toBe(403);
      expect(await body(response)).toEqual({ error: "forbidden" });
    }
    expect(await statesIssued(h)).toBe(before);
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);
  });

  // #103-IB-15
  it("refuses a person who was an Owner when the request was routed but is a Member in the database", async () => {
    const { h, a, owner } = await scene();
    await h.db
      .updateTable("workspace_members")
      .set({ role: "member" })
      .where("user_id", "=", owner.id)
      .execute();

    // The access the route resolved is out of date; the service reads the membership again.
    const response = await h
      .handlers(owner)
      .connect(json({}), h.accessOf(owner, a, "owner"));

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ error: "workspace_role_required" });
    expect(await statesIssued(h)).toBe(0);
  });

  // #103-IB-22
  it("refuses Connect GitHub with its own code while the user authorization is not configured, in a multi-tenant instance", async () => {
    const { h, a, owner } = await scene({
      tenancy: "multi",
      userAuthorization: false,
    });

    const response = await h
      .handlers(owner)
      .connect(json({}), h.accessOf(owner, a, "owner"));

    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({
      error: "user_authorization_not_configured",
    });
    expect(await statesIssued(h)).toBe(0);
  });

  // #103-IB-17
  it("limits how often a person starts a flow, and says when to come back", async () => {
    const { h, a, owner } = await scene();
    const handlers = h.handlers(owner);
    const access = h.accessOf(owner, a, "owner");

    const answers: Response[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1)
      answers.push(await handlers.connect(json({}), access));

    expect(
      answers.slice(0, 10).every((response) => response.status === 200),
    ).toBe(true);
    expect(answers[10]?.status).toBe(429);
    expect(await body(answers[10] as Response)).toEqual({
      error: "rate_limited",
    });
    expect(Number(answers[10]?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  // #103-IB-02
  it("refuses a choice that is not in a list made for this person", async () => {
    const { h, a, owner } = await scene();

    const response = await h
      .handlers(owner)
      .choose(
        json({ picker: "forged", installationId: "4242" }),
        h.accessOf(owner, a, "owner"),
      );

    expect(response.status).toBe(422);
    expect(await body(response)).toEqual({ error: "picker_invalid" });
  });
});

describe("the redirects of GitHub", () => {
  async function setupRequest(
    h: BindingHarness,
    actor: BindingActor,
    workspaceId: string,
    extra: Record<string, string> = {},
  ): Promise<Request> {
    const started = await h.binding.service.startConnect(actor, workspaceId);
    if (!started.ok) throw new Error("Connect did not start");
    const back = await h.confirmInstallation(started.url, {
      installationId: 4242,
    });
    for (const [name, value] of Object.entries(extra))
      back.searchParams.set(name, value);
    return new Request(back.toString());
  }

  // #103-IB-16
  it("ignores an extra redirect or next parameter: the browser goes where the flow says, to GitHub and then to a fixed page", async () => {
    const { h, a, owner } = await scene();
    const request = await setupRequest(h, owner, a.id, {
      redirect: "https://evil.example/steal",
      next: "https://evil.example/next",
      redirect_uri: "https://evil.example/cb",
      return_to: "/admin",
    });

    const toGithub = await h.handlers(owner).setupCallback(request);

    expect(toGithub.status).toBe(302);
    expect(toGithub.headers.get("referrer-policy")).toBe("no-referrer");
    expect(toGithub.headers.get("cache-control")).toBe("no-store");
    const authorize = new URL(toGithub.headers.get("location") ?? "");
    expect(authorize.origin).toBe(h.github.baseUrl);
    expect(authorize.pathname).toBe("/login/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "https://reviews.example.test/api/auth/callback/github",
    );
    expect(toGithub.headers.get("location")).not.toContain("evil");

    const callback = await h.github.authorize(authorize.toString(), "octo");
    callback.searchParams.set("redirect", "https://evil.example/steal");
    callback.searchParams.set("next", "https://evil.example/next");
    const landed = await h
      .handlers(owner)
      .authorizationCallback(new Request(callback.toString()));

    expect(landed?.status).toBe(302);
    expect(landed?.headers.get("location")).toBe(
      "/w/a/settings/integrations?github=linked",
    );
    expect(landed?.headers.get("referrer-policy")).toBe("no-referrer");
  });

  // #103-IB-16
  it("ends on the page for no workspace when the state cannot name one the person administers", async () => {
    const { h, owner } = await scene();

    const response = await h
      .handlers(owner)
      .setupCallback(
        new Request(
          "https://reviews.example.test/github/connected?installation_id=4242&setup_action=install&state=junk&redirect=https://evil.example",
        ),
      );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/github/result?github=state_invalid",
    );
  });

  // #103-IB-10
  it("shows the wait for GitHub's approval on the connections page of the workspace", async () => {
    const { h, a, owner } = await scene();
    const started = await h.binding.service.startConnect(owner, a.id);
    if (!started.ok) throw new Error("Connect did not start");
    const back = await h.confirmInstallation(started.url, {
      installationId: 4242,
      action: "request",
    });

    const response = await h
      .handlers(owner)
      .setupCallback(new Request(back.toString()));

    expect(response.headers.get("location")).toBe(
      "/w/a/settings/integrations?github=waiting_for_github_approval",
    );
  });

  // #103-IB-17
  it("limits the callbacks of a person: after ten the answer is the page that says to wait", async () => {
    const { h, owner } = await scene();
    const handlers = h.handlers(owner);
    const junk = () =>
      new Request(
        "https://reviews.example.test/github/connected?installation_id=4242&state=junk",
      );

    const locations: Array<string | null> = [];
    for (let attempt = 0; attempt < 11; attempt += 1)
      locations.push(
        (await handlers.setupCallback(junk())).headers.get("location"),
      );

    expect(
      locations
        .slice(0, 10)
        .every((l) => l === "/github/result?github=state_invalid"),
    ).toBe(true);
    expect(locations[10]).toBe("/github/result?github=rate_limited");
  });

  // #103-IB-06
  it("sends a visitor without a session to the sign-in and does nothing", async () => {
    const { h, a, owner } = await scene();
    const request = await setupRequest(h, owner, a.id);

    const response = await h.handlers(null).setupCallback(request);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
    // The state is not used up: the person can still come back signed in.
    const again = await h.handlers(owner).setupCallback(request);
    expect(new URL(again.headers.get("location") ?? "").pathname).toBe(
      "/login/oauth/authorize",
    );
  });

  // #103-IB-06
  it("takes only the authorization states of this flow: the sign in and the linking of an identity are not its callbacks", async () => {
    const { h, a, owner } = await scene();
    const handlers = h.handlers(owner);
    const linkState = await h.binding.signedStates.issue({
      purpose: "github-link",
      userId: owner.id,
      sessionId: owner.sessionId,
    });
    const picker = await h.binding.signedStates.issue({
      purpose: "github-picker",
      userId: owner.id,
      sessionId: owner.sessionId,
      workspaceId: a.id,
    });

    for (const state of [linkState, picker, "plain-better-auth-state"])
      expect(
        await handlers.authorizationCallback(
          new Request(
            `https://reviews.example.test/api/auth/callback/github?code=c&state=${state}`,
          ),
        ),
      ).toBeNull();
    // Nor is another path or method.
    expect(
      await handlers.authorizationCallback(
        new Request(
          "https://reviews.example.test/api/auth/callback/other?state=x.y",
        ),
      ),
    ).toBeNull();
    expect(
      await handlers.authorizationCallback(
        new Request(
          "https://reviews.example.test/api/auth/callback/github?state=x.y",
          {
            method: "POST",
          },
        ),
      ),
    ).toBeNull();
  });

  // #103-IB-14
  it("is caught as a failure of the page, not an exception, when the database fails", async () => {
    const { h, owner } = await scene();
    const failing = h.handlers(owner);
    await h.db.schema.dropTable("rate_limits").execute();

    const response = await failing.setupCallback(
      new Request(
        "https://reviews.example.test/github/connected?installation_id=4242&state=a.b",
      ),
    );

    expect(response.headers.get("location")).toBe(
      "/github/result?github=unavailable",
    );
  });
});

describe("disconnecting and synchronizing through the routes", () => {
  // #103-IB-14
  it("ends a connection of the workspace, and finds none of another workspace", async () => {
    const { h, a, owner } = await scene();
    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });
    const [integration] = await h.integrationRows();
    const b = await h.workspace("b");
    const ownerB = await h.person("owner-b", {
      workspaceId: b.id,
      role: "owner",
    });
    const request = () =>
      new Request("https://reviews.example.test/api/x", { method: "DELETE" });

    const foreign = await h
      .handlers(ownerB)
      .disconnect(
        request(),
        h.accessOf(ownerB, b, "owner"),
        integration?.id ?? "",
      );
    const own = await h
      .handlers(owner)
      .disconnect(
        request(),
        h.accessOf(owner, a, "owner"),
        integration?.id ?? "",
      );

    expect(foreign.status).toBe(404);
    expect(await body(foreign)).toEqual({ error: "integration_not_found" });
    expect(own.status).toBe(200);
    expect(await body(own)).toEqual({ ok: true });
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ status: "disconnected" }),
    ]);
  });

  // #103-IB-13
  it("answers the synchronization of a workspace with its own counts and problems only", async () => {
    const { h, a, owner } = await scene();
    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });
    const b = await h.workspace("b");
    const ownerB = await h.person("owner-b", {
      workspaceId: b.id,
      role: "owner",
    });
    h.githubUser(1003, "octo2");
    h.install(
      { id: 4300, account: { login: "beta", id: 5100, type: "Organization" } },
      ["beta/app"],
    );
    h.github.addOrgMember("beta", "octo2", "active", "admin");
    await h.walk(ownerB, b.id, { installationId: 4300, githubLogin: "octo2" });
    h.github.addRepository(4242, { id: 7003, fullName: "acme/extra" });
    h.github.addRepository(4300, { id: 8003, fullName: "beta/extra" });
    h.github.fail({ pathIncludes: "/app/installations/4300", status: 503 });
    const [ownIntegration] = (await h.integrationRows()).filter(
      (row) => row.workspace_id === a.id,
    );

    const response = await h
      .handlers(owner)
      .syncWorkspace(json({}), h.accessOf(owner, a, "owner"));

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ added: 1, errors: [] });
    expect(ownIntegration).toBeDefined();
  });

  // #103-IB-17
  it("limits how often a person can press the synchronization of a workspace", async () => {
    const { h, a, owner } = await scene();
    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });
    const handlers = h.handlers(owner);
    const access = h.accessOf(owner, a, "owner");

    const statuses = [];
    for (let attempt = 0; attempt < 12; attempt += 1)
      statuses.push((await handlers.syncWorkspace(json({}), access)).status);
    const refused = await handlers.syncWorkspace(json({}), access);

    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(refused.status).toBe(429);
    expect(await body(refused)).toEqual({ error: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // The window ends: the button works again.
    h.advance(11 * 60 * 1000);
    expect((await handlers.syncWorkspace(json({}), access)).status).toBe(200);
  });

  // #103-IB-13
  it("answers a synchronization that fails with a stable code and no text of the operator, and a problem with its code only", async () => {
    const { h, a, owner } = await scene();
    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });
    const access = h.accessOf(owner, a, "owner");
    const failing = h.handlers(owner, {
      sync: {
        syncWorkspace: () =>
          Promise.reject(
            new Error("database is locked: /srv/code-reviewer/data.db"),
          ),
      },
    });

    const response = await failing.syncWorkspace(json({}), access);

    expect(response.status).toBe(503);
    expect(await body(response)).toEqual({ error: "unavailable" });

    // A problem GitHub caused reaches the page as a code, without the text written for the operator.
    h.github.fail({ pathIncludes: "/app/installations/4242", status: 503 });
    const problem = await h.handlers(owner).syncWorkspace(json({}), access);
    const answer = (await body(problem)) as {
      errors: Record<string, unknown>[];
    };
    expect(problem.status).toBe(200);
    expect(answer.errors.length).toBeGreaterThan(0);
    for (const error of answer.errors)
      expect(Object.keys(error)).toEqual(["code"]);
  });
});
