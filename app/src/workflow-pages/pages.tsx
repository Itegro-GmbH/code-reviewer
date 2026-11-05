// SPDX-License-Identifier: LicenseRef-Proprietary

// The content of the three workflow pages (#873): the list of workflows, one workflow (its Start form and its runs) and one run. The
// `load…` functions gather the data from the services (passed in); an id nobody has in this workspace, also the id of another
// workspace's, gives `not_found` and the page shows the not-found page, nothing of anything else. The `…Content` components render it.
import Link from "next/link";
import { Breadcrumbs } from "../components/breadcrumbs.tsx";
import { Button } from "../components/button.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { ROLE_NOT_ALLOWED } from "../copy/messages.ts";
import { WorkflowError } from "../workflows/errors.ts";
import type {
  WorkflowList,
  WorkflowService,
  WorkflowView,
} from "../workflows/service.ts";
import { workspacePath } from "../workspaces/paths.ts";
import { WorkflowRunError } from "../workflow-runs/errors.ts";
import { RUNS_LISTED_MAX } from "../workflow-runs/limits.ts";
import type {
  RunSummaryView,
  RunView,
  WorkflowRunService,
} from "../workflow-runs/service.ts";
import type { WorkflowRunsApi } from "./api.ts";
import { PAGE_COPY, START_COPY } from "./messages.ts";
import { WorkflowRunDetail } from "./run-detail.tsx";
import { WorkflowRunsList } from "./runs-list.tsx";
import { StartForm } from "./start-form.tsx";
import { startFormOf, type StartFormSpec } from "./start-form-spec.ts";
import { WorkflowsList } from "./workflows-list.tsx";

type NotFound = { kind: "not_found" };

/** Runs `work`, and turns "there is no such workflow or run" into `not_found`; any other failure is the page's. */
async function orNotFound<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    if (
      (error instanceof WorkflowError && error.code === "WORKFLOW_NOT_FOUND") ||
      (error instanceof WorkflowRunError &&
        (error.code === "WORKFLOW_RUN_NOT_FOUND" ||
          error.code === "WORKFLOW_RUN_WORKFLOW_NOT_FOUND"))
    )
      return undefined;
    throw error;
  }
}

// --- the list of workflows

export async function loadWorkflowsPage(deps: {
  workflows: Pick<WorkflowService, "list">;
}): Promise<WorkflowList> {
  return deps.workflows.list();
}

export function WorkflowsPageContent({
  workspaceSlug,
  data,
}: {
  workspaceSlug: string;
  data: WorkflowList;
}) {
  return (
    <>
      <PageHeader
        title={PAGE_COPY.workflowsTitle}
        description={PAGE_COPY.workflowsDescription}
      />
      <WorkflowsList workspaceSlug={workspaceSlug} workflows={data.workflows} />
    </>
  );
}

// --- one workflow

export type WorkflowPageData =
  | NotFound
  | {
      kind: "ready";
      workflow: Pick<WorkflowView, "id" | "name" | "version" | "archivedAt">;
      form: StartFormSpec;
      runs: RunSummaryView[];
    };

export async function loadWorkflowPage(
  workflowId: string,
  deps: {
    workflows: Pick<WorkflowService, "get">;
    runs: Pick<WorkflowRunService, "list">;
  },
): Promise<WorkflowPageData> {
  const found = await orNotFound(async () => ({
    workflow: await deps.workflows.get(workflowId),
    runs: (await deps.runs.list(workflowId)).runs,
  }));
  if (found === undefined) return { kind: "not_found" };
  const { workflow, runs } = found;
  return {
    kind: "ready",
    workflow: {
      id: workflow.id,
      name: workflow.name,
      version: workflow.version,
      archivedAt: workflow.archivedAt,
    },
    form: startFormOf(workflow.document),
    runs,
  };
}

function StartSection({
  workspaceSlug,
  data,
  mayStart,
}: {
  workspaceSlug: string;
  data: Extract<WorkflowPageData, { kind: "ready" }>;
  mayStart: boolean;
}) {
  const { workflow, form } = data;
  // Every role of a workspace may start today, so `mayStart` is true on every request the app makes. The branch stays so that a role
  // that loses the right (the permission table is where that is decided) gets this sentence and no form, not a form whose every
  // start the server refuses; #873-T73 holds it.
  const notice =
    workflow.archivedAt !== null
      ? "This workflow is archived and cannot be started."
      : !mayStart
        ? ROLE_NOT_ALLOWED
        : form.kind === "not_manual"
          ? START_COPY.notManual
          : form.kind === "unusable"
            ? "The saved workflow cannot be read."
            : null;
  return (
    <section aria-labelledby="start-heading" className="flex flex-col gap-4">
      <h2 id="start-heading" className="text-xl font-semibold">
        {START_COPY.heading}
      </h2>
      {notice !== null || form.kind !== "form" ? (
        <Alert variant="info" role="status">
          {notice ?? ""}
        </Alert>
      ) : (
        <StartForm
          workspaceSlug={workspaceSlug}
          workflowId={workflow.id}
          fields={form.fields}
        />
      )}
    </section>
  );
}

export function WorkflowPageContent({
  workspaceSlug,
  data,
  mayStart,
  api,
}: {
  workspaceSlug: string;
  data: Extract<WorkflowPageData, { kind: "ready" }>;
  mayStart: boolean;
  /** Only tests pass this: a server component cannot hand functions to the client component. */
  api?: WorkflowRunsApi;
}) {
  const { workflow } = data;
  return (
    <>
      <PageHeader
        title={workflow.name}
        description={`${PAGE_COPY.workflowVersion} ${String(workflow.version)}`}
        breadcrumb={
          <Breadcrumbs
            items={[
              {
                label: PAGE_COPY.breadcrumbRoot,
                href: workspacePath(workspaceSlug, "/workflows"),
              },
              { label: workflow.name },
            ]}
          />
        }
      />
      <StartSection
        workspaceSlug={workspaceSlug}
        data={data}
        mayStart={mayStart}
      />
      <section aria-labelledby="runs-heading" className="flex flex-col gap-4">
        <h2 id="runs-heading" className="text-xl font-semibold">
          {PAGE_COPY.runsHeading}
        </h2>
        <WorkflowRunsList
          workspaceSlug={workspaceSlug}
          workflowId={workflow.id}
          initial={{ runs: data.runs }}
          {...(api === undefined ? {} : { api })}
        />
        {data.runs.length < RUNS_LISTED_MAX ? null : (
          <p className="text-sm text-muted-foreground">
            {PAGE_COPY.runsShowing}
          </p>
        )}
      </section>
    </>
  );
}

// --- one run

export type RunPageData =
  | NotFound
  | {
      kind: "ready";
      workflow: Pick<WorkflowView, "id" | "name">;
      run: RunView;
    };

export async function loadRunPage(
  workflowId: string,
  runId: string,
  deps: {
    workflows: Pick<WorkflowService, "get">;
    runs: Pick<WorkflowRunService, "get">;
  },
): Promise<RunPageData> {
  const found = await orNotFound(async () => ({
    workflow: await deps.workflows.get(workflowId),
    run: await deps.runs.get(workflowId, runId),
  }));
  if (found === undefined) return { kind: "not_found" };
  return {
    kind: "ready",
    workflow: { id: found.workflow.id, name: found.workflow.name },
    run: found.run,
  };
}

export function RunPageContent({
  workspaceSlug,
  data,
  api,
}: {
  workspaceSlug: string;
  data: Extract<RunPageData, { kind: "ready" }>;
  /** Only tests pass this: a server component cannot hand functions to the client component. */
  api?: WorkflowRunsApi;
}) {
  const { workflow, run } = data;
  const workflowHref = workspacePath(
    workspaceSlug,
    `/workflows/${encodeURIComponent(workflow.id)}`,
  );
  return (
    <>
      <PageHeader
        title={`${workflow.name}, ${PAGE_COPY.runTitle.toLowerCase()}`}
        breadcrumb={
          <Breadcrumbs
            items={[
              {
                label: PAGE_COPY.breadcrumbRoot,
                href: workspacePath(workspaceSlug, "/workflows"),
              },
              { label: workflow.name, href: workflowHref },
              { label: PAGE_COPY.runTitle },
            ]}
          />
        }
        actions={
          <Button asChild variant="secondary">
            <Link href={workflowHref}>{PAGE_COPY.allRuns}</Link>
          </Button>
        }
      />
      {/* Keyed on the run. The polled data is tied to the server data it was fetched next to, so a page that stays mounted behind
          another one (Cache Components) and is shown again with fresh server data starts from that data. */}
      <WorkflowRunDetail
        key={run.id}
        workspaceSlug={workspaceSlug}
        workflowId={workflow.id}
        initial={{ run }}
        {...(api === undefined ? {} : { api })}
      />
    </>
  );
}
