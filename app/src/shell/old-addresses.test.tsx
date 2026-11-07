// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment node
// The pages that became tabs of the settings in the factory (#925): there, the old addresses `/members` and `/connections` lead to
// the tabs, the second one carrying only the two query parameters a finished GitHub flow leaves. Without the capability `implementer`
// (code-review.com) they are the pages they were, and the tabs do not exist.
import { afterEach, describe, expect, it, vi } from "vitest";

const next = vi.hoisted(() => ({
  redirect: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  factory: true,
}));
vi.mock("next/navigation", () => ({
  redirect: next.redirect,
  notFound: next.notFound,
}));
vi.mock("@/capabilities/shared", () => ({
  getCapabilities: () => ({
    has: (capability: string) =>
      capability === "implementer" ? next.factory : true,
  }),
}));
vi.mock("@/workspaces/access-runtime", () => ({
  requireWorkspace: async () => ({
    workspace: { id: "workspace-1", slug: "acme", name: "Acme" },
    role: "member",
    user: { isInstanceAdmin: false },
  }),
}));

import ConnectionsPage from "../app/(app)/w/[workspace]/connections/page.tsx";
import MembersPage from "../app/(app)/w/[workspace]/members/page.tsx";
import IntegrationsTab from "../app/(app)/w/[workspace]/settings/integrations/page.tsx";
import MembersTab from "../app/(app)/w/[workspace]/settings/members/page.tsx";

afterEach(() => {
  next.redirect.mockReset();
  next.notFound.mockClear();
  next.factory = true;
});

describe("the old addresses in the factory", () => {
  // #925
  it("sends /members to the Members tab of the workspace in the address", async () => {
    await MembersPage({
      params: Promise.resolve({ workspace: "acme" }),
    } as never);

    expect(next.redirect).toHaveBeenCalledWith("/w/acme/settings/members");
  });

  // #925
  it("sends /connections to the Integrations tab", async () => {
    await ConnectionsPage({
      params: Promise.resolve({ workspace: "acme" }),
      searchParams: Promise.resolve({}),
    } as never);

    expect(next.redirect).toHaveBeenCalledWith("/w/acme/settings/integrations");
  });

  // #925
  it("carries the result of a GitHub flow and nothing else", async () => {
    await ConnectionsPage({
      params: Promise.resolve({ workspace: "acme" }),
      searchParams: Promise.resolve({
        github: "linked",
        picker: "abc",
        next: "https://evil.example",
      }),
    } as never);

    expect(next.redirect).toHaveBeenCalledWith(
      "/w/acme/settings/integrations?github=linked&picker=abc",
    );
  });
});

describe("the pages without the capability `implementer`", () => {
  // #925
  it("keep /members and /connections as the pages they were: no redirect", async () => {
    next.factory = false;

    await MembersPage({
      params: Promise.resolve({ workspace: "acme" }),
    } as never);
    await ConnectionsPage({
      params: Promise.resolve({ workspace: "acme" }),
      searchParams: Promise.resolve({ github: "linked" }),
    } as never);

    expect(next.redirect).not.toHaveBeenCalled();
  });

  // #925
  it("have no Members or Integrations tab: the pages answer not found", async () => {
    next.factory = false;

    await expect(
      MembersTab({ params: Promise.resolve({ workspace: "acme" }) } as never),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      IntegrationsTab({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({}),
      } as never),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
