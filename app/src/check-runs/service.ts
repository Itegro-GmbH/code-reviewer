// SPDX-License-Identifier: LicenseRef-Proprietary

// The check run and the review verdict of a review job (#405, README.md in this folder). The App, not the Worker,
// makes GitHub match the job: it holds the installation token and sees every way a job ends (a result, a release, a
// supersede, a lease that ran out, the sweep). `syncJob` reads the job and does whatever is still missing, so it is
// safe to call from any of those places and to repeat:
//
//  - the check run of the job (one per job and head commit, named "Code Reviewer") shows the status of the job:
//    waiting, reviewing, and a conclusion that is never red (check-text.ts). It is made once and changed in place
//    by its stored id; one that was made but whose id was not kept (the process died) is found again by the id of
//    the job (`external_id`) before another is made.
//  - after a successful review the verdict is submitted once (verdict.ts), by the stored review id and, after an
//    attempt that may have worked, by looking for the App's own review with the job's marker first. It is submitted
//    only while the pull request is open and still at the head that was reviewed.
//
// Best effort throughout. Nothing here throws or changes a job: a failure is one log line with a stable code and ids
// only (never a token, a body or a name). A call that failed because GitHub could not be reached is tried again twice
// at once (after one and after three seconds), then the job waits and is tried again by `reconcileDue` (called by the
// sweep, the timer of a long-lived server and the requests that touch the database), at most five times; but while a
// check run is open on GitHub (made, not yet completed) the job is tried again for about fifteen hours, a wait of up
// to an hour between two tries, so no check stays "Reviewing" because of an outage. A sync lives within the time of
// the function that runs it (`budgetMs`) and is counted as an attempt when it starts, so one that is cut off is not
// forgotten. An App that was not granted the Checks permission (an installation that has not accepted it, an App
// made by hand) simply has no check run: the row's check part is dropped with `CHECK_RUN_PERMISSION_MISSING`, once
// per job, and the verdict, which needs another permission, goes on. A check run that was made and can no longer be
// written (the permission was taken away) is tried again like an outage. What stays open for good, because GitHub
// cannot be asked any more: an installation that is gone, a repository that was archived or left the installation,
// and a connection a person disconnected (README.md, "Failure behaviour").
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type {
  JobCheckRunsRepository,
  StoredJobCheck,
} from "../db/repositories/job-check-runs-repository.ts";
import type { JobWithCheckWork } from "../db/repositories/job-check-runs-sweep.ts";
import type {
  RepositoriesRepository,
  StoredRepository,
} from "../db/repositories/repositories-repository.ts";
import { IntegrationError } from "../integrations/errors.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { ProductIdentity } from "../product-identity/identity.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import type { Job } from "../jobs/job-types.ts";
import type { ReviewVerdictMode } from "../review-settings/settings.ts";
import { describeCheck } from "./check-text.ts";
import { readResultFacts, type ResultFacts } from "./result-facts.ts";
import {
  VERDICT_MARKER_PREFIX,
  decideVerdict,
  verdictBody,
  verdictMarker,
  type VerdictDecision,
} from "./verdict.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** How long one sync holds the job: another instance does not sync it meanwhile. Under the 60 s of a function. */
export const SYNC_LEASE_MS = 90 * SECOND;
/** After a failed sync the job waits this long times the syncs so far, and never longer than `MAX_RETRY_WAIT_MS`. */
export const RETRY_WAIT_MS = 2 * MINUTE;
export const MAX_RETRY_WAIT_MS = 60 * MINUTE;
/** A job whose syncs failed or were cut off this many times in a row is given up. */
export const MAX_ATTEMPTS = 5;
/**
 * The same for a job whose check run is open on GitHub (made and not completed): it is given more tries, about
 * fifteen hours with the waits above, because giving it up leaves "Reviewing" on the pull request for good.
 */
export const MAX_OPEN_ATTEMPTS = 30;
/** A sync of a job that changed while it ran goes round again, at most this often. */
const MAX_ROUNDS = 3;
/** A call that could not reach GitHub is tried again after these waits, within the same request. */
const TRY_AGAIN_AFTER_MS = [1 * SECOND, 3 * SECOND];
/** How long an App that lacks the Checks permission is not asked again for the jobs that follow. */
export const PERMISSION_MEMORY_MS = 10 * MINUTE;
/**
 * How many jobs one `reconcileDue` works through, and for how long at most. A function lives 60 seconds, and a
 * request that runs this after its response may have spent a good part of that already, so the default is short;
 * a long-lived server and the internal routes with more time pass more. Every call has its own timeout besides.
 */
export const RECONCILE_BATCH = 20;
export const RECONCILE_BUDGET_MS = 20 * SECOND;
/** The time one `syncJob` has when nobody says otherwise. */
export const SYNC_BUDGET_MS = 20 * SECOND;
/** A sync is not started with less time than this left: it could not finish a call. */
const MIN_TIME_FOR_SYNC_MS = 3 * SECOND;
/** The longest a rate limit is waited for. */
const MAX_RETRY_AFTER_MS = 60 * MINUTE;

/** The stable codes of the log lines and of what the row keeps. */
export const CHECK_RUN_LOG_CODES = [
  "CHECK_RUN_PERMISSION_MISSING",
  "CHECK_RUN_FAILED",
  "CHECK_RUN_UNSUPPORTED",
  "CHECK_RUN_CONNECTION_UNAVAILABLE",
  "CHECK_RUN_ERROR",
  "CHECK_RUN_REPOSITORY_ARCHIVED",
  "CHECK_RUN_REPOSITORY_NOT_ACCESSIBLE",
  "REVIEW_VERDICT_SUBMITTED",
  "REVIEW_VERDICT_WITHDRAWN",
  "REVIEW_VERDICT_SKIPPED",
  "REVIEW_VERDICT_REFUSED",
  "REVIEW_COMMENT_UNREADABLE",
] as const;

export type CheckRunServiceDeps = {
  /** Who the check run and the verdict speak for: the name of the check run and the words of both (`ProductIdentity`). */
  product: ProductIdentity;
  /** A job by its id, whatever its workspace (the runner queue's `get`). */
  jobs: { get(id: string): Promise<Job | undefined> };
  repositories: (workspaceId: string) => Pick<RepositoriesRepository, "get">;
  integrations: (workspaceId: string) => Pick<IntegrationsRepository, "get">;
  checks: (workspaceId: string) => JobCheckRunsRepository;
  /** The jobs whose check run is behind, across workspaces (the reconciler). */
  dueJobs: (
    now: Date,
    options: { limit: number },
  ) => Promise<JobWithCheckWork[]>;
  /** What the project of the repository wants submitted after a review (read when it is decided). */
  verdictMode: (
    workspaceId: string,
    repositoryId: string,
  ) => Promise<ReviewVerdictMode>;
  registry: Pick<IntegrationRegistry, "resolve">;
  now: () => Date;
  /** Waits between two tries of one call; the default is a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Receives lines of ids and stable codes only. */
  log: { info(line: string): void; error(line: string): void };
};

export type ReconcileReport = { synced: number };

export type CheckRunService = {
  /**
   * Never rejects. Makes GitHub show what the job is now, and submits the verdict of a successful review, within
   * `budgetMs` (`SYNC_BUDGET_MS` when omitted).
   */
  syncJob(jobId: string, options?: { budgetMs?: number }): Promise<void>;
  /**
   * Never rejects. Syncs the jobs whose check run is behind or whose retry is due: at most a batch, within
   * `budgetMs` (`RECONCILE_BUDGET_MS` when omitted). Asked for while another is waiting to start, it is that one.
   */
  reconcileDue(options?: { budgetMs?: number }): Promise<ReconcileReport>;
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

const FINAL_STATUSES: readonly string[] = [
  "succeeded",
  "failed",
  "superseded",
  "cancelled",
];

type Target = {
  job: Job;
  integration: Integration;
  provider: IntegrationProvider;
  repo: RepoRef;
};

/** What the sync of a job has been decided about before any call: the setting, and what it makes of the result. */
type VerdictPlan = {
  mode: ReviewVerdictMode;
  facts: ResultFacts;
  decision: VerdictDecision;
};

/** The time of a sync is over: it stops without a failure, and the job is taken again by the next reconcile. */
class DeadlineReached extends Error {}

/** The time a sync has: it ends at `deadline`, and a call in flight is cut off then. */
type Budget = { deadline: number; signal: AbortSignal };

/**
 * Is the check run of the row open on GitHub, or may it be? Made (or maybe made, the process died before its id was
 * kept) and not yet completed: giving the row up would leave it as it is.
 */
function checkIsOpen(row: StoredJobCheck): boolean {
  return (
    row.checkState === "active" &&
    (row.checkRunId !== null || row.checkCreateAttempts > 0) &&
    !FINAL_STATUSES.includes(row.syncedStatus ?? "")
  );
}

/** A method a provider may or may not have, bound to it; the caller has checked that it has it. */
function bound<
  K extends
    | "publishReviewCheck"
    | "submitReviewVerdict"
    | "withdrawReviewVerdict"
    | "readReviewComment",
>(provider: IntegrationProvider, name: K): NonNullable<IntegrationProvider[K]> {
  const method = provider[name];
  if (method === undefined)
    throw new IntegrationError(
      "INTEGRATION_ACCESS_FAILED",
      `The provider cannot do ${name}.`,
    );
  return method.bind(provider) as NonNullable<IntegrationProvider[K]>;
}

/** The most characters of a review comment that is kept: GitHub's own limit for a comment. */
export const MAX_REVIEW_COMMENT_CHARS = 65_536;

/** The link to the review comment, only when it is a comment of this very pull request. */
function trustedCommentUrl(
  url: string | null,
  repo: RepoRef,
  prNumber: number,
): string | null {
  if (url === null) return null;
  const prefix = `${repo.url.replace(/\/+$/, "")}/pull/${String(prNumber)}#issuecomment-`;
  return url.startsWith(prefix) && /^\d{1,20}$/.test(url.slice(prefix.length))
    ? url
    : null;
}

/**
 * The id of the review comment a run links to (#657), only when the link is a comment of this very pull request of this
 * very repository. The host is github.com, as the runner reports it, or the host the repository itself is stored with (a
 * test double or an enterprise server whose pull request pages sit elsewhere than the comment links the runner got).
 */
function postedCommentId(
  url: string | null,
  repo: RepoRef,
  prNumber: number,
): string | null {
  if (url === null) return null;
  let host = "github.com";
  try {
    host = new URL(repo.url).host;
  } catch {
    // The repository has no usable address: only github.com links count.
  }
  const hosts = new Set(["github.com", host]);
  const match =
    /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)#issuecomment-(\d{1,20})$/.exec(
      url,
    );
  if (match === null) return null;
  const [, linkHost, fullName, number, id] = match;
  return linkHost !== undefined &&
    hosts.has(linkHost) &&
    fullName === repo.fullName &&
    number === String(prNumber)
    ? (id ?? null)
    : null;
}

export const withdrawMessage = (product: ProductIdentity): string =>
  `The review verdict of ${product.name} is switched off for this project, so its earlier request for changes no longer applies.`;

export function createCheckRunService(
  deps: CheckRunServiceDeps,
): CheckRunService {
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // One reconcile at a time inside a process: a backlog never opens many requests at GitHub at once.
  let tail: Promise<unknown> = Promise.resolve();
  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }
  // A reconcile that is asked for while another waits to start is that one: it looks at everything that is due.
  let waiting: Promise<ReconcileReport> | null = null;
  // The installations that were found to lack the Checks permission, and until when that is believed.
  const permissionMissingUntil = new Map<string, number>();
  // The same for the permission to review pull requests.
  const reviewPermissionMissingUntil = new Map<string, number>();

  const where = (job: Job) =>
    `job=${job.id} workspace=${job.workspaceId} repository=${job.repositoryId}`;
  const timeLeft = (budget: Budget) => budget.deadline - deps.now().getTime();

  function rememberPermissionMissing(integration: Integration): void {
    permissionMissingUntil.set(
      integration.id,
      deps.now().getTime() + PERMISSION_MEMORY_MS,
    );
  }
  function verdictPermissionKnownMissing(integration: Integration): boolean {
    return (
      (reviewPermissionMissingUntil.get(integration.id) ?? 0) >
      deps.now().getTime()
    );
  }
  function permissionKnownMissing(integration: Integration): boolean {
    return (
      (permissionMissingUntil.get(integration.id) ?? 0) > deps.now().getTime()
    );
  }

  /**
   * One call to GitHub within the time of the sync. A call that could not reach GitHub is tried again after a short
   * wait, twice at most and only if the time allows; `again` tells the call it is a repeat, which may have worked
   * the first time without the answer arriving.
   */
  async function viaRetries<T>(
    budget: Budget,
    call: (again: boolean) => Promise<T>,
  ): Promise<T> {
    for (let tried = 0; ; tried += 1) {
      if (timeLeft(budget) <= 0) throw new DeadlineReached();
      try {
        return await call(tried > 0);
      } catch (error) {
        const wait = TRY_AGAIN_AFTER_MS[tried];
        if (
          wait === undefined ||
          !(
            error instanceof IntegrationError &&
            error.code === "INTEGRATION_ACCESS_UNAVAILABLE"
          ) ||
          timeLeft(budget) <= wait
        )
          throw error;
        await sleep(wait);
      }
    }
  }

  /** What the job's connection can do, or why nothing can be done for it now. */
  async function targetOf(
    job: Job,
    held: StoredJobCheck,
    checks: JobCheckRunsRepository,
  ): Promise<
    { kind: "ready"; target: Target } | { kind: "gone" } | { kind: "wait" }
  > {
    const repository = await deps
      .repositories(job.workspaceId)
      .get(job.repositoryId);
    const integration =
      repository === undefined
        ? undefined
        : await deps
            .integrations(job.workspaceId)
            .get(repository.integrationId);
    if (repository === undefined || integration === undefined) {
      deps.log.error(
        `[check-runs] CHECK_RUN_CONNECTION_UNAVAILABLE ${where(job)}`,
      );
      await checks.drop(job.id, "CHECK_RUN_CONNECTION_UNAVAILABLE");
      return { kind: "gone" };
    }
    if (integration.status !== "active") {
      // A connection that is switched off may come back; a check run that is open, or a verdict that is due, waits.
      if (
        checkIsOpen(held) ||
        (job.status === "succeeded" && held.reviewState === "pending")
      ) {
        if (held.attempts <= 1)
          deps.log.error(
            `[check-runs] CHECK_RUN_CONNECTION_UNAVAILABLE ${where(job)} waiting`,
          );
        return { kind: "wait" };
      }
      deps.log.error(
        `[check-runs] CHECK_RUN_CONNECTION_UNAVAILABLE ${where(job)}`,
      );
      await checks.drop(job.id, "CHECK_RUN_CONNECTION_UNAVAILABLE");
      return { kind: "gone" };
    }
    const provider = deps.registry.resolve(integration.type);
    if (provider.publishReviewCheck === undefined) {
      deps.log.error(`[check-runs] CHECK_RUN_UNSUPPORTED ${where(job)}`);
      await checks.drop(job.id, "CHECK_RUN_UNSUPPORTED");
      return { kind: "gone" };
    }
    return {
      kind: "ready",
      target: { job, integration, provider, repo: repoRefOf(repository) },
    };
  }

  /** What the app makes of the result of a successful job: the setting and the decision, before any call. */
  async function planVerdict(job: Job): Promise<VerdictPlan | null> {
    if (job.status !== "succeeded") return null;
    const mode = await deps.verdictMode(job.workspaceId, job.repositoryId);
    const facts = readResultFacts(job.result);
    return {
      mode,
      facts,
      decision: decideVerdict({
        mode,
        findings: facts.findings,
        stoppedEarly: facts.stoppedEarly,
        modelCalls: facts.modelCalls,
      }),
    };
  }

  /**
   * After a run that posted a review comment (#657): reads the comment once and keeps its body, so the run page can show
   * what was posted. Best effort and never a reason to retry the sync: a failure is one log line with a stable code, and
   * the run page then offers the link to the comment alone. A comment that is gone, or not the app's own, is kept as "".
   */
  async function captureReviewComment(
    target: Target,
    checks: JobCheckRunsRepository,
    budget: Budget,
  ): Promise<void> {
    const { job, integration, provider, repo } = target;
    if (provider.readReviewComment === undefined) return;
    if (!FINAL_STATUSES.includes(job.status)) return;
    const commentId = postedCommentId(
      readResultFacts(job.result).commentUrl,
      repo,
      job.prNumber,
    );
    if (commentId === null) return;
    if ((await checks.reviewCommentOf(job.id)) !== null) return;
    // A read is not started with no time left for it: the sync would be cut off, and the check run is more important.
    if (timeLeft(budget) < MIN_TIME_FOR_SYNC_MS) return;
    try {
      const read = await viaRetries(budget, () =>
        bound(provider, "readReviewComment")(
          integration,
          repo,
          commentId,
          budget.signal,
        ),
      );
      // The id in the result comes from the runner: the comment must sit below this very pull request of this repository.
      const ofThisRun =
        read !== null &&
        read.below !== null &&
        read.below.repoFullName.toLowerCase() === repo.fullName.toLowerCase() &&
        read.below.number === job.prNumber;
      await checks.recordReviewComment(
        job.id,
        read === null || !ofThisRun
          ? ""
          : read.body
              .replaceAll("\u0000", "")
              .slice(0, MAX_REVIEW_COMMENT_CHARS),
      );
    } catch (error) {
      if (error instanceof DeadlineReached) throw error;
      deps.log.error(
        `[check-runs] REVIEW_COMMENT_UNREADABLE ${where(job)} code=${errorCodeOf(error)}`,
      );
    }
  }

  type CheckStep = "ok" | "dropped" | { retry: IntegrationError };

  /** The check run of the job shows the status the job has. */
  async function syncCheck(
    target: Target,
    held: StoredJobCheck,
    checks: JobCheckRunsRepository,
    plan: VerdictPlan | null,
    budget: Budget,
  ): Promise<CheckStep> {
    const { job, integration, provider, repo } = target;
    if (held.checkState === "dropped" || held.syncedStatus === job.status)
      return "ok";
    const mayHaveCheck =
      held.checkRunId !== null || held.checkCreateAttempts > 0;
    // A job that was cancelled or replaced shows nothing it did not show before: a check run that exists (or may,
    // the process died before its id was kept) is completed, none is made.
    const ended = job.status === "cancelled" || job.status === "superseded";
    if (!mayHaveCheck && ended) return "ok";
    if (!mayHaveCheck && permissionKnownMissing(integration)) {
      await checks.dropCheck(job.id, "CHECK_RUN_PERMISSION_MISSING");
      return "ok";
    }
    const facts = plan?.facts ?? readResultFacts(job.result);
    const text = describeCheck(deps.product, {
      status: job.status,
      errorCode: job.errorCode,
      commentUrl: trustedCommentUrl(facts.commentUrl, repo, job.prNumber),
      findings: facts.findings,
      stoppedEarly: facts.stoppedEarly,
      ...(plan === null ? {} : { verdict: plan.decision }),
    });
    if (held.checkRunId === null && !ended)
      await checks.noteStarted(job.id, "check");
    try {
      const published = await viaRetries(budget, (again) =>
        bound(provider, "publishReviewCheck")(
          integration,
          repo,
          {
            jobId: job.id,
            headSha: job.headSha,
            name: deps.product.checkName,
            ...text,
          },
          {
            checkRunId: held.checkRunId,
            // An earlier attempt to make it may have worked without its id being kept.
            mayExist:
              held.checkRunId === null &&
              (held.checkCreateAttempts > 0 || again),
            createIfMissing: !ended,
          },
          budget.signal,
        ),
      );
      permissionMissingUntil.delete(integration.id);
      if (published.checkRunId === null) {
        // Looked for, none there: whatever the earlier attempt did, it made nothing.
        await checks.forgetCheckAttempts(job.id);
        return "ok";
      }
      await checks.recordCheck(job.id, {
        checkRunId: published.checkRunId,
        syncedStatus: job.status,
      });
      return "ok";
    } catch (error) {
      if (!(error instanceof IntegrationError)) throw error;
      if (
        error.code === "INTEGRATION_REPOSITORY_ARCHIVED" ||
        error.code === "INTEGRATION_REPOSITORY_NOT_ACCESSIBLE"
      ) {
        // Nothing can be written to it: neither the check run nor the review.
        const code =
          error.code === "INTEGRATION_REPOSITORY_ARCHIVED"
            ? "CHECK_RUN_REPOSITORY_ARCHIVED"
            : "CHECK_RUN_REPOSITORY_NOT_ACCESSIBLE";
        deps.log.error(`[check-runs] ${code} ${where(job)}`);
        await checks.drop(job.id, code);
        return "dropped";
      }
      if (error.code !== "INTEGRATION_ACCESS_SCOPE_REFUSED") throw error;
      // The App may not write check runs (the installation has not accepted the permission, an App made by hand
      // lacks it): once per job, and the job goes on without one. The verdict needs another permission.
      rememberPermissionMissing(integration);
      if (held.checkRunId === null) {
        deps.log.error(
          `[check-runs] CHECK_RUN_PERMISSION_MISSING ${where(job)}`,
        );
        await checks.dropCheck(job.id, "CHECK_RUN_PERMISSION_MISSING");
        return "ok";
      }
      // A check run was made and cannot be changed now (the permission was taken away): it stays open, and is
      // tried again like an outage; the verdict goes on meanwhile.
      if (held.attempts <= 1)
        deps.log.error(
          `[check-runs] CHECK_RUN_PERMISSION_MISSING ${where(job)}`,
        );
      return { retry: error };
    }
  }

  async function skipVerdict(
    job: Job,
    checks: JobCheckRunsRepository,
    reason: string,
  ): Promise<void> {
    deps.log.info(
      `[check-runs] REVIEW_VERDICT_SKIPPED ${where(job)} reason=${reason}`,
    );
    await checks.recordReview(job.id, { reviewId: null, reviewState: "done" });
  }

  /** Is the pull request open, and at which head? A reason when the verdict has nowhere to go. */
  async function pullRequestFor(
    target: Target,
    budget: Budget,
  ): Promise<
    { open: true; headSha: string } | { open: false; reason: string }
  > {
    const { integration, provider, repo, job } = target;
    try {
      const pullRequest = await viaRetries(budget, () =>
        provider.getPullRequest(integration, repo, job.prNumber, budget.signal),
      );
      return pullRequest.state === "open"
        ? { open: true, headSha: pullRequest.headSha }
        : { open: false, reason: "pull_request_closed" };
    } catch (error) {
      if (
        error instanceof IntegrationError &&
        error.code === "INTEGRATION_PULL_REQUEST_NOT_FOUND"
      )
        return { open: false, reason: "pull_request_gone" };
      throw error;
    }
  }

  /** GitHub refuses this for good (the App may not review, the pull request is its own, the repository is read-only). */
  async function verdictRefused(
    target: Target,
    checks: JobCheckRunsRepository,
    error: unknown,
  ): Promise<void> {
    if (
      !(error instanceof IntegrationError) ||
      (error.code !== "INTEGRATION_ACCESS_SCOPE_REFUSED" &&
        error.code !== "INTEGRATION_REQUEST_REFUSED" &&
        error.code !== "INTEGRATION_REPOSITORY_ARCHIVED" &&
        error.code !== "INTEGRATION_REPOSITORY_NOT_ACCESSIBLE")
    )
      throw error;
    if (error.code === "INTEGRATION_ACCESS_SCOPE_REFUSED")
      reviewPermissionMissingUntil.set(
        target.integration.id,
        deps.now().getTime() + PERMISSION_MEMORY_MS,
      );
    deps.log.error(
      `[check-runs] REVIEW_VERDICT_REFUSED ${where(target.job)} code=${error.code}`,
    );
    await checks.recordReview(target.job.id, {
      reviewId: null,
      reviewState: "dropped",
    });
  }

  /** The project switched the verdict off: the App's own earlier request for changes no longer applies. */
  async function withdrawVerdict(
    target: Target,
    checks: JobCheckRunsRepository,
    budget: Budget,
  ): Promise<void> {
    const { job, integration, provider, repo } = target;
    if (provider.withdrawReviewVerdict === undefined)
      return skipVerdict(job, checks, "off");
    // Only where the app asked for changes and has not taken it back since: nothing is asked of GitHub otherwise.
    if (
      (await checks.lastReviewEventOfPullRequest(job.id)) !== "request_changes"
    )
      return skipVerdict(job, checks, "off");
    if (verdictPermissionKnownMissing(integration))
      return skipVerdict(job, checks, "permission_missing");
    const pullRequest = await pullRequestFor(target, budget);
    if (!pullRequest.open) return skipVerdict(job, checks, pullRequest.reason);
    try {
      const withdrawn = await viaRetries(budget, () =>
        bound(provider, "withdrawReviewVerdict")(
          integration,
          repo,
          job.prNumber,
          {
            message: withdrawMessage(deps.product),
            markerPrefix: VERDICT_MARKER_PREFIX,
          },
          budget.signal,
        ),
      );
      await checks.recordReview(job.id, {
        reviewId: withdrawn.reviewId,
        reviewState: "done",
        reviewEvent: "withdrawn",
      });
      deps.log.info(
        `[check-runs] REVIEW_VERDICT_WITHDRAWN ${where(job)} outcome=${withdrawn.outcome}`,
      );
    } catch (error) {
      await verdictRefused(target, checks, error);
    }
  }

  /** After a successful review: carry out the decision. A skipped verdict leaves an earlier request as it is. */
  async function syncVerdict(
    target: Target,
    held: StoredJobCheck,
    checks: JobCheckRunsRepository,
    plan: VerdictPlan | null,
    budget: Budget,
  ): Promise<void> {
    const { job, integration, provider, repo } = target;
    if (plan === null || held.reviewState !== "pending") return;
    const { decision, mode, facts } = plan;
    if (decision.kind === "skip")
      return decision.reason === "off"
        ? withdrawVerdict(target, checks, budget)
        : skipVerdict(job, checks, decision.reason);
    if (provider.submitReviewVerdict === undefined)
      return skipVerdict(job, checks, "unsupported");

    if (verdictPermissionKnownMissing(integration)) {
      deps.log.info(
        `[check-runs] REVIEW_VERDICT_REFUSED ${where(job)} code=INTEGRATION_ACCESS_SCOPE_REFUSED known`,
      );
      return checks.recordReview(job.id, {
        reviewId: null,
        reviewState: "dropped",
      });
    }
    // Only a pull request that is open and still at the head that was reviewed gets a verdict: the review of a
    // newer head decides for itself, and a verdict on an old head would be read as one on the new.
    const pullRequest = await pullRequestFor(target, budget);
    if (!pullRequest.open) return skipVerdict(job, checks, pullRequest.reason);
    if (pullRequest.headSha !== job.headSha)
      return skipVerdict(job, checks, "stale_head");

    await checks.noteStarted(job.id, "review");
    try {
      const submitted = await viaRetries(budget, (again) =>
        bound(provider, "submitReviewVerdict")(
          integration,
          repo,
          job.prNumber,
          {
            jobId: job.id,
            headSha: job.headSha,
            event: decision.event,
            body: verdictBody(deps.product, {
              jobId: job.id,
              event: decision.event,
              mode,
              blocking: decision.blocking,
              commentUrl: trustedCommentUrl(
                facts.commentUrl,
                repo,
                job.prNumber,
              ),
            }),
            marker: verdictMarker(job.id),
          },
          // An earlier attempt may have submitted it without its id being kept: the App's own review is looked for.
          { lookForEarlier: held.reviewSubmitAttempts > 0 || again },
          budget.signal,
        ),
      );
      await checks.recordReview(job.id, {
        reviewId: submitted.reviewId,
        reviewState: "done",
        reviewEvent:
          decision.event === "approve" ? "approve" : "request_changes",
      });
      deps.log.info(
        `[check-runs] REVIEW_VERDICT_SUBMITTED ${where(job)} event=${decision.event} outcome=${submitted.outcome}`,
      );
    } catch (error) {
      await verdictRefused(target, checks, error);
    }
  }

  /**
   * A failed sync waits and is tried again, a bounded number of times (more while a check run is open); a connection
   * that is gone is given up.
   */
  async function failedSync(
    job: Job,
    held: StoredJobCheck,
    checks: JobCheckRunsRepository,
    error: unknown,
  ): Promise<void> {
    const code = errorCodeOf(error);
    if (code === "INTEGRATION_ACCESS_CONNECTION_GONE") {
      deps.log.error(
        `[check-runs] CHECK_RUN_FAILED ${where(job)} code=${code} gone`,
      );
      await checks.drop(job.id, code);
      return;
    }
    const row = (await checks.find(job.id)) ?? held;
    const attempt = held.attempts;
    deps.log.error(
      `[check-runs] CHECK_RUN_FAILED ${where(job)} code=${code} attempt=${String(attempt)}`,
    );
    const wait =
      error instanceof IntegrationError && error.retryAfterSeconds !== null
        ? Math.min(error.retryAfterSeconds * SECOND, MAX_RETRY_AFTER_MS)
        : 0;
    await checks.failed(job.id, {
      code,
      retryAt: new Date(
        deps.now().getTime() +
          Math.max(wait, Math.min(RETRY_WAIT_MS * attempt, MAX_RETRY_WAIT_MS)),
      ),
      maxAttempts: checkIsOpen(row) ? MAX_OPEN_ATTEMPTS : MAX_ATTEMPTS,
    });
  }

  /** One round: true when the job changed while it ran, so another round is due. */
  async function syncRound(jobId: string, budget: Budget): Promise<boolean> {
    const job = await deps.jobs.get(jobId);
    if (job === undefined) return false;
    // #752: a turn of the Implementer has no pull request, no head commit of one and no check run: nothing to make match.
    if (job.reviewKind === "implementer") return false;
    const checks = deps.checks(job.workspaceId);

    // Nothing to do (in step, settled, dropped): no write, no call.
    const known = await checks.find(job.id);
    if (known !== undefined && !needsWork(known, job)) return false;

    const taken = await checks.take(job.id, {
      leaseMs: SYNC_LEASE_MS,
      maxAttempts:
        known !== undefined && checkIsOpen(known)
          ? MAX_OPEN_ATTEMPTS
          : MAX_ATTEMPTS,
    });
    if (!taken.acquired) return false;
    const held = taken.check;
    try {
      const reached = await targetOf(job, held, checks);
      if (reached.kind === "gone") return false;
      if (reached.kind === "wait") {
        await failedSync(
          job,
          held,
          checks,
          new IntegrationError(
            "INTEGRATION_ACCESS_CONNECTION_SUSPENDED",
            "The connection is switched off.",
          ),
        );
        return false;
      }
      const { target } = reached;
      const plan = await planVerdict(job);
      const step = await syncCheck(target, held, checks, plan, budget);
      await captureReviewComment(target, checks, budget);
      if (step === "dropped") return false;
      const afterCheck = (await checks.find(job.id)) ?? held;
      await syncVerdict(target, afterCheck, checks, plan, budget);
      if (step !== "ok") {
        await failedSync(job, held, checks, step.retry);
        return false;
      }
      const done = (await checks.find(job.id)) ?? afterCheck;
      const final = FINAL_STATUSES.includes(job.status);
      const ended = job.status === "cancelled" || job.status === "superseded";
      const checkDone =
        done.checkState === "dropped" ||
        done.syncedStatus === job.status ||
        (done.checkRunId === null && done.checkCreateAttempts === 0 && ended);
      const verdictDone =
        job.status !== "succeeded" || done.reviewState !== "pending";
      await checks.finish(job.id, {
        settled: final && checkDone && verdictDone,
      });
    } catch (error) {
      if (error instanceof DeadlineReached) {
        // Out of time, not a failure: the next reconcile goes on from what is recorded.
        await checks.finish(job.id, { settled: false });
        return false;
      }
      await failedSync(job, held, checks, error);
      return false;
    }
    const latest = await deps.jobs.get(job.id);
    return latest !== undefined && latest.status !== job.status;
  }

  async function syncUntil(jobId: string, deadline: number): Promise<void> {
    const budget: Budget = {
      deadline,
      signal: AbortSignal.timeout(Math.max(1, deadline - deps.now().getTime())),
    };
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1)
        if (!(await syncRound(jobId, budget))) return;
    } catch (error) {
      deps.log.error(
        `[check-runs] CHECK_RUN_ERROR job=${jobId} code=${errorCodeOf(error)}`,
      );
    }
  }

  return {
    syncJob(jobId, options) {
      return syncUntil(
        jobId,
        deps.now().getTime() + (options?.budgetMs ?? SYNC_BUDGET_MS),
      );
    },

    reconcileDue(options) {
      if (waiting !== null) return waiting;
      const run = inOrder(async () => {
        waiting = null;
        const deadline =
          deps.now().getTime() + (options?.budgetMs ?? RECONCILE_BUDGET_MS);
        let due: JobWithCheckWork[];
        try {
          due = await deps.dueJobs(deps.now(), { limit: RECONCILE_BATCH });
        } catch (error) {
          deps.log.error(
            `[check-runs] CHECK_RUN_ERROR code=${errorCodeOf(error)}`,
          );
          return { synced: 0 };
        }
        let synced = 0;
        for (const item of due) {
          // The function that runs this lives a minute: what is left waits for the next run.
          if (deadline - deps.now().getTime() < MIN_TIME_FOR_SYNC_MS) break;
          await syncUntil(item.jobId, deadline);
          synced += 1;
        }
        return { synced };
      });
      waiting = run;
      return run;
    },
  };
}

/** Is there anything left to do for the job given the row? */
function needsWork(row: StoredJobCheck, job: Job): boolean {
  if (row.state !== "active") return false;
  const checkBehind =
    row.checkState === "active" && row.syncedStatus !== job.status;
  const verdictDue =
    job.status === "succeeded" && row.reviewState === "pending";
  // A job that ended with nothing left to send still has its row settled, in one pass that makes no call.
  return checkBehind || verdictDue || FINAL_STATUSES.includes(job.status);
}
