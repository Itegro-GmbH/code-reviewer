// SPDX-License-Identifier: LicenseRef-Proprietary

// Turns GitHub's pull request JSON into the app's PullRequestRef. Returns null when a field the app
// needs is missing, so the caller can report an unexpected answer instead of passing on garbage.
import { isRecord } from "./guards.ts";
import type { PullRequestRef, PullRequestState } from "../../types.ts";
import { requestedReviewersOf } from "./tracker-map.ts";

export function toPullRequestRef(json: unknown): PullRequestRef | null {
  if (!isRecord(json) || !isRecord(json.head) || !isRecord(json.base))
    return null;
  const { user } = json;
  if (!isRecord(user)) return null;
  if (
    typeof json.number !== "number" ||
    typeof json.title !== "string" ||
    typeof json.html_url !== "string" ||
    typeof json.head.sha !== "string" ||
    typeof json.head.ref !== "string" ||
    typeof json.base.ref !== "string" ||
    typeof user.login !== "string" ||
    typeof json.state !== "string"
  )
    return null;

  const requestedReviewers = requestedReviewersOf(json);
  const merged = json.merged === true || typeof json.merged_at === "string";
  const state: PullRequestState = merged
    ? "merged"
    : json.state === "open"
      ? "open"
      : "closed";
  return {
    number: json.number,
    title: json.title,
    url: json.html_url,
    headSha: json.head.sha,
    baseRef: json.base.ref,
    headRef: json.head.ref,
    draft: json.draft === true,
    state,
    author: {
      login: user.login,
      externalId: typeof user.id === "number" ? String(user.id) : null,
    },
    ...(requestedReviewers === undefined ? {} : { requestedReviewers }),
  };
}
