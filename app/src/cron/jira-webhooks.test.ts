// SPDX-License-Identifier: LicenseRef-Proprietary

// The nightly Jira webhook job (#1039): the credential, the skip, the counts, one failure never stopping the others, and the budget.
import { describe, expect, it } from "vitest";
import type { ReconcileResult } from "../jira/webhook-registrar.ts";
import {
  handleJiraWebhooksCron,
  type JiraWebhooksCronDependencies,
} from "./jira-webhooks.ts";

const SECRET = "s".repeat(40);
const TARGETS = ["a", "b", "c", "d"].map((id) => ({
  workspaceId: "ws",
  projectId: id,
}));

function run(
  results: Record<string, ReconcileResult | Error>,
  over: Partial<JiraWebhooksCronDependencies> = {},
  authorization: string | null = `Bearer ${SECRET}`,
) {
  const lines: string[] = [];
  const seen: string[] = [];
  const response = handleJiraWebhooksCron(
    new Request("https://factory.example.test/api/internal/jira-webhooks", {
      headers: authorization === null ? {} : { authorization },
    }),
    {
      env: { CRON_SECRET: SECRET },
      enabled: () => true,
      targets: async () => TARGETS,
      reconcile: async (_workspaceId, projectId) => {
        seen.push(projectId);
        const result = results[projectId] ?? { outcome: "unchanged" };
        if (result instanceof Error) throw result;
        return result;
      },
      log: (line) => lines.push(line),
      ...over,
    },
  );
  return { response, lines, seen };
}

describe("the nightly Jira webhook job", () => {
  // #1039
  it("is refused without the cron's credential and does nothing", async () => {
    for (const authorization of [null, "Bearer wrong", `Bearer ${SECRET}x`]) {
      const { response, seen } = run({}, {}, authorization);
      expect((await response).status).toBe(401);
      expect(seen).toEqual([]);
    }
  });

  // #1039
  it("skips where the factory or the Atlassian settings are missing", async () => {
    const { response, seen } = run({}, { enabled: () => false });
    expect(await (await response).json()).toEqual({
      status: "skipped",
      reason: "not_enabled",
    });
    expect(seen).toEqual([]);
  });

  // #1039-T03
  it("counts what each webhook came to and never lets one failure stop the others", async () => {
    const { response, lines, seen } = run({
      a: { outcome: "extended" },
      b: { outcome: "failed", error: "jira_unavailable" },
      c: new Error("db gone: postgres://secret@host/db"),
      d: { outcome: "registered" },
    });
    expect(await (await response).json()).toEqual({
      status: "ok",
      webhooks: 4,
      registered: 1,
      extended: 1,
      unchanged: 0,
      removed: 0,
      failed: 2,
      deferred: 0,
    });
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(lines.join("\n")).not.toContain("postgres://");
  });

  // #1039
  it("defers what its budget does not reach", async () => {
    let clock = 0;
    const { response, seen } = run(
      {},
      {
        budgetMs: 100,
        now: () => clock,
        reconcile: async (_workspaceId, projectId) => {
          clock += 60;
          return { outcome: "unchanged", ...(projectId === "" ? {} : {}) };
        },
      },
    );
    expect(await (await response).json()).toMatchObject({
      webhooks: 4,
      unchanged: 2,
      deferred: 2,
    });
    expect(seen).toEqual([]);
  });

  // #1039
  it("answers 500 with a code when the webhooks cannot be listed", async () => {
    const { response } = run(
      {},
      {
        targets: async () => {
          throw new Error("postgres://secret@host/db");
        },
      },
    );
    const answer = await response;
    expect(answer.status).toBe(500);
    expect(await answer.json()).toEqual({
      status: "error",
      code: "JIRA_WEBHOOKS_CRON_FAILED",
    });
  });
});
