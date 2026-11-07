// SPDX-License-Identifier: LicenseRef-Proprietary

// The workflows of a workspace as a small table (#873): the way to a workflow's builder, its runs and its
// Start form. The names are free text of whoever wrote the workflow: rendered as text.
import Link from "next/link";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";
import { formatUtc } from "../ui/format-time.ts";
import { workspacePath } from "../workspaces/paths.ts";
import type { WorkflowSummaryView } from "../workflows/service.ts";
import { PAGE_COPY } from "./messages.ts";

export function WorkflowsList({
  workspaceSlug,
  workflows,
}: {
  workspaceSlug: string;
  workflows: readonly WorkflowSummaryView[];
}) {
  if (workflows.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{PAGE_COPY.workflowsTitle}</EmptyTitle>
          <EmptyDescription>{PAGE_COPY.workflowsEmpty}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <Table>
      <caption className="sr-only">{PAGE_COPY.workflowsTitle}</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Name</TableHead>
          <TableHead scope="col">{PAGE_COPY.workflowVersion}</TableHead>
          <TableHead scope="col">{PAGE_COPY.workflowUpdated}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {workflows.map((workflow) => (
          <TableRow key={workflow.id} data-workflow-id={workflow.id}>
            <TableCell className="min-w-0 whitespace-normal">
              <Link
                href={workspacePath(
                  workspaceSlug,
                  `/workflows/${encodeURIComponent(workflow.id)}`,
                )}
                className="font-semibold break-words text-foreground no-underline"
              >
                {workflow.name}
              </Link>
            </TableCell>
            <TableCell className="text-xs">{workflow.version}</TableCell>
            <TableCell className="text-xs">
              <time dateTime={workflow.updatedAt}>
                {formatUtc(workflow.updatedAt)}
              </time>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
