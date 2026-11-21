// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the shape of the workspace settings sub-pages (#178): each is its own screen with the
// settings sub-nav marking it, and no page stacks independent forms — one form on "General"
// (rename), "Review defaults" and "LLM access", and "Advanced" only holds the deletion of the workspace
// (#658), a dialog with its own form, so none on the page itself. The behaviour of each form is pinned in its own
// file; this one pins the split.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chooseOption,
  openSection,
} from "../../test-support/settings-sections.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
}));

import { modelFromGlobalView } from "../../review-settings/ui/form-model.ts";
import { GlobalSettingsPageContent } from "../../review-settings/ui/global-settings-page.tsx";
import {
  describeConfigStatus,
  type ConfigStatus,
} from "../../config-status/status.ts";
import { testGithubAppStatus } from "../../test-support/github-app.ts";
import {
  BUILT_IN,
  managedModel,
  untouchedGlobalView,
} from "../../test-support/settings-form-models.ts";
import { LlmSettingsPageContent } from "../../llm/ui/llm-settings-page.tsx";
import { AdvancedSettingsPageContent } from "./advanced-settings-page.tsx";
import { GeneralSettingsPageContent } from "./general-settings-page.tsx";
import { getProductIdentity } from "../../product-identity/current.ts";

const PRODUCT = getProductIdentity();

afterEach(cleanup);

const GLOBAL_DATA = {
  model: modelFromGlobalView(untouchedGlobalView()),
  dynamicReviewEnabled: true,
};

function workingConfig(): ConfigStatus {
  return describeConfigStatus({}, testGithubAppStatus());
}

const WORKS = { configured: true, source: "workspace" } as const;

const renders = [
  {
    key: "general",
    label: "General",
    element: (
      <GeneralSettingsPageContent
        product={PRODUCT}
        workspaceSlug="acme"
        workspaceName="Acme"
        canRename
        canManageLlmKey
        audience="operator"
        config={workingConfig()}
        llmSummary={WORKS}
      />
    ),
    forms: 1,
  },
  {
    key: "review-defaults",
    label: "Review defaults",
    element: (
      <GlobalSettingsPageContent
        product={getProductIdentity()}
        workspaceSlug="acme"
        data={GLOBAL_DATA}
      />
    ),
    forms: 1,
  },
  {
    key: "llm",
    label: "LLM",
    element: (
      <LlmSettingsPageContent
        product={PRODUCT}
        workspaceSlug="acme"
        canManage
        keyStatuses={[
          { provider: "openrouter", status: { state: "not_configured" } },
        ]}
        summary={{ configured: false, reason: "no_key" }}
      />
    ),
    forms: 1,
  },
  {
    key: "advanced",
    label: "Advanced",
    element: (
      <AdvancedSettingsPageContent workspaceSlug="acme" workspaceName="Acme" />
    ),
    forms: 0,
  },
];

describe("the workspace settings sub-pages", () => {
  // #178-T02
  it("each renders its own screen with the sub-nav marking it and at most one form", () => {
    for (const { key, label, element, forms } of renders) {
      const { container, unmount } = render(<div key={key}>{element}</div>);

      expect(container.querySelectorAll("form"), label).toHaveLength(forms);
      const nav = screen.getByRole("navigation", { name: "Settings sections" });
      expect(
        within(nav)
          .getByRole("link", { name: label })
          .getAttribute("aria-current"),
        label,
      ).toBe("page");
      // The Owner's navigation has Advanced (the Advanced page itself says so); the others have three links.
      expect(within(nav).getAllByRole("link")).toHaveLength(
        key === "advanced" ? 4 : 3,
      );
      unmount();
    }
  });
});

describe("a page of Setup below the settings address (#1108)", () => {
  const llm = (setup: boolean) => (
    <LlmSettingsPageContent
      product={PRODUCT}
      workspaceSlug="acme"
      canManage
      keyStatuses={[
        { provider: "openrouter", status: { state: "not_configured" } },
      ]}
      summary={{ configured: false, reason: "no_key" }}
      setup={setup}
    />
  );

  // #1108
  it("has the title of its sidebar link, Setup as its breadcrumb root and no settings tabs", () => {
    render(llm(true));

    expect(
      screen.getByRole("heading", { level: 1, name: "LLM keys" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("navigation", { name: "Settings sections" }),
    ).toBeNull();
    const trail = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(trail).getByText("Setup")).toBeTruthy();
    expect(within(trail).queryByRole("link", { name: "Settings" })).toBeNull();
    expect(
      within(trail).getByText("LLM keys").getAttribute("aria-current"),
    ).toBe("page");
  });

  // #1108: code-review.com renders this page as it always did
  it("is the settings page called LLM, with its tabs, where it is not a place of Setup", () => {
    render(llm(false));

    expect(screen.getByRole("heading", { level: 1, name: "LLM" })).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).toBeTruthy();
    const trail = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(trail).getByRole("link", { name: "Settings" })).toBeTruthy();
  });
});

describe("the review defaults page, read only (#1108)", () => {
  const defaults = (props: { canEdit?: boolean; readOnlyNote?: string }) => (
    <GlobalSettingsPageContent
      product={PRODUCT}
      workspaceSlug="acme"
      data={GLOBAL_DATA}
      {...props}
    />
  );

  // #1108: the factory shows the defaults and an AI sets them through the API
  it("shows the note in place of Save, and offers neither a reset of the defaults nor a change", () => {
    render(
      defaults({
        canEdit: false,
        readOnlyNote: "An AI sets these through the API.",
      }),
    );

    expect(screen.getByText("An AI sets these through the API.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Reset every default/ }),
    ).toBeNull();
  });

  // #1108: the guard of code-review.com
  it("keeps Save and no note where the person may edit", () => {
    render(defaults({ canEdit: true }));

    expect(screen.getByRole("button", { name: /Save/ })).toBeTruthy();
    expect(screen.queryByText("An AI sets these through the API.")).toBeNull();
  });
});

describe("the review defaults page (#656)", () => {
  // #656-T06
  it("has the same sections as a project: Review, LLM, Trigger and Limits, with the kind and verdict as defaults and no skill", () => {
    render(
      <GlobalSettingsPageContent
        product={getProductIdentity()}
        workspaceSlug="acme"
        data={GLOBAL_DATA}
      />,
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Review",
      "LLM",
      "Trigger",
      "Limits",
    ]);
    // #676-T01: the kind and the verdict are workspace defaults now; the skill stays a project's.
    expect(
      screen.getByRole("radiogroup", { name: "Review kind" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", { name: "Review verdict" }),
    ).toBeTruthy();
    expect(screen.queryByText("Review skill")).toBeNull();
  });
});

describe("the review defaults of a workspace that uses the instance's key (#283)", () => {
  // #676-T01
  it("offers the choice of the catalog, like a project, and no model name", async () => {
    const user = userEvent.setup();
    render(
      <GlobalSettingsPageContent
        product={getProductIdentity()}
        workspaceSlug="acme"
        data={{
          model: managedModel({ mode: "global" }),
          dynamicReviewEnabled: true,
        }}
      />,
    );

    await openSection(user, "LLM");
    expect(screen.queryByText(/chosen for each project/)).toBeNull();
    expect(screen.getByRole("combobox", { name: "Provider" }).textContent).toBe(
      "Default",
    );
    expect(screen.getByText("Billed via code-review.com")).toBeTruthy();
    await chooseOption(
      user,
      screen.getByRole("combobox", { name: "Provider" }),
      "OpenAI",
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
    expect(screen.queryByLabelText("Fallback model")).toBeNull();
    expect(document.body.innerHTML).not.toContain(BUILT_IN.model);
  });
});
