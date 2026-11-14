// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/internal/jira-webhooks, called once a night by the platform's cron (`vercel.json`; #1039): every Jira webhook the factory
// registered at a site is looked at again. Atlassian ends a webhook that was registered through the REST API after 30 days unless it is
// extended, so the one thing that keeps a Jira source alive is this job: a webhook that ends within ten days is extended, one that Jira no
// longer knows is registered again, one that failed to register is tried again, and one whose project is off or has another source is
// deleted (`src/jira/webhook-registrar.ts`, which this only walks).
//
//  - One webhook's failure never stops the others: each is tried on its own and logged by its project id and the code of its failure.
//  - A deployment without the factory (`implementer`), or without the Atlassian settings, touches nothing and answers `skipped`.
//  - The run has a budget (the function's time limit is longer); the webhooks it does not reach are counted `deferred` and come first
//    the next night (the list is oldest first, and one that failed is retried at the next run anyway).
//  - Overlapping runs are safe: a webhook that was extended is not extended again, and two registrations of one project leave the row at
//    the last one.
// The answer carries counts only.
import "server-only";
import type { ReconcileResult } from "../jira/webhook-registrar.ts";
import { refuseUnlessCron } from "./auth.ts";

export const JIRA_WEBHOOKS_CRON_ERROR_CODES = [
  "JIRA_WEBHOOKS_CRON_FAILED",
] as const;

/** How long a run keeps starting new webhooks (the function may run 300 seconds). */
export const JIRA_WEBHOOKS_BUDGET_MS = 240_000;

/** At most this many webhooks one run walks; a deployment has a handful per site, Jira allows five per connection. */
export const JIRA_WEBHOOKS_MAX_PER_RUN = 1000;

export type JiraWebhooksCounts = {
  webhooks: number;
  registered: number;
  extended: number;
  unchanged: number;
  removed: number;
  failed: number;
  deferred: number;
};

export type JiraWebhooksCronDependencies = {
  env: Readonly<Record<string, string | undefined>>;
  enabled(): boolean;
  /** The projects that have a webhook row, of every workspace, oldest first. */
  targets(limit: number): Promise<{ workspaceId: string; projectId: string }[]>;
  reconcile(workspaceId: string, projectId: string): Promise<ReconcileResult>;
  now?: () => number;
  budgetMs?: number;
  log?: (line: string) => void;
};

export async function handleJiraWebhooksCron(
  request: Request,
  deps: JiraWebhooksCronDependencies,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budgetMs = deps.budgetMs ?? JIRA_WEBHOOKS_BUDGET_MS;
  const log = deps.log ?? ((line) => console.error(line));
  const refusal = refuseUnlessCron(request, deps.env);
  if (refusal !== null) return refusal;
  const headers = { "cache-control": "no-store" };
  if (!deps.enabled())
    return Response.json(
      { status: "skipped", reason: "not_enabled" },
      { headers },
    );
  try {
    const targets = await deps.targets(JIRA_WEBHOOKS_MAX_PER_RUN);
    const counts: JiraWebhooksCounts = {
      webhooks: targets.length,
      registered: 0,
      extended: 0,
      unchanged: 0,
      removed: 0,
      failed: 0,
      deferred: 0,
    };
    for (const target of targets) {
      if (now() - startedAt >= budgetMs) {
        counts.deferred += 1;
        continue;
      }
      try {
        const result = await deps.reconcile(
          target.workspaceId,
          target.projectId,
        );
        if (result.outcome === "failed") counts.failed += 1;
        else if (result.outcome === "none") counts.unchanged += 1;
        else counts[result.outcome] += 1;
      } catch (error) {
        counts.failed += 1;
        // The code only: a database error may carry a connection string.
        log(
          `[jira] JIRA_WEBHOOK_RECONCILE_FAILED: project=${target.projectId} (${error instanceof Error ? error.name : "unknown error"}); the others go on.`,
        );
      }
    }
    log(
      `[jira] nightly webhooks done: ${String(counts.webhooks)} webhooks, ${String(counts.registered)} registered, ${String(counts.extended)} extended, ${String(counts.removed)} removed, ${String(counts.failed)} failed, ${String(counts.deferred)} deferred`,
    );
    return Response.json({ status: "ok", ...counts }, { headers });
  } catch {
    console.error(
      "[jira] JIRA_WEBHOOKS_CRON_FAILED: the nightly job could not list the webhooks.",
    );
    return Response.json(
      { status: "error", code: "JIRA_WEBHOOKS_CRON_FAILED" },
      { status: 500, headers },
    );
  }
}
