// SPDX-License-Identifier: LicenseRef-Proprietary

// The scope lookup of the workflow service (#927): the body is checked, the workspace's profiles decide what an agent step yields, and the
// samples come from the run of the workflow that was named. The repositories are fakes; the rules are the validator's (reach.test.ts).
import { describe, expect, it, vi } from "vitest";
import { WorkflowError } from "./errors.ts";
import { createWorkflowService, type WorkflowService } from "./service.ts";

function serviceWith(
  samples?: Parameters<typeof createWorkflowService>[0]["samples"],
): WorkflowService {
  return createWorkflowService({
    workflows: {} as never,
    projects: {} as never,
    environments: {
      listSummaries: async () => [{ name: "node" }],
    } as never,
    profiles: {
      list: async () => [{ id: "p1", name: "implementer", version: 1 }],
      versionFacts: async () => [
        {
          profileId: "p1",
          version: 1,
          canPush: true,
          defaultResult: null,
          managedModel: false,
          harness: "claude-code",
          environmentId: null,
        },
      ],
      archivedNames: async () => [],
    } as never,
    ...(samples === undefined ? {} : { samples }),
  });
}

const DOCUMENT = {
  version: 1,
  name: "Scope",
  triggers: [{ id: "labeled", kind: "ticket.labeled", label: "go" }],
  steps: [
    {
      id: "implement",
      kind: "agent",
      profile: "implementer@1",
      environment: "node",
      instruction: "x",
    },
    {
      id: "tell",
      kind: "action",
      connector: "github.issue.comment",
      issue: "{{trigger.ticket}}",
      body: "x",
    },
  ],
};

async function refusal(work: Promise<unknown>): Promise<WorkflowError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof WorkflowError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the scope lookup of the service", () => {
  // #927-T21
  it("lists what the step can reach for the document in the body, without samples when none were asked for", async () => {
    const answer = await serviceWith().scope({
      document: DOCUMENT,
      at: "/steps/1",
    });

    expect(answer.sampled).toBe(false);
    expect(answer.at).toBe("/steps/1");
    const found = answer.entries.map((entry) => entry.reference);
    expect(found).toContain("trigger.ticket.title");
    expect(found).toContain("implement.costUsd");
    expect(answer.entries.every((entry) => entry.sample === undefined)).toBe(
      true,
    );
  });

  // #927-T22
  it("holds a target input to the roots it takes", async () => {
    const answer = await serviceWith().scope({
      document: DOCUMENT,
      at: "/steps/1",
      targetRoots: ["ticket"],
    });

    expect(answer.entries.map((entry) => entry.reference)).toEqual([
      "trigger.ticket",
      "trigger.ticket.number",
    ]);
  });

  // #927-T23
  it("takes the samples of the workflow that was named, and only that", async () => {
    const samples = vi.fn(async (id: string) =>
      id === "wf-1" ? { trigger: { ticket: { title: "Crash" } } } : undefined,
    );
    const service = serviceWith(samples);

    const named = await service.scope({
      document: DOCUMENT,
      at: "/steps/1",
      workflowId: "wf-1",
    });
    const other = await service.scope({
      document: DOCUMENT,
      at: "/steps/1",
      workflowId: "wf-2",
    });
    const none = await service.scope({ document: DOCUMENT, at: "/steps/1" });

    expect(
      named.entries.find((entry) => entry.reference === "trigger.ticket.title")
        ?.sample,
    ).toBe("Crash");
    expect([named.sampled, other.sampled, none.sampled]).toEqual([
      true,
      false,
      false,
    ]);
    expect(samples).toHaveBeenCalledTimes(2);
  });

  // #927-T24
  it("refuses a body without a pointer, a pointer that is no step and a root the format does not have, naming what is wrong", async () => {
    const service = serviceWith();

    const noAt = await refusal(service.scope({ document: DOCUMENT }));
    const noStep = await refusal(
      service.scope({ document: DOCUMENT, at: "/steps/9" }),
    );
    const badRoot = await refusal(
      service.scope({
        document: DOCUMENT,
        at: "/steps/1",
        targetRoots: ["nope"],
      }),
    );

    expect(noAt.code).toBe("WORKFLOW_REQUEST_INVALID");
    expect(noAt.issues[0]).toMatchObject({ path: "at", code: "body_invalid" });
    expect(noStep.issues[0]).toMatchObject({
      path: "at",
      code: "scope_at_unknown",
    });
    expect(badRoot.issues[0]).toMatchObject({
      path: "targetRoots",
      code: "scope_target_unknown",
    });
    expect(badRoot.issues[0]?.available).toContain("ticket");
  });
});
