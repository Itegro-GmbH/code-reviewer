// SPDX-License-Identifier: LicenseRef-Proprietary

// Applies what a Jira delivery says to the ticket mirror (#1039): the Jira issues of a project's ticket source are cached in `tracker_items`
// under the id of the repository the code lives in, with `provider = jira` and the text key `PROJ-7` (the mirror is keyed by repository,
// provider and key since #1035; a Jira source always names that repository). The row's `number` is the number at the end of the key (it
// keeps the old primary key unique within a project and the UI's `#7` meaningful), the status is Jira's own status name in `board_status`
// (never mapped), and a status category `done` reads as `closed`. Like all of the mirror it is a read cache: a change that cannot be applied
// is `not_mirrored`, never an error, and the next delivery or full read rebuilds what a missed one left. Pure over its repository.
import type { TrackerRepository } from "../db/repositories/tracker-repository.ts";
import {
  issueNumberOfKey,
  projectKeyOfIssueKey,
  type JiraIssue,
} from "./issue.ts";
import type { JiraChange } from "./webhook-events.ts";

/** The provider name the rows carry. */
export const JIRA_TRACKER_PROVIDER = "jira";

/** The mirror's own limits (`tracker_items_shape_check`): a longer text is cut, never refused. */
const TITLE_MAX_CHARS = 1024;
const BODY_EXCERPT_MAX_CHARS = 4000;

export type JiraMirrorTarget = {
  /** The repository the code of the project lives in: where the rows sit. */
  repositoryId: string;
  /** `owner/name` of that repository. */
  repoFullName: string;
};

export type JiraMirror = {
  /** Writes the change; throws what the database throws. */
  apply(
    target: JiraMirrorTarget,
    change: JiraChange,
  ): Promise<"updated" | "not_mirrored">;
};

function parentNumberOf(issue: JiraIssue): number | null {
  // A parent in another project has a number of that project: it is not one of this project's rows.
  if (
    issue.parentKey === undefined ||
    projectKeyOfIssueKey(issue.parentKey) !== issue.projectKey
  )
    return null;
  return issueNumberOfKey(issue.parentKey) ?? null;
}

const cut = (text: string, max: number): string =>
  Array.from(text).slice(0, max).join("");

export function createJiraMirror(deps: {
  tracker: Pick<TrackerRepository, "upsertItem" | "deleteItem">;
}): JiraMirror {
  return {
    async apply(target, change) {
      if (change.kind === "ignored") return "not_mirrored";
      if (change.kind === "issue_deleted") {
        const number = issueNumberOfKey(change.key);
        if (number === undefined) return "not_mirrored";
        // The row stays as a tombstone: a delivery about the issue that is older than this one does not bring it back.
        return (await deps.tracker.deleteItem(
          target.repositoryId,
          number,
          change.at,
        ))
          ? "updated"
          : "not_mirrored";
      }
      const { issue } = change;
      if (issue.updatedAt === "") return "not_mirrored";
      const written = await deps.tracker.upsertItem(target.repositoryId, {
        provider: JIRA_TRACKER_PROVIDER,
        repo: target.repoFullName,
        key: issue.key,
        number: issue.number,
        // The id a board item would find the row by: Jira has no boards in the mirror, the prefix keeps it clear of GitHub's node ids.
        nodeId: `jira:${issue.id}`,
        kind: "issue",
        state: issue.statusCategory === "done" ? "closed" : "open",
        stateReason: null,
        type: issue.type === "" ? null : issue.type,
        title: cut(issue.title, TITLE_MAX_CHARS),
        bodyExcerpt: cut(issue.body, BODY_EXCERPT_MAX_CHARS),
        labels: issue.labels.map((name) => ({ name, color: "" })),
        assignees: issue.assignees.map((login) => ({ login })),
        closes: [],
        updatedAt: issue.updatedAt,
        parentNumber: parentNumberOf(issue),
        boardStatus: issue.status === "" ? null : issue.status,
      });
      return written ? "updated" : "not_mirrored";
    },
  };
}
