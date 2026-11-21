// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment node
// The review settings page of a project decides whether its form is read only (#1108): in the factory (the capability `implementer`) an AI
// sets the values through the API, so the form is handed `readOnly` and the note; without the capability the form is handed neither and
// stays what it is in code-review.com. Everything the page reads is replaced; only the props it hands on are looked at.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const state = vi.hoisted(() => ({ factory: false }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
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
    user: { isInstanceAdmin: false },
  }),
}));
vi.mock("@/db/repositories/instance-settings-repository", () => ({
  createInstanceSettingsRepository: () => ({ get: async () => null }),
}));
vi.mock("@/db/startup", () => ({ getDatabase: () => ({}) }));
vi.mock("@/billing/enabled", () => ({ isBillingOn: async () => true }));
vi.mock("@/native-providers/form-data", () => ({
  nativeFormDataFor: async () => undefined,
}));
vi.mock("@/native-providers/shared", () => ({ getNativeCatalog: () => ({}) }));
vi.mock("@/native-cost/token-cap", () => ({ ownKeyTokenCapOf: () => null }));
vi.mock("@/jobs/dynamic-review-gate", () => ({
  isDynamicReviewEnabled: async () => true,
}));
vi.mock("@/config-status/shared", () => ({
  getConfigStatusFor: async () => ({}),
}));
vi.mock("@/llm/shared", () => ({
  getWorkspaceLlm: () => ({
    summaryFor: async () => ({ configured: true }),
    keyServiceFor: () => ({}),
  }),
}));
vi.mock("@/llm/ui/llm-access-notice", () => ({
  llmAccessAttention: () => null,
}));
vi.mock("@/review-settings/ui/keyed-providers", () => ({
  keyedProvidersFor: async () => undefined,
}));
vi.mock("@/projects/shared", () => ({ projectServiceFor: () => ({}) }));
vi.mock("@/review-settings/shared", () => ({
  reviewSettingsServiceFor: () => ({}),
}));
vi.mock("@/projects/ui/project-settings-page", () => ({
  loadProjectSettingsPage: async () => ({ kind: "ready", model: {} }),
  ProjectSettingsPageContent: () => null,
}));

import { FACTORY_READ_ONLY_NOTE } from "@/review-settings/ui/read-only-note";
import ProjectSettingsPage from "./page.tsx";

afterEach(() => {
  state.factory = false;
});

async function renderedProps(): Promise<Record<string, unknown>> {
  const outer = (await ProjectSettingsPage({
    params: Promise.resolve({ workspace: "acme", repositoryId: "repo-1" }),
  } as Parameters<typeof ProjectSettingsPage>[0])) as ReactElement<
    Record<string, unknown>
  > & { type: (props: Record<string, unknown>) => Promise<unknown> };
  // The page renders an async component that does the reading: run it to get the form's page and its props.
  const inner = (await outer.type(outer.props)) as ReactElement<
    Record<string, unknown>
  >;
  return inner.props;
}

describe("the review settings page of a project", () => {
  // #1108
  it("hands the form readOnly and the note in the factory", async () => {
    state.factory = true;

    const props = await renderedProps();

    expect(props.readOnly).toBe(true);
    expect(props.readOnlyNote).toBe(FACTORY_READ_ONLY_NOTE);
  });

  // #1108: the guard of code-review.com
  it("hands the form neither without the capability implementer", async () => {
    const props = await renderedProps();

    expect(props).not.toHaveProperty("readOnly");
    expect(props).not.toHaveProperty("readOnlyNote");
  });
});
