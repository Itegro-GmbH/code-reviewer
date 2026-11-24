// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the project configuration for the serverless platform (app/vercel.json) and the build
// output that depends on the runtime mode (#319): the region, a cron that calls a route that exists and
// is open to the cron, durations for routes that exist, and `output: "standalone"` for the Docker image
// only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "../auth/access.ts";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));

type VercelConfig = {
  regions?: string[];
  crons?: Array<{ path: string; schedule: string }>;
  git?: { deploymentEnabled?: boolean };
  functions?: Record<string, { maxDuration?: number }>;
} & Record<string, unknown>;

const config = JSON.parse(
  readFileSync(`${appRoot}vercel.json`, "utf8"),
) as VercelConfig;

function routeFile(path: string): string {
  return `${appRoot}src/app${path}/route.ts`;
}

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = `${directory}/${name}`;
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

describe("app/vercel.json", () => {
  // #319-T08
  it("runs in the one region the golden snapshots and the database live in", () => {
    expect(config.regions).toEqual(["fra1"]);
  });

  // #403-T10
  it("switches Git auto-deploy off: the project is deployed by the production workflow and by nothing else", () => {
    expect(config.git).toEqual({ deploymentEnabled: false });
  });

  // #403-T10
  it("keeps its crons", () => {
    expect((config.crons ?? []).map(({ path }) => path).sort()).toEqual([
      "/api/internal/dispatch-sweep",
      "/api/internal/jira-webhooks",
      // #1131: the same route, walking only the webhooks that wait for a registration after a move.
      "/api/internal/jira-webhooks?retry=pending",
      "/api/internal/repository-sync",
      // #1140: the hourly tick that starts the runs of schedule triggers.
      "/api/internal/schedule-runs",
      "/api/internal/tracker-resync",
    ]);
    // #1140: the route runs under the 300 seconds the glob of the internal routes gives every cron (no route sets its own `maxDuration`).
    expect(config.functions?.["src/app/api/internal/**/route.ts"]).toEqual({
      maxDuration: 300,
    });
    // #1140: once an hour, so a schedule starts at the first tick at or after its time (minute precision is not given).
    expect(
      (config.crons ?? []).find(({ path }) => path.endsWith("schedule-runs"))
        ?.schedule,
    ).toBe("0 * * * *");
  });

  // #319-T08
  it("calls only routes that exist and that a cron without a session may reach, on a valid schedule", () => {
    const crons = config.crons ?? [];
    expect(crons.length).toBeGreaterThan(0);
    for (const { path: address, schedule } of crons) {
      // A query string is no part of the route.
      const path = address.split("?")[0] ?? address;
      expect(existsSync(routeFile(path)), `${path} has a route file`).toBe(
        true,
      );
      expect(isPublicPath(path), `${path} is open to the cron`).toBe(true);
      expect(schedule.split(" ")).toHaveLength(5);
    }
  });

  // #319-T08
  it("syncs with GitHub at most once a day", () => {
    const sync = (config.crons ?? []).filter(
      ({ path }) => path === "/api/internal/repository-sync",
    );
    expect(sync).toHaveLength(1);
    const [minute, hour, day, month] = (sync[0]?.schedule ?? "").split(" ");
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);
    expect([day, month]).toEqual(["*", "*"]);
  });

  // #395-T01
  it("sweeps every two hours, once: a safety net, so the scale-to-zero database can sleep between webhooks", () => {
    const sweep = (config.crons ?? []).filter(
      ({ path }) => path === "/api/internal/dispatch-sweep",
    );
    expect(sweep).toEqual([
      { path: "/api/internal/dispatch-sweep", schedule: "0 */2 * * *" },
    ]);
  });

  // #479-T11
  it("gives the routes that enqueue a review (Review now, the pull request list) the minute the inline retries are counted in", () => {
    const matches = (pattern: string, file: string): boolean =>
      new RegExp(
        `^${pattern
          .replaceAll(".", "\\.")
          .replaceAll("**", "\u0000")
          .replaceAll("*", "[^/]*")
          .replaceAll("\u0000", ".*")}$`,
      ).test(file);
    const files = routeFiles(`${appRoot}src/app/api/w`).map((file) =>
      file.slice(appRoot.length),
    );
    const enqueuing = files.filter((file) =>
      /\/repositories\/\[repositoryId\]\/(reviews|pull-requests)\/route\.ts$/.test(
        file,
      ),
    );

    expect(enqueuing).toHaveLength(2);
    for (const file of enqueuing) {
      const durations = Object.entries(config.functions ?? {})
        .filter(([pattern]) => matches(pattern, file))
        .map(([, { maxDuration }]) => maxDuration ?? 0);
      expect(
        Math.max(0, ...durations),
        `${file} has a duration of at least a minute`,
      ).toBeGreaterThanOrEqual(60);
    }
  });

  // #319-T08
  it("sets a duration only for patterns that match a route file", () => {
    const files = routeFiles(`${appRoot}src/app`).map((file) =>
      file.slice(appRoot.length),
    );
    for (const [pattern, { maxDuration }] of Object.entries(
      config.functions ?? {},
    )) {
      expect(maxDuration).toBeGreaterThan(0);
      const expression = new RegExp(
        `^${pattern
          .replaceAll(".", "\\.")
          .replaceAll("**", "\u0000")
          .replaceAll("*", "[^/]*")
          .replaceAll("\u0000", ".*")}$`,
      );
      expect(
        files.some((file) => expression.test(file)),
        `${pattern} matches a route file`,
      ).toBe(true);
    }
  });
});

describe("next.config.ts output", () => {
  // #319-T08
  it("leaves the output to the platform, which packages every function itself (no standalone server)", async () => {
    expect(
      (await import("../../next.config.ts")).default.output,
    ).toBeUndefined();
  });
});
