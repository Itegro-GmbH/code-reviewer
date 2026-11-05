// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: the inputs of an action once its references are resolved, held to the connector's spec.
import { describe, expect, it } from "vitest";
import {
  GITHUB_ISSUE_COMMENT,
  GITHUB_ISSUE_LABELS,
  GITHUB_PULL_REQUEST_OPEN,
} from "../workflows/connectors.ts";
import {
  ActionInputError,
  createConnectorRegistry,
  resolveActionInputs,
  specOf,
} from "./connectors.ts";
import { TemplateError, type RunValues } from "./templates.ts";

const values: RunValues = {
  trigger: {
    input: { issueNo: 7, bad: 0, labels: ["x", "y"], label: "z", base: "dev" },
  },
  steps: { work: { branch: "workflow/r/work", summary: "Done." } },
};

function failure(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected a failure");
}

describe("the inputs of an action", () => {
  // #844-T200
  it("resolves the inputs of a pull request: a text with references, a branch, a flag", () => {
    expect(
      resolveActionInputs(
        {
          head: "{{work.branch}}",
          base: "{{trigger.input.base}}",
          title: "Work: {{work.summary}}",
          draft: true,
        },
        GITHUB_PULL_REQUEST_OPEN,
        values,
      ),
    ).toEqual({
      head: "workflow/r/work",
      base: "dev",
      title: "Work: Done.",
      draft: true,
    });
  });

  // #844-T201
  it("keeps the type of an issue number and holds it to a positive whole number again", () => {
    const comment = (issue: unknown) =>
      resolveActionInputs({ issue, body: "Hi" }, GITHUB_ISSUE_COMMENT, values);
    expect(comment("{{trigger.input.issueNo}}")).toEqual({
      issue: 7,
      body: "Hi",
    });
    expect(comment(12)).toEqual({ issue: 12, body: "Hi" });
    expect(comment({ number: 5 })).toEqual({ issue: 5, body: "Hi" });
    for (const bad of ["{{trigger.input.bad}}", 0, -3, 1.5, 2 ** 31, "seven"])
      expect(failure(() => comment(bad))).toBeInstanceOf(ActionInputError);
  });

  // #844-T202
  it("takes labels as a list: the whole list or entries, and needs at least one", () => {
    expect(
      resolveActionInputs(
        {
          issue: 7,
          add: "{{trigger.input.labels}}",
          remove: ["{{trigger.input.label}}", "old"],
        },
        GITHUB_ISSUE_LABELS,
        values,
      ),
    ).toEqual({ issue: 7, add: ["x", "y"], remove: ["z", "old"] });
    expect(
      failure(() =>
        resolveActionInputs(
          { issue: 7, add: [], remove: [] },
          GITHUB_ISSUE_LABELS,
          values,
        ),
      ),
    ).toBeInstanceOf(ActionInputError);
    expect(
      failure(() =>
        resolveActionInputs(
          { issue: 7, add: [3] },
          GITHUB_ISSUE_LABELS,
          values,
        ),
      ),
    ).toBeInstanceOf(ActionInputError);
  });

  // #844-T203
  it("refuses a missing input, and a reference to a value the run does not have", () => {
    expect(
      failure(() =>
        resolveActionInputs({ title: "x" }, GITHUB_PULL_REQUEST_OPEN, values),
      ).message,
    ).toBe("head is missing.");
    expect(
      failure(() =>
        resolveActionInputs(
          { head: "{{work.nothing}}", title: "x" },
          GITHUB_PULL_REQUEST_OPEN,
          values,
        ),
      ),
    ).toBeInstanceOf(TemplateError);
  });

  // #844-T204
  it("knows the three connectors of the format and finds only the ones registered", () => {
    expect(specOf("github.issue.comment")).toBe(GITHUB_ISSUE_COMMENT);
    expect(specOf("slack.message")).toBeUndefined();
    const registry = createConnectorRegistry([
      { name: "github.issue.comment", run: async () => ({ url: "u" }) },
    ]);
    expect(registry.get("github.issue.comment")).toBeDefined();
    expect(registry.get("github.pullRequest.open")).toBeUndefined();
    expect(
      createConnectorRegistry().get("github.issue.comment"),
    ).toBeUndefined();
  });
});
