// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the "General" sub-page of the workspace settings (#178): the rename (an Owner) or the
// read-only name (everybody else), and the one
// "Needs attention" strip that carries the configuration hints and the workspace's LLM hint. A member
// reads no variable name and no value.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: navigation.refresh,
    replace: navigation.replace,
  }),
}));

import {
  describeConfigStatus,
  statusForMembers,
  type ConfigAudience,
  type ConfigStatus,
  type GithubAppStatus,
} from "../../config-status/status.ts";
import type { WorkspaceLlmSummary } from "../../llm/assemble.ts";
import { testGithubAppStatus } from "../../test-support/github-app.ts";
import type { PlanHandoffErrorCode } from "../../plan-handoff/errors.ts";
import { GeneralSettingsPageContent } from "./general-settings-page.tsx";
import { getProductIdentity } from "../../product-identity/current.ts";

const PRODUCT = getProductIdentity();

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
  navigation.replace.mockClear();
  // The redirect test sets a hash; leave the next test a clean address.
  window.history.replaceState(null, "", "/");
});

const LLM_KEY = "dummy-llm-key-0123456789";
const MISSING_GITHUB: GithubAppStatus = {
  configured: false,
  kind: "missing",
  variables: ["app_id"],
  slug: null,
};
const WORKS: WorkspaceLlmSummary = { configured: true, source: "workspace" };
const MISSING: WorkspaceLlmSummary = { configured: false, reason: "no_key" };

function general({
  config = describeConfigStatus({}, testGithubAppStatus()),
  audience = "operator" as ConfigAudience,
  canRename = true,
  llmSummary = WORKS,
  canManagePlan,
  planError,
}: {
  config?: ConfigStatus;
  audience?: ConfigAudience;
  canRename?: boolean;
  llmSummary?: WorkspaceLlmSummary;
  canManagePlan?: boolean;
  planError?: PlanHandoffErrorCode;
} = {}) {
  return render(
    <GeneralSettingsPageContent
      product={PRODUCT}
      workspaceSlug="acme"
      workspaceName="Acme"
      canRename={canRename}
      canManageLlmKey
      audience={audience}
      config={config}
      llmSummary={llmSummary}
      {...(canManagePlan === undefined ? {} : { canManagePlan })}
      {...(planError === undefined ? {} : { planError })}
    />,
  );
}

describe("Manage plan on the General settings sub-page", () => {
  // #284-T01
  it("is not there while the instance has no plan management page, whatever the role", () => {
    general();
    expect(screen.queryByRole("button", { name: "Manage plan" })).toBeNull();
    cleanup();
    general({ canManagePlan: false });

    expect(screen.queryByRole("button", { name: "Manage plan" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Plan" })).toBeNull();
  });

  // #284-T02
  it("posts to the handoff route of the workspace, as a plain form, for somebody who may manage the plan", () => {
    const { container } = general({ canManagePlan: true });

    const button = screen.getByRole("button", { name: "Manage plan" });
    const form = button.closest("form");
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form?.getAttribute("action")).toBe("/api/w/acme/plan-handoff");
    expect(button.getAttribute("type")).toBe("submit");
    // No field: nothing of the page travels with the click, and no link points out of the app.
    expect(form?.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("a[href^='http']")).toHaveLength(0);
  });

  // #284-T02
  it("says what happens in generic words, and names no price, provider or company", () => {
    general({ canManagePlan: true });

    const region = screen.getByRole("region", { name: "Plan" });
    expect(region.textContent).toMatch(/operator-configured page/i);
    expect(region.textContent).toMatch(/Owner or Admin/);
    expect(region.textContent).not.toMatch(/[$€£]|price/i);
  });
});

describe("a refused click on Manage plan", () => {
  // #284-P3
  it.each([
    ["rate_limited", /Too many attempts/],
    ["cross_site_request", /did not come from this page/],
  ] as const)(
    "says why for %s, as an alert next to the button",
    (code, text) => {
      general({ canManagePlan: true, planError: code });

      const region = screen.getByRole("region", { name: "Plan" });
      expect(within(region).getByRole("alert").textContent).toMatch(text);
      expect(
        within(region).getByRole("button", { name: "Manage plan" }),
      ).toBeTruthy();
    },
  );

  it("says nothing when the click was not refused", () => {
    general({ canManagePlan: true });

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the General settings sub-page", () => {
  // #178-T01
  it("shows General at the settings index with exactly one form, the rename", () => {
    const { container } = general();

    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(container.querySelector("form")?.getAttribute("aria-label")).toBe(
      "Workspace name",
    );
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getByRole("link", { name: "General" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  // #658-T01
  it("has no Instance part: no heading, no tenancy, member count or GitHub fact", () => {
    general();

    expect(screen.queryByRole("heading", { name: "Instance" })).toBeNull();
    expect(screen.queryByText("Tenancy")).toBeNull();
    expect(screen.queryByText("Multi-tenant")).toBeNull();
    expect(screen.queryByText("Members")).toBeNull();
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeTruthy();
  });

  it("has one Needs attention strip that carries the configuration hints and the LLM hint", () => {
    general({
      config: describeConfigStatus({}, MISSING_GITHUB),
      llmSummary: MISSING,
    });

    const regions = screen.getAllByRole("region", { name: "Needs attention" });
    expect(regions).toHaveLength(1);
    expect(
      within(regions[0]!).getByText("GitHub App not configured"),
    ).toBeTruthy();
    expect(within(regions[0]!).getByText("LLM not configured")).toBeTruthy();
    // The static rows carry no alert role.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // #178-T01
  it("gives a member no form and only the read-only name, with no variable name or value", () => {
    const { container } = general({
      config: statusForMembers(describeConfigStatus({}, MISSING_GITHUB)),
      audience: "member",
      canRename: false,
    });

    expect(container.querySelectorAll("form")).toHaveLength(0);
    expect(screen.getByText(/Only an Owner can rename it\./)).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/GITHUB_APP|LLM_|openrouter|Missing:/);
    expect(text).not.toContain(LLM_KEY);
  });

  it("shows no hint while the configuration is complete and never a key", () => {
    const { container } = general();

    expect(
      screen.queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
    expect(container.textContent).not.toContain(LLM_KEY);
  });

  // #178 review N3
  it("sends an old `#llm-access` bookmark on to the LLM sub-page", async () => {
    window.history.replaceState(null, "", "#llm-access");

    general();

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/w/acme/settings/llm"),
    );
  });
});
