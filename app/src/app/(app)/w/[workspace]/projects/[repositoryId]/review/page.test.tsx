// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment node
// The project settings page decides what its form is handed. A workspace on the operator's key never gets a
// provider id in the form's props, not even one it stored a key of its own for earlier, and the page does not
// read the key statuses for it (#433, "the form never receives provider or model for a managed workspace").
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const state = vi.hoisted(() => ({
  managed: false,
  statusAll: vi.fn(),
  nativeStatuses: vi.fn(),
}));

vi.mock("@/workspaces/access-runtime", () => ({
  requireWorkspace: async () => ({
    workspace: { id: "workspace-1", slug: "acme" },
    role: "owner",
    user: { isInstanceAdmin: false },
  }),
}));
vi.mock("@/llm/shared", () => ({
  getWorkspaceLlm: () => ({
    summaryFor: async () => ({ configured: true }),
    keyServiceFor: () => ({
      statusAll: state.statusAll,
      nativeStatuses: state.nativeStatuses,
    }),
  }),
}));
// The catalog providers of Dynamic Review on the own key (#555): one offered provider, billing off, the default token cap.
vi.mock("@/native-providers/shared", () => ({
  getNativeCatalog: () => ({
    providers: async () => [{ id: "deepseek", label: "DeepSeek" }],
  }),
}));
vi.mock("@/billing/enabled", () => ({ isBillingOn: async () => false }));
vi.mock("@/db/repositories/instance-settings-repository", () => ({
  createInstanceSettingsRepository: () => ({ get: async () => undefined }),
}));
vi.mock("@/llm/ui/llm-access-notice", () => ({
  llmAccessAttention: () => null,
}));
vi.mock("@/db/startup", () => ({ getDatabase: () => ({}) }));
vi.mock("@/jobs/dynamic-review-gate", () => ({
  isDynamicReviewEnabled: async () => false,
}));
vi.mock("@/config-status/shared", () => ({ getConfigStatusFor: () => ({}) }));
vi.mock("@/projects/shared", () => ({ projectServiceFor: () => ({}) }));
vi.mock("@/review-settings/shared", () => ({
  reviewSettingsServiceFor: () => ({}),
}));
vi.mock("@/projects/ui/project-settings-page", () => ({
  loadProjectSettingsPage: async () => ({
    kind: "ready",
    model: { managed: state.managed },
  }),
  ProjectSettingsPageContent: () => null,
}));

import ProjectSettingsPage from "./page.tsx";

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
  const page = (await ProjectSettingsPage({
    params: Promise.resolve({ workspace: "acme", repositoryId: "repo-1" }),
    searchParams: Promise.resolve({}),
  })) as ReactElement<Record<string, unknown>>;
  // The page hands over to an async server component of its own; run it the way the server would.
  const content = (await (
    page.type as (props: unknown) => Promise<ReactElement>
  )(page.props)) as ReactElement<Record<string, unknown>>;
  return content.props;
}

describe("the project settings page", () => {
  // #433-T04
  it("hands a workspace on the operator's key no provider id, even with a stored key of its own", async () => {
    state.managed = true;
    state.statusAll.mockResolvedValue(OWN_OPENROUTER_KEY);

    const props = await renderedProps();

    expect(props).not.toHaveProperty("keyedProviders");
    expect(state.statusAll).not.toHaveBeenCalled();
  });

  // #555-T08
  it("hands a workspace on the operator's key nothing of the catalog providers and does not read their keys", async () => {
    state.managed = true;
    state.nativeStatuses.mockResolvedValue([]);

    const props = await renderedProps();

    expect(props).not.toHaveProperty("nativeCatalog");
    expect(state.nativeStatuses).not.toHaveBeenCalled();
  });

  // #433-T11
  it("hands a workspace on its own key the providers that have a stored key", async () => {
    state.managed = false;
    state.statusAll.mockResolvedValue(OWN_OPENROUTER_KEY);

    expect((await renderedProps()).keyedProviders).toEqual(["openrouter"]);
  });

  // #555-T01
  it("hands a workspace on its own key the catalog providers it holds a key for, and no other", async () => {
    state.managed = false;
    state.statusAll.mockResolvedValue([]);
    const configured = (provider: string) => ({
      provider,
      status: {
        state: "configured",
        provider,
        lastFour: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
        updatedBy: null,
      },
    });
    state.nativeStatuses.mockResolvedValue([
      configured("deepseek"),
      configured("not_offered"),
    ]);

    const props = await renderedProps();

    expect(props.nativeCatalog).toMatchObject({
      providers: [{ id: "deepseek", label: "DeepSeek", hasKey: true }],
      billingOn: false,
    });
  });
});
