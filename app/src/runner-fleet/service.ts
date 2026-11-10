// SPDX-License-Identifier: LicenseRef-Proprietary

// The service behind the runners page and its routes (#854): the runners of ONE workspace with their state, a registration token for
// a new one, and the revoking of a runner. Who may do this is the route's (`withWorkspace` with a right of the matrix); every rule
// about the data is here.
import type { RunnersRepository } from "../db/repositories/runners-repository.ts";
import type {
  RunnerLimits,
  RunnerManifest,
} from "../runner-identity/announcement.ts";
import { RunnerFleetError } from "./errors.ts";
import {
  hashSecret,
  customerRunnerId,
  newRegistrationToken,
  REGISTRATION_TOKEN_TTL_SECONDS,
} from "../runner-identity/tokens.ts";
import { statusOf, type RunnerStatus } from "../runner-identity/online.ts";

export { statusOf, type RunnerStatus };

/** How many registration tokens a workspace may hold that are neither used nor expired. */
export const OPEN_TOKENS_PER_WORKSPACE_MAX = 20;

export type RunnerView = {
  id: string;
  name: string;
  labels: string[];
  baseVersion: string;
  manifest: RunnerManifest;
  limits: RunnerLimits;
  createdAt: string;
  lastSeenAt: string;
  status: RunnerStatus;
};

export type RunnerList = {
  runners: RunnerView[];
  /** The oldest base a runner may have, or null. */
  minBaseVersion: string | null;
  onlineWithinSeconds: number;
};

export type NewTokenView = {
  /** Shown once: it is not kept. */
  token: string;
  expiresAt: string;
};

export type RunnerFleetService = {
  list(): Promise<RunnerList>;
  createToken(user: { id: string }): Promise<NewTokenView>;
  revoke(id: string): Promise<void>;
};

const ID_MAX_LENGTH = 128;

export function createRunnerFleetService(deps: {
  runners: RunnersRepository;
  settings: () => {
    minBaseVersion: string | null;
    onlineWithinSeconds: number;
  };
  /**
   * Ends the running claims of a revoked runner, by the id the runner has in `jobs.runner_id`. Called after the revoke has taken effect,
   * so the runner can report nothing more; absent, the claims end when their leases run out (two minutes).
   */
  endClaimsOf?: (customerRunnerId: string) => Promise<void>;
  now?: () => Date;
}): RunnerFleetService {
  const now = deps.now ?? (() => new Date());
  return {
    async list() {
      const settings = deps.settings();
      const at = now();
      return {
        runners: (await deps.runners.list()).map((runner) => ({
          id: runner.id,
          name: runner.name,
          labels: runner.labels,
          baseVersion: runner.baseVersion,
          manifest: runner.manifest,
          limits: runner.limits,
          createdAt: runner.createdAt,
          lastSeenAt: runner.lastSeenAt,
          status: statusOf(runner, at, settings),
        })),
        minBaseVersion: settings.minBaseVersion,
        onlineWithinSeconds: settings.onlineWithinSeconds,
      };
    },

    async createToken(user) {
      const token = newRegistrationToken();
      const outcome = await deps.runners.createToken(
        {
          tokenHash: hashSecret(token),
          createdBy: user.id,
          expiresAt: new Date(
            now().getTime() + REGISTRATION_TOKEN_TTL_SECONDS * 1000,
          ),
        },
        OPEN_TOKENS_PER_WORKSPACE_MAX,
      );
      if (!outcome.ok)
        throw new RunnerFleetError(
          "RUNNER_FLEET_TOKEN_LIMIT_REACHED",
          "The workspace holds the most unused registration tokens it may.",
          { maximum: OPEN_TOKENS_PER_WORKSPACE_MAX },
        );
      return { token, expiresAt: outcome.expiresAt };
    },

    async revoke(id) {
      const found =
        id.length > 0 &&
        id.length <= ID_MAX_LENGTH &&
        !id.includes("\u0000") &&
        (await deps.runners.revoke(id));
      if (!found)
        throw new RunnerFleetError(
          "RUNNER_FLEET_NOT_FOUND",
          "There is no such runner in this workspace.",
        );
      // From here the runner is refused on every call, so it can report nothing for the job it is running. The job is ended now and not
      // left to run out its lease: a turn has one attempt, so it fails, and its token and its record are dealt with as for any lost lease.
      await deps.endClaimsOf?.(customerRunnerId(id));
    },
  };
}
