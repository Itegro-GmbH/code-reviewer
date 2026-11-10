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
    // #854: the kind of the environment and the labels of a runner environment; null for every turn that exists (hosted).
    "environment_kind",
    "environment_labels",
    // #843: the profile version a task ran with; null for every turn that exists (no profile: the platform's defaults).
    "profile_id",
    "profile_name",
    "profile_version",
    "profile_instructions",
    "profile_can_push",
    // #856: the harness of the profile version; null for every turn that exists (it reads OpenCode).
    "profile_harness",
    // #843: the result schema a task ran with and the result the agent handed in; null for every turn that exists.
    "result_schema",
    "result_value",
    // #918: the minutes a turn may run, from the workflow that started it; null for every turn that exists (the platform's 60).
    "time_limit_minutes",
  ],
  // #841: the next instruction of a session and the one that could not start; null for every session that exists.
  implementer_sessions: [
    "queued_instruction",
    "queued_discarded",
    "queued_attempted_at",
    "queued_first_failed_at",
    // #909: the branch a session branch is made from apart from its base; null for every session that exists.
    "start_branch",
  ],
  // #745, step 7: the environment's network rule; every environment that exists reads `off` and no hosts (`DEFAULTS_OF_COLUMNS`).
  // #854: the kind (`hosted`) and the labels (none) of every environment that exists.
  implementer_environments: ["network_mode", "network_hosts", "kind", "labels"],
  // #818: the size of the VM where the Dispatcher reported it; null for every VM that exists.
  job_vm_runs: ["vcpus"],
  // #845: what started a run; every run that exists was started by hand (`DEFAULTS_OF_COLUMNS`).
  // #891: when a member asked for the run to stop; null for every run that exists.
  // #916: the trigger of the document that started the run; null for every run that exists.
  // #923: the ticket a run is about; null for every run that exists (the label trigger's runs are backfilled by the migration, and no
  // test of an older migration holds such a run).
  // #921: when a run was discarded and when a member asked it to pause; null for every run that exists.
  workflow_runs: [
    "trigger_kind",
    "cancel_requested_at",
    "trigger_id",
    "ticket_ref",
    "discarded_at",
    "pause_requested_at",
  ],
  // #922: the ticket source of a project (null reads as the issues of its repository without a board) and the project a lane belongs to
  // (the migration places the lanes that exist, but not at the time an older migration's test seeds them); null for every row that exists.
  projects: ["ticket_source"],
  workflows: ["project_id"],
  // #924: who a review of a pull request is asked from, and who acted on it while the request stood; null for every row that exists.
  tracker_items: ["review_requested_from", "review_acted_by"],
  // #920: the question a step ended with and the comment that carries it; null for every step that exists.
  workflow_step_runs: ["ask", "waiting_on_comment_id"],
  // #891: when a member asked for the running turn to stop; null for every job that exists.
  // #971: the labels a job requires; null for every job that exists (the claim derives them).
  jobs: ["cancel_requested_at", "required_labels"],
  // #919: the environment a profile version runs in; null for every version that exists (its step names the environment).
  profile_versions: ["environment_id"],
  // #856: how to read a settled record without a cost (a subscription turn); null for every record that exists.
  usage_records: ["cost_basis"],
};

/** What a column added later holds on an existing row when it is not null: a constant default. */
const DEFAULTS_OF_COLUMNS: Record<string, Record<string, unknown>> = {
  implementer_environments: {
    network_mode: "off",
    network_hosts: "",
    kind: "hosted",
    labels: "",
  },
  workflow_runs: { trigger_kind: "manual" },
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
