// SPDX-License-Identifier: LicenseRef-Proprietary

// Whether the runners of a workspace announce what a profile asks for (#973): the validator offers only the combinations some online runner of the
// workspace announces. A runner that is online and has every label of the environment is the one that could take the turn; the question is whether
// one of them has an entry for the demand (`accessMatches`, the claim's rule in memory).
import {
  accessMatches,
  type AccessDemand,
  type HarnessAccess,
} from "./access.ts";
import { hasAllLabels } from "./labels.ts";

/** A runner of the workspace that is online (heard from lately and not below the minimum base): what it can take. */
export type OnlineRunner = {
  labels: readonly string[];
  access: readonly HarnessAccess[];
};

/**
 * `announced`: an online runner with the environment's labels has an entry for the demand. `not_announced`: some runner with the labels is online and
 * none of them has one, so the turn would wait for ever. `unknown`: no runner with the labels is online (it may be asleep), so nothing can be said:
 * the turn waits as a turn for a runner always does.
 */
export type Announcement = "announced" | "not_announced" | "unknown";

const AUTH_WORDS: Record<NonNullable<AccessDemand["auth"]>, string> = {
  managed: "the platform's own keys",
  "app-key": "a key of the workspace",
  "local-key": "a key on the runner",
  subscription: "a subscription on the runner",
};

/** What a demand asks for, in words for the message of a refusal: `claude-code on a subscription on the runner, model opus`. */
export function describeDemand(demand: AccessDemand): string {
  const auth = demand.auth === null ? "" : ` on ${AUTH_WORDS[demand.auth]}`;
  const model = demand.model === null ? "" : `, model ${demand.model}`;
  return `${demand.harness}${auth}${model}`;
}

export function announcedBy(
  runners: readonly OnlineRunner[],
  labels: readonly string[],
  demand: AccessDemand,
): Announcement {
  const candidates = runners.filter((runner) =>
    hasAllLabels(runner.labels, labels),
  );
  if (candidates.length === 0) return "unknown";
  return candidates.some((runner) => accessMatches(runner.access, demand))
    ? "announced"
    : "not_announced";
}
