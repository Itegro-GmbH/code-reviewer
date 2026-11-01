// SPDX-License-Identifier: LicenseRef-Proprietary

// What the queue's hook for ended claims does about write tokens (#790), and that the server's queue is wired to it.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { endedClaimsReaction } from "./write-token.ts";

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
