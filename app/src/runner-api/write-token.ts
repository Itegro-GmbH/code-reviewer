// SPDX-License-Identifier: LicenseRef-Proprietary

// The write token of a turn of the Implementer ends with the turn (#753, reviews of #776 and #790). `implementerAccess` hands out a
// token that lives up to an hour and may push to one repository; nothing may keep it alive after its job. Every token the claim
// hands out is remembered sealed (`claimed-keys.ts`, with the time it expires) before it leaves, and is forgotten only after the
// platform said it is off, or once it has expired on its own:
//
//  - `revokeUndelivered`: the token never reached the Worker (the fetch failed after it was made). Exactly that token, with the
//    value in hand, whether or not it could be remembered.
//  - `revokeAllOf`: the turn is over, however it ended (a stored result, a job given back, the reaper, a stop, the hard timeout:
//    the queue's `onClaimsEnded`). Every token the ledger holds for the job.
//  - `retryPending`: what could not be switched off is tried again, from the ledger, until the token expires; the maintenance
//    that already runs between requests and in the sweep calls it.
//
// Nothing here ever throws, and the log names the job and counts, never a token.
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type {
  JobClaimedKeysRepository,
  TokenJob,
} from "../db/repositories/job-claimed-keys-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { Job } from "../jobs/job-types.ts";
import type { ClaimedKeys, GitTokenEntry } from "./claimed-keys.ts";
import { describeError, type RunnerApiLogger } from "./logger.ts";

/** What a job must say about itself for its write tokens to be looked after. */
export type WriteTokenJob = Pick<
  Job,
  "id" | "reviewKind" | "workspaceId" | "repositoryId"
>;

/** Switches off every write token the ledger holds for the job (the turn is over). Never rejects; does nothing for another kind. */
export type WriteTokenRevoker = (job: WriteTokenJob) => Promise<void>;

/** Switches off one write token that was made but never handed over. Never rejects; does nothing for another kind. */
export type UndeliveredTokenRevoker = (
  job: WriteTokenJob,
  token: GitTokenEntry,
) => Promise<void>;

/** How long a token lives when the platform did not say (GitHub: one hour). */
export const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
/** The most jobs one retry looks at. */
const RETRY_BATCH = 50;
/** How far back an ended turn is looked at for tokens still to switch off: a token lives an hour, a turn at most 70 minutes more. */
const RETRY_WINDOW_MS = 2 * 60 * 60 * 1000;

export type WriteTokens = {
  revokeAllOf: WriteTokenRevoker;
  revokeUndelivered: UndeliveredTokenRevoker;
  /** The turns whose claims ended (`onClaimsEnded`): all their tokens. Other kinds are left alone. */
  revokeEnded(jobIds: readonly string[]): Promise<void>;
  /** Tries again for the turns that ended lately and still hold a token. */
  retryPending(): Promise<void>;
};

export function createWriteTokens(deps: {
  repositories: (workspaceId: string) => Pick<RepositoriesRepository, "get">;
  integrations: (workspaceId: string) => Pick<IntegrationsRepository, "get">;
  registry: IntegrationRegistry;
  claimedKeys: Pick<
    ClaimedKeys,
    "rememberGitToken" | "gitTokensOf" | "forgetGitTokens"
  >;
  rows: Pick<
    JobClaimedKeysRepository,
    "implementerJobs" | "endedImplementerJobsWithRows"
  >;
  logger: RunnerApiLogger;
  now: () => Date;
}): WriteTokens {
  /**
   * Switches off `tokens` (those whose time has not come yet), forgets the ones that are off or expired from the ledger, and
   * keeps the others. Tokens not in the ledger are put there first, so that a failure here is tried again later.
   */
  async function settle(
    job: WriteTokenJob,
    tokens: readonly GitTokenEntry[],
  ): Promise<void> {
    const at = deps.now().getTime();
    const done: string[] = [];
    const live: GitTokenEntry[] = [];
    for (const entry of tokens) {
      if (new Date(entry.expiresAt).getTime() <= at) done.push(entry.token);
      else live.push(entry);
    }
    let off = 0;
    if (live.length > 0) {
      const integration = await integrationOf(job);
      if (integration === undefined) {
        deps.logger.error(
          `[runner-api] job=${job.id} ${String(live.length)} write token(s) not switched off: the connection is gone`,
        );
      } else {
        const provider = deps.registry.resolve(integration.type);
        const outcomes = await Promise.all(
          live.map((entry) =>
            provider
              .revokeImplementerAccess(integration, entry.token)
              .catch(() => false),
          ),
        );
        live.forEach((entry, index) => {
          if (outcomes[index] === true) {
            done.push(entry.token);
            off += 1;
          }
        });
      }
    }
    if (done.length > 0)
      await deps.claimedKeys.forgetGitTokens(job.id, done).catch((error) => {
        deps.logger.error(
          `[runner-api] job=${job.id} write tokens could not be forgotten: ${describeError(error)}`,
        );
      });
    const kept = live.length - off;
    if (off > 0)
      deps.logger.info(
        `[runner-api] job=${job.id} ${String(off)} write token(s) switched off`,
      );
    if (kept > 0)
      deps.logger.error(
        `[runner-api] job=${job.id} ${String(kept)} write token(s) not switched off yet; tried again until they expire`,
      );
  }

  async function integrationOf(job: WriteTokenJob) {
    const repository = await deps
      .repositories(job.workspaceId)
      .get(job.repositoryId);
    return repository === undefined
      ? undefined
      : deps.integrations(job.workspaceId).get(repository.integrationId);
  }

  async function guarded(job: WriteTokenJob, work: () => Promise<void>) {
    if (job.reviewKind !== "implementer") return;
    try {
      await work();
    } catch (error) {
      // No error text beyond its description: the failing layer may hold anything.
      deps.logger.error(
        `[runner-api] job=${job.id} write tokens could not be switched off: ${describeError(error)}`,
      );
    }
  }

  const revokeAllOf: WriteTokenRevoker = (job) =>
    guarded(job, async () =>
      settle(job, await deps.claimedKeys.gitTokensOf(job.id)),
    );

  return {
    revokeAllOf,
    revokeUndelivered: (job, entry) =>
      guarded(job, async () => {
        // The token in hand is switched off whatever the ledger says; it is put in the ledger first, so that a failure leaves a
        // record to retry from. A ledger that cannot be written does not keep the token alive.
        await deps.claimedKeys
          .rememberGitToken(job.id, entry.token, entry.expiresAt)
          .catch(() => undefined);
        await settle(job, [entry]);
      }),
    async revokeEnded(jobIds) {
      let jobs: TokenJob[];
      try {
        jobs = await deps.rows.implementerJobs(jobIds);
      } catch (error) {
        deps.logger.error(
          `[runner-api] write tokens of ended turns could not be looked up: ${describeError(error)}`,
        );
        return;
      }
      for (const job of jobs) await revokeAllOf(job);
    },
    async retryPending() {
      let jobs: TokenJob[];
      try {
        jobs = await deps.rows.endedImplementerJobsWithRows(
          new Date(deps.now().getTime() - RETRY_WINDOW_MS),
          RETRY_BATCH,
        );
      } catch (error) {
        deps.logger.error(
          `[runner-api] write tokens still to switch off could not be looked up: ${describeError(error)}`,
        );
        return;
      }
      for (const job of jobs) await revokeAllOf(job);
    },
  };
}

/**
 * What the queue's hook for ended claims does about write tokens (#790): after the response, switches off the tokens of the
 * turns of the Implementer among the jobs whose claim ended, however it ended (a result, the reaper, a stop, the hard timeout).
 * Nothing happens in a deployment without the capability, and nothing here throws or delays the response.
 */
export function endedClaimsReaction(deps: {
  /** Whether this deployment has the Implementer. */
  allowed: () => boolean;
  /** Runs the work after the response (`runAfterResponse` on the server). */
  schedule: (work: () => Promise<void>) => void;
  tokens: () => Pick<WriteTokens, "revokeEnded">;
  logger: RunnerApiLogger;
}): (jobIds: readonly string[]) => void {
  return (jobIds) => {
    if (jobIds.length === 0) return;
    try {
      if (!deps.allowed()) return;
      deps.schedule(() => deps.tokens().revokeEnded(jobIds));
    } catch {
      deps.logger.error("[runner-api] WRITE_TOKEN_REVOKE_FAILED");
    }
  };
}
