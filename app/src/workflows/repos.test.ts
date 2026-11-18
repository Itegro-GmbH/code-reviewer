// SPDX-License-Identifier: LicenseRef-Proprietary

// #1092 (epic #1090, ADR 0006): the `repos` of an agent step: the shape, the targets (a literal or one reference to a value the platform or
// the caller vouches for; a text with such references for the branch), the exclusions with `branch` and `session.continue`, the
// duplicates without regard to case, the mount names that clash, and the fact `{{<step>.repos}}`.
import { describe, expect, it } from "vitest";
import { FAKE_RESOLVER } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

function lane(step: Json, more: Json[] = []): Json {
  return {
    version: 1,
    name: "Several repositories",
    trigger: { kind: "ticket.labeled", label: "ready" },
    budgetUsd: 20,
    steps: [
      {
        id: "implement",
        kind: "agent",
        profile: "implementer",
        environment: "node",
        instruction: "Do it.",
        ...step,
      },
      ...more,
    ],
  };
}

function codes(document: unknown): string[][] {
  return validateWorkflow(document, FAKE_RESOLVER).errors.map((e) => [
    e.path,
    e.code,
  ]);
}

const AT = "/steps/0/repos";

describe("the repos of an agent step", () => {
  // #1092-T01
  it("takes one to ten repositories with a base and a branch, literals or references", () => {
    expect(
      codes(
        lane({
          repos: [
            {
              repo: "{{trigger.ticket.repo.fullName}}",
              base: "{{trigger.ticket.repo.defaultBranch}}",
              branch: "feature/{{trigger.ticket.key}}",
            },
            { repo: "Itegro-GmbH/shared-lib", base: "development" },
            { repo: "acme/docs", branch: "{{trigger.ticket.number}}" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  // #1092-T02
  it("leaves a step without repos exactly as it was", () => {
    expect(codes(lane({}))).toEqual([]);
    expect(codes(lane({ branch: "main" }))).toEqual([]);
  });

  // #1092-T03
  it("refuses an empty list, more than ten, an entry that is no object, an entry without a repo and unknown keys", () => {
    expect(codes(lane({ repos: [] }))).toEqual([[AT, "invalid_value"]]);
    expect(
      codes(
        lane({
          repos: Array.from({ length: 11 }, (_, i) => ({ repo: `a/r${i}` })),
        }),
      ).map(([, code]) => code),
    ).toContain("limit_exceeded");
    expect(codes(lane({ repos: ["a/b"] }))).toEqual([
      [`${AT}/0`, "wrong_type"],
    ]);
    expect(codes(lane({ repos: [{ base: "main" }] }))).toEqual([
      [`${AT}/0/repo`, "missing_field"],
    ]);
    expect(codes(lane({ repos: [{ repo: "a/b", remote: "x" }] }))).toEqual([
      [`${AT}/0/remote`, "unknown_field"],
    ]);
    expect(codes(lane({ repos: [{ repo: "justaname" }] }))).toEqual([
      [`${AT}/0/repo`, "invalid_value"],
    ]);
    expect(codes(lane({ repos: { repo: "a/b" } }))).toEqual([
      [AT, "wrong_type"],
    ]);
  });

  // #1092 (review finding 6): a repository whose mount name the runner contract refuses is the lane's invalid_value, never a runner's invalid_job.
  it.each([
    "acme/-app",
    "-acme/app",
    "acme/.",
    "acme/..",
    "acme/.git",
    "acme/.GIT",
    "../app",
    "./app",
  ])(
    "refuses the repository %s, whose mount name the runner would refuse",
    (repo) => {
      expect(codes(lane({ repos: [{ repo }] }))).toEqual([
        [`${AT}/0/repo`, "invalid_value"],
      ]);
    },
  );

  // #1092 (review finding 6)
  it("still takes a name that starts with a dot, and the reserved names (they are mounted as owner__name)", () => {
    expect(
      codes(
        lane({
          repos: [{ repo: "acme/.github" }, { repo: "acme/result" }],
        }),
      ),
    ).toEqual([]);
  });

  // #1092-T04
  it("does not take repos together with the start branch or with a session that goes on", () => {
    expect(codes(lane({ branch: "main", repos: [{ repo: "a/b" }] }))).toEqual([
      [AT, "repos_with_branch"],
    ]);
    expect(
      codes(
        lane({ session: { continue: "implement" }, repos: [{ repo: "a/b" }] }),
      ).map(([, code]) => code),
    ).toContain("repos_with_session_continue");
    expect(codes(lane({ session: "new", repos: [{ repo: "a/b" }] }))).toEqual(
      [],
    );
    // An empty session object is no session, and no good partner for repos either.
    expect(
      codes(lane({ session: {}, repos: [{ repo: "a/b" }] })),
    ).toContainEqual([AT, "repos_with_session_continue"]);
  });

  // #1092-T05
  it("holds the three fields to the targets: no title, body, label or result of an agent", () => {
    for (const repos of [
      [{ repo: "{{trigger.ticket.title}}" }],
      [{ repo: "{{trigger.ticket.repo.defaultBranch}}" }],
      [{ repo: "x/{{trigger.ticket.key}}" }],
      [{ repo: "a/b", base: "{{trigger.ticket.key}}" }],
      [{ repo: "a/b", base: "{{trigger.ticket.repo.fullName}}" }],
      [{ repo: "a/b", branch: "{{trigger.ticket.title}}" }],
      [{ repo: "a/b", branch: "fix-{{trigger.ticket.labels}}" }],
    ])
      expect(
        codes(lane({ repos })).map(([, code]) => code),
        JSON.stringify(repos),
      ).toContain("target_from_untrusted_value");
    // A step that ran before is no source either.
    expect(
      codes(
        lane({}, [
          {
            id: "second",
            kind: "agent",
            profile: "implementer",
            environment: "node",
            instruction: "Again.",
            repos: [{ repo: "a/b", branch: "{{implement.branch}}" }],
          },
        ]),
      ).map(([, code]) => code),
    ).toContain("target_from_untrusted_value");
  });

  // #1092-T06
  it("reports two literals that name one repository without regard to case", () => {
    expect(
      codes(lane({ repos: [{ repo: "Acme/App" }, { repo: "acme/app" }] })),
    ).toEqual([[`${AT}/1/repo`, "repo_duplicate"]]);
    expect(
      codes(
        lane({
          repos: [
            { repo: "{{trigger.ticket.repo.fullName}}" },
            { repo: "a/b" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  // #1092-T07
  it("reports mount names that clash after the derivation, when every entry is a literal", () => {
    expect(
      codes(
        lane({
          repos: [
            { repo: "acme/app" },
            { repo: "x/app" },
            { repo: "acme/acme__app" },
          ],
        }),
      ),
    ).toEqual([[`${AT}/2/repo`, "repo_name_clash"]]);
    expect(
      codes(lane({ repos: [{ repo: "acme/app" }, { repo: "x/app" }] })),
    ).toEqual([]);
  });

  // #1092-T08
  it("yields the fact repos for a profile that may push, and the single facts stay", () => {
    const reads = (text: string) =>
      codes(
        lane({ repos: [{ repo: "a/b" }] }, [
          {
            id: "tell",
            kind: "action",
            connector: "ticket.comment",
            ticket: "{{trigger.ticket}}",
            body: text,
          },
        ]),
      );
    expect(reads("{{implement.branch}} {{implement.headCommit}}")).toEqual([]);
    // A list has no text form inside a text; the fields of one entry are reached by the steps that read the list (the pull request step, #1094).
    expect(reads("{{implement.repos}}").map(([, code]) => code)).not.toContain(
      "reference_unknown_field",
    );
    expect(
      codes(
        lane({ repos: [{ repo: "a/b" }] }, [
          {
            id: "tell",
            kind: "action",
            connector: "ticket.comment",
            ticket: "{{trigger.ticket}}",
            body: "{{implement.nothing}}",
          },
        ]),
      ).map(([, code]) => code),
    ).toContain("reference_unknown_field");
  });

  // #1092-T09
  it("reserves the result field repos only in a step that has repos", () => {
    const result = {
      type: "object",
      required: ["repos"],
      properties: { repos: { type: "string" } },
    };
    expect(codes(lane({ result }))).toEqual([]);
    expect(codes(lane({ result, repos: [{ repo: "a/b" }] }))).toEqual([
      ["/steps/0/result/properties/repos", "result_field_reserved"],
    ]);
  });

  // #1092-T10
  it("has no fact repos for a profile that may not push", () => {
    const document = lane({ profile: "reviewer", repos: [{ repo: "a/b" }] }, [
      {
        id: "tell",
        kind: "action",
        connector: "ticket.comment",
        ticket: "{{trigger.ticket}}",
        body: "{{implement.repos}}",
      },
    ]);
    expect(codes(document).map(([, code]) => code)).toContain(
      "reference_fact_unavailable",
    );
  });
});
