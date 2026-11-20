// SPDX-License-Identifier: LicenseRef-Proprietary

// #1105: the models that agent steps with settings of their own name are looked up once each, by the rule of the Implementer form, and the
// validator refuses the ones the workspace cannot run (`model_not_allowed`), exactly as a profile's model is refused when it is saved.
import { describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { createWorkflowService } from "./service.ts";

const MANAGED: ModelChoice = { entryId: "entry-1" };
const OWN: ModelChoice = { provider: "anthropic", model: "claude-sonnet-5-5" };

function serviceWith(check?: (model: ModelChoice) => Promise<string | null>) {
  return createWorkflowService({
    workflows: {} as never,
    projects: {} as never,
    environments: {
      listSummaries: async () => [{ name: "node", kind: "hosted" }],
    } as never,
    profiles: {
      list: async () => [],
      versionFacts: async () => [],
      archivedNames: async () => [],
    } as never,
    ...(check === undefined ? {} : { models: { check: check as never } }),
  });
}

function document(...models: ModelChoice[]) {
  return {
    version: 1,
    name: "Models",
    triggers: [{ id: "labeled", kind: "ticket.labeled", label: "go" }],
    steps: models.map((model, index) => ({
      id: `work${index}`,
      kind: "agent",
      model,
      canPush: false,
      environment: "node",
      instruction: "x",
    })),
  };
}

describe("the model of a step with settings of its own, in the service", () => {
  // #1105-T50
  it("refuses a model the workspace cannot run, at that step's model, and asks once for a model named twice", async () => {
    const check = vi.fn(async (model: ModelChoice) =>
      "entryId" in model ? "not_enabled" : null,
    );

    const checked = await serviceWith(check).validate(
      document(OWN, MANAGED, OWN, MANAGED),
    );

    expect(checked.valid).toBe(false);
    expect(checked.errors.map((e) => [e.path, e.code])).toEqual([
      ["/steps/1/model", "model_not_allowed"],
      ["/steps/3/model", "model_not_allowed"],
    ]);
    expect(checked.errors[0]?.message).toContain("not_enabled");
    expect(check).toHaveBeenCalledTimes(2);
  });

  // #1105-T51
  it("accepts a model the workspace can run, and checks no model when the service has no rule", async () => {
    expect(
      (await serviceWith(async () => null).validate(document(OWN, MANAGED)))
        .valid,
    ).toBe(true);
    expect((await serviceWith().validate(document(MANAGED))).valid).toBe(true);
  });
});
