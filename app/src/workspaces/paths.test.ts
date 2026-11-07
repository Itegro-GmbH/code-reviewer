// SPDX-License-Identifier: LicenseRef-Proprietary

// The addresses of a workspace: which paths name a workspace, which slug they name, and that an odd spelling
// can only fail to name one.
import { describe, expect, it } from "vitest";
import { createCapabilitySet } from "../capabilities/capability.ts";
import {
  connectionsPlace,
  isWorkspaceSlug,
  legacyWorkspaceTarget,
  workspaceApiPath,
  workspaceHome,
  workspacePath,
  workspaceSlugOfPath,
} from "./paths.ts";

describe("the slug in an address", () => {
  it.each([
    ["/w/acme", "acme"],
    ["/w/acme/", "acme"],
    ["/w/acme/projects", "acme"],
    ["/w/team-a-2/runs/42", "team-a-2"],
    ["/api/w/acme", "acme"],
    ["/api/w/acme/repositories/7/project", "acme"],
  ])("reads %s as the workspace %s", (path, slug) => {
    expect(workspaceSlugOfPath(path)).toBe(slug);
  });

  it.each([
    "/w/",
    "/w/ACME",
    "/w/-acme",
    "/w/acme-",
    "/w/a--b",
    "/w/acme%2Fx",
    "/w/..",
    "/w/a_b",
    `/w/${"a".repeat(49)}`,
    "/api/w/",
    "/api/w/Acme/runs",
  ])(
    "reads %s as a workspace address with a slug that cannot exist",
    (path) => {
      expect(workspaceSlugOfPath(path)).toBeNull();
    },
  );

  it.each([
    "/",
    "/projects",
    "/windows",
    "/w",
    "/api/workspaces",
    "/api/w",
    "/api/runs",
    "/W/acme",
    "/no-access",
  ])("does not read %s as a workspace address", (path) => {
    expect(workspaceSlugOfPath(path)).toBeUndefined();
  });

  it("knows the shape of a slug", () => {
    expect(isWorkspaceSlug("default")).toBe(true);
    expect(isWorkspaceSlug("a")).toBe(true);
    expect(isWorkspaceSlug("")).toBe(false);
    expect(isWorkspaceSlug(7)).toBe(false);
    expect(isWorkspaceSlug("a b")).toBe(false);
  });
});

describe("building an address", () => {
  it("puts the slug in front of the page and of the data route", () => {
    expect(workspacePath("acme", "/runs")).toBe("/w/acme/runs");
    expect(workspacePath("acme")).toBe("/w/acme");
    expect(workspaceApiPath("acme", "/runs")).toBe("/api/w/acme/runs");
    expect(workspaceHome("acme")).toBe("/w/acme/projects");
  });
});

describe("where the connections are shown", () => {
  // #925
  it("is /connections everywhere but in the factory, whose settings have the tab", () => {
    expect(connectionsPlace()).toBe("/connections");
    expect(connectionsPlace(createCapabilitySet(["review"]))).toBe(
      "/connections",
    );
    expect(
      connectionsPlace(createCapabilitySet(["review", "dynamic-review"])),
    ).toBe("/connections");
    expect(
      connectionsPlace(
        createCapabilitySet(["review", "dynamic-review", "implementer"]),
      ),
    ).toBe("/settings/integrations");
  });
});

describe("the target of an address from before the workspace was in the address", () => {
  it.each([
    ["/", "/w/acme/projects"],
    ["/projects", "/w/acme/projects"],
    ["/projects/7/settings", "/w/acme/projects/7/settings"],
    ["/runs", "/w/acme/runs"],
    ["/runs/abc", "/w/acme/runs/abc"],
    ["/settings", "/w/acme/settings"],
  ])("leads %s to %s", (pathname, target) => {
    expect(legacyWorkspaceTarget(pathname, "acme")).toBe(target);
  });

  it.each([
    "/projectsx",
    "/run",
    "/settings-old",
    "/w/acme/projects",
    "/api/w/acme/runs",
    "//projects",
    "/login",
    "",
  ])("leads %j nowhere", (pathname) => {
    expect(legacyWorkspaceTarget(pathname, "acme")).toBeNull();
  });
});
