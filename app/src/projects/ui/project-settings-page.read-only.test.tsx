// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The settings page of a project hands the form what the factory needs (#1108): `readOnly` and the note go through to the form, and a page
// that is given neither leaves the form editable (code-review.com). The form itself is a stub here that shows the props it got; what the
// form does with them is proven in `settings-form.test.tsx` and `review-kind-card.test.tsx`.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../review-settings/ui/settings-form.tsx", () => ({
  SettingsForm: (props: { readOnly?: boolean; readOnlyNote?: string }) => (
    <p data-testid="form">
      {JSON.stringify({
        readOnly: props.readOnly,
        readOnlyNote: props.readOnlyNote ?? null,
      })}
    </p>
  ),
}));
vi.mock("./project-page-header.tsx", () => ({
  ProjectPageHeader: () => null,
}));

import { describeConfigStatus } from "../../config-status/status.ts";
import { getProductIdentity } from "../../product-identity/current.ts";
import { testGithubAppStatus } from "../../test-support/github-app.ts";
import {
  ProjectSettingsPageContent,
  type ProjectSettingsPageData,
} from "./project-settings-page.tsx";

afterEach(cleanup);

const DATA = {
  kind: "ready",
  row: { repositoryId: "repo-1", status: "active" },
  model: {},
  config: describeConfigStatus({}, testGithubAppStatus()),
  dynamicReviewEnabled: true,
} as unknown as Extract<ProjectSettingsPageData, { kind: "ready" }>;

function formProps(): { readOnly: boolean; readOnlyNote: string | null } {
  return JSON.parse(screen.getByTestId("form").textContent ?? "{}") as {
    readOnly: boolean;
    readOnlyNote: string | null;
  };
}

describe("the settings page of a project, read only (#1108)", () => {
  // #1108
  it("hands the form readOnly and the note it is given", () => {
    render(
      <ProjectSettingsPageContent
        product={getProductIdentity()}
        workspaceSlug="acme"
        data={DATA}
        readOnly
        readOnlyNote="An AI sets these through the API."
      />,
    );

    expect(formProps()).toEqual({
      readOnly: true,
      readOnlyNote: "An AI sets these through the API.",
    });
  });

  // #1108: the guard of code-review.com
  it("leaves the form editable, with no note, when it is given neither", () => {
    render(
      <ProjectSettingsPageContent
        product={getProductIdentity()}
        workspaceSlug="acme"
        data={DATA}
      />,
    );

    expect(formProps()).toEqual({ readOnly: false, readOnlyNote: null });
  });
});
