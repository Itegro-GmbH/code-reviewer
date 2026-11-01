// SPDX-License-Identifier: LicenseRef-Proprietary

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { recordingLogger } from "../test-support/harness.ts";
import { ReapError, type ReapReport, type Reaper } from "./reaper.ts";
import { REAP_PATH, mountReaperRoute } from "./route.ts";

const CRON_SECRET = "a-cron-secret-of-at-least-32-characters";
const REPORT: ReapReport = {
  listed: 5,
  candidates: 3,
  stopped: 2,
  kept: 1,
  unreadable: 0,
  failed: 0,
  deleted: 0,
  deleteFailed: 0,
  deleteKept: 0,
  deleteNotTried: 0,
};

function setup(
  options: { secret?: string | undefined; reaper?: Partial<Reaper> } = {},
) {
  let runs = 0;
  const logger = recordingLogger();
  const app = new Hono();
  mountReaperRoute(app, {
    cronSecret: "secret" in options ? options.secret : CRON_SECRET,
    reaper: {
      run: () => {
        runs += 1;
        return Promise.resolve(REPORT);
      },
      ...options.reaper,
    },
    logger,
  });
  const call = (headers: Record<string, string> = {}, method = "GET") =>
    app.fetch(
      new Request(`http://dispatcher.test${REAP_PATH}`, { method, headers }),
    );
  return { call, runs: () => runs, logger };
}

describe("the cron route of the reaper", () => {
  // #364-T15
  it.each<[string, Record<string, string>]>([
    ["no Authorization header", {}],
    [
      "a wrong secret",
      { authorization: "Bearer not-the-cron-secret-at-all-0000000000" },
    ],
    ["the secret in another scheme", { authorization: `Basic ${CRON_SECRET}` }],
    ["the secret without a scheme", { authorization: CRON_SECRET }],
    [
      "a prefix of the secret",
      { authorization: `Bearer ${CRON_SECRET.slice(0, -1)}` },
    ],
    ["the secret and more", { authorization: `Bearer ${CRON_SECRET}x` }],
    [
      "a dispatcher credential",
      { authorization: "Bearer dummy-dispatcher-token-for-tests" },
    ],
    ["a per-job credential", { authorization: `Bearer crj_${"A".repeat(43)}` }],
  ])("refuses %s with 401 and runs nothing", async (_name, headers) => {
    const t = setup();

    const response = await t.call(headers);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("CRON_UNAUTHORIZED");
    expect(t.runs()).toBe(0);
  });

  // #364-T16
  it.each<[string, string | undefined]>([
    ["unset", undefined],
    ["empty", ""],
  ])("refuses every caller when CRON_SECRET is %s", async (_name, secret) => {
    const t = setup({ secret });

    for (const authorization of [
      "Bearer ",
      "Bearer undefined",
      "Bearer ",
      `Bearer ${CRON_SECRET}`,
    ]) {
      const response = await t.call({ authorization });
      expect(response.status).toBe(401);
    }
    expect(t.runs()).toBe(0);
  });

  // #364-T15
  it("answers only GET", async () => {
    const t = setup();

    const response = await t.call(
      { authorization: `Bearer ${CRON_SECRET}` },
      "POST",
    );

    expect(response.status).toBe(404);
    expect(t.runs()).toBe(0);
  });

  // #364-T13
  it("runs the reaper for the secret and answers its counts, not cacheable", async () => {
    const t = setup();

    const response = await t.call({ authorization: `Bearer ${CRON_SECRET}` });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toStrictEqual({ status: "ok", ...REPORT });
    expect(t.runs()).toBe(1);
  });

  // #364-T11
  it("answers 500 with the stable code of a failed listing, and nothing of the cause", async () => {
    const t = setup({
      reaper: {
        run: () => Promise.reject(new ReapError("REAP_LIST_FAILED")),
      },
    });

    const response = await t.call({ authorization: `Bearer ${CRON_SECRET}` });

    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual({
      status: "error",
      code: "REAP_LIST_FAILED",
    });
  });

  // #364-T13
  it("answers 500 REAP_FAILED for anything else, without its text, and logs only the event", async () => {
    const t = setup({
      reaper: {
        run: () => Promise.reject(new Error(`boom ${CRON_SECRET} Bearer abc`)),
      },
    });

    const response = await t.call({ authorization: `Bearer ${CRON_SECRET}` });

    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual({
      status: "error",
      code: "REAP_FAILED",
    });
    expect(t.logger.text()).toContain("reap_failed");
    expect(t.logger.text()).not.toContain(CRON_SECRET);
  });
});
