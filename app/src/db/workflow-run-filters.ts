// SPDX-License-Identifier: LicenseRef-Proprietary

// The status filters of the list of lane runs (#1078), as words: kept outside the repository (which is server only) so that the filter of
// the page in the browser, the service and the repository say the same words. `active`: running or waiting for an answer; `waiting`: only
// the runs that wait for an answer; `ended`: succeeded, failed, cancelled or discarded; `failed`: only the failed ones.
export const WORKSPACE_RUN_STATUS_FILTERS = [
  "active",
  "waiting",
  "ended",
  "failed",
] as const;
export type WorkspaceRunStatusFilter =
  (typeof WORKSPACE_RUN_STATUS_FILTERS)[number];
