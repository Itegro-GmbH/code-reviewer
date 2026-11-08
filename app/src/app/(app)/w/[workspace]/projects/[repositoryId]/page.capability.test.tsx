// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment node
// The project's own address (#925): the cockpit with its Issues tab in the factory, the review settings in place everywhere else (no
// redirect, so the address of a project stays what it was).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const state = vi.hoisted(() => ({ factory: false, redirect: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: state.redirect,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/capabilities/shared", () => ({
  getCapabilities: () => ({
    has: (capability: string) =>
      capability === "implementer" ? state.factory : true,
  }),
}));
vi.mock("@/workspaces/access-runtime", () => ({
  requireWorkspace: async () => ({
    workspace: { id: "workspace-1", slug: "acme" },
    role: "owner",
    user: { isInstanceAdmin: false },
  }),
}));
vi.mock("./review/page", () => ({
  default: async () => "review settings",
}));
vi.mock("./cockpit-frame", () => ({ CockpitFrame: () => null }));

import ProjectPage, { generateMetadata } from "./page.tsx";

const PROPS = {
  params: Promise.resolve({ workspace: "acme", repositoryId: "repo-1" }),
  searchParams: Promise.resolve({}),
} as Parameters<typeof ProjectPage>[0];

afterEach(() => {
  state.factory = false;
  state.redirect.mockReset();
});

describe("the page of a project", () => {
  // #925
  it("is the review settings, in place, without the capability `implementer`", async () => {
    expect(await ProjectPage(PROPS)).toBe("review settings");
    expect(state.redirect).not.toHaveBeenCalled();
    expect(generateMetadata().title).toBe("Project settings");
  });

  // #925
  it("is the cockpit with the Issues tab in the factory", async () => {
    state.factory = true;

    const page = (await ProjectPage(PROPS)) as ReactElement<{ tab: string }>;

    expect(page.props.tab).toBe("");
    expect(generateMetadata().title).toBe("Project · Issues");
  });
});
