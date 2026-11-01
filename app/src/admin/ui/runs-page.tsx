// SPDX-License-Identifier: LicenseRef-Proprietary

// The job view of the admin portal (#541): the newest runs of every workspace in one table, and one run
// with its facts, what it consumed and the tables of its calls. The operator looks at what a run did, so the
// log and the question of an `/ask` are not here; the cost is shown in full. Names that came from GitHub or
// from a person are text, and a long name truncates instead of widening the page.
import Link from "next/link";
import { Breadcrumbs } from "../../components/breadcrumbs.tsx";
import { DescriptionList } from "../../components/description-list.tsx";
import { PageHeader } from "../../components/page-header.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "../../components/ui/empty.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { JOB_KIND_NAMES } from "../../review-settings/kind-names.ts";
import { formatDuration } from "../../runs/run-duration.ts";
import { RUN_STATUS_PRESENTATION } from "../../runs/run-status.ts";
import { CallTraceTables } from "../../runs/ui/call-trace.tsx";
import { CALL_TRACE_COPY } from "../../runs/ui/call-trace-messages.ts";
import { usageItems } from "../../runs/ui/usage-facts.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { AdminRunDetailView, AdminRunsListView } from "../runs-service.ts";
import { ADMIN_RUNS_COPY } from "./runs-messages.ts";

const runPath = (id: string) => `/admin/runs/${encodeURIComponent(id)}`;

export function AdminRunsListContent({ list }: { list: AdminRunsListView }) {
  const columns = ADMIN_RUNS_COPY.columns;
  return (
    <div data-slot="admin-runs" className="flex flex-col gap-6">
      <PageHeader
        title={ADMIN_RUNS_COPY.listTitle}
        description={ADMIN_RUNS_COPY.listDescription}
        breadcrumb={
          <Breadcrumbs
            items={[
              { label: ADMIN_RUNS_COPY.breadcrumbRoot, href: "/admin" },
              { label: ADMIN_RUNS_COPY.listTitle },
            ]}
          />
        }
      />
      {list.runs.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>{ADMIN_RUNS_COPY.empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table aria-label={ADMIN_RUNS_COPY.listTitle}>
          <TableHeader>
            <TableRow>
              <TableHead>{columns.workspace}</TableHead>
              <TableHead>{columns.project}</TableHead>
              <TableHead>{columns.kind}</TableHead>
              <TableHead>{columns.status}</TableHead>
              <TableHead>{columns.created}</TableHead>
              <TableHead>{columns.duration}</TableHead>
              <TableHead>{columns.error}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="max-w-[10rem] truncate">
                  {run.workspaceSlug}
                </TableCell>
                <TableCell className="max-w-[16rem] truncate">
                  <Link
                    className="text-primary underline-offset-4 hover:underline"
                    href={runPath(run.id)}
                  >
                    <span className="sr-only">{run.id.slice(0, 8)} </span>
                    {run.project} #{run.prNumber}
                  </Link>
                </TableCell>
                <TableCell>{JOB_KIND_NAMES[run.reviewKind]}</TableCell>
                <TableCell>
                  {RUN_STATUS_PRESENTATION[run.status].label}
                </TableCell>
                <TableCell>
                  <time dateTime={run.createdAt}>
                    {formatUtc(run.createdAt)}
                  </time>
                </TableCell>
                <TableCell>
                  {run.durationMs === null
                    ? ""
                    : formatDuration(run.durationMs)}
                </TableCell>
                <TableCell>
                  {run.errorCode === null ? (
                    ""
                  ) : (
                    <code className="font-mono text-xs">{run.errorCode}</code>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {list.hasMore ? (
        <p className="text-sm text-muted-foreground">
          {ADMIN_RUNS_COPY.limited}
        </p>
      ) : null}
    </div>
  );
}

export function AdminRunDetailContent({
  detail,
}: {
  detail: AdminRunDetailView;
}) {
  const { run } = detail;
  const usage = usageItems(run);
  const items = [
    {
      term: "Workspace",
      description: `${detail.workspaceName} (${detail.workspaceSlug})`,
    },
    { term: "Project", description: run.project },
    { term: "Pull request", description: `#${run.prNumber}` },
    { term: "Review kind", description: JOB_KIND_NAMES[run.reviewKind] },
    { term: "Status", description: RUN_STATUS_PRESENTATION[run.status].label },
    ...(run.errorCode === null
      ? []
      : [
          {
            term: "Error code",
            description: <code className="font-mono">{run.errorCode}</code>,
          },
        ]),
    { term: "Created", description: formatUtc(run.createdAt) },
    {
      term: "Duration",
      description:
        run.durationMs === null ? "" : formatDuration(run.durationMs),
    },
    ...usage.model,
    ...usage.consumption,
  ];
  return (
    <div data-slot="admin-run" className="flex max-w-[64rem] flex-col gap-6">
      <PageHeader
        title={`Run ${run.id.slice(0, 8)}`}
        description={ADMIN_RUNS_COPY.detailDescription}
        breadcrumb={
          <Breadcrumbs
            items={[
              { label: ADMIN_RUNS_COPY.breadcrumbRoot, href: "/admin" },
              { label: ADMIN_RUNS_COPY.listTitle, href: "/admin/runs" },
              { label: run.id.slice(0, 8) },
            ]}
          />
        }
      />
      <Card role="region" aria-label={ADMIN_RUNS_COPY.summaryTitle}>
        <CardHeader>
          <CardTitle>
            <h2 className="text-lg font-semibold tracking-tight">
              {ADMIN_RUNS_COPY.summaryTitle}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DescriptionList items={items} />
        </CardContent>
      </Card>
      <Card role="region" aria-label={CALL_TRACE_COPY.title}>
        <CardHeader>
          <CardTitle>
            <h2 className="text-lg font-semibold tracking-tight">
              {CALL_TRACE_COPY.title}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {run.callTrace === null ? (
            <p className="text-sm text-muted-foreground">
              {ADMIN_RUNS_COPY.noTrace}
            </p>
          ) : (
            <CallTraceTables trace={run.callTrace} showProviderDetail />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
