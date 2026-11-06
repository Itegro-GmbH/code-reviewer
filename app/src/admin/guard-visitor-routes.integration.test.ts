// SPDX-License-Identifier: LicenseRef-Proprietary

// A visitor without a session on every data route of the portal with every method (the first part of
// guard.integration.test.ts, which holds the rest of the guard; the routes and the harness are in
// src/test-support/admin-guard-cases.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { concretePath } from "../test-support/routes.ts";
import {
  METHODS,
  dataRoutes,
  startPortal,
} from "../test-support/admin-guard-cases.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a visitor without a session", () => {
  // #98-AD-01
  it.each(
    dataRoutes.flatMap(({ route }) =>
      METHODS.map((method) => ({ route, method })),
    ),
  )(
    "gets 401 from the data route $route with $method",
    async ({ route, method }) => {
      const { portal } = await startPortal();

      const response = await portal.visit(concretePath(route), { method });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    },
  );
});
