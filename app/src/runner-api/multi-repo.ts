// SPDX-License-Identifier: LicenseRef-Proprietary

// The repositories of a turn on several repositories, as the claim hands them out (#1092, epic #1090, ADR 0006): `implementer.repos`, one
// git token for each installation of the GitHub App that owns a repository of the turn (made for exactly the repository ids of the turn that
// belong to it, so a token never reaches more than the job named), `git.token` (the first repository's token) and the preamble that the app
// writes at the start of the instruction. Everything here is decided by the app; the runner follows the job.
//
// A failure leaves no token behind: what was made before the failure is switched off here, and the caller never has a half-made job.
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import {
  deriveMountNames,
  isDirect,
  preambleOf,
  type SessionRepo,
} from "../db/session-repos.ts";
import { revealGitAccess } from "../integrations/normalized.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { GitAccess, Integration, RepoRef } from "../integrations/types.ts";
import type { ImplementerJobRepo } from "../contracts/runner-api.ts";
import type { GitTokenEntry } from "./claimed-keys.ts";
import { DEFAULT_TOKEN_LIFETIME_MS } from "./write-token.ts";
import type { ResumeBlock } from "./resume.ts";

/** Why the claim does not go on with the job: the code the job ends with and the detail the log gets. Never a token. */
export class MultiRepoRefusal extends Error {
  readonly errorCode: string;
  readonly detail: string | undefined;
  constructor(errorCode: string, detail?: string) {
    super(errorCode);
    this.name = "MultiRepoRefusal";
    this.errorCode = errorCode;
    this.detail = detail;
  }
}

export type MultiRepoDeps = {
  repositories: (workspaceId: string) => Pick<RepositoriesRepository, "get">;
  integrations: (workspaceId: string) => Pick<IntegrationsRepository, "get">;
  registry: Pick<IntegrationRegistry, "resolve">;
  /** The clone address of a repository's web address, or null when it is not one the runner may clone from (`cloneUrlOf` of the claim). */
  cloneUrlOf: (repositoryUrl: string) => string | null;
  /** Whether the integration is GitHub: the runner speaks GitHub only. */
  isGithub: (integration: Integration) => boolean;
  /** Switches off tokens that were made but are not handed out. Never rejects. */
  revoke: (tokens: GitTokenEntry[]) => Promise<void>;
  now: () => Date;
};

/** What the builder yields: the parts of the job and the tokens the ledger must hold before the job leaves. */
export type MultiRepoParts = {
  repos: ImplementerJobRepo[];
  tokens: Array<{ id: string; token: string }>;
  /** `git.token` of the job (byte-equal to the token of the first repository), and the address and the login the job names. */
  git: { baseUrl: string; token: string; botLogin: string };
  /** Every token made, for the ledger that switches them off when the turn is over. */
  ledger: GitTokenEntry[];
  /** The earliest expiry of a token (ISO 8601), or null when the platform said none. */
  tokenExpiresAt: string | null;
  /** The instruction with the preamble in front, within `INSTRUCTION_MAX_LENGTH`. */
  instruction: string;
};

function entryOf(
  git: GitAccess,
  integrationId: string,
  now: Date,
): GitTokenEntry {
  return {
    token: git.token,
    integrationId,
    expiresAt:
      git.expiresAt ??
      new Date(now.getTime() + DEFAULT_TOKEN_LIFETIME_MS).toISOString(),
  };
}

/** The longest instruction a job carries (`INSTRUCTION_MAX_LENGTH` of `implementer/start-input.ts`, and the contract's `maxLength`). */
export const INSTRUCTION_MAX_LENGTH = 20_000;

const CUT_NOTE = "\n\n[The task was cut here: it did not fit the limit.]";

/** The preamble and the task in one text of at most `INSTRUCTION_MAX_LENGTH` characters; the task gives way, never the preamble. */
export function instructionWithPreamble(
  preamble: string,
  task: string,
): string {
  const room = INSTRUCTION_MAX_LENGTH - preamble.length;
  if (task.length <= room) return preamble + task;
  // Counted in UTF-16 units (at least as many as characters), and a pair of surrogates is never cut in two.
  let text = "";
  const allowed = Math.max(0, room - CUT_NOTE.length);
  for (const char of task) {
    if (text.length + char.length > allowed) break;
    text += char;
  }
  return preamble + text + CUT_NOTE;
}

/**
 * Builds the repositories, the tokens and the instruction of a multi-repository turn from the session's stored list. Throws
 * `MultiRepoRefusal` (the job ends with its code) or the `IntegrationError` of the platform (the caller decides: give back or end).
 */
export async function buildMultiRepo(
  deps: MultiRepoDeps,
  input: {
    workspaceId: string;
    session: { repos: readonly SessionRepo[] };
    /** The turn is not the first: a working branch an earlier turn pushed exists, whatever the platform lists now (its loss is the runner's `clone_failed`). */
    resume: ResumeBlock | null;
    canPush: boolean;
    instruction: string;
  },
): Promise<MultiRepoParts> {
  const stored = input.session.repos;
  const resolved: Array<{
    entry: SessionRepo;
    integration: Integration;
    repo: RepoRef;
    cloneUrl: string;
  }> = [];
  for (const entry of stored) {
    const repository = await deps
      .repositories(input.workspaceId)
      .get(entry.repositoryId);
    const integration =
      repository === undefined
        ? undefined
        : await deps
            .integrations(input.workspaceId)
            .get(repository.integrationId);
    if (
      repository === undefined ||
      !repository.active ||
      integration === undefined ||
      integration.status !== "active"
    )
      throw new MultiRepoRefusal("git_connection_disabled");
    if (!deps.isGithub(integration))
      throw new MultiRepoRefusal("git_access_failed");
    const cloneUrl = deps.cloneUrlOf(repository.url);
    if (cloneUrl === null)
      throw new MultiRepoRefusal(
        "implementer_config_invalid",
        "reason=clone_url",
      );
    resolved.push({
      entry,
      integration,
      repo: {
        integrationId: repository.integrationId,
        externalId: repository.externalId,
        fullName: repository.fullName,
        url: repository.url,
      },
      cloneUrl,
    });
  }

  // The mount names are the ones the first turn stored; a repository renamed since would change what the runner derives, so the turn ends.
  const derived = deriveMountNames(resolved.map((item) => item.repo.fullName));
  if (resolved.some((item, index) => item.entry.name !== derived[index]))
    throw new MultiRepoRefusal(
      "implementer_config_invalid",
      "reason=repo_renamed",
    );

  // The installations, in the order they first appear: the first repository's is the first, so `git.token` is its token.
  const installations = new Map<
    string,
    { integration: Integration; repos: RepoRef[] }
  >();
  for (const item of resolved) {
    const found = installations.get(item.integration.id);
    if (found === undefined)
      installations.set(item.integration.id, {
        integration: item.integration,
        repos: [item.repo],
      });
    else found.repos.push(item.repo);
  }

  // Every read of the platform comes before the first token exists.
  if (input.canPush)
    for (const { integration } of installations.values()) {
      const held = await deps.registry
        .resolve(integration.type)
        .installationPermissions(integration);
      if (!held.contentsWrite)
        throw new MultiRepoRefusal("git_write_not_granted");
    }
  const resumeRepos = input.resume?.repos;
  const branchExists: boolean[] = [];
  for (const [index, item] of resolved.entries()) {
    if (isDirect(item.entry)) {
      branchExists.push(false);
      continue;
    }
    // #1177: the first turn of a `pushBranch` entry follows what the start of the session decided (`expectExisting`): asking the platform
    // again would continue a branch that appeared in between and push onto work that is not the lane's. The runner then ends the turn
    // `branch_exists` (it was told the branch is new and finds it) or `clone_failed` (it was told the branch is there and it is gone).
    if (
      input.resume === null &&
      item.entry.pushOnly === true &&
      item.entry.expectExisting !== undefined
    ) {
      branchExists.push(item.entry.expectExisting);
      continue;
    }
    const pushedBefore =
      resumeRepos?.[index]?.branches.some(
        (branch) => branch.name === item.entry.branch,
      ) === true;
    branchExists.push(
      pushedBefore ||
        (await deps.registry
          .resolve(item.integration.type)
          .getBranch(item.integration, item.repo, item.entry.branch)) !== null,
    );
  }

  const ledger: GitTokenEntry[] = [];
  const tokens: Array<{ id: string; token: string }> = [];
  const tokenIdOf = new Map<string, string>();
  let access: GitAccess | undefined;
  try {
    for (const { integration, repos } of installations.values()) {
      const [first, ...others] = repos as [RepoRef, ...RepoRef[]];
      const made = revealGitAccess(
        await deps.registry
          .resolve(integration.type)
          .implementerAccess(integration, first, {
            // A profile that may not push gets a token that cannot, whatever the Worker does.
            readOnly: !input.canPush,
            ...(others.length === 0 ? {} : { alsoRepos: others }),
          }),
      );
      ledger.push(entryOf(made, integration.id, deps.now()));
      const id = `t${String(tokens.length + 1)}`;
      tokens.push({ id, token: made.token });
      tokenIdOf.set(integration.id, id);
      access ??= made;
    }
    if (access === undefined || access.botLogin === null)
      throw new MultiRepoRefusal("git_access_failed");
  } catch (error) {
    await deps.revoke(ledger);
    throw error;
  }

  const repos: ImplementerJobRepo[] = resolved.map((item, index) => ({
    name: item.entry.name,
    fullName: item.repo.fullName,
    cloneUrl: item.cloneUrl,
    base: item.entry.base,
    branch: item.entry.branch,
    branchExists: branchExists[index] === true,
    tokenId: tokenIdOf.get(item.integration.id) as string,
    // #1177: the runner pushes this branch only (`select_branches`); every other entry keeps the rule of all branches.
    ...(item.entry.pushOnly === true ? { pushOnly: true } : {}),
  }));
  const times = ledger.map((entry) => entry.expiresAt).sort();
  return {
    repos,
    tokens,
    git: {
      baseUrl: access.baseUrl,
      token: (tokens[0] as { token: string }).token,
      botLogin: access.botLogin,
    },
    ledger,
    tokenExpiresAt: times[0] ?? null,
    instruction: instructionWithPreamble(
      preambleOf(
        resolved.map((item) => item.entry),
        branchExists,
      ),
      input.instruction,
    ),
  };
}
