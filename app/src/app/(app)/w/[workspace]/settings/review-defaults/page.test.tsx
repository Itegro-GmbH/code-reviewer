// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment node
// The "Review defaults" page decides what its form is handed. A workspace on the operator's key never gets a
// provider id in the form's props, not even one it stored a key of its own for earlier, and the page does not
// read the key statuses for it (#433, "the form never receives provider or model for a managed workspace").
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const state = vi.hoisted(() => ({
  factory: false,
  managed: false,
  statusAll: vi.fn(),
}));

vi.mock("@/capabilities/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/capabilities/shared")>()),
  getCapabilities: () => ({
    has: (capability: string) =>
      capability === "implementer" ? state.factory : true,
  }),
}));
vi.mock("@/workspaces/access-runtime", () => ({
  requireWorkspace: async () => ({
    workspace: { id: "workspace-1", slug: "acme" },
    role: "owner",
  }),
}));
vi.mock("@/llm/shared", () => ({
  getWorkspaceLlm: () => ({
    keyServiceFor: () => ({ statusAll: state.statusAll }),
  }),
}));
vi.mock("@/review-settings/shared", () => ({
  reviewSettingsServiceFor: () => ({}),
}));
vi.mock("@/db/startup", () => ({ getDatabase: () => ({}) }));
vi.mock("@/billing/enabled", () => ({ isBillingOn: async () => true }));
vi.mock("@/usage/shared", () => ({ planPageLinkedFor: async () => false }));
vi.mock("@/billing/shared", () => ({
  billingPageLinkedFor: async () => false,
}));
vi.mock("@/review-settings/ui/global-settings-page", () => ({
  loadGlobalSettingsPage: async () => ({ model: { managed: state.managed } }),
  GlobalSettingsPageContent: () => null,
}));

import { FACTORY_READ_ONLY_NOTE } from "@/review-settings/ui/read-only-note";
import ReviewDefaultsSettingsPage from "./page.tsx";

const OWN_OPENROUTER_KEY = [
  {
    provider: "openrouter",
    status: {
      state: "configured",
      provider: "openrouter",
      lastFour: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
      updatedBy: null,
    },
  },
];

async function renderedProps(): Promise<Record<string, unknown>> {
  const element = (await ReviewDefaultsSettingsPage({
    params: Promise.resolve({ workspace: "acme" }),
    searchParams: Promise.resolve({}),
  })) as ReactElement<Record<string, unknown>>;
  return element.props;
}

describe("the Review defaults page", () => {
  // #433-T04
  it("hands a workspace on the operator's key no provider id, even with a stored key of its own", async () => {
    state.managed = true;
    state.statusAll.mockResolvedValue(OWN_OPENROUTER_KEY);

    const props = await renderedProps();

    expect(props).not.toHaveProperty("keyedProviders");
    expect(state.statusAll).not.toHaveBeenCalled();
  });

  // #433-T11
  it("hands a workspace on its own key the providers that have a stored key", async () => {
    state.managed = false;
    state.statusAll.mockResolvedValue(OWN_OPENROUTER_KEY);

    expect((await renderedProps()).keyedProviders).toEqual(["openrouter"]);
  });

  // #1108: the factory shows the defaults and an AI sets them through the API, even for the Owner who could save them elsewhere
  it("is read only in the factory, with the note, whatever the role", async () => {
    state.factory = true;
    state.managed = false;
    state.statusAll.mockResolvedValue([]);

    const props = await renderedProps();

    expect(props.canEdit).toBe(false);
    expect(props.readOnlyNote).toBe(FACTORY_READ_ONLY_NOTE);
    state.factory = false;
  });

  // #1108: the guard of code-review.com
  it("stays editable for an Owner without the capability implementer, with no note", async () => {
    state.factory = false;
    state.managed = false;
    state.statusAll.mockResolvedValue([]);

    const props = await renderedProps();

    expect(props.canEdit).toBe(true);
    expect(props).not.toHaveProperty("readOnlyNote");
  });
});
