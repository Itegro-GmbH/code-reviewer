// SPDX-License-Identifier: LicenseRef-Proprietary

// Which runners are online (#854) and what the online ones announce (#973): the one rule of the runners page, the claim's "update needed" and the
// validator of profiles and workflows. Pure: the runners come in as a list, so this module needs no database.
import type { RunnerManifest } from "./announcement.ts";
import type { OnlineRunner } from "./announced.ts";
import { minimumBaseVersion, ONLINE_WITHIN_SECONDS } from "./config.ts";
import { meetsMinimum } from "./versions.ts";

/**
 * `online`: heard from lately and good enough for jobs. `update_needed`: heard from lately, but the base is older than the minimum, so
 * it gets no jobs. `offline`: not heard from for `onlineWithinSeconds`.
 */
export type RunnerStatus = "online" | "update_needed" | "offline";

export type OnlineSettings = {
  minBaseVersion: string | null;
  onlineWithinSeconds: number;
};

/** The state of a runner at `now`: the one rule of the list and of the claim. */
export function statusOf(
  runner: { lastSeenAt: string; baseVersion: string },
  now: Date,
  settings: OnlineSettings,
): RunnerStatus {
  const seen = Date.parse(runner.lastSeenAt);
  if (!(now.getTime() - seen <= settings.onlineWithinSeconds * 1000))
    return "offline";
  return settings.minBaseVersion !== null &&
    !meetsMinimum(runner.baseVersion, settings.minBaseVersion)
    ? "update_needed"
    : "online";
}

/** What the listing of runners gives (`RunnersRepository.list`), as far as this module reads it. */
export type ListedRunner = {
  labels: readonly string[];
  baseVersion: string;
  lastSeenAt: string;
  manifest: RunnerManifest;
};

/**
 * The runners of the workspace that are online at `now` (heard from lately, base at the minimum or above), with what each announces: the
 * runners the validator asks whether a profile can run (#973). A revoked runner is not listed by the repository.
 */
export async function onlineRunnersOf(
  runners: { list(): Promise<readonly ListedRunner[]> },
  settings: OnlineSettings,
  now: Date,
): Promise<OnlineRunner[]> {
  return (await runners.list())
    .filter((runner) => statusOf(runner, now, settings) === "online")
    .map((runner) => ({
      labels: runner.labels,
      access: runner.manifest.harnesses,
    }));
}

/** The question of the validator for one workspace's runners, with the settings of the running server. */
export function onlineRunnersFrom(runners: {
  list(): Promise<readonly ListedRunner[]>;
}): () => Promise<OnlineRunner[]> {
  return () =>
    onlineRunnersOf(
      runners,
      {
        minBaseVersion: minimumBaseVersion(process.env),
        onlineWithinSeconds: ONLINE_WITHIN_SECONDS,
      },
      new Date(),
    );
}
