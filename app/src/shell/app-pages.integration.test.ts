// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down who sees the pages inside the app frame (Projects, Runs, Settings): a visitor without a
// session is sent to the login page and gets neither navigation nor user data, from the proxy and
// again from the page itself (the second guard), and the "Sign out" action ends the session on the
// server so the next request to an app page is turned away. Real Better Auth and Postgres; only the
// Next.js request context (headers, cookies) is stood in for, and the process-wide auth singletons
// are pointed at the test instance.
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type AuthHarness,
  type CookieJar,
} from "../test-support/auth-harness.ts";
import { createAccessProxy } from "../auth/access-proxy.ts";

const request = vi.hoisted(() => ({
  headers: new Headers(),
  harness: null as unknown,
  setCookies: [] as string[],
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(request.headers),
  cookies: () =>
    Promise.resolve({
      set: (name: string) => void request.setCookies.push(name),
      get: () => undefined,
      delete: () => undefined,
    }),
}));
vi.mock("../auth/auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/auth.ts")>()),
  getAuth: () => (request.harness as AuthHarness).auth,
}));
// The gates the pages ask (a verified address, a workspace): a test changes them with `startApp(harness, gates)`.
const pageGates = vi.hoisted(() => ({
  current: null as unknown,
}));
vi.mock("../auth/access-gates-runtime.ts", () => ({
  getAccessGates: () => pageGates.current,
}));

vi.mock("../db/startup.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/startup.ts")>()),
  getDatabase: () => (request.harness as AuthHarness).db,
}));

import { signOut } from "../auth/actions.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import ProjectsPage from "../app/(app)/w/[workspace]/projects/page.tsx";
import RunsPage from "../app/(app)/w/[workspace]/runs/page.tsx";
import RunDetailPage from "../app/(app)/w/[workspace]/runs/[id]/page.tsx";
import SettingsPage from "../app/(app)/w/[workspace]/settings/page.tsx";
import MembersPage from "../app/(app)/w/[workspace]/members/page.tsx";
import ProjectSettingsPage from "../app/(app)/w/[workspace]/projects/[repositoryId]/page.tsx";
import PlanSettingsPage from "../app/(app)/w/[workspace]/settings/plan/page.tsx";
import { noWorkspaceGates, openGates } from "../test-support/open-gates.ts";
import type { AccessGates } from "../auth/access-gates.ts";

const WORKSPACE = { workspace: "acme" };

const APP_PAGES = [
  {
    path: "/w/acme/projects",
    render: () =>
      ProjectsPage({ params: Promise.resolve(WORKSPACE) } as Parameters<
        typeof ProjectsPage
      >[0]),
  },
  {
    path: "/w/acme/runs",
    render: () =>
      RunsPage({
        params: Promise.resolve(WORKSPACE),
        searchParams: Promise.resolve({}),
      } as Parameters<typeof RunsPage>[0]),
  },
  {
    path: "/w/acme/runs/some-run",
    render: () =>
      RunDetailPage({
        params: Promise.resolve({ ...WORKSPACE, id: "some-run" }),
      } as Parameters<typeof RunDetailPage>[0]),
  },
  {
    path: "/w/acme/settings",
    render: () =>
      SettingsPage({
        params: Promise.resolve(WORKSPACE),
        searchParams: Promise.resolve({}),
      } as Parameters<typeof SettingsPage>[0]),
  },
  {
    path: "/w/acme/settings/plan",
    render: () =>
      PlanSettingsPage({ params: Promise.resolve(WORKSPACE) } as Parameters<
        typeof PlanSettingsPage
      >[0]),
  },
  {
    path: "/w/acme/members",
    render: () =>
      MembersPage({ params: Promise.resolve(WORKSPACE) } as Parameters<
        typeof MembersPage
      >[0]),
  },
  {
    path: "/w/acme/projects/some-repository",
    render: () =>
      ProjectSettingsPage({
        params: Promise.resolve({
          ...WORKSPACE,
          repositoryId: "some-repository",
        }),
      } as Parameters<typeof ProjectSettingsPage>[0]),
  },
] as const;

async function startApp(
  existing?: AuthHarness,
  gates: AccessGates = openGates,
) {
  const harness = existing ?? (await createAuthHarness());
  request.harness = harness;
  pageGates.current = gates;
  const proxy = createAccessProxy({
    getAuth: () => harness.auth,
    getGates: () => gates,
  });
  function visit(path: string, cookies?: CookieJar) {
    const headers = new Headers();
    if (cookies && cookies.size > 0)
      headers.set("cookie", cookieHeader(cookies));
    return proxy(new NextRequest(`${TEST_BASE_URL}${path}`, { headers }));
  }
  function sendCookies(cookies: CookieJar) {
    request.headers = new Headers({ cookie: cookieHeader(cookies) });
  }
  return { ...harness, visit, sendCookies };
}

afterEach(() => {
  request.headers = new Headers();
  request.harness = null;
  pageGates.current = null;
  request.setCookies = [];
});

async function redirectTarget(render: () => Promise<unknown>) {
  const error = await render().then(
    () => null,
    (thrown: unknown) => thrown,
  );
  return (error as { digest?: string } | null)?.digest ?? null;
}

describe("a visitor without a session", () => {
  // CR-36-T04
  it.each(APP_PAGES)(
    "is sent to the login page from $path and receives no navigation or user data",
    async ({ path }) => {
      const app = await startApp();

      const response = await app.visit(path);
      const body = await response.text();

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
      expect(body).toBe("");
      expect([...response.headers.keys()].join(",")).not.toMatch(/user/i);
    },
  );

  // CR-36-T04
  it.each(APP_PAGES)(
    "is sent to the login page by the page $path itself, before it renders anything",
    async ({ render }) => {
      await startApp();

      const digest = await redirectTarget(render);

      expect(digest).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login;/);
    },
  );
});

describe("a signed in person who belongs to no workspace", () => {
  // CR-34-T12
  it.each(APP_PAGES)(
    "is sent to the page that says so from $path, by the proxy and by the page itself",
    async ({ path, render }) => {
      const signedIn = await startApp();
      const { cookies } = await signedIn.signIn();
      const app = await startApp(signedIn, noWorkspaceGates);

      const response = await app.visit(path, cookies);
      app.sendCookies(cookies);
      const digest = await redirectTarget(render);

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `${TEST_BASE_URL}/no-access`,
      );
      expect(digest).toMatch(/^NEXT_REDIRECT;[a-z]+;\/no-access;/);
    },
  );
});

describe("signing out", () => {
  // CR-36-T03
  it("ends the session on the server so every app page turns the old cookie away", async () => {
    const app = await startApp();
    const { cookies } = await app.signIn();
    // The pages are for the members of the workspace in the address.
    const workspaces = createWorkspacesRepository(app.db);
    const workspace = await workspaces.create({
      name: "Acme",
      slug: "acme",
      createdBy: null,
    });
    for (const user of await app.db.selectFrom("users").select("id").execute())
      await workspaces.addMember(workspace.id, user.id, "owner");
    const oldCookies = new Map(cookies);
    for (const { path, render } of APP_PAGES) {
      expect((await app.visit(path, oldCookies)).headers.get("location")).toBe(
        null,
      );
      app.sendCookies(oldCookies);
      await expect(render()).resolves.toBeDefined();
    }
    app.sendCookies(cookies);

    const digest = await redirectTarget(signOut);

    expect(digest).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login;/);
    expect(await app.db.selectFrom("sessions").selectAll().execute()).toEqual(
      [],
    );
    for (const { path, render } of APP_PAGES) {
      const response = await app.visit(path, oldCookies);
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
      app.sendCookies(oldCookies);
      expect(await redirectTarget(render)).toMatch(
        /^NEXT_REDIRECT;[a-z]+;\/login;/,
      );
    }
  });
});
