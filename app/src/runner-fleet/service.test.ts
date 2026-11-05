// SPDX-License-Identifier: LicenseRef-Proprietary

// The runners page's service (#854), with a fake repository.
import { describe, expect, it } from "vitest";
import type {
  RunnersRepository,
  StoredRunner,
} from "../db/repositories/runners-repository.ts";
import { RunnerFleetError } from "./errors.ts";
import {
  createRunnerFleetService,
  OPEN_TOKENS_PER_WORKSPACE_MAX,
  statusOf,
} from "./service.ts";
import {
  hashSecret,
  REGISTRATION_TOKEN_PATTERN,
} from "../runner-identity/tokens.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const SETTINGS = { minBaseVersion: null, onlineWithinSeconds: 120 };

function runner(change: Partial<StoredRunner> = {}): StoredRunner {
  return {
    id: "r1",
    workspaceId: "w1",
    name: "box",
    labels: ["linux"],
    baseVersion: "1.2.0",
    manifest: { harnesses: {}, capabilities: [] },
    limits: {},
    createdAt: "2026-11-05T10:00:00.000Z",
    lastSeenAt: "2026-11-05T11:59:30.000Z",
    revokedAt: null,
    ...change,
  };
}

function fakeRepository(
  stored: StoredRunner[] = [],
  tokensOpen = 0,
): RunnersRepository & {
  tokens: Array<{ tokenHash: string; expiresAt: Date }>;
} {
  const tokens: Array<{ tokenHash: string; expiresAt: Date }> = [];
  return {
    tokens,
    list: async () => stored,
    createToken: async (token, maximum) => {
      if (tokensOpen + tokens.length >= maximum)
        return { ok: false, reason: "limit_reached" };
      tokens.push({ tokenHash: token.tokenHash, expiresAt: token.expiresAt });
      return { ok: true, id: "t1", expiresAt: token.expiresAt.toISOString() };
    },
    revoke: async (id) => stored.some((entry) => entry.id === id),
  };
}

describe("the state of a runner", () => {
  // #854-T40
  it("is online when it was heard from lately, offline when not", () => {
    expect(statusOf(runner(), NOW, SETTINGS)).toBe("online");
    expect(
      statusOf(
        runner({ lastSeenAt: "2026-11-05T11:58:00.000Z" }),
        NOW,
        SETTINGS,
      ),
    ).toBe("online");
    expect(
      statusOf(
        runner({ lastSeenAt: "2026-11-05T11:57:59.000Z" }),
        NOW,
        SETTINGS,
      ),
    ).toBe("offline");
    expect(statusOf(runner({ lastSeenAt: "garbage" }), NOW, SETTINGS)).toBe(
      "offline",
    );
  });

  // #854-T41
  it("needs an update when it is online below the minimum, and is offline when it is not there", () => {
    const settings = { ...SETTINGS, minBaseVersion: "1.3.0" };

    expect(statusOf(runner(), NOW, settings)).toBe("update_needed");
    expect(statusOf(runner({ baseVersion: "1.3.0" }), NOW, settings)).toBe(
      "online",
    );
    expect(
      statusOf(
        runner({ lastSeenAt: "2026-11-05T09:00:00.000Z" }),
        NOW,
        settings,
      ),
    ).toBe("offline");
  });
});

describe("the runner fleet service", () => {
  // #854-T42
  it("lists the runners with their state and the minimum", async () => {
    const service = createRunnerFleetService({
      runners: fakeRepository([runner()]),
      settings: () => ({ ...SETTINGS, minBaseVersion: "1.0.0" }),
      now: () => NOW,
    });

    const list = await service.list();

    expect(list.minBaseVersion).toBe("1.0.0");
    expect(list.onlineWithinSeconds).toBe(120);
    expect(list.runners).toEqual([
      expect.objectContaining({ id: "r1", name: "box", status: "online" }),
    ]);
  });

  // #854-T43
  it("makes a token that lasts an hour and keeps only its hash", async () => {
    const repository = fakeRepository();
    const service = createRunnerFleetService({
      runners: repository,
      settings: () => SETTINGS,
      now: () => NOW,
    });

    const made = await service.createToken({ id: "u1" });

    expect(made.token).toMatch(REGISTRATION_TOKEN_PATTERN);
    expect(made.expiresAt).toBe("2026-11-05T13:00:00.000Z");
    expect(repository.tokens).toEqual([
      {
        tokenHash: hashSecret(made.token),
        expiresAt: new Date("2026-11-05T13:00:00.000Z"),
      },
    ]);
    expect(JSON.stringify(repository.tokens)).not.toContain(made.token);
  });

  // #854-T44
  it("refuses a token when the workspace holds the most unused ones", async () => {
    const service = createRunnerFleetService({
      runners: fakeRepository([], OPEN_TOKENS_PER_WORKSPACE_MAX),
      settings: () => SETTINGS,
      now: () => NOW,
    });

    await expect(service.createToken({ id: "u1" })).rejects.toMatchObject({
      code: "RUNNER_FLEET_TOKEN_LIMIT_REACHED",
      maximum: OPEN_TOKENS_PER_WORKSPACE_MAX,
    });
  });

  // #854-T45
  it("revokes a runner of the workspace and answers not found for any other id", async () => {
    const service = createRunnerFleetService({
      runners: fakeRepository([runner()]),
      settings: () => SETTINGS,
      now: () => NOW,
    });

    await expect(service.revoke("r1")).resolves.toBeUndefined();
    for (const id of ["nope", "", "x".repeat(129), "a\u0000b"])
      await expect(service.revoke(id)).rejects.toBeInstanceOf(RunnerFleetError);
    await expect(service.revoke("nope")).rejects.toMatchObject({
      code: "RUNNER_FLEET_NOT_FOUND",
    });
  });
});
