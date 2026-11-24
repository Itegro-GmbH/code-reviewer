// SPDX-License-Identifier: LicenseRef-Proprietary

// #1140: the hourly tick of the schedule triggers: the credential, the skip, the counts and a failure of the whole tick.
import { describe, expect, it, vi } from "vitest";
import type {
  ScheduleRunner,
  ScheduleTickResult,
} from "../workflow-runs/schedule-trigger.ts";
import {
  handleScheduleRunsCron,
  type ScheduleRunsCronDependencies,
} from "./schedule-runs.ts";

const SECRET = "s".repeat(40);
const RESULT: ScheduleTickResult = {
  workspaces: 2,
  lanes: 3,
  started: 1,
  existing: 1,
  busy: 0,
  notDue: 1,
  skipped: 0,
  failed: 0,
};

function call(
  authorization: string | null,
  over: Partial<ScheduleRunsCronDependencies> = {},
) {
  const run = vi.fn<ScheduleRunner["run"]>(async () => RESULT);
  const runner = vi.fn(() => ({ run }));
  const response = handleScheduleRunsCron(
    new Request("https://factory.example.test/api/internal/schedule-runs", {
      headers: authorization === null ? {} : { authorization },
    }),
    { env: { CRON_SECRET: SECRET }, enabled: () => true, runner, ...over },
  );
  return { response, run, runner };
}

describe("the hourly schedule tick", () => {
  // #1140-T04
  it("is refused without the cron's credential and starts nothing", async () => {
    for (const authorization of [
      null,
      "Bearer wrong",
      `Bearer ${SECRET}x`,
      SECRET,
      "Basic abc",
    ]) {
      const { response, run, runner } = call(authorization);
      const answered = await response;
      expect(answered.status).toBe(401);
      expect(await answered.json()).toEqual({ code: "CRON_UNAUTHORIZED" });
      // A refused call opens no connection: the runner is not even made.
      expect(runner).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    }
  });

  // #1140-T04
  it("refuses every caller when CRON_SECRET is not set or is too short", async () => {
    for (const env of [{}, { CRON_SECRET: "short" }]) {
      const { response, run } = call(`Bearer ${SECRET}`, { env });
      expect((await response).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    }
  });

  // #1140-T04
  it("runs the tick for the cron and answers the counts, uncached", async () => {
    const { response, run } = call(`Bearer ${SECRET}`);

    const answered = await response;

    expect(answered.status).toBe(200);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect(await answered.json()).toEqual({ status: "ok", ...RESULT });
    expect(run).toHaveBeenCalledTimes(1);
  });

  // #1140-T04
  it("does nothing and says so in a deployment without the factory", async () => {
    const { response, runner } = call(`Bearer ${SECRET}`, {
      enabled: () => false,
    });

    const answered = await response;

    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      status: "skipped",
      reason: "not_enabled",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  // #1140-T03
  it("answers a code, and never the cause, when the whole tick fails", async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(line);
    });
    const { response } = call(`Bearer ${SECRET}`, {
      runner: () => ({
        run: async () => {
          throw new Error("connect ECONNREFUSED postgres://user:hunter2@db");
        },
      }),
    });

    const answered = await response;

    expect(answered.status).toBe(500);
    expect(await answered.json()).toEqual({
      status: "error",
      code: "SCHEDULE_RUNS_CRON_FAILED",
    });
    expect(String(errors.join("\n"))).toContain("SCHEDULE_RUNS_CRON_FAILED");
    expect(String(errors.join("\n"))).not.toContain("hunter2");
  });
});
