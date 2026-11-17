// SPDX-License-Identifier: LicenseRef-Proprietary

// The statuses of a Jira project (id, name, untranslated name) for the webhook and its status trigger (#1058): a delivery names a status the
// way Jira keeps it for every language, the REST API (the lane editor's picker, the full read, the stale guard) the way the connected user
// reads it, and only the id is the same in both. A delivery reads the list at most twice (the mirror and the trigger), so a read is kept for
// a short while per connection and project: a burst of deliveries asks Jira once. Never throws; a list that cannot be read is undefined.
import type { StatusRef } from "../workflows/status-match.ts";
import type { JiraProjectReader } from "./projects.ts";

/** How long a read of a project's statuses is kept. A rename of a status shows up in the mirror within this time. */
export const STATUS_CACHE_MS = 60_000;
/** The most projects kept (a process serves many workspaces); the oldest read goes first. */
const MAX_ENTRIES = 200;

export type JiraStatusDirectory = {
  statusesOf(source: {
    connectionId: string;
    projectKey: string;
  }): Promise<readonly StatusRef[] | undefined>;
};

export function createJiraStatusDirectory(deps: {
  reader: Pick<JiraProjectReader, "listStatuses">;
  now?: () => number;
  ttlMs?: number;
}): JiraStatusDirectory {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? STATUS_CACHE_MS;
  const kept = new Map<string, { at: number; statuses: StatusRef[] }>();
  return {
    async statusesOf({ connectionId, projectKey }) {
      const cacheKey = `${connectionId}\u0000${projectKey}`;
      const earlier = kept.get(cacheKey);
      if (earlier !== undefined && now() - earlier.at < ttlMs)
        return earlier.statuses;
      let read;
      try {
        read = await deps.reader.listStatuses(connectionId, projectKey);
      } catch {
        return undefined;
      }
      if (!read.ok) return undefined;
      const statuses = read.statuses.map(
        ({ id, name, untranslatedName }): StatusRef => ({
          id,
          name,
          ...(untranslatedName === undefined ? {} : { untranslatedName }),
        }),
      );
      kept.delete(cacheKey);
      kept.set(cacheKey, { at: now(), statuses });
      for (const oldest of kept.keys()) {
        if (kept.size <= MAX_ENTRIES) break;
        kept.delete(oldest);
      }
      return statuses;
    },
  };
}
