// SPDX-License-Identifier: LicenseRef-Proprietary

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { portalRewriteTarget } from "../admin/paths.ts";
import { discoverRoutes } from "../test-support/routes.ts";
import { isServerFunctionFile } from "../test-support/server-functions.ts";
import { createCapabilitySet } from "./capability.ts";
import {
  capabilityOfPath,
  classOfRoute,
  isAbsentPath,
  ROUTE_CLASSES,
} from "./routes.ts";

const SRC = join(import.meta.dirname, "..");

// Every file of Server Functions, relative to src. A Server Function is a POST that any page of the build can reach by
// its action id, so the path gate of the proxy (routes.ts) does not cover it: a file of them may not belong to a
// capability. A new one has to be added here on purpose, and its author has to say how it is gated.
const SERVER_FUNCTION_FILES = ["auth/actions.ts"];

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesBelow(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) &&
      !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
}

/** Whether the table lists this route file itself: a blanket prefix above it does not count. */
function hasOwnEntry(route: string): boolean {
  return ROUTE_CLASSES.some((entry) => entry.route === route);
}

describe("the route classification", () => {
  // #731-T07
  it("has an entry of its own for every page, route handler and metadata file of the app", () => {
    const routes = discoverRoutes().map(({ route }) => route);
    expect(routes.length).toBeGreaterThan(100);
    expect(
      routes.filter((route) => !hasOwnEntry(route)),
      "add the route to ROUTE_CLASSES in src/capabilities/routes.ts, with the class it belongs to",
    ).toEqual([]);
  });

  // #731-T07
  it("fails for a route nobody classified, also below a route that is core (fixture)", () => {
    expect(hasOwnEntry("/a-new-feature")).toBe(false);
    expect(hasOwnEntry("/new-top-level/[id]")).toBe(false);
    expect(hasOwnEntry("/api/w/[workspace]/a-new-feature")).toBe(false);
    expect(hasOwnEntry("/w/[workspace]/settings/a-new-section")).toBe(false);
    expect(hasOwnEntry("/instance-portal/a-new-page")).toBe(false);
    expect(hasOwnEntry("/api/operator/v1/a-new-endpoint")).toBe(false);
    expect(hasOwnEntry("/github/a-new-page")).toBe(false);
    expect(classOfRoute("/a-new-feature")).toBeUndefined();
    expect(hasOwnEntry("/w/[workspace]/settings/billing")).toBe(true);
  });

  // #731-T07
  it("sees every kind of file that makes a route (page, handler, metadata)", () => {
    const files = discoverRoutes().map(({ file }) => basename(file));
    expect(files).toContain("page.tsx");
    expect(files).toContain("route.ts");
    expect(
      files.some((file) => /^(icon|apple-icon|favicon)\./.test(file)),
    ).toBe(true);
  });

  it("has no entry that matches no file of the app (no stale entry) and none twice", () => {
    const routes = new Set(discoverRoutes().map(({ route }) => route));
    expect(
      ROUTE_CLASSES.filter((entry) => !routes.has(entry.route)).map(
        (entry) => entry.route,
      ),
    ).toEqual([]);
    const seen = ROUTE_CLASSES.map((entry) => entry.route);
    expect(seen.filter((route, i) => seen.indexOf(route) !== i)).toEqual([]);
  });

  // #731-T07
  it("allows a file of Server Functions only where it is listed, and the list is not stale", () => {
    const found = sourceFilesBelow(SRC)
      .filter((file) => isServerFunctionFile(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file).split(sep).join("/"))
      .sort();
    expect(
      found,
      "a new file of Server Functions must be added to SERVER_FUNCTION_FILES (routes.test.ts) on purpose",
    ).toEqual([...SERVER_FUNCTION_FILES].sort());
  });

  it("puts each billing and review route in its capability, the specific pattern winning inside a core one", () => {
    const expected: Record<string, string> = {
      "/w/[workspace]/settings/billing": "billing",
      "/w/[workspace]/settings": "core",
      "/w/[workspace]/settings/llm": "core",
      "/w/[workspace]/settings/review-defaults": "review",
      "/w/[workspace]/projects/[repositoryId]": "review",
      "/w/[workspace]/connections": "core",
      "/api/w/[workspace]/billing/top-ups/[id]/check": "billing",
      "/api/w/[workspace]/runs/[id]": "review",
      "/api/w/[workspace]/members/[userId]": "core",
      "/api/billing/webhook": "billing",
      "/api/webhooks/github-app": "review",
      "/api/runners/v1/claim": "review",
      "/api/workers/v1/jobs/[id]": "dynamic-review",
      "/api/workers/v1/jobs/[id]/heartbeat": "dynamic-review",
      "/api/workers/v1/jobs/[id]/result": "dynamic-review",
      "/api/internal/repository-sync": "review",
      "/api/internal/dispatch-sweep": "core",
      "/instance-portal/billing/reviews": "billing",
      "/api/instance-portal/billing/webhook-endpoint": "billing",
      "/instance-portal/runs/[id]": "review",
      "/instance-portal/llm": "core",
      "/projects/[[...rest]]": "review",
      "/api/health": "core",
      "/favicon.ico": "core",
      // #755-T14: the routes behind the Implementer form belong to the capability, none of them is core.
      "/api/w/[workspace]/implementer/repositories": "implementer",
      "/api/w/[workspace]/implementer/repositories/[repositoryId]/branches":
        "implementer",
      "/api/w/[workspace]/implementer/models": "implementer",
      "/api/w/[workspace]/implementer/tasks": "implementer",
      // #756-T09: the page of the form belongs to the capability too.
      "/w/[workspace]/implementer": "implementer",
    };
    for (const [route, expectedClass] of Object.entries(expected))
      expect(classOfRoute(route), route).toBe(expectedClass);
  });
});

describe("the Implementer routes", () => {
  // #755-T14
  it("are all classified implementer, and every route below the implementer folder of the app is", () => {
    const files = discoverRoutes().filter(
      ({ route }) =>
        route.startsWith("/api/w/[workspace]/implementer") ||
        route.startsWith("/w/[workspace]/implementer"),
    );
    expect(files.map(({ route }) => route)).toEqual(
      expect.arrayContaining([
        "/api/w/[workspace]/implementer/models",
        "/api/w/[workspace]/implementer/repositories",
        "/api/w/[workspace]/implementer/repositories/[repositoryId]/branches",
        "/api/w/[workspace]/implementer/tasks",
        // #756-T09
        "/w/[workspace]/implementer",
      ]),
    );
    expect(
      files.filter(({ route }) => classOfRoute(route) !== "implementer"),
    ).toEqual([]);
  });
});

describe("capabilityOfPath and isAbsentPath", () => {
  const factory = createCapabilitySet(["review", "dynamic-review"]);
  const nothing = createCapabilitySet([]);

  it("reads the admin addresses as the portal does: the files that serve them", () => {
    for (const path of [
      "/admin",
      "/admin/billing",
      "/admin/runs/1",
      "/admin/setup/instance",
      "/api/admin",
      "/api/admin/billing/reviews",
      "/api/admin/settings",
    ]) {
      const served = classOfRoute(portalRewriteTarget(path) ?? path);
      expect(capabilityOfPath(path), path).toBe(
        served === "core" ? undefined : served,
      );
    }
  });

  it("read a request path the way the router does, the admin addresses as the files that serve them", () => {
    expect(capabilityOfPath("/w/acme/settings/billing")).toBe("billing");
    expect(capabilityOfPath("/w/acme/settings/billing/")).toBe("billing");
    expect(capabilityOfPath("/w/acme//settings/%62illing")).toBe("billing");
    expect(capabilityOfPath("/w/acme/./projects/../settings/billing")).toBe(
      "billing",
    );
    expect(capabilityOfPath("/admin/billing")).toBe("billing");
    expect(capabilityOfPath("/api/admin/billing/reviews")).toBe("billing");
    expect(capabilityOfPath("/admin/runs/7")).toBe("review");
    expect(capabilityOfPath("/admin/setup/instance")).toBeUndefined();
    expect(capabilityOfPath("/projects")).toBe("review");
    expect(capabilityOfPath("/projects/12/x")).toBe("review");
    // not the same word
    expect(capabilityOfPath("/projects-archive")).toBeUndefined();
    expect(capabilityOfPath("/api/billing-other")).toBeUndefined();
    // cannot be read: no page either
    expect(capabilityOfPath("/w/%E0%A4%A/projects")).toBeUndefined();
  });

  // #755-T10
  it("find every Implementer path absent in a set without the capability (code-review.com's, today's factory's, none), however it is written, and present with it", () => {
    const paths = [
      "/api/w/acme/implementer/repositories",
      "/api/w/acme/implementer/repositories/r1/branches",
      "/api/w/acme/implementer/models",
      "/api/w/acme/implementer/tasks",
      "/api/w/acme/implementer/tasks/",
      "/api/w/acme//implementer/./tasks",
      "/api/w/acme/%69mplementer/tasks",
      "/api/w/acme/implementer/x/../tasks",
    ];
    const withIt = createCapabilitySet([
      "review",
      "dynamic-review",
      "implementer",
    ]);
    for (const path of paths) {
      expect(capabilityOfPath(path), path).toBe("implementer");
      expect(isAbsentPath(path, createCapabilitySet(["review"])), path).toBe(
        true,
      );
      expect(isAbsentPath(path, factory), path).toBe(true);
      expect(isAbsentPath(path, nothing), path).toBe(true);
      expect(isAbsentPath(path, withIt), path).toBe(false);
    }
  });

  // #731-T03
  it("find the billing paths absent in the factory set, pages and APIs", () => {
    for (const path of [
      "/api/billing/webhook",
      "/w/acme/settings/billing",
      "/api/w/acme/billing/top-ups",
      "/api/w/acme/billing/journal",
      "/api/w/acme/llm-key-mode",
      "/admin/billing",
      "/admin/billing/reviews",
      "/api/admin/billing",
      "/api/admin/billing/workspaces/abc/credit",
    ])
      expect(isAbsentPath(path, factory), path).toBe(true);
    for (const path of [
      "/w/acme/projects",
      "/w/acme/settings",
      "/api/webhooks/github-app",
      "/api/runners/v1/claim",
      "/admin/setup/instance",
      "/api/health",
    ])
      expect(isAbsentPath(path, factory), path).toBe(false);
  });

  // #731-T05
  it("find the Worker API absent in a set with review but without dynamic-review, and present with it", () => {
    const diffOnly = createCapabilitySet(["review"]);
    for (const path of [
      "/api/workers/v1/jobs/1",
      "/api/workers/v1/jobs/1/heartbeat",
      "/api/workers/v1/jobs/1/result",
    ]) {
      expect(capabilityOfPath(path), path).toBe("dynamic-review");
      expect(isAbsentPath(path, diffOnly), path).toBe(true);
      expect(isAbsentPath(path, factory), path).toBe(false);
    }
    expect(isAbsentPath("/api/runners/v1/claim", diffOnly)).toBe(false);
  });

  // #731-T04
  it("find the review paths absent in a set without review, and the health check never", () => {
    for (const path of [
      "/api/webhooks/github-app",
      "/api/runners/v1/claim",
      "/api/workers/v1/jobs/1/result",
      "/w/acme/projects",
      "/w/acme/runs/3",
      "/api/w/acme/runs",
      "/api/w/acme/repositories/5/reviews",
      "/projects",
      "/runs/4",
      "/api/internal/repository-sync",
    ])
      expect(isAbsentPath(path, nothing), path).toBe(true);
    for (const path of [
      "/api/health",
      "/login",
      "/w/acme/members",
      "/api/internal/dispatch-sweep",
    ])
      expect(isAbsentPath(path, nothing), path).toBe(false);
  });
});
