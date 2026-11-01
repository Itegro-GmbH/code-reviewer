// SPDX-License-Identifier: LicenseRef-Proprietary

// How a turn of the Implementer sits in a row of `jobs` (#752, part of #745). The table is shaped like a pull request review,
// so the pull request columns hold placeholders here, and this module is the ONLY place that writes them:
//  - `pr_number` is `-slot` of the session. A negative number is never a GitHub pull request, so nothing that acts on real pull
//    requests (the webhooks) can match it, and the unique index "one running job per (repository, pr_number)" becomes "one
//    running turn per session".
//  - `pr_url` is the url of the branch (each part of the name percent-encoded, so `#` and `%` in a name stay in the path),
//    `head_sha` the tip of the base branch read when the task was accepted. Neither is shown
//    as pull request data; the consumers that would are gated by the kind (`src/jobs/README.md`, "The implementer kind").
//  - `command` is `review` and `args` empty: the queue's claim only hands out `review` commands.
//  - `delivery_id` is `implementer:<workspace id>:<client request id>`. The unique index of the column spans every workspace
//    (a webhook delivery id is a GUID), so the workspace is part of the key: two workspaces cannot collide on, or probe, a
//    request id; the same request in one workspace is the same job.
// This module imports nothing: the database layer imports it, and it must not pull a cycle back in.

export type ImplementerJobShapeInput = {
  workspaceId: string;
  /** The url of the repository, as the repositories table holds it. */
  repositoryUrl: string;
  branch: string;
  /** The slot of the session in its repository, from 1. */
  slot: number;
  /** The tip of the base branch when the task was accepted: 40 hexadecimal characters. */
  baseSha: string;
  clientRequestId: string;
};

export type ImplementerJobShape = {
  prNumber: number;
  prUrl: string;
  headSha: string;
  command: "review";
  args: "";
  deliveryId: string;
};

/** The prefix of every turn's delivery id; the lookup of a repeated request names the whole id. */
const DELIVERY_PREFIX = "implementer:";

export function implementerDeliveryId(
  workspaceId: string,
  clientRequestId: string,
): string {
  return `${DELIVERY_PREFIX}${workspaceId}:${clientRequestId}`;
}

export function implementerJobShape(
  input: ImplementerJobShapeInput,
): ImplementerJobShape {
  if (!Number.isSafeInteger(input.slot) || input.slot < 1)
    throw new RangeError("The slot of a session starts at 1.");
  return {
    prNumber: -input.slot,
    prUrl: `${input.repositoryUrl.replace(/\/+$/, "")}/tree/${input.branch.split("/").map(encodeURIComponent).join("/")}`,
    headSha: input.baseSha.toLowerCase(),
    command: "review",
    args: "",
    deliveryId: implementerDeliveryId(input.workspaceId, input.clientRequestId),
  };
}
