// SPDX-License-Identifier: LicenseRef-Proprietary

// What the first turn (`service.ts`) and the follow-up turns (`follow-up.ts`) share: the refusals that mean the same thing for both,
// what an access failure of the platform becomes, and the checks of a repository, an environment and a profile that are copied into
// a turn. Nothing here is asked of the platform unless a function says so.
import type { ImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import type {
  TurnEnvironment,
  TurnProfile,
} from "../db/repositories/implementer-repository.ts";
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type { ProfilesRepository } from "../db/repositories/profiles-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import {
  IntegrationError,
  type IntegrationErrorCode,
} from "../integrations/errors.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { isEnvironmentVcpus } from "./environments/limits.ts";
import { ImplementerError, type UnwritableReason } from "./errors.ts";
import { readStoredResultSchema } from "./agent-result.ts";
import type { ResultSchema } from "../workflows/result-schema.ts";

export const MAX_ID_LENGTH = 128;

export const NOT_FOUND = () =>
  new ImplementerError(
    "IMPLEMENTER_REPOSITORY_NOT_FOUND",
    "There is no such repository in this workspace.",
  );
export const NOT_INSTALLED = () =>
  new ImplementerError(
    "IMPLEMENTER_APP_NOT_INSTALLED",
    "The app is not installed for this repository any more, or GitHub refuses it access.",
  );
export const UNAVAILABLE = () =>
  new ImplementerError(
    "IMPLEMENTER_GITHUB_UNAVAILABLE",
    "GitHub could not be asked, or answered with something unusable.",
  );
export const BRANCH_EXISTS = () =>
  new ImplementerError(
    "IMPLEMENTER_BRANCH_EXISTS",
    "A branch or an earlier task of this repository already has this branch name. Choose a new branch name.",
  );

export const BRANCH_CONFLICT = () =>
  new ImplementerError(
    "IMPLEMENTER_BRANCH_CONFLICT",
    "A branch name cannot be a folder of another branch (foo and foo/bar), and a branch of this repository already has such a name. Choose a new branch name.",
  );

/**
 * The codes of an access failure that mean the app has no (more) access to the connection or the repository, each with the
 * reason the form gives for it.
 */
const NO_ACCESS_REASONS: Partial<
  Record<IntegrationErrorCode, UnwritableReason>
> = {
  INTEGRATION_ACCESS_CONNECTION_GONE: "connection_gone",
  INTEGRATION_ACCESS_CONNECTION_SUSPENDED: "connection_suspended",
  INTEGRATION_ACCESS_APP_AUTH_FAILED: "app_auth_failed",
  INTEGRATION_ACCESS_SCOPE_REFUSED: "scope_refused",
  INTEGRATION_REPOSITORY_NOT_ACCESSIBLE: "repository_not_accessible",
};

export function noAccessReason(error: unknown): UnwritableReason | undefined {
  return error instanceof IntegrationError
    ? NO_ACCESS_REASONS[error.code]
    : undefined;
}

export function isNoAccess(error: unknown): boolean {
  return noAccessReason(error) !== undefined;
}

/** What went wrong while asking the platform, as an error of this module. */
export function platformFailure(error: unknown): ImplementerError {
  if (error instanceof ImplementerError) return error;
  return isNoAccess(error) ? NOT_INSTALLED() : UNAVAILABLE();
}

/** The repository, its active integration and the reference the provider needs, or the refusal. Nothing is asked of the platform. */
export async function resolveRepository(
  deps: {
    repositories: Pick<RepositoriesRepository, "get">;
    integrations: Pick<IntegrationsRepository, "get">;
  },
  repositoryId: string,
): Promise<{ integration: Integration; repo: RepoRef }> {
  if (
    typeof repositoryId !== "string" ||
    repositoryId.trim() === "" ||
    repositoryId.length > MAX_ID_LENGTH
  )
    throw new ImplementerError(
      "IMPLEMENTER_REQUEST_INVALID",
      "The repository id is missing or malformed.",
    );
  // Postgres refuses a NUL in text (22021) and the request would end in a 500: no row has such an id, so it is an unknown id.
  if (repositoryId.includes("\u0000")) throw NOT_FOUND();
  const repository = await deps.repositories.get(repositoryId);
  if (repository === undefined || !repository.active) throw NOT_FOUND();
  const integration = await deps.integrations.get(repository.integrationId);
  if (integration === undefined) throw NOT_FOUND();
  if (integration.status !== "active") throw NOT_INSTALLED();
  return {
    integration,
    repo: {
      integrationId: repository.integrationId,
      externalId: repository.externalId,
      fullName: repository.fullName,
      url: repository.url,
    },
  };
}

/**
 * The environment of the workspace as a turn copies it. An id of another workspace, or of one that is gone, is the same refusal; a size
 * that is no longer offered (1 vCPU) is shown on the page as it is and refused here, before a turn, a job or a VM exists.
 */
export async function copyEnvironment(
  environments: Pick<ImplementerEnvironmentsRepository, "get">,
  environmentId: string,
): Promise<TurnEnvironment> {
  const found = await environments.get(environmentId);
  if (found === undefined)
    throw new ImplementerError(
      "IMPLEMENTER_ENVIRONMENT_NOT_FOUND",
      "There is no such environment in this workspace.",
    );
  if (!isEnvironmentVcpus(found.vcpus))
    throw new ImplementerError(
      "IMPLEMENTER_ENVIRONMENT_SIZE_UNSUPPORTED",
      "The size of this environment is no longer offered.",
    );
  return {
    id: found.id,
    name: found.name,
    vcpus: found.vcpus,
    setupScript: found.setupScript,
    network: found.network,
  };
}

/** A profile version as a turn copies it, with the default result schema text of the version; the refusal when there is none. */
export async function copyProfile(
  profiles: Pick<ProfilesRepository, "findByName">,
  ref: { name: string; version: number | null },
): Promise<{
  profile: TurnProfile;
  model: ModelChoice;
  costLimitCents: number | null;
  defaultResult: string | null;
}> {
  const found = await profiles.findByName(ref.name, ref.version ?? undefined);
  if (found === undefined)
    throw new ImplementerError(
      "IMPLEMENTER_PROFILE_NOT_FOUND",
      "There is no such profile in this workspace, or it has no such version.",
    );
  const { content } = found.version;
  return {
    profile: {
      id: found.profile.id,
      name: found.profile.name,
      version: found.version.version,
      instructions: content.instructions,
      canPush: content.canPush,
    },
    model: content.model,
    costLimitCents: content.costLimitCents,
    defaultResult: content.defaultResult,
  };
}

/** Whether a stored model choice is the one of the body: the same entry, or the same provider and model. */
export function sameModel(stored: ModelChoice, asked: ModelChoice): boolean {
  if ("entryId" in stored || "entryId" in asked)
    return (
      "entryId" in stored &&
      "entryId" in asked &&
      stored.entryId === asked.entryId
    );
  return stored.provider === asked.provider && stored.model === asked.model;
}

/**
 * Whether the profile a repeated body names is the one the earlier task ran with: the same name, and the same version when the body
 * pins one (a body that names none is the newest at the time of the first request, which a new version since does not change).
 */
/**
 * The default result schema of a profile version (#843), stored as the validator accepted it. Should the text not be one any more
 * (it cannot be: the table is written by the validator's own service), the task is refused instead of run without the finish
 * tool the profile asked for.
 */
export function resultOfProfile(stored: string | null): ResultSchema | null {
  if (stored === null) return null;
  const schema = readStoredResultSchema(stored);
  if (schema === null)
    throw new ImplementerError(
      "IMPLEMENTER_REQUEST_INVALID",
      "The default result schema of the profile cannot be used.",
    );
  return schema;
}
