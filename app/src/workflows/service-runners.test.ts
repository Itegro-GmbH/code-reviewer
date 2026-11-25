// SPDX-License-Identifier: LicenseRef-Proprietary

// #1105 (ADR 0007): the runners a step names are read by the service for the validator: the list (hosted runners, then the self-hosted ones
// that are not revoked), and a revoked runner the document names by id, found one by one, so the answer is "revoked" and not "unknown".
import { describe, expect, it, vi } from "vitest";
import type { NamedRunner } from "../named-runners/types.ts";
import { createWorkflowService } from "./service.ts";

const HOSTED: NamedRunner = {
  kind: "hosted",
  id: "h-4",
  name: "Vercel Sandbox 4 vCPU",
  vcpus: 4,
  placement: "vercel",
  available: true,
  concurrency: 2,
};
const DEVBOX: NamedRunner = {
  kind: "self_hosted",
  id: "r-devbox",
  name: "DevBox",
  labels: [],
  baseVersion: "1.0.0",
  manifest: { harnesses: [], capabilities: [] },
  limits: {},
  lastSeenAt: "2026-11-21T00:00:00.000Z",
  revokedAt: null,
};
const REVOKED: NamedRunner = {
  ...DEVBOX,
  id: "r-old",
  name: "Old box",
  revokedAt: "2026-11-20T00:00:00.000Z",
};

function serviceWith(
  find = vi.fn(async (id: string) =>
    [HOSTED, DEVBOX, REVOKED].find((r) => r.id === id),
  ),
) {
  const list = vi.fn(async () => [HOSTED, DEVBOX]);
  const service = createWorkflowService({
    workflows: {} as never,
    projects: {} as never,
    environments: { listSummaries: async () => [] } as never,
    profiles: {
      list: async () => [],
      versionFacts: async () => [],
      archivedNames: async () => [],
    } as never,
    runners: { list, find },
  });
  return { service, list, find };
}

function document(...runners: unknown[]) {
  return {
    version: 1,
    name: "Runners",
    triggers: [{ id: "labeled", kind: "ticket.labeled", label: "go" }],
    steps: runners.map((runner, index) => ({
      id: `work${index}`,
      kind: "agent",
      model: { provider: "anthropic", model: "claude-sonnet-5-5" },
      canPush: false,
      runner,
      instruction: "x",
    })),
  };
}

describe("the runners of a step, in the service", () => {
  // #1105-R90
  it("accepts the ids of a hosted and a self-hosted runner without looking any up one by one", async () => {
    const { service, find } = serviceWith();

    const checked = await service.validate(document(HOSTED.id, DEVBOX.id));

    expect(checked.errors).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  // #1105-R91
  it("says a revoked runner is revoked (found by its id), and an id nobody has is unknown, listing only the runners that can be named", async () => {
    const { service, find } = serviceWith();

    const checked = await service.validate(document(REVOKED.id, "nowhere"));

    expect(checked.errors.map((e) => [e.path, e.code])).toEqual([
      ["/steps/0/runner", "runner_unknown"],
      ["/steps/1/runner", "runner_unknown"],
    ]);
    expect(checked.errors[0]?.message).toContain("revoked");
    expect(checked.errors[1]?.message).not.toContain("revoked");
    expect(checked.errors[1]?.available).toEqual([HOSTED.id, DEVBOX.id]);
    expect(find).toHaveBeenCalledWith(REVOKED.id);
    expect(find).toHaveBeenCalledWith("nowhere");
  });

  // #1105-R92
  it("looks nothing up for a value that is no id of a step, and nothing outside the places steps live", async () => {
    const { service, find } = serviceWith();

    await service.validate({
      ...document(5, null),
      description: [{ kind: "agent", runner: "fake" }],
    });

    expect(find).not.toHaveBeenCalled();
  });
});
