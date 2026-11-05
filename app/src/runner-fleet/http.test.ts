// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the runners page's routes (#854), with a fake service.
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import { RunnerFleetError } from "./errors.ts";
import { createRunnerFleetRouteHandlers } from "./http.ts";
import type { RunnerFleetService } from "./service.ts";

const USER = { id: "u1" } as SessionUser;

function handlers(service: Partial<RunnerFleetService> = {}) {
  const requireUser = vi.fn(() => Promise.resolve(USER));
  const full: RunnerFleetService = {
    list: async () => ({
      runners: [],
      minBaseVersion: null,
      onlineWithinSeconds: 120,
    }),
    createToken: async () => ({ token: "crt_x", expiresAt: "t" }),
    revoke: async () => undefined,
    ...service,
  };
  return {
    requireUser,
    ...createRunnerFleetRouteHandlers({ requireUser, service: full }),
  };
}

const request = (init: RequestInit = {}, headers: HeadersInit = {}) =>
  new Request("https://app.test/api/w/acme/runners", {
    ...init,
    headers: { "sec-fetch-site": "same-origin", ...headers },
  });

describe("the runner fleet route handlers", () => {
  // #854-T50
  it("answer the list, a made token (201) and a revoke, all with no-store", async () => {
    const h = handlers();

    const list = await h.list(request());
    const made = await h.createToken(request({ method: "POST" }));
    const revoked = await h.revoke(request({ method: "POST" }), "r1");

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      runners: [],
      minBaseVersion: null,
      onlineWithinSeconds: 120,
    });
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ token: "crt_x", expiresAt: "t" });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    for (const response of [list, made, revoked])
      expect(response.headers.get("cache-control")).toBe("no-store");
  });

  // #854-T51
  it("ask who the caller is before anything else, and refuse a request from another site", async () => {
    const service = { createToken: vi.fn() };
    const h = handlers(service);

    const response = await h.createToken(
      request({ method: "POST" }, { "sec-fetch-site": "cross-site" }),
    );

    expect(h.requireUser).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "RUNNER_FLEET_CROSS_SITE_REQUEST",
    });
    expect(service.createToken).not.toHaveBeenCalled();
  });

  // #854-T52
  it("answer a refusal of the service with its code and status, and the maximum for a full workspace", async () => {
    const h = handlers({
      revoke: async () => {
        throw new RunnerFleetError("RUNNER_FLEET_NOT_FOUND", "no");
      },
      createToken: async () => {
        throw new RunnerFleetError("RUNNER_FLEET_TOKEN_LIMIT_REACHED", "full", {
          maximum: 20,
        });
      },
    });

    const missing = await h.revoke(request({ method: "POST" }), "r9");
    const full = await h.createToken(request({ method: "POST" }));

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "RUNNER_FLEET_NOT_FOUND" });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({
      error: "RUNNER_FLEET_TOKEN_LIMIT_REACHED",
      maximum: 20,
    });
  });

  it("let a failure nobody planned for through", async () => {
    const h = handlers({
      list: async () => {
        throw new Error("boom");
      },
    });

    await expect(h.list(request())).rejects.toThrow("boom");
  });
});
