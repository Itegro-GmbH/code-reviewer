// SPDX-License-Identifier: LicenseRef-Proprietary

// #1092 (epic #1090, ADR 0006): what the claim builds for a turn on several repositories: the repositories with their mount, base, branch and
// `branchExists`, one token for each installation made for exactly the repositories of the turn that belong to it, `git.token` (the first
// repository's), the preamble in front of the instruction, and the refusals that leave no token behind.
import { describe, expect, it } from "vitest";
import type { SessionRepo } from "../implementer/session-repos.ts";
import { INSTRUCTION_MAX_LENGTH } from "../implementer/start-input.ts";
import { createGitAccess } from "../integrations/normalized.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import {
  buildMultiRepo,
  instructionWithPreamble,
  MultiRepoRefusal,
  type MultiRepoDeps,
} from "./multi-repo.ts";
import { breakOfJobRule, type JobDocument } from "./multi-repo-job.ts";

function integration(id: string): Integration {
  return {
    id,
    workspaceId: "w-1",
    type: "github_app",
    displayName: id,
    externalId: `ext-${id}`,
    status: "active",
  } as unknown as Integration;
}

type Row = { id: string; integrationId: string; fullName: string };
const ROWS: Row[] = [
  { id: "r-app", integrationId: "i-1", fullName: "acme/app" },
  { id: "r-lib", integrationId: "i-1", fullName: "acme/lib" },
  { id: "r-docs", integrationId: "i-2", fullName: "other/docs" },
  { id: "r-lib2", integrationId: "i-2", fullName: "other/lib" },
];

function sessionRepo(row: Row, branch?: string): SessionRepo {
  const name = row.fullName.split("/")[1] as string;
  return {
    repositoryId: row.id,
    fullName: row.fullName,
    name,
    base: "main",
    branch: branch ?? "main",
  };
}

function setup(options: { write?: boolean; branches?: string[] } = {}) {
  const made: Array<{ repo: string; also: string[]; readOnly: boolean }> = [];
  const revoked: string[] = [];
  const registry = {
    resolve: () => ({
      installationPermissions: async () => ({
        contentsWrite: options.write ?? true,
      }),
      getBranch: async (_i: Integration, _r: RepoRef, name: string) =>
        (options.branches ?? []).includes(name)
          ? { name, sha: "a".repeat(40) }
          : null,
      implementerAccess: async (
        i: Integration,
        repo: RepoRef,
        o?: { readOnly?: boolean; alsoRepos?: RepoRef[] },
      ) => {
        made.push({
          repo: repo.fullName,
          also: (o?.alsoRepos ?? []).map((r) => r.fullName),
          readOnly: o?.readOnly === true,
        });
        return createGitAccess({
          provider: "github",
          baseUrl: "https://api.github.com",
          token: `token-${i.id}`,
          authType: "token",
          botLogin: "bot[bot]",
          expiresAt: "2026-11-18T13:00:00.000Z",
        });
      },
    }),
  };
  const deps: MultiRepoDeps = {
    repositories: () => ({
      get: async (id: string) => {
        const row = ROWS.find((r) => r.id === id);
        return row === undefined
          ? undefined
          : ({
              id: row.id,
              integrationId: row.integrationId,
              externalId: row.id.length.toString(),
              fullName: row.fullName,
              url: `https://github.com/${row.fullName}`,
              active: true,
            } as never);
      },
    }),
    integrations: () => ({ get: async (id: string) => integration(id) }),
    registry: registry as never,
    cloneUrlOf: (url) => `${url}.git`,
    isGithub: () => true,
    revoke: async (tokens) => void revoked.push(...tokens.map((t) => t.token)),
    now: () => new Date("2026-11-18T12:00:00.000Z"),
  };
  return { deps, made, revoked };
}

const input = (repos: SessionRepo[], extra: Record<string, unknown> = {}) => ({
  workspaceId: "w-1",
  session: { repos },
  resume: null,
  canPush: true,
  instruction: "Do the task.",
  ...extra,
});

describe("the repositories of a turn on several repositories", () => {
  // #1092-T20
  it("makes one token for each installation, for exactly the repositories of the turn that belong to it", async () => {
    const { deps, made } = setup();
    const parts = await buildMultiRepo(
      deps,
      input([
        sessionRepo(ROWS[0] as Row),
        sessionRepo(ROWS[2] as Row),
        sessionRepo(ROWS[1] as Row),
      ]),
    );

    expect(made).toEqual([
      { repo: "acme/app", also: ["acme/lib"], readOnly: false },
      { repo: "other/docs", also: [], readOnly: false },
    ]);
    expect(parts.tokens).toEqual([
      { id: "t1", token: "token-i-1" },
      { id: "t2", token: "token-i-2" },
    ]);
    expect(parts.repos.map((r) => [r.name, r.tokenId])).toEqual([
      ["app", "t1"],
      ["docs", "t2"],
      ["lib", "t1"],
    ]);
    // `git.token` is the token of the first repository.
    expect(parts.git.token).toBe("token-i-1");
    expect(parts.ledger).toHaveLength(2);
    expect(parts.tokenExpiresAt).toBe("2026-11-18T13:00:00.000Z");
  });

  // #1092-T21
  it("makes a token that can only read for a profile that may not push, and needs no right to write", async () => {
    const { deps, made } = setup({ write: false });
    await buildMultiRepo(
      deps,
      input([sessionRepo(ROWS[0] as Row)], { canPush: false }),
    );
    expect(made.map((m) => m.readOnly)).toEqual([true]);

    const { deps: strict } = setup({ write: false });
    await expect(
      buildMultiRepo(strict, input([sessionRepo(ROWS[0] as Row)])),
    ).rejects.toMatchObject({ errorCode: "git_write_not_granted" });
  });

  // #1092-T22
  it("derives the mount names from the full names, whatever their order", async () => {
    const { deps } = setup();
    const parts = await buildMultiRepo(
      deps,
      input([
        { ...sessionRepo(ROWS[1] as Row), name: "acme__lib" },
        { ...sessionRepo(ROWS[3] as Row), name: "other__lib" },
      ]),
    );
    expect(parts.repos.map((r) => r.name)).toEqual(["acme__lib", "other__lib"]);
    // A name the first turn stored that the full names no longer give (a renamed repository) ends the turn.
    await expect(
      buildMultiRepo(
        deps,
        input([sessionRepo(ROWS[1] as Row), sessionRepo(ROWS[3] as Row)]),
      ),
    ).rejects.toMatchObject({
      errorCode: "implementer_config_invalid",
      detail: "reason=repo_renamed",
    });
  });

  // #1092-T23
  it("decides branchExists: false for direct work, the provider's answer for a working branch, true for a branch an earlier turn pushed", async () => {
    const { deps } = setup({ branches: ["feature/x"] });
    const parts = await buildMultiRepo(
      deps,
      input([
        sessionRepo(ROWS[0] as Row, "feature/x"),
        sessionRepo(ROWS[1] as Row, "feature/y"),
        sessionRepo(ROWS[2] as Row),
      ]),
    );
    expect(parts.repos.map((r) => r.branchExists)).toEqual([
      true,
      false,
      false,
    ]);

    const follow = await buildMultiRepo(
      deps,
      input([sessionRepo(ROWS[1] as Row, "feature/y")], {
        resume: {
          turn: 2,
          repos: [
            {
              name: "lib",
              branches: [{ name: "feature/y", head: "b".repeat(40) }],
              checkout: null,
            },
          ],
          snapshot: false,
        },
      }),
    );
    // Gone on the provider now, but an earlier turn pushed it: the runner ends the turn `clone_failed` naming the repository.
    expect(follow.repos[0]?.branchExists).toBe(true);
  });

  // #1092-T24
  it("writes the preamble at the start of the instruction", async () => {
    const { deps } = setup({ branches: ["feature/x"] });
    const parts = await buildMultiRepo(
      deps,
      input([
        sessionRepo(ROWS[0] as Row, "feature/x"),
        sessionRepo(ROWS[1] as Row),
      ]),
    );
    expect(parts.instruction.endsWith("Do the task.")).toBe(true);
    expect(parts.instruction).toContain("/work/app");
    expect(parts.instruction).toContain(
      'the working branch "feature/x" already exists',
    );
    expect(parts.instruction).toContain("work directly on its base branch");
  });

  // #1092-T25
  it("keeps the preamble and cuts the task within the 20000 characters of an instruction", () => {
    const preamble = "P".repeat(500);
    const task = "x".repeat(INSTRUCTION_MAX_LENGTH);
    const text = instructionWithPreamble(preamble, task);
    expect(text.length).toBeLessThanOrEqual(INSTRUCTION_MAX_LENGTH);
    expect(text.startsWith(preamble)).toBe(true);
    expect(text).toContain("The task was cut here");
    expect(instructionWithPreamble(preamble, "short")).toBe(`${preamble}short`);
    // A pair of surrogates is not cut in two.
    const emoji = instructionWithPreamble(
      preamble,
      "😀".repeat(INSTRUCTION_MAX_LENGTH),
    );
    expect(emoji.length).toBeLessThanOrEqual(INSTRUCTION_MAX_LENGTH);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  // #1092-T26
  it("switches off the tokens it made when a later one cannot be made, and refuses a repository that is gone", async () => {
    const { deps, revoked } = setup();
    let calls = 0;
    const real = deps.registry.resolve;
    deps.registry = {
      resolve: (type: never) => {
        const provider = real(type) as unknown as Record<string, unknown>;
        return {
          ...provider,
          implementerAccess: async (...args: unknown[]) => {
            calls += 1;
            if (calls === 2) throw new Error("platform down");
            return (provider.implementerAccess as (...a: unknown[]) => unknown)(
              ...args,
            );
          },
        };
      },
    } as never;
    await expect(
      buildMultiRepo(
        deps,
        input([sessionRepo(ROWS[0] as Row), sessionRepo(ROWS[2] as Row)]),
      ),
    ).rejects.toThrow("platform down");
    expect(revoked).toEqual(["token-i-1"]);

    const { deps: gone } = setup();
    await expect(
      buildMultiRepo(
        gone,
        input([
          {
            repositoryId: "r-missing",
            fullName: "x/y",
            name: "y",
            base: "main",
            branch: "main",
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(MultiRepoRefusal);
  });

  // #1092-T27
  it("builds a job that holds every rule the contract states beyond the schema", async () => {
    const { deps } = setup();
    const parts = await buildMultiRepo(
      deps,
      input([sessionRepo(ROWS[0] as Row), sessionRepo(ROWS[2] as Row)]),
    );
    const job: JobDocument = {
      git: {
        baseUrl: parts.git.baseUrl,
        token: parts.git.token,
        tokens: parts.tokens,
      },
      implementer: { repos: parts.repos },
    };
    expect(breakOfJobRule(job)).toBeNull();
    const broken = structuredClone(job);
    broken.git.token = "other";
    expect(breakOfJobRule(broken)).toBe("git_token_mismatch");
  });
});
