// SPDX-License-Identifier: LicenseRef-Proprietary

// Outside the capability `implementer` every route of the form answers the way a path that does not exist answers (#755-T10): the
// proxy marks it as missing and the app then serves the platform's own 404, so a deployment without the capability (code-review.com
// first of all) hands out nothing: no 401 that would show the path exists, no redirect to the sign-in page for a path a signed
// out visitor asks for beyond what any other missing path gets. The 404 itself, byte for byte against a path that does not exist, is
// compared in the hosted lane (e2e/hosted/capabilities.e2e.ts), which runs the real server.
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { PORTAL_DENIED_HEADER } from "../admin/paths.ts";
import { createAccessProxy } from "../auth/access-proxy.ts";
import type { AccessGates } from "../auth/access-gates.ts";
import type { SessionLookup } from "../auth/session-user.ts";
import { createCapabilitySet } from "../capabilities/capability.ts";
import { isAbsentPath, ROUTE_CLASSES } from "../capabilities/routes.ts";
import { concretePath } from "../test-support/routes.ts";

const lookupSession = vi.hoisted(() => vi.fn());
vi.mock("../auth/session-user.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/session-user.ts")>()),
  lookupSession,
}));

const BASE = "http://localhost:3000";
const REQUEST_HEADER = (name: string) => `x-middleware-request-${name}`;

const SIGNED_IN: SessionLookup = {
  kind: "user",
  user: {
    id: "u1",
    name: "A Person",
    email: "person@example.com",
    isInstanceAdmin: false,
    githubLogin: "octocat",
    githubId: null,
    image: null,
  },
};

const member = { workspaceRole: () => Promise.resolve("owner" as const) };

function proxyFor(capabilities: ReturnType<typeof createCapabilitySet>) {
  return createAccessProxy({
    getAuth: () => undefined as never,
    getGates: () => member as unknown as AccessGates,
    isAbsent: (pathname) => isAbsentPath(pathname, capabilities),
  });
}

function isMarkedAsMissing(response: Response): boolean {
  return (
    response.headers.get("x-middleware-next") === "1" &&
    response.headers.get(REQUEST_HEADER(PORTAL_DENIED_HEADER)) === "1" &&
    response.headers.get("x-middleware-rewrite") === null
  );
}

const implementerRoutes = ROUTE_CLASSES.filter(
  (entry) => entry.class === "implementer",
).map((entry) => entry.route);

const WITHOUT: Array<[string, string[]]> = [
  ["code-review.com's set", ["review", "dynamic-review"]],
  ["a review-only set", ["review"]],
  ["no capability at all", []],
];

describe("the routes of the Implementer form without the capability", () => {
  it("has the four API routes in the table, so this test looks at something", () => {
    expect(implementerRoutes).toEqual(
      expect.arrayContaining([
        "/api/w/[workspace]/implementer/models",
        "/api/w/[workspace]/implementer/repositories",
        "/api/w/[workspace]/implementer/repositories/[repositoryId]/branches",
        "/api/w/[workspace]/implementer/tasks",
      ]),
    );
  });

  // #756-T09
  it("has the page of the form in the table, so the loops below cover it", () => {
    expect(implementerRoutes).toContain("/w/[workspace]/implementer");
  });

  // #755-T10
  it.each(WITHOUT)(
    "are marked as missing by the proxy for %s, for a member and for a visitor, for every method",
    async (_name, names) => {
      const proxy = proxyFor(
        createCapabilitySet(names as Parameters<typeof createCapabilitySet>[0]),
      );
      for (const lookup of [
        SIGNED_IN,
        { kind: "none" } satisfies SessionLookup,
      ]) {
        lookupSession.mockResolvedValue(lookup);
        for (const route of implementerRoutes)
          for (const method of ["GET", "POST", "PUT", "DELETE"]) {
            const path = concretePath(route).replace("/w/x/", "/w/acme/");
            const response = await proxy(
              new NextRequest(`${BASE}${path}`, {
                method,
                headers: { "content-type": "application/json" },
              }),
            );
            // A signed out visitor gets what any path gets (the sign in redirect for a page, 401 for data); a member gets the mark.
            if (lookup.kind === "user")
              expect(isMarkedAsMissing(response), `${method} ${path}`).toBe(
                true,
              );
            else
              expect(
                isMarkedAsMissing(response) ||
                  response.status === 401 ||
                  (response.status === 307 &&
                    new URL(response.headers.get("location") ?? "", BASE)
                      .pathname === "/login"),
                `${method} ${path}`,
              ).toBe(true);
          }
      }
    },
  );

  // #755-T10
  it("go on untouched where the deployment has the capability", async () => {
    const proxy = proxyFor(
      createCapabilitySet(["review", "dynamic-review", "implementer"]),
    );
    lookupSession.mockResolvedValue(SIGNED_IN);
    for (const route of implementerRoutes) {
      const response = await proxy(
        new NextRequest(
          `${BASE}${concretePath(route).replace("/w/x/", "/w/acme/")}`,
        ),
      );
      expect(response.headers.get("x-middleware-next"), route).toBe("1");
      expect(
        response.headers.get(REQUEST_HEADER(PORTAL_DENIED_HEADER)),
        route,
      ).toBeNull();
    }
  });
});
