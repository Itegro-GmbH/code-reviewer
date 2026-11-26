// SPDX-License-Identifier: LicenseRef-Proprietary

// The claim features that depend on the Worker image (#1098). Most of what a Worker reads it names itself in its details
// request; a feature in this list changes which jobs the App hands to the *Dispatcher*, before any Worker exists, so the
// Dispatcher has to know what the image of its golden snapshot can do. The Dispatcher deploys before a new snapshot is live
// (or with an old one that is reused), and a fixed entry would give a multi-repo job to a Worker that cannot run it: the job
// would end `implementer_engine_unavailable` instead of waiting in the queue for a Dispatcher that can.
import type { KnownClaimFeature } from "../contracts/runner-api.ts";
import { parseWorkerFeatures } from "../snapshot/worker-features.ts";

/**
 * The claim features named only when the Worker image lists a feature of the same name (`SANDBOX_WORKER_FEATURES`, recorded
 * by the snapshot build from the image itself). `implementer_multi_repo` (#1090): the Worker reads `implementer.repos`; `implementer_workspace_token` (#1150): the Worker reads the workspace's Claude Code token; `implementer_subscription_door` (#1176): the Worker's model door holds that token.
 */
export const IMAGE_GATED_CLAIM_FEATURES = [
  "implementer_multi_repo",
  // #1150: the Worker reads `implementer.subscription.oauthToken`. A snapshot built before this release does not list it, so the Dispatcher
  // does not name it, the App leaves a hosted turn on `claude-code` queued, and no VM starts that would refuse it.
  "implementer_workspace_token",
  // #1176: the Worker's model door holds the Claude Code token (subscription mode), so the step's own network rule is allowed for such a turn.
  // An image without it keeps the token in the container: the App then refuses an open or wide rule for the claim, free, before a VM starts.
  "implementer_subscription_door",
] as const satisfies readonly KnownClaimFeature[];

/**
 * #1158 (epic #1157): the claim feature that tells the App this Dispatcher can launch a hosted job on a Cloudflare Container. Only a claim that names it has the
 * platform label of that placement, so a job of a Cloudflare runner is never a candidate of a Dispatcher without the configuration.
 */
export const PLACEMENT_CLOUDFLARE_FEATURE =
  "placement_cloudflare" as const satisfies KnownClaimFeature;

/**
 * The claim features of a Dispatcher that may launch on Cloudflare. One claim can be given a job of either placement, so an image-gated feature is named
 * only when **both** images list it (the snapshot's, `vercel`, and the Cloudflare image's, from its health answer): otherwise a job that needs it could
 * be given to the placement whose Worker cannot run it. With no answer from Cloudflare (`undefined`: not configured, not reachable, or its answer is
 * unusable) the claim is the Vercel one and does not name the placement, so no job of that placement is claimed. A feature of the list that is
 * not image-gated is never touched here.
 */
export function claimFeaturesForPlacements(
  vercel: readonly KnownClaimFeature[],
  cloudflareWorkerFeatures: unknown,
  cloudflareUsable: boolean,
): KnownClaimFeature[] {
  if (!cloudflareUsable) return [...vercel];
  const cloudflare = imageClaimFeatures(cloudflareWorkerFeatures);
  return [
    ...vercel.filter((feature) => cloudflare.includes(feature)),
    PLACEMENT_CLOUDFLARE_FEATURE,
  ];
}

/** The gated features the image lists: none for an image whose list is absent, empty or unreadable. */
export function imageClaimFeatures(
  workerFeatures: unknown,
): KnownClaimFeature[] {
  const listed = parseWorkerFeatures(workerFeatures);
  return IMAGE_GATED_CLAIM_FEATURES.filter((feature) =>
    listed.includes(feature),
  );
}
