// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import { TrackerError } from "./errors.ts";
import {
  createTrackerRouteHandlers,
  readTicketQuery,
  SYNC_BUDGET_MS,
} from "./http.ts";
import type { TrackerService } from "./service.ts";

const USER = { id: "u-1" } as SessionUser;
const LIST = {
  repositoryId: "r-1",
  repo: "acme/widgets",
  items: [],
  sync: { lastFullSyncAt: null, inProgress: false },
};
const PROGRESS = {
  status: "done" as const,
  next: null,
  written: 1,
  removed: 0,
  boardAvailable: true,
};

function setup(service: Partial<TrackerService> = {}) {
  const requireUser = vi.fn(async () => USER);
  const full: TrackerService = {
    listIssues: vi.fn(async () => LIST),
    sync: vi.fn(async () => PROGRESS),
    ...service,
  };
  const handlers = createTrackerRouteHandlers({
    requireUser,
    service: full,
    now: () => 1_000,
  });
  return { handlers, requireUser, service: full };
}

const get = (query = "") =>
  new Request(`https://app.test/api/w/acme/repositories/r-1/issues${query}`);
const post = (headers: Record<string, string> = {}) =>
  new Request("https://app.test/api/w/acme/repositories/r-1/issues/sync", {
    method: "POST",
    headers,
  });

describe("the query of the list", () => {
  // #923-T63
  it("is the open tickets, 100 at a time, from the start", () => {
    expect(readTicketQuery(new URL("https://x.test/i"))).toEqual({
      ok: true,
      value: { state: "open", limit: 100, offset: 0 },
    });
  });

  // #923-T64
  it("takes state, limit and offset", () => {
    expect(readTicketQuery(new URL("https://x.test/i?state=all&limit=200&offset=40"))).toEqual({
      ok: true,
      value: { state: "all", limit: 200, offset: 40 },
    });
  });

  // #923-T65
  it("names every parameter that cannot be used, with its path, code, message and what is available", () => {
    const query = readTicketQuery(
      new URL("https://x.test/i?state=merged&limit=0&offset=-1"),
    );

    expect(query).toEqual({
      ok: false,
      issues: [
        {
          path: "state",
          code: "invalid",
          message: 'state "merged" is not one of open, closed, all.',
          available: ["open", "closed", "all"],
        },
        { path: "limit", code: "out_of_range", message: "limit must be between 1 and 200." },
        { path: "offset", code: "invalid", message: "offset must be a whole number." },
      ],
    });
  });

  // #923-T66
  it("refuses a limit above the maximum and a text that is no number", () => {
    const query = readTicketQuery(new URL("https://x.test/i?limit=201&offset=abc"));

    expect(query).toMatchObject({
      ok: false,
      issues: [
        { path: "limit", code: "out_of_range" },
        { path: "offset", code: "invalid" },
      ],
    });
  });
});

describe("GET issues", () => {
  // #923-T67
  it("answers the list, never cached, after the user is known", async () => {
    const { handlers, requireUser, service } = setup();

    const response = await handlers.list(get("?state=all"), "r-1");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(LIST);
    expect(requireUser).toHaveBeenCalledTimes(1);
    expect(service.listIssues).toHaveBeenCalledWith("r-1", { state: "all", limit: 100, offset: 0 });
  });

  // #923-T68
  it("answers 400 with the issues of a bad query and asks the service nothing", async () => {
    const { handlers, service } = setup();

    const response = await handlers.list(get("?state=nope"), "r-1");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "TRACKER_REQUEST_INVALID",
      issues: [{ path: "state", code: "invalid", available: ["open", "closed", "all"] }],
    });
    expect(service.listIssues).not.toHaveBeenCalled();
  });

  // #923-T69
  it.each([
    ["TRACKER_REPOSITORY_NOT_FOUND", 404],
    ["TRACKER_PROJECT_NOT_ACTIVE", 409],
  ] as const)("answers %s with %i", async (code, status) => {
    const { handlers } = setup({
      listIssues: async () => {
        throw new TrackerError(code, "no");
      },
    });

    const response = await handlers.list(get(), "r-1");

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });

  // #923-T70
  it("does not swallow what is not a refusal", async () => {
    const { handlers } = setup({
      listIssues: async () => {
        throw new Error("database down");
      },
    });

    await expect(handlers.list(get(), "r-1")).rejects.toThrow("database down");
  });
});

describe("POST issues/sync", () => {
  // #923-T71
  it("answers 200 when the cache is complete, with the budget of a request", async () => {
    const { handlers, service } = setup();

    const response = await handlers.sync(post(), "r-1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PROGRESS);
    expect(service.sync).toHaveBeenCalledWith("r-1", { deadline: 1_000 + SYNC_BUDGET_MS });
  });

  // #923-T72
  it("answers 202 when asking again is needed", async () => {
    const { handlers } = setup({
      sync: async () => ({ ...PROGRESS, status: "partial", next: "checks" }),
    });

    const response = await handlers.sync(post(), "r-1");

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "partial", next: "checks" });
  });

  // #923-T73
  it("refuses a request from another site before anything is done", async () => {
    const { handlers, service } = setup();

    const response = await handlers.sync(post({ "sec-fetch-site": "cross-site" }), "r-1");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "TRACKER_CROSS_SITE_REQUEST" });
    expect(service.sync).not.toHaveBeenCalled();
  });

  // #923-T74
  it.each([
    ["TRACKER_INTEGRATION_UNAVAILABLE", 409],
    ["TRACKER_SYNC_FAILED", 503],
  ] as const)("answers %s with %i", async (code, status) => {
    const { handlers } = setup({
      sync: async () => {
        throw new TrackerError(code, "no");
      },
    });

    const response = await handlers.sync(post(), "r-1");

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });
});
