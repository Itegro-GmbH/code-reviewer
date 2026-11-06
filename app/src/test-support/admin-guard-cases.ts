// SPDX-License-Identifier: LicenseRef-Proprietary

// What the files `src/admin/guard*.integration.test.ts` share: the routes of the portal as the file system has
// them, the portal harness with a signed in member, and the cases that run on every route and method. The one file
// of 484 tests that these were is five files since #905 (one test file runs in one worker, so the shard it was in
// was as slow as that file); the cases themselves did not change.
import { describe, expect, it } from "vitest";
import { MISSING_ANSWER_MARKER, createAdminHarness } from "./admin-harness.ts";
import { concretePath, discoverRoutes } from "./routes.ts";
import { isInternalPortalPath } from "../admin/paths.ts";

export const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// The files of the portal live below /instance-portal; the address of a person is /admin
// (src/admin/paths.ts). `route` is the address a person uses.
export const portalFiles = discoverRoutes().filter(({ route }) =>
  isInternalPortalPath(concretePath(route)),
);
export const adminRoutes = portalFiles.map(({ route, file }) => ({
  route: route.replace(/^(\/api)?\/instance-portal/, "$1/admin"),
  file,
}));
export const pageRoutes = adminRoutes.filter(({ file }) =>
  /page\.[a-z]+$/.test(file),
);
export const dataRoutes = adminRoutes.filter(({ file }) =>
  /route\.[a-z]+$/.test(file),
);

export async function startPortal() {
  const portal = await createAdminHarness();
  await portal.createUser({ id: "member-1", ...MEMBER });
  const memberCookies = await portal.signIn(MEMBER.email, MEMBER.password);
  return { portal, memberCookies };
}

// The answer of a path that is no route of the app (the harness's stand-in for Next.js's 404): nothing
// of the portal reached, no redirect, no rewrite header.
export function isHidden(response: Response): boolean {
  return (
    response.status === 404 &&
    response.headers.get(MISSING_ANSWER_MARKER) === "1" &&
    response.headers.get("x-middleware-rewrite") === null &&
    response.headers.get("location") === null
  );
}

/** A signed in person who is not an instance admin, on every route of the portal with each of the `methods`. */
export function describeMemberOnEveryRoute(
  methods: readonly (typeof METHODS)[number][],
): void {
  describe("a signed in person who is not an instance admin", () => {
    // #98-AD-02
    it.each(
      adminRoutes.flatMap(({ route }) =>
        methods.map((method) => ({ route, method })),
      ),
    )(
      "gets the 404 of a missing path from $route with $method",
      async ({ route, method }) => {
        const { portal, memberCookies } = await startPortal();

        const response = await portal.visit(concretePath(route), {
          method,
          cookies: memberCookies,
          ...(method === "GET" ? {} : { body: { tenancy: "multi" } }),
        });

        expect(isHidden(response)).toBe(true);
        expect(await response.text()).not.toContain("reached");
        expect((await portal.service.readSettings()).tenancy.value).toBe(
          "single",
        );
      },
    );
  });
}
