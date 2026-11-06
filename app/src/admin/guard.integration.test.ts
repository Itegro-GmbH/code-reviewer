// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down who reaches the admin portal, with real requests through the real proxy and the real data
// route over a real database and the real Better Auth: a visitor without a session is sent to the
// sign-in (a page) or gets 401 (a data route); a signed in person who is not an instance admin gets
// the 404 of a path that does not exist, on every page and every data route below the portal, with any
// method, in any spelling, and also from the data route itself when the proxy is not in front; the admin
// gets in, with an unverified email address too. The routes are read from the file system, so a page or
// route added to the portal without a decision here fails the test.
// The cases that run on every route and method are in guard-visitor-routes.integration.test.ts and the
// guard-member-*.integration.test.ts files (#905: one file of 484 tests made its shard the slowest of the job); the
// routes and the harness they share are in src/test-support/admin-guard-cases.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AdminHarness } from "../test-support/admin-harness.ts";
import { concretePath } from "../test-support/routes.ts";
import {
  adminRoutes,
  isHidden,
  portalFiles,
  startPortal,
  pageRoutes,
} from "../test-support/admin-guard-cases.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the routes of the portal", () => {
  it("are found on the file system: the pages of the sections, the settings route, the test mail route, the routes of the GitHub integration and the synchronization and the routes of the model catalog and of the models.dev catalog and the page and the routes of billing", () => {
    expect(adminRoutes.map(({ route }) => route).sort()).toEqual([
      "/admin",
      "/admin/approvals",
      "/admin/billing",
      "/admin/billing/reviews",
      "/admin/catalog",
      "/admin/integrations",
      "/admin/integrations/github",
      "/admin/limits",
      "/admin/llm",
      "/admin/mail",
      "/admin/runs",
      "/admin/runs/[id]",
      "/admin/setup",
      "/admin/setup/instance",
      "/admin/setup/sign-in",
      "/admin/setup/sign-up",
      "/api/admin/approvals/[id]",
      "/api/admin/billing",
      "/api/admin/billing/check",
      "/api/admin/billing/reviews",
      "/api/admin/billing/reviews/check",
      "/api/admin/billing/reviews/resolve",
      "/api/admin/billing/webhook-endpoint",
      "/api/admin/billing/workspaces",
      "/api/admin/billing/workspaces/[id]",
      "/api/admin/billing/workspaces/[id]/credit",
      "/api/admin/catalog-fetch",
      "/api/admin/catalog-models",
      "/api/admin/catalog-models/enablement",
      "/api/admin/catalog-models/enablement/reset",
      "/api/admin/catalog-models/price/confirm",
      "/api/admin/catalog-models/price/correct",
      "/api/admin/catalog-providers/url/confirm",
      "/api/admin/github",
      "/api/admin/github/check",
      "/api/admin/github/manifest",
      "/api/admin/github/manifest/callback",
      "/api/admin/integrations/sync",
      "/api/admin/llm-keys/[provider]/test",
      "/api/admin/mail/test",
      "/api/admin/model-catalog",
      "/api/admin/model-catalog/[id]",
      "/api/admin/model-catalog/[id]/release",
      "/api/admin/model-catalog/[id]/retire",
      "/api/admin/model-catalog/check",
      "/api/admin/model-catalog/defaults",
      "/api/admin/model-catalog/order",
      "/api/admin/settings",
    ]);
  });
});

describe("the files of the portal", () => {
  it.each(portalFiles.map(({ route }) => route))(
    "are not reachable by their own address %s, not even for the admin",
    async (route) => {
      const { portal, memberCookies } = await startPortal();

      const asAdmin = await portal.visit(route, {
        cookies: portal.adminCookies,
      });
      const asMember = await portal.visit(route, { cookies: memberCookies });

      expect(isHidden(asAdmin)).toBe(true);
      expect(isHidden(asMember)).toBe(true);
    },
  );
});

describe("a visitor without a session", () => {
  // #98-AD-01
  it.each(pageRoutes.map(({ route }) => route))(
    "is sent to the sign-in from the page %s",
    async (route) => {
      const { portal } = await startPortal();

      const response = await portal.visit(concretePath(route));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
        "/login",
      );
    },
  );

  // #98-AD-01
  it("gets 401 from the data route itself when the proxy is not in front, and nothing is changed", async () => {
    const { portal } = await startPortal();

    const get = await portal.callRoute("/api/instance-portal/settings");
    const put = await portal.callRoute("/api/instance-portal/settings", {
      method: "PUT",
      body: { tenancy: "multi" },
    });

    expect([get.status, put.status]).toEqual([401, 401]);
    expect((await portal.service.readSettings()).tenancy.value).toBe("single");
  });
});

describe("a signed in person who is not an instance admin", () => {
  // #98-AD-02
  it("is handled by the proxy exactly like a person asking for a path that does not exist", async () => {
    const { portal, memberCookies } = await startPortal();

    const portalPaths = ["/admin", "/admin/setup", "/api/admin/settings"];
    const proxied = async (path: string, method = "GET") => {
      const response = await portal.askProxy(path, {
        cookies: memberCookies,
        method,
      });
      return [...response.headers].sort();
    };
    for (const method of ["GET", "POST", "PUT"])
      for (const path of portalPaths)
        expect(await proxied(path, method), `${method} ${path}`).toEqual(
          await proxied("/there-is-no-such-page", method),
        );
  });

  // #98-AD-02
  it.each([
    "/admin/",
    "/%61dmin",
    "//admin",
    "/admin//setup",
    "/admin/../admin",
    "/api//admin/settings",
    "/api/%61dmin/settings",
    "/admin/setup/anything/below",
  ])("gets the 404 for the spelling %s too", async (path) => {
    const { portal, memberCookies } = await startPortal();

    const response = await portal.visit(path, { cookies: memberCookies });

    expect(isHidden(response)).toBe(true);
  });

  // #98-AD-02
  it("gets the 404 for a Server Function posted to a portal page", async () => {
    const { portal, memberCookies } = await startPortal();

    const response = await portal.visit("/admin/setup", {
      method: "POST",
      cookies: memberCookies,
      headers: { "next-action": "00abc123", "content-type": "text/plain" },
      body: "[]",
    });

    expect(isHidden(response)).toBe(true);
  });

  // #98-AD-02
  it("gets the 404 from the data route itself when the proxy is not in front, and nothing is changed", async () => {
    const { portal, memberCookies } = await startPortal();
    const attempts = [
      { tenancy: "multi" },
      { signUp: { kind: "emails", entries: ["me@example.com"] } },
      { signInMethods: { emailPassword: true, github: false } },
      { limits: { maxWorkspacesPerUser: 99 } },
    ];

    const answers = [
      await portal.callRoute("/api/instance-portal/settings", {
        cookies: memberCookies,
      }),
      ...(await Promise.all(
        attempts.map((body) =>
          portal.callRoute("/api/instance-portal/settings", {
            method: "PUT",
            body,
            cookies: memberCookies,
          }),
        ),
      )),
    ];

    expect(answers.map((response) => response.status)).toEqual([
      404, 404, 404, 404, 404,
    ]);
    const settings = await portal.db
      .selectFrom("instance_settings")
      .selectAll()
      .execute();
    expect(settings.map((row) => row.key).sort()).toEqual([
      "setup_completed_at",
      "sign_up_rule",
      "tenancy",
    ]);
    expect((await portal.service.readSettings()).signUpRule.value).toEqual({
      kind: "everyone",
    });
  });

  it("loses access at once when the admin flag is taken away", async () => {
    const { portal } = await startPortal();
    const before = await portal.visit("/admin", {
      cookies: portal.adminCookies,
    });

    await portal.db
      .updateTable("users")
      .set({ is_instance_admin: 0 })
      .where("id", "=", portal.adminId)
      .execute();
    const after = await portal.visit("/admin", {
      cookies: portal.adminCookies,
    });
    const data = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });

    expect(isHidden(before)).toBe(false);
    expect(isHidden(after)).toBe(true);
    expect(isHidden(data)).toBe(true);
  });
});

describe("the instance admin", () => {
  async function reaches(portal: AdminHarness) {
    const page = await portal.visit("/admin/setup", {
      cookies: portal.adminCookies,
    });
    const data = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });
    return { page, data };
  }

  // #98-AD-03
  it("reaches the portal pages and the data route", async () => {
    const { portal } = await startPortal();

    const { page, data } = await reaches(portal);

    expect(await page.text()).toBe("reached");
    expect(data.status).toBe(200);
    expect(await data.json()).toMatchObject({ tenancy: { value: "single" } });
  });

  // #98-AD-19
  it("keeps access with an unverified email address while a mail server is configured, to repair it", async () => {
    const { portal } = await startPortal();
    portal.flags.mail = true;
    const row = await portal.db
      .selectFrom("users")
      .select("email_verified")
      .where("id", "=", portal.adminId)
      .executeTakeFirstOrThrow();

    const { page, data } = await reaches(portal);

    expect(row.email_verified).toBe(0);
    expect(await page.text()).toBe("reached");
    expect(data.status).toBe(200);
    expect(await data.json()).toMatchObject({ mailConfigured: true });
  });
});

describe("the synchronization with GitHub", () => {
  const SYNC = "/api/admin/integrations/sync";

  // #101-WM-08
  it("runs for the instance admin and answers with the instance-wide counts", async () => {
    const { portal } = await startPortal();

    const response = await portal.visit(SYNC, {
      method: "POST",
      cookies: portal.adminCookies,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ added: 3, errors: [] });
    expect(portal.syncCalls.count).toBe(1);
  });

  // #101-WM-08
  it("is a path that does not exist for a signed in person who does not run the instance, and does not run", async () => {
    const { portal, memberCookies } = await startPortal();

    const throughTheProxy = await portal.visit(SYNC, {
      method: "POST",
      cookies: memberCookies,
    });
    // The proxy is not in front: the route asks for the admin itself.
    const routeAlone = await portal.callRoute(
      "/api/instance-portal/integrations/sync",
      { method: "POST", cookies: memberCookies },
    );

    expect(isHidden(throughTheProxy)).toBe(true);
    expect(routeAlone.status).toBe(404);
    expect(portal.syncCalls.count).toBe(0);
  });

  // #101-WM-08
  it("answers a visitor without a session with 401 and does not run", async () => {
    const { portal } = await startPortal();

    const response = await portal.visit(SYNC, { method: "POST" });

    expect(response.status).toBe(401);
    expect(portal.syncCalls.count).toBe(0);
  });

  it("does not run for a request from another site", async () => {
    const { portal } = await startPortal();

    const response = await portal.visit(SYNC, {
      method: "POST",
      cookies: portal.adminCookies,
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });

    expect(response.status).toBe(403);
    expect(portal.syncCalls.count).toBe(0);
  });
});
