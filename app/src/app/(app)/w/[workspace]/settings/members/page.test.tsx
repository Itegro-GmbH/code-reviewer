// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment node
// The old addresses of the pages that became tabs of the settings (#925) lead to their new place: `/members` to the Members tab and
// `/connections` to the Integrations tab, the second one carrying only the two query parameters a finished GitHub flow leaves.
import { afterEach, describe, expect, it, vi } from "vitest";

const next = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: next.redirect }));
vi.mock("@/workspaces/access-runtime", () => ({
  requireWorkspace: async () => ({
    workspace: { id: "workspace-1", slug: "acme" },
    role: "member",
    user: { isInstanceAdmin: false },
  }),
}));

import ConnectionsRedirectPage from "../../connections/page.tsx";
import MembersRedirectPage from "../../members/page.tsx";

afterEach(() => next.redirect.mockReset());

describe("the old addresses", () => {
  // #925
  it("sends /members to the Members tab of the workspace in the address", async () => {
    await MembersRedirectPage({
      params: Promise.resolve({ workspace: "acme" }),
    } as never);

    expect(next.redirect).toHaveBeenCalledWith("/w/acme/settings/members");
  });

  // #925
  it("sends /connections to the Integrations tab", async () => {
    await ConnectionsRedirectPage({
      params: Promise.resolve({ workspace: "acme" }),
      searchParams: Promise.resolve({}),
    } as never);

    expect(next.redirect).toHaveBeenCalledWith("/w/acme/settings/integrations");
  });

  // #925
  it("carries the result of a GitHub flow and nothing else", async () => {
    await ConnectionsRedirectPage({
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
