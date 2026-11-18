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
 * by the snapshot build from the image itself). `implementer_multi_repo` (#1090): the Worker reads `implementer.repos`.
 */
export const IMAGE_GATED_CLAIM_FEATURES = [
  "implementer_multi_repo",
] as const satisfies readonly KnownClaimFeature[];

/** The gated features the image lists: none for an image whose list is absent, empty or unreadable. */
export function imageClaimFeatures(
  workerFeatures: unknown,
): KnownClaimFeature[] {
  const listed = parseWorkerFeatures(workerFeatures);
  return IMAGE_GATED_CLAIM_FEATURES.filter((feature) =>
    listed.includes(feature),
  );
}
