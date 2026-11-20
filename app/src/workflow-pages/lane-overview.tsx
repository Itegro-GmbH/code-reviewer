// SPDX-License-Identifier: LicenseRef-Proprietary

// What a lane page shows of the lane itself (#1107, ADR 0007): its name is the page's title; here are its description, its project, a
// line per trigger and the list of its versions, each with its number, when it was saved, by whom, and what it changed against the
// one before. Nothing here is edited: a lane is changed through the API, by an AI, and says so in the change description. Every text
// comes from whoever saved the lane, so it is shown as text and never as markup.
import Link from "next/link";
import { DescriptionList } from "../components/description-list.tsx";
import { formatUtc } from "../ui/format-time.ts";
import { workspacePath } from "../workspaces/paths.ts";
import { PAGE_COPY } from "./messages.ts";

export type LaneVersionRow = {
  version: number;
  savedAt: string;
  /** The name of whoever saved it; null when they are no member of the workspace any more. */
  author: string | null;
  /** What it changed; for version 1 the lane's description as first saved; null for a version saved before change descriptions. */
  text: string | null;
};

export type LaneOverviewData = {
  /** The lane's description; null when the saved document has none. */
  description: string | null;
  /** The project the lane belongs to: its repository's name and the id of the repository its page is at; null when none is known. */
  project: { name: string; repositoryId: string } | null;
  /** One line per trigger. */
  triggers: string[];
  /** False when the saved document cannot be read as a lane. */
  readable: boolean;
  /** Every saved version, the newest first. */
  versions: LaneVersionRow[];
};

export function LaneOverview({
  workspaceSlug,
  data,
  current,
  archived,
}: {
  workspaceSlug: string;
  data: LaneOverviewData;
  current: number;
  archived: boolean;
}) {
  return (
    <section aria-labelledby="lane-heading" className="flex flex-col gap-4">
      <h2 id="lane-heading" className="text-xl font-semibold">
        {PAGE_COPY.laneHeading}
      </h2>
      {data.readable ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {PAGE_COPY.laneUnreadable}
        </p>
      )}
      <DescriptionList
        items={[
          {
            term: PAGE_COPY.laneDescription,
            description: (
              <span className="whitespace-pre-wrap">
                {data.description ?? PAGE_COPY.laneNoDescription}
              </span>
            ),
          },
          ...(data.project === null
            ? []
            : [
                {
                  term: PAGE_COPY.laneProject,
                  description: (
                    <Link
                      href={workspacePath(
                        workspaceSlug,
                        `/projects/${encodeURIComponent(data.project.repositoryId)}`,
                      )}
                      className="underline"
                    >
                      {data.project.name}
                    </Link>
                  ),
                },
              ]),
          {
            term: PAGE_COPY.laneTriggers,
            description:
              data.triggers.length === 0 ? (
                PAGE_COPY.laneNoTriggers
              ) : (
                <ul className="list-disc pl-5">
                  {data.triggers.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              ),
          },
          ...(archived
            ? [{ term: PAGE_COPY.laneArchived, description: "✓" }]
            : []),
        ]}
      />
      <h3 id="versions-heading" className="text-lg font-semibold">
        {PAGE_COPY.versionsHeading}
      </h3>
      <p className="text-sm text-muted-foreground">{PAGE_COPY.versionsAskAi}</p>
      <ol aria-labelledby="versions-heading" className="flex flex-col gap-3">
        {data.versions.map((row) => (
          <li
            key={row.version}
            className="rounded-md border p-3 text-sm"
            data-version={row.version}
          >
            <p className="font-medium">
              {PAGE_COPY.workflowVersion} {row.version}
              {row.version === current ? ` · ${PAGE_COPY.versionCurrent}` : ""}
            </p>
            <p className="text-muted-foreground">
              <time dateTime={row.savedAt}>{formatUtc(row.savedAt)}</time>{" "}
              {PAGE_COPY.versionSavedBy}{" "}
              {row.author ?? PAGE_COPY.versionUnknownAuthor}
            </p>
            <p className="mt-1 whitespace-pre-wrap">
              {row.version === 1
                ? row.text === null
                  ? PAGE_COPY.laneNoDescription
                  : `${PAGE_COPY.versionFirst} ${row.text}`
                : (row.text ?? PAGE_COPY.versionNoChangeDescription)}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
