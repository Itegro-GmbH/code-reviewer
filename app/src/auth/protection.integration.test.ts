// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down who gets in: the access proxy in front of every route, driven with real requests
// against a real Better Auth instance and a real Postgres database. Without a valid session a page sends
// the person to the login page and a data route answers 401; a signed out, expired or forged
// session counts as no session. The route list is read from the file system, so a route added
// without deciding here whether it is public makes the test fail (default deny).
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type CookieJar,
} from "../test-support/auth-harness.ts";
import { concretePath, discoverRoutes } from "../test-support/routes.ts";
import { createAccessProxy } from "./access-proxy.ts";
import { noWorkspaceGates, openGates } from "../test-support/open-gates.ts";

// Every route of the app and whether it needs a session. A new route must be added here.
const PUBLIC_ROUTES = [
  "/login",
  "/api/health",
  // The first-run setup: protected by the setup code and the setup session, and gone (404) once the
  // instance is set up (src/setup/gate.ts).
  "/setup",
  "/api/setup/code",
  "/api/setup/complete",
  "/api/auth/[...all]",
  // A reset link carries its own credential, the token (src/auth/password-reset-http.ts).
  "/reset-password",
  "/api/password-reset",
  // Asking for a reset link by mail: no session yet (src/auth/password-reset-request-http.ts).
  "/forgot-password",
  "/api/password-reset/request",
  // Signing up and verifying an address: no session yet (src/signup/http.ts).
  "/sign-up",
  "/api/sign-up",
  "/verify-email",
  "/api/verify-email",
  "/api/verify-email/resend",
  // An invitation link: whoever holds it opens the page, which only shows what the invitation is about;
  // accepting is a POST that needs a session (src/workspaces/README.md).
  "/invitation",
  // GitHub signs its deliveries; the route checks the signature itself (src/webhooks/README.md).
  "/api/webhooks/github-app",
  // A payment provider signs its webhooks; the route asks the active adapter to check the signature (#497).
  "/api/billing/webhook",
  // The runner sends its own shared token (src/runner-api/README.md).
  "/api/runners/v1/claim",
  "/api/runners/v1/jobs/[id]/heartbeat",
  "/api/runners/v1/jobs/[id]/complete",
  // A Dispatcher gives a job back and reads the version with the same token (#322).
  "/api/runners/v1/jobs/[id]/release",
  // A Dispatcher reports the VM it created with the same token and the job credential in the body (#493).
  "/api/runners/v1/jobs/[id]/vm",
  "/api/runners/v1/version",
  // A Dispatcher reads the status of a job with the same token (#364).
  "/api/runners/v1/jobs/[id]",
  // A Worker sends the per-job credential of its claim (src/runner-api/README.md, #320).
  "/api/workers/v1/jobs/[id]",
  "/api/workers/v1/jobs/[id]/heartbeat",
  "/api/workers/v1/jobs/[id]/result",
  // The operator sends its own bearer token; the routes do not exist until it is set (src/operator-api/README.md).
  "/api/operator/v1/workspaces",
  "/api/operator/v1/workspaces/[id]/entitlements",
  "/api/operator/v1/workspaces/[id]/usage",
  "/api/operator/v1/workspaces/[id]/usage/summary",
  "/api/operator/v1/usage",
  "/api/operator/v1/usage/unknown-cost",
  "/api/operator/v1/entitlements/default",
  "/api/operator/v1/plan-management",
  "/api/operator/v1/handoff/redeem",
  "/api/operator/v1/[...path]",
  // The platform's cron sends CRON_SECRET; the route is a 404 outside serverless mode (src/cron/, #319).
  "/api/internal/repository-sync",
  // The same cron, once a minute: the sweep of a hosted deployment, a 404 outside serverless mode (#328).
  "/api/internal/dispatch-sweep",
] as const;
const PROTECTED_ROUTES = [
  "/",
  // The files of the admin portal; people use /admin, which is rewritten to them for the instance admin
  // and does not exist for anybody else (src/admin/guard.integration.test.ts).
  "/instance-portal",
  "/instance-portal/approvals",
  "/instance-portal/billing",
  "/instance-portal/billing/reviews",
  "/instance-portal/catalog",
  "/instance-portal/integrations",
  "/instance-portal/integrations/github",
  "/instance-portal/limits",
  "/instance-portal/llm",
  "/instance-portal/mail",
  "/instance-portal/runs",
  "/instance-portal/runs/[id]",
  "/instance-portal/setup",
  "/instance-portal/setup/instance",
  "/instance-portal/setup/sign-in",
  "/instance-portal/setup/sign-up",
  "/account",
  // The binding of a GitHub installation to a workspace: where GitHub sends the browser after an installation
  // (the Setup URL of the App; a route that redirects) and where a flow ends when no workspace can be named
  // (src/installation-binding/).
  "/github/connected",
  "/github/result",
  // The old addresses of the pages, which lead to the first workspace of the person.
  "/projects/[[...rest]]",
  "/runs/[[...rest]]",
  "/settings",
  // A person without a workspace reaches these (src/auth/access.ts, NO_WORKSPACE_PATHS).
  "/no-access",
  "/invitations",
  "/workspaces/new",
  // The pages of a workspace: for its members only (src/workspaces/access-runtime.ts).
  "/w/[workspace]",
  "/w/[workspace]/connections",
  "/w/[workspace]/implementer",
  "/w/[workspace]/members",
  "/w/[workspace]/projects",
  "/w/[workspace]/projects/[repositoryId]",
  "/w/[workspace]/runs",
  "/w/[workspace]/runs/[id]",
  "/w/[workspace]/settings",
  "/w/[workspace]/settings/advanced",
  "/w/[workspace]/settings/billing",
  "/w/[workspace]/settings/llm",
  "/w/[workspace]/settings/plan",
  "/w/[workspace]/settings/review-defaults",
] as const;
// Data routes: a visitor without a session gets 401 instead of a redirect.
const PROTECTED_DATA_ROUTES = [
  "/api/account/github/link",
  "/api/instance-portal/approvals/[id]",
  "/api/instance-portal/billing",
  "/api/instance-portal/billing/check",
  "/api/instance-portal/billing/reviews",
  "/api/instance-portal/billing/reviews/check",
  "/api/instance-portal/billing/reviews/resolve",
  "/api/instance-portal/billing/webhook-endpoint",
  "/api/instance-portal/billing/workspaces",
  "/api/instance-portal/billing/workspaces/[id]",
  "/api/instance-portal/billing/workspaces/[id]/credit",
  "/api/instance-portal/catalog-fetch",
  "/api/instance-portal/settings",
  "/api/instance-portal/mail/test",
  "/api/instance-portal/llm-keys/[provider]/test",
  "/api/instance-portal/catalog-models",
  "/api/instance-portal/catalog-models/enablement",
  "/api/instance-portal/catalog-models/enablement/reset",
  "/api/instance-portal/catalog-models/price/confirm",
  "/api/instance-portal/catalog-models/price/correct",
  "/api/instance-portal/catalog-providers/url/confirm",
  "/api/instance-portal/model-catalog",
  "/api/instance-portal/model-catalog/[id]",
  "/api/instance-portal/model-catalog/[id]/release",
  "/api/instance-portal/model-catalog/[id]/retire",
  "/api/instance-portal/model-catalog/check",
  "/api/instance-portal/model-catalog/defaults",
  "/api/instance-portal/model-catalog/order",
  "/api/instance-portal/github",
  "/api/instance-portal/github/check",
  "/api/instance-portal/github/manifest",
  "/api/instance-portal/github/manifest/callback",
  "/api/instance-portal/integrations/sync",
  // Not about one workspace: creating one, accepting an invitation (src/auth/access.ts, NO_WORKSPACE_PATHS).
  "/api/workspaces",
  "/api/invitations/accept",
  // The data routes of a workspace: for its members only (src/workspaces/access-runtime.ts).
  "/api/w/[workspace]",
  "/api/w/[workspace]/billing/invoices",
  "/api/w/[workspace]/billing/journal",
  "/api/w/[workspace]/billing/monthly-limit",
  "/api/w/[workspace]/billing/profile",
  "/api/w/[workspace]/billing/top-ups",
  "/api/w/[workspace]/billing/top-ups/[id]/check",
  "/api/w/[workspace]/github/connect",
  "/api/w/[workspace]/github/installations",
  "/api/w/[workspace]/github/installations/choose",
  // The routes behind the Implementer form (#755).
  "/api/w/[workspace]/implementer/models",
  "/api/w/[workspace]/implementer/repositories",
  "/api/w/[workspace]/implementer/repositories/[repositoryId]/branches",
  "/api/w/[workspace]/implementer/tasks",
  "/api/w/[workspace]/integrations/[integrationId]",
  "/api/w/[workspace]/integrations/sync",
  "/api/w/[workspace]/invitations",
  "/api/w/[workspace]/invitations/[invitationId]",
  "/api/w/[workspace]/invitations/[invitationId]/resend",
  // The models of one catalog provider for the picker of the project settings (#555).
  "/api/w/[workspace]/llm-catalog/[provider]/models",
  "/api/w/[workspace]/llm-key",
  "/api/w/[workspace]/llm-key-mode",
  "/api/w/[workspace]/llm-key/test",
  "/api/w/[workspace]/llm-keys/[provider]",
  "/api/w/[workspace]/llm-keys/[provider]/test",
  "/api/w/[workspace]/plan",
  "/api/w/[workspace]/plan-handoff",
  "/api/w/[workspace]/members/[userId]",
  "/api/w/[workspace]/repositories/[repositoryId]/project",
  "/api/w/[workspace]/repositories/[repositoryId]/project/settings",
  "/api/w/[workspace]/repositories/[repositoryId]/pull-requests",
  "/api/w/[workspace]/repositories/[repositoryId]/reviews",
  "/api/w/[workspace]/review-settings",
  "/api/w/[workspace]/runs",
  "/api/w/[workspace]/runs/[id]",
] as const;
// Files the proxy matcher leaves out on purpose (src/proxy.ts), so no session rule applies to them.
const OUTSIDE_THE_PROXY = [
  "/favicon.ico",
  "/icon.svg",
  "/apple-icon.png",
] as const;

async function createGuardedApp() {
  const harness = await createAuthHarness();
  const proxy = createAccessProxy({
    getAuth: () => harness.auth,
    getGates: () => openGates,
  });
  function visit(path: string, cookies?: CookieJar, method = "GET") {
    const headers = new Headers();
    if (cookies && cookies.size > 0)
      headers.set("cookie", cookieHeader(cookies));
    return proxy(
      new NextRequest(`${TEST_BASE_URL}${path}`, { method, headers }),
    );
  }
  return { ...harness, visit };
}

function passesThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a request without a session", () => {
  // CR-18-T07
  it("knows every route of the app as either public or protected", () => {
    const known = [
      ...PUBLIC_ROUTES,
      ...PROTECTED_ROUTES,
      ...PROTECTED_DATA_ROUTES,
      ...OUTSIDE_THE_PROXY,
    ].sort();

    expect(discoverRoutes().map(({ route }) => route)).toEqual(known);
  });

  // CR-18-T07
  it.each(PROTECTED_ROUTES)(
    "is sent to the login page for the page %s",
    async (route) => {
      const app = await createGuardedApp();

      const response = await app.visit(concretePath(route));

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
    },
  );

  // CR-18-T07
  it.each(PROTECTED_DATA_ROUTES)(
    "is answered with 401 for the data route %s",
    async (route) => {
      const app = await createGuardedApp();

      const response = await app.visit(concretePath(route), undefined, "PUT");

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    },
  );

  // CR-18-T07
  it.each(PUBLIC_ROUTES)("may open the public route %s", async (route) => {
    const app = await createGuardedApp();

    const response = await app.visit(concretePath(route), undefined, "POST");

    expect(passesThrough(response)).toBe(true);
  });

  // CR-18-T07
  it("may open the paths of the runner and the webhooks, which carry their own authentication", async () => {
    const app = await createGuardedApp();

    for (const path of [
      "/api/runners/v1/claim",
      "/api/workers/v1/jobs/42",
      "/api/webhooks/github-app",
    ]) {
      expect(passesThrough(await app.visit(path, undefined, "POST"))).toBe(
        true,
      );
    }
  });

  // CR-18-T07
  it("is turned away on a route that does not exist yet", async () => {
    const app = await createGuardedApp();

    const page = await app.visit("/projects/42/settings");
    const data = await app.visit("/api/jobs");

    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
    expect(data.status).toBe(401);
    expect(await data.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  // CR-18-T07
  it("is not let in by a path that only looks like a public one", async () => {
    const app = await createGuardedApp();

    for (const path of [
      "/api/healthz",
      "/loginx",
      "/api/runnersx/v1/claim",
      "/api/health/x",
    ]) {
      expect(passesThrough(await app.visit(path)), path).toBe(false);
    }
  });

  it("is turned away when the session cookie is forged", async () => {
    const app = await createGuardedApp();
    await app.signIn();
    const forged = new Map([
      ["better-auth.session_token", "not-a-real-token.forged-signature"],
    ]);

    const response = await app.visit("/w/default/projects", forged);

    expect(response.status).toBe(307);
  });
});

describe("a request with a valid session", () => {
  it("reaches pages and data routes", async () => {
    const app = await createGuardedApp();
    const { cookies } = await app.signIn();

    expect(passesThrough(await app.visit("/w/default/projects", cookies))).toBe(
      true,
    );
    expect(passesThrough(await app.visit("/api/jobs", cookies))).toBe(true);
  });

  it("is turned away when the user belongs to no workspace", async () => {
    const app = await createGuardedApp();
    const { cookies } = await app.signIn();
    const refusing = createAccessProxy({
      getAuth: () => app.auth,
      getGates: () => noWorkspaceGates,
    });

    const response = await refusing(
      new NextRequest(`${TEST_BASE_URL}/`, {
        headers: { cookie: cookieHeader(cookies) },
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${TEST_BASE_URL}/no-access`);
  });
});

describe("a session that has ended", () => {
  // CR-18-T03
  it("stops working when its cookie is sent again after signing out", async () => {
    const app = await createGuardedApp();
    const { cookies } = await app.signIn();
    const oldCookies = new Map(cookies);
    expect(
      passesThrough(await app.visit("/w/default/projects", oldCookies)),
    ).toBe(true);

    const signOut = await app.request("/api/auth/sign-out", {
      method: "POST",
      cookies,
    });
    expect(signOut.status).toBe(200);

    const page = await app.visit("/w/default/projects", oldCookies);
    const data = await app.visit("/api/jobs", oldCookies);
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
    expect(data.status).toBe(401);
    expect(await app.db.selectFrom("sessions").selectAll().execute()).toEqual(
      [],
    );
  });

  // CR-18-T12
  it("is no longer accepted once its 30 days are over, and still is one day before", async () => {
    const app = await createGuardedApp();
    const { cookies } = await app.signIn();
    const day = 24 * 60 * 60 * 1000;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });

    vi.setSystemTime(Date.now() + 29 * day);
    expect(passesThrough(await app.visit("/w/default/projects", cookies))).toBe(
      true,
    );

    vi.setSystemTime(Date.now() + 1 * day + 1000);
    const page = await app.visit("/w/default/projects", cookies);
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
    expect((await app.visit("/api/jobs", cookies)).status).toBe(401);
  });
});

describe("a check that cannot be made", () => {
  it("refuses the request with 503 instead of letting it through", async () => {
    const proxy = createAccessProxy({
      getAuth: () => {
        throw new Error("the database is not initialized");
      },
      getGates: () => openGates,
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await proxy(new NextRequest(`${TEST_BASE_URL}/`));

    expect(response.status).toBe(503);
    expect(passesThrough(response)).toBe(false);
    expect(error).toHaveBeenCalled();
  });
});
