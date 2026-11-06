// SPDX-License-Identifier: LicenseRef-Proprietary

// A signed in person who is not an instance admin gets the 404 of a missing path from every route of the portal with GET and POST
// (the cases of guard.integration.test.ts that run on every route and method, split by method so that the
// test files are about the same size; the routes and the harness are in src/test-support/admin-guard-cases.ts).
import { afterEach, vi } from "vitest";
import { describeMemberOnEveryRoute } from "../test-support/admin-guard-cases.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describeMemberOnEveryRoute(["GET", "POST"]);
