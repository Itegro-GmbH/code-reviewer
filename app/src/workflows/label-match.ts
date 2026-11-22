// SPDX-License-Identifier: LicenseRef-Proprietary

// Which label of a Jira issue a lane's label stands for (#1129, epic #1034). Jira labels cannot contain whitespace, and the factory writes a
// label it names with a space ("ready for agent") with a hyphen ("ready-for-agent"; `jira/ticket-writer.ts`), so a lane that waits for
// "ready for agent" starts when a person puts "ready-for-agent" on a Jira issue. The match is exact after that, case counts, as it does for a
// GitHub label. Pure (it lives here, not in `src/jira/`, because `workflow-runs` may not import `jira`: an import cycle).

/** The longest label Jira takes. */
const JIRA_LABEL_MAX_CHARS = 255;

/** A label Jira takes: no whitespace (a run of it becomes one hyphen), at most 255 characters. */
export function jiraLabel(label: string): string {
  return label.trim().replace(/\s+/g, "-").slice(0, JIRA_LABEL_MAX_CHARS);
}

/** Whether the label a lane waits for is the one of `labels` (the labels a Jira delivery says were put on), as Jira would spell it. */
export function laneLabelIsAmong(
  wanted: string,
  labels: ReadonlySet<string>,
): boolean {
  const spelled = jiraLabel(wanted);
  return spelled !== "" && labels.has(spelled);
}

/** The labels of a Jira changelog item (`fromString`, `toString`: the labels separated by spaces), each once, in order. */
export function labelsOfChangelogText(text: string | null): string[] {
  if (text === null) return [];
  return [...new Set(text.split(/\s+/).filter((label) => label !== ""))];
}

/** The labels a `labels` item of a Jira changelog put on: those of the new list that the old list did not have. A removal adds none. */
export function labelsAdded(
  fromString: string | null,
  toString: string | null,
): string[] {
  const before = new Set(labelsOfChangelogText(fromString));
  return labelsOfChangelogText(toString).filter((label) => !before.has(label));
}
