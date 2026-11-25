// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type {
  HostedRunner,
  SelfHostedRunner,
} from "../../../named-runners/types.ts";
import { RunnerFleetError } from "../../../runner-fleet/errors.ts";
import { call, contextWith, data, failure } from "../runs/test-support.ts";
import { namedRunnersService, runnerFleetService } from "./services.ts";

const hosted = (over: Partial<HostedRunner> = {}): HostedRunner => ({
  kind: "hosted",
  id: "h4",
  name: "Vercel Sandbox 4 vCPU",
  vcpus: 4,
  concurrency: 2,
  ...over,
});
const own = (over: Partial<SelfHostedRunner> = {}): SelfHostedRunner => ({
  kind: "self_hosted",
  id: "r1",
  name: "Luca's laptop",
  labels: ["linux"],
  baseVersion: "1.2.0",
  manifest: { harnesses: [], capabilities: [] },
  limits: {},
  lastSeenAt: "2026-11-25T09:59:00.000Z",
  revokedAt: null,
  ...over,
});
const view = (id: string, status = "online") => ({
  id,
  name: "x",
  labels: [],
  baseVersion: "1.2.0",
  manifest: { harnesses: [], capabilities: [] },
  limits: {},
  createdAt: "2026-11-01T00:00:00.000Z",
  lastSeenAt: "2026-11-25T09:59:00.000Z",
  status,
});

function setup(
  named: Record<string, unknown>,
  fleet: Record<string, unknown> = {},
  overrides: Parameters<typeof contextWith>[1] = {},
) {
  const base = {
    list: async () => ({
      runners: [view("r1")],
      minBaseVersion: null,
      onlineWithinSeconds: 120,
    }),
    ...fleet,
  };
  return contextWith(
    [
      [namedRunnersService as never, named],
      [runnerFleetService as never, base],
    ],
    overrides,
  );
}

describe("list_runners", () => {
  // #1147-T1
  it("lists the hosted runners AND the self-hosted ones with id, name, kind, placement, size and status", async () => {
    const answer = await data(
      "list_runners",
      setup(
        { list: async () => [hosted(), own()] },
        {},
        { role: "member", scopes: ["factory:read"] },
      ),
      {},
    );
    expect(answer.runners).toEqual([
      {
        id: "h4",
        name: "Vercel Sandbox 4 vCPU",
        kind: "hosted",
        placement: "vercel",
        vcpus: 4,
        concurrency: 2,
        status: "available",
      },
      {
        id: "r1",
        name: "Luca's laptop",
        kind: "self_hosted",
        placement: "self_hosted",
        status: "online",
        labels: ["linux"],
        baseVersion: "1.2.0",
        limits: {},
        lastSeenAt: "2026-11-25T09:59:00.000Z",
        createdAt: "2026-11-01T00:00:00.000Z",
      },
    ]);
  });

  // #1147-T2
  it("shows the placement a hosted runner carries (a later placement needs no change here)", async () => {
    const withPlacement = { ...hosted({ id: "c2" }), placement: "cloudflare" };
    const answer = await data(
      "list_runners",
      setup({ list: async () => [withPlacement as never] }),
      {},
    );
    expect(answer.runners).toMatchObject([
      { id: "c2", placement: "cloudflare" },
    ]);
  });

  // #1147-T3
  it("a self-hosted runner the fleet does not list is offline, and the same ids the validator offers come back", async () => {
    const answer = await data(
      "list_runners",
      setup(
        { list: async () => [own({ id: "r9" })] },
        {
          list: async () => ({
            runners: [],
            minBaseVersion: null,
            onlineWithinSeconds: 120,
          }),
        },
      ),
      {},
    );
    expect(answer.runners).toMatchObject([{ id: "r9", status: "offline" }]);
  });
});

describe("get_runner", () => {
  // #1147-T4
  it("answers one runner with its manifest, a revoked one as revoked, an unknown one as not_found", async () => {
    const find = vi.fn(async (id: string) =>
      id === "r1"
        ? own({ manifest: { harnesses: [], capabilities: ["docker"] } })
        : id === "r2"
          ? own({ id: "r2", revokedAt: "2026-11-20T00:00:00.000Z" })
          : undefined,
    );
    const context = setup({ find });
    expect(await data("get_runner", context, { runnerId: "r1" })).toMatchObject(
      {
        runner: {
          id: "r1",
          status: "online",
          manifest: { capabilities: ["docker"] },
        },
      },
    );
    expect(await data("get_runner", context, { runnerId: "r2" })).toMatchObject(
      {
        runner: { status: "revoked", revokedAt: "2026-11-20T00:00:00.000Z" },
      },
    );
    expect(
      await failure("get_runner", context, { runnerId: "zz" }),
    ).toMatchObject({
      error: "not_found",
    });
  });
});

describe("update_runner", () => {
  // #1147-T5
  it("renames a self-hosted runner through the fleet service", async () => {
    const rename = vi.fn(async () => undefined);
    const find = vi
      .fn()
      .mockResolvedValueOnce(own())
      .mockResolvedValueOnce(own({ name: "Build box" }));
    const answer = await data("update_runner", setup({ find }, { rename }), {
      runnerId: "r1",
      name: "Build box",
    });
    expect(rename).toHaveBeenCalledWith("r1", "Build box");
    expect(answer).toMatchObject({ runner: { id: "r1", name: "Build box" } });
  });

  // #1147-T6
  it("refuses a hosted or revoked runner, maps a taken or invalid name, and is for Owners and Admins", async () => {
    const find = async (id: string) =>
      id === "h4"
        ? hosted()
        : id === "rv"
          ? own({ id: "rv", revokedAt: "2026-11-20T00:00:00.000Z" })
          : own();
    const taken = async () => {
      throw new RunnerFleetError("RUNNER_FLEET_NAME_TAKEN", "taken");
    };
    const context = setup({ find }, { rename: taken });
    expect(
      await failure("update_runner", context, { runnerId: "h4", name: "x" }),
    ).toMatchObject({ error: "invalid_input" });
    expect(
      await failure("update_runner", context, { runnerId: "rv", name: "x" }),
    ).toMatchObject({ error: "conflict" });
    expect(
      await failure("update_runner", context, { runnerId: "r1", name: "x" }),
    ).toMatchObject({
      error: "conflict",
      code: "RUNNER_FLEET_NAME_TAKEN",
    });
    const member = setup({ find }, {}, { role: "member" });
    expect(
      await failure("update_runner", member, { runnerId: "r1", name: "x" }),
    ).toMatchObject({ error: "forbidden" });
    const readOnly = setup({ find }, {}, { scopes: ["factory:read"] });
    expect(
      (await call("update_runner", readOnly, { runnerId: "r1", name: "x" })).ok,
    ).toBe(false);
  });
});

describe("create_runner_token", () => {
  // #1147-T7
  it("returns the single-use token once with its expiry, for the person of the token", async () => {
    const createToken = vi.fn(async () => ({
      token: "rt_secret",
      expiresAt: "2026-11-25T11:00:00.000Z",
    }));
    const answer = await data(
      "create_runner_token",
      setup({}, { createToken }),
      {},
    );
    expect(createToken).toHaveBeenCalledWith({ id: "user-ada" });
    expect(answer).toEqual({
      token: "rt_secret",
      expiresAt: "2026-11-25T11:00:00.000Z",
      singleUse: true,
      registerUrl: "https://factory.example.test/api/runners/v1/register",
    });
  });

  // #1147-T8
  it("maps the token limit to limit_reached with the maximum, and a Member to forbidden", async () => {
    const createToken = async () => {
      throw new RunnerFleetError("RUNNER_FLEET_TOKEN_LIMIT_REACHED", "full", {
        maximum: 20,
      });
    };
    expect(
      await failure("create_runner_token", setup({}, { createToken }), {}),
    ).toMatchObject({
      error: "limit_reached",
      maximum: 20,
    });
    expect(
      await failure(
        "create_runner_token",
        setup({}, {}, { role: "member" }),
        {},
      ),
    ).toMatchObject({
      error: "forbidden",
    });
  });
});

describe("revoke_runner", () => {
  // #1147-T9
  it("revokes by id and answers an unknown id as not_found", async () => {
    const revoke = vi.fn(async (id: string) => {
      if (id === "zz")
        throw new RunnerFleetError("RUNNER_FLEET_NOT_FOUND", "none");
    });
    const context = setup({}, { revoke });
    expect(await data("revoke_runner", context, { runnerId: "r1" })).toEqual({
      revoked: true,
      runnerId: "r1",
    });
    expect(
      await failure("revoke_runner", context, { runnerId: "zz" }),
    ).toMatchObject({ error: "not_found" });
  });
});
