// SPDX-License-Identifier: LicenseRef-Proprietary

// A test of an older migration says "it changes no existing row": it reads the rows of a table before the migration and again
// after every later one and expects the same. A migration that comes later and adds a nullable column to a table makes every
// row grow that column, which is no change to the row the older migration was about. So the rows are compared without the
// columns added later, which must still hold their default (a migration that backfills would be a change, and fails here).
// Add the column here when a migration adds one to a table that existing rows live in.
const COLUMNS_ADDED_LATER: Record<string, readonly string[]> = {
  // #658: when a workspace was deleted; null for every workspace that exists.
  workspaces: ["deleted_at"],
  // #692: the PostHog identity of the landing page; null for every user that exists.
  users: ["posthog_distinct_id", "posthog_session_id", "posthog_captured_at"],
  // #818: the environment a task started with; null for every turn that exists (no environment: the standard).
  implementer_turns: [
    "environment_id",
    "environment_name",
    "environment_vcpus",
    "environment_setup_script",
    // #745, step 7: the environment's network rule, copied with it; null for every turn that exists (it reads `off`).
    "environment_network_mode",
    "environment_network_hosts",
    // #843: the profile version a task ran with; null for every turn that exists (no profile: the platform's defaults).
    "profile_id",
    "profile_name",
    "profile_version",
    "profile_instructions",
    "profile_can_push",
  ],
  // #745, step 7: the environment's network rule; every environment that exists reads `off` and no hosts (`DEFAULTS_OF_COLUMNS`).
  implementer_environments: ["network_mode", "network_hosts"],
  // #818: the size of the VM where the Dispatcher reported it; null for every VM that exists.
  job_vm_runs: ["vcpus"],
};

/** What a column added later holds on an existing row when it is not null: a constant default. */
const DEFAULTS_OF_COLUMNS: Record<string, Record<string, unknown>> = {
  implementer_environments: { network_mode: "off", network_hosts: "" },
};

/** `rows` of `table` without the columns that migrations after the one under test added; those columns must be null. */
export function withoutColumnsAddedLater(
  table: string,
  rows: readonly unknown[],
): unknown[] {
  const added = COLUMNS_ADDED_LATER[table] ?? [];
  if (added.length === 0) return [...rows];
  return rows.map((row) => {
    const copy = { ...(row as Record<string, unknown>) };
    for (const column of added) {
      const expected = DEFAULTS_OF_COLUMNS[table]?.[column] ?? null;
      if (column in copy && copy[column] !== expected)
        throw new Error(
          `${table}.${column} was added by a later migration and must be ${expected === null ? "null" : "its default"} on an existing row.`,
        );
      delete copy[column];
    }
    return copy;
  });
}
