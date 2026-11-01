// SPDX-License-Identifier: LicenseRef-Proprietary

// The notice a pull request gets when a review is refused for a limit or a suspension (#281). The claim has failed
// the job already (src/usage/README.md, "Limits and suspension at claim"); this posts ONE short comment on the pull
// request, as the app (its own installation token, no runner and no model involved), once per pull request and
// period. Best effort throughout: nothing here ever throws or changes the outcome of a job, a failure is one log
// line with a stable code, and a failed post is tried again only a few times, after a wait (the cron sweep, #328,
// calls `retryDue`; without a sweep the next refusal on the pull request tries again).
//
// Untrusted data: the title, branches and description of the pull request are never read into the text (the text
// takes the code, the period and the instance's link), and a pull request is looked at only for being open and,
// for an automatic review, not a draft.
import type { ProductIdentity } from "../product-identity/identity.ts";
import type {
  RefusalNoticesRepository,
  StoredNotice,
} from "../db/repositories/refusal-notices-repository.ts";
import type { ClaimRefusal } from "../db/repositories/claim-admission.ts";
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type {
  RepositoriesRepository,
  StoredRepository,
} from "../db/repositories/repositories-repository.ts";
import type { WorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { IntegrationError } from "../integrations/errors.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { RepoRef } from "../integrations/types.ts";
import {
  isNoticeCode,
  noticeLinkKind,
  noticeBody,
  noticeMarker,
  type NoticeCode,
} from "./notice-text.ts";

const MINUTE = 60 * 1000;

/** How long an attempt holds the notice: another instance does not post while it may still be running. */
export const ATTEMPT_LEASE_MS = 2 * MINUTE;
/** A notice that started this many posts is given up; the sweep and the next refusal leave it alone. */
export const MAX_ATTEMPTS = 3;
/** After a failed post the notice waits this long times the attempts made so far. */
export const RETRY_WAIT_MS = 5 * MINUTE;
/** How many due notices one sweep run works through. */
export const RETRY_BATCH = 20;
/** The look for an earlier post starts this long before the first attempt (clocks of the app and of GitHub differ). */
const EARLIER_LOOK_MARGIN_MS = 5 * MINUTE;

/** The stable codes of this module's log lines. */
export const NOTICE_LOG_CODES = [
  "REFUSAL_NOTICE_FAILED",
  "REFUSAL_NOTICE_PULL_REQUEST_UNREADABLE",
  "REFUSAL_NOTICE_UNSUPPORTED",
  "REFUSAL_NOTICE_ERROR",
] as const;

/** Failures of reading the pull request that no later attempt will cure: it, or the installation, is gone. */
const PERMANENT_READ_FAILURES: readonly string[] = [
  "INTEGRATION_PULL_REQUEST_NOT_FOUND",
  "INTEGRATION_ACCESS_CONNECTION_GONE",
];

const BEGIN = { leaseMs: ATTEMPT_LEASE_MS, maxAttempts: MAX_ATTEMPTS };

/** What the claim tells about a refused job (the fields the notice needs). */
export type NoticeRefusal = Pick<
  ClaimRefusal,
  | "workspaceId"
  | "repositoryId"
  | "prNumber"
  | "triggerKind"
  | "reviewKind"
  | "errorCode"
  | "periodStart"
>;

export type RetryReport = { tried: number };

export type RefusalNoticeService = {
  /** Never rejects. Posts the notice of the refusal if the pull request has none for the period yet. */
  onRefused(refusal: NoticeRefusal): Promise<void>;
  /** Never rejects. Tries the notices that are due again; at most `RETRY_BATCH`. */
  retryDue(): Promise<RetryReport>;
};

export type RefusalNoticeDeps = {
  /** Who the notice speaks for: it names the product when nobody in the workspace can act. */
  product: ProductIdentity;
  repositories: (workspaceId: string) => Pick<RepositoriesRepository, "get">;
  integrations: (workspaceId: string) => Pick<IntegrationsRepository, "get">;
  workspaces: Pick<WorkspacesRepository, "get">;
  notices: (workspaceId: string) => RefusalNoticesRepository;
  /** The notices that wait for another attempt, across workspaces (the sweep). */
  dueNotices: (
    now: Date,
    options: { limit: number; maxAttempts: number },
  ) => Promise<StoredNotice[]>;
  registry: Pick<IntegrationRegistry, "resolve">;
  /** The link to the plan page of a workspace, or null when the instance has none (plan-link.ts). */
  planPageUrl: (
    workspaceSlug: string,
  ) => string | null | Promise<string | null>;
  /**
   * The link to the settings of a workspace, where an Owner or Admin adds credit (#498; until the balance page exists, #505) or
   * changes the monthly limit (#499): for a refusal for the balance or the monthly limit. Absent: no link.
   */
  settingsUrl?: (
    workspaceSlug: string,
  ) => string | null | Promise<string | null>;
  now: () => Date;
  /** Receives lines of ids and stable codes only. */
  log: { info(line: string): void; error(line: string): void };
};

type Target = {
  workspaceId: string;
  repositoryId: string;
  prNumber: number;
  periodStart: string;
  code: NoticeCode;
  /** An automatic review does not announce itself on a draft; one that somebody asked for does. */
  skipDraft: boolean;
};

function errorCodeOf(error: unknown): string {
  return error instanceof IntegrationError
    ? error.code
    : "INTEGRATION_ACCESS_FAILED";
}

function repoRefOf(repository: StoredRepository): RepoRef {
  return {
    integrationId: repository.integrationId,
    externalId: repository.externalId,
    fullName: repository.fullName,
    url: repository.url,
  };
}

export function createRefusalNoticeService(
  deps: RefusalNoticeDeps,
): RefusalNoticeService {
  // One at a time inside a process: a backlog refused in one claim never opens many requests at GitHub at once.
  let tail: Promise<unknown> = Promise.resolve();
  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  /** When a notice whose attempt failed may be taken again: longer after every attempt. */
  const retryAt = (notice: StoredNotice) =>
    new Date(deps.now().getTime() + RETRY_WAIT_MS * notice.attempts);

  /** The link, or none: a notice without one is still the notice, so a setting that cannot be read costs only the link. */
  async function noticeLink(
    code: NoticeCode,
    workspaceSlug: string,
  ): Promise<string | null> {
    try {
      switch (noticeLinkKind(code)) {
        case "settings":
          return (await deps.settingsUrl?.(workspaceSlug)) ?? null;
        case "none":
          return null;
        case "plan":
          return await deps.planPageUrl(workspaceSlug);
      }
    } catch {
      return null;
    }
  }

  async function attempt(target: Target): Promise<void> {
    const { workspaceId, repositoryId, prNumber, periodStart, code } = target;
    const where = `workspace=${workspaceId} repository=${repositoryId} pr=${prNumber}`;
    const notices = deps.notices(workspaceId);
    const key = { repositoryId, prNumber, periodStart };

    // Posted, dropped, or an attempt that is still running: nothing to do, and no call to GitHub.
    const existing = await notices.find(key);
    if (existing !== undefined) {
      if (existing.state !== "pending") return;
      if (existing.attempts >= MAX_ATTEMPTS) return;
      if (existing.nextAttemptAt > deps.now().toISOString()) return;
    }

    // A notice that is due again must always move on (be posted, be counted as an attempt, or be dropped): a row
    // that is skipped without a change would be listed by the sweep on every run, and could starve newer ones.
    const drop = async () => {
      if (existing !== undefined) await notices.markDropped(existing.id);
    };
    const repository = await deps.repositories(workspaceId).get(repositoryId);
    if (repository === undefined) return drop();
    const integration = await deps
      .integrations(workspaceId)
      .get(repository.integrationId);
    if (integration === undefined || integration.status !== "active")
      return drop();
    const provider = deps.registry.resolve(integration.type);
    if (provider.postPullRequestNotice === undefined) {
      deps.log.error(`[notices] REFUSAL_NOTICE_UNSUPPORTED ${where}`);
      return drop();
    }
    const repo = repoRefOf(repository);

    let pullRequest;
    try {
      pullRequest = await provider.getPullRequest(integration, repo, prNumber);
    } catch (error) {
      const failure = errorCodeOf(error);
      deps.log.error(
        `[notices] REFUSAL_NOTICE_PULL_REQUEST_UNREADABLE ${where} code=${failure}`,
      );
      if (existing === undefined) return;
      // The pull request or the installation is gone for good: nothing will ever be posted.
      if (PERMANENT_READ_FAILURES.includes(failure)) return drop();
      // Maybe a moment: count it as an attempt and wait, so it is not read on every run of the sweep.
      const counted = await notices.begin(key, code, BEGIN);
      if (counted.acquired)
        await notices.failed(counted.notice.id, retryAt(counted.notice));
      return;
    }
    if (pullRequest.state !== "open") {
      // Nobody reads a notice on a closed pull request, and the same refusal would not post one later either.
      return drop();
    }
    if (pullRequest.draft && target.skipDraft) return;

    const taken = await notices.begin(key, code, BEGIN);
    if (!taken.acquired) return;
    const { notice } = taken;

    const workspace = await deps.workspaces.get(workspaceId);
    const link =
      workspace === undefined ? null : await noticeLink(code, workspace.slug);
    try {
      await provider.postPullRequestNotice(integration, repo, prNumber, {
        body: noticeBody(deps.product, code, periodStart, link),
        marker: noticeMarker(periodStart),
        // A later attempt may follow one that posted and then stopped before it was noted: look first.
        ...(notice.attempts > 1
          ? {
              lookForEarlierSince: new Date(
                Date.parse(notice.createdAt) - EARLIER_LOOK_MARGIN_MS,
              ).toISOString(),
            }
          : {}),
      });
      await notices.markPosted(notice.id);
    } catch (error) {
      deps.log.error(
        `[notices] REFUSAL_NOTICE_FAILED ${where} code=${errorCodeOf(error)} attempt=${notice.attempts}`,
      );
      await notices.failed(notice.id, retryAt(notice));
    }
  }

  /** Whatever goes wrong, the caller is not told: a notice is never a reason to fail anything. */
  async function safely(target: Target): Promise<void> {
    try {
      await attempt(target);
    } catch (error) {
      deps.log.error(
        `[notices] REFUSAL_NOTICE_ERROR workspace=${target.workspaceId} code=${errorCodeOf(error)}`,
      );
    }
  }

  return {
    onRefused(refusal) {
      return inOrder(async () => {
        const { workspaceId, errorCode, periodStart } = refusal;
        if (!isNoticeCode(errorCode) || periodStart === undefined) return;
        // #752: a turn of the Implementer has no pull request to comment on (its number is a placeholder).
        if (refusal.reviewKind === "implementer") return;
        await safely({
          workspaceId,
          repositoryId: refusal.repositoryId,
          prNumber: refusal.prNumber,
          periodStart,
          code: errorCode,
          skipDraft: refusal.triggerKind === "webhook",
        });
      });
    },

    retryDue() {
      return inOrder(async () => {
        let due: StoredNotice[];
        try {
          due = await deps.dueNotices(deps.now(), {
            limit: RETRY_BATCH,
            maxAttempts: MAX_ATTEMPTS,
          });
        } catch (error) {
          deps.log.error(
            `[notices] REFUSAL_NOTICE_ERROR code=${errorCodeOf(error)}`,
          );
          return { tried: 0 };
        }
        for (const notice of due)
          await safely({
            workspaceId: notice.workspaceId,
            repositoryId: notice.repositoryId,
            prNumber: notice.prNumber,
            periodStart: notice.periodStart,
            code: notice.code,
            skipDraft: false,
          });
        return { tried: due.length };
      });
    },
  };
}
