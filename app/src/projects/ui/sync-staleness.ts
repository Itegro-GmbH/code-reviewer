// SPDX-License-Identifier: LicenseRef-Proprietary

// When the Setup tab tells the tickets may be out of date (#937). The mirror is fed by deliveries and healed by a full sync (the nightly
// one and "Resync"). A repository whose last full sync is older than `STALE_SYNC_DAYS` and where no delivery has written a row since
// (`lastWriteAt` is not after `lastFullSyncAt`, the reading #932 gave the field) may have missed changes: the page says so and points at
// Resync. Three days: the nightly sync covers a quiet repository, so older than that means it did not run through, and a repository that
// receives deliveries is not nagged. Pure, so the page and its test share it.

/** How many days old the last full sync may be before the hint shows. */
export const STALE_SYNC_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the issue list's `sync` says (src/tracker/service.ts). */
export type SyncState = {
  lastFullSyncAt: string | null;
  inProgress: boolean;
  lastWriteAt: string | null;
};

export type SyncStaleness = { kind: "never" } | { kind: "stale"; days: number };

/**
 * The hint to show, or null for none: no state (the project is off, the list could not be read), a sync under way, a sync that is
 * recent, or a delivery that arrived after it.
 */
export function syncStaleness(
  sync: SyncState | null,
  now: Date,
): SyncStaleness | null {
  if (sync === null || sync.inProgress) return null;
  if (sync.lastFullSyncAt === null) return { kind: "never" };
  const last = Date.parse(sync.lastFullSyncAt);
  if (Number.isNaN(last)) return null;
  const age = now.getTime() - last;
  if (age <= STALE_SYNC_DAYS * DAY_MS) return null;
  if (sync.lastWriteAt !== null) {
    const written = Date.parse(sync.lastWriteAt);
    if (!Number.isNaN(written) && written > last) return null;
  }
  return { kind: "stale", days: Math.floor(age / DAY_MS) };
}
