// SPDX-License-Identifier: LicenseRef-Proprietary

// What the queue's hook for ended claims does about write tokens (#790), and that the server's queue is wired to it.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { GitTokenEntry } from "./claimed-keys.ts";
import { createWriteTokens, endedClaimsReaction } from "./write-token.ts";

function setup(options: { allowed?: boolean; failWith?: Error } = {}) {
  const revokeEnded = vi.fn<(jobIds: readonly string[]) => Promise<void>>(
    async () => undefined,
  );
  const error = vi.fn();
  const scheduled: (() => Promise<void>)[] = [];
  const react = endedClaimsReaction({
    allowed: () => {
      if (options.failWith !== undefined) throw options.failWith;
      return options.allowed ?? true;
    },
    schedule: (work) => {
      scheduled.push(work);
    },
    tokens: () => ({ revokeEnded }),
    logger: { info: vi.fn(), error },
  });
  return { react, revokeEnded, error, scheduled };
}

describe("the write tokens of ended claims", () => {
  // #790
  it("switches the tokens of the ended claims off after the response, not before", async () => {
    const t = setup();

    t.react(["job-1", "job-2"]);

    expect(t.revokeEnded).not.toHaveBeenCalled();
    await t.scheduled[0]!();
    expect(t.revokeEnded).toHaveBeenCalledWith(["job-1", "job-2"]);
  });

  // #790
  it("does nothing for no job, and nothing in a deployment without the Implementer", () => {
    const none = setup();
    none.react([]);
    const code = setup({ allowed: false });
    code.react(["job-1"]);

    expect(none.scheduled).toEqual([]);
    expect(code.scheduled).toEqual([]);
  });

  // #790
  it("never throws, and says so in the log without a message, when the deployment cannot be read", () => {
    const t = setup({ failWith: new Error("PRODUCT_ID is wrong: secret") });

    expect(() => t.react(["job-1"])).not.toThrow();

    expect(t.error).toHaveBeenCalledWith(
      "[runner-api] WRITE_TOKEN_REVOKE_FAILED",
    );
  });

  // #790: the server's queue is wired to it (the wiring needs a database, so it is pinned here).
  it("is what the queue of the server calls when a claim ends", () => {
    const source = readFileSync(
      new URL("../jobs/shared.ts", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(
      /onClaimsEnded:\s*\(jobIds\)\s*=>\s*\{[^}]*revokeTokensOfEndedClaims\(jobIds\);/,
    );
  });
});

// #1092 (review findings 4 and 5): a turn on several repositories holds one token for each installation; every one is switched off,
// each through the connection that made it, and one that fails stays in the ledger and is tried again.
describe("the write tokens of a turn on several repositories", () => {
  const LATER = "2999-01-01T00:00:00.000Z";
  const JOB = {
    id: "job-1",
    reviewKind: "implementer",
    workspaceId: "w-1",
    repositoryId: "r-1",
  } as const;

  function setup(
    ledger: GitTokenEntry[],
    options: { firstRepositoryGone?: boolean; failing?: string[] } = {},
  ) {
    const held = [...ledger];
    const calls: Array<{ integrationId: string; token: string }> = [];
    const failing = new Set(options.failing ?? []);
    const tokens = createWriteTokens({
      repositories: () => ({
        get: async () =>
          options.firstRepositoryGone === true
            ? undefined
            : ({ id: "r-1", integrationId: "i-1" } as never),
      }),
      integrations: () => ({
        get: async (id: string) => ({ id, type: "github_app" }) as never,
      }),
      registry: {
        resolve: () => ({
          revokeImplementerAccess: async (
            integration: { id: string },
            token: string,
          ) => {
            calls.push({ integrationId: integration.id, token });
            return !failing.has(token);
          },
        }),
      } as never,
      claimedKeys: {
        rememberGitToken: async () => undefined,
        gitTokensOf: async () => [...held],
        forgetGitTokens: async (
          _jobId: string,
          forgotten: readonly string[],
        ) => {
          for (const token of forgotten) {
            const index = held.findIndex((entry) => entry.token === token);
            if (index >= 0) held.splice(index, 1);
          }
        },
      },
      rows: {
        implementerJobs: async () => [],
        endedImplementerJobsWithRows: async () => [JOB as never],
      },
      logger: { info: vi.fn(), error: vi.fn() },
      now: () => new Date("2026-11-18T12:00:00.000Z"),
    });
    return { tokens, calls, held };
  }

  // #1092-T90
  it("switches every token off, each through the connection that made it", async () => {
    const t = setup([
      { token: "tok-a", expiresAt: LATER, integrationId: "i-1" },
      { token: "tok-b", expiresAt: LATER, integrationId: "i-2" },
    ]);

    await t.tokens.revokeAllOf(JOB);

    expect(t.calls).toEqual([
      { integrationId: "i-1", token: "tok-a" },
      { integrationId: "i-2", token: "tok-b" },
    ]);
    expect(t.held).toEqual([]);
  });

  // #1092-T91
  it("still switches them off when the first repository of the job is gone, and uses its connection only for a token that names none", async () => {
    const t = setup(
      [
        { token: "tok-a", expiresAt: LATER, integrationId: "i-2" },
        { token: "tok-b", expiresAt: LATER, integrationId: "i-3" },
      ],
      { firstRepositoryGone: true },
    );

    await t.tokens.revokeAllOf(JOB);

    expect(t.calls.map((call) => call.integrationId)).toEqual(["i-2", "i-3"]);
    expect(t.held).toEqual([]);

    const old = setup([{ token: "tok-old", expiresAt: LATER }]);
    await old.tokens.revokeAllOf(JOB);
    expect(old.calls).toEqual([{ integrationId: "i-1", token: "tok-old" }]);
  });

  // #1092-T92
  it("keeps the token that could not be switched off in the ledger, and the next try is for that one only", async () => {
    const t = setup(
      [
        { token: "tok-a", expiresAt: LATER, integrationId: "i-1" },
        { token: "tok-b", expiresAt: LATER, integrationId: "i-2" },
      ],
      { failing: ["tok-b"] },
    );

    await t.tokens.revokeAllOf(JOB);
    expect(t.held.map((entry) => entry.token)).toEqual(["tok-b"]);

    t.calls.length = 0;
    await t.tokens.retryPending();
    expect(t.calls).toEqual([{ integrationId: "i-2", token: "tok-b" }]);
  });
});
