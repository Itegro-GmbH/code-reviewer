// SPDX-License-Identifier: LicenseRef-Proprietary

// #1094 (epic #1090, ADR 0006): the pull request step with `repos`: the one reference to the `repos` fact that is a target, `head` and `base` that
// it replaces, `{{repo.…}}` in the title and the body, and the outputs that are optional then.
import { describe, expect, it } from "vitest";
import { FAKE_RESOLVER } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

function lane(pr: Json, more: Json[] = [], agent: Json = {}): Json {
  return {
    version: 1,
    name: "Pull requests per repository",
    trigger: { kind: "ticket.labeled", label: "ready" },
    budgetUsd: 20,
    steps: [
      {
        id: "implement",
        kind: "agent",
        profile: "implementer",
        environment: "node",
        instruction: "Do it.",
        repos: [{ repo: "a/b", branch: "x" }, { repo: "a/c" }],
        ...agent,
      },
      {
        id: "pr",
        kind: "action",
        connector: "pullRequest.open",
        title: "Fix {{repo.fullName}}",
        ...pr,
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

describe("the pull request step with repos", () => {
  // #1094-T01
  it("takes the repos fact of an agent step instead of head and base", () => {
    expect(codes(lane({ repos: "{{implement.repos}}" }))).toEqual([]);
  });

  // #1094-T02
  it("needs head or repos, and not both", () => {
    expect(codes(lane({ title: "Fix" }))).toEqual([
      ["/steps/1", "missing_field"],
    ]);
    expect(codes(lane({ repos: "{{implement.repos}}", head: "x" }))).toEqual([
      ["/steps/1/head", "invalid_value"],
    ]);
    expect(codes(lane({ repos: "{{implement.repos}}", base: "main" }))).toEqual(
      [["/steps/1/base", "invalid_value"]],
    );
  });

  // #1094-T03
  it("leaves the single form as it was", () => {
    expect(
      codes(
        lane({ head: "{{implement.branch}}", title: "Fix" }, [], {
          repos: undefined,
        }),
      ),
    ).toEqual([]);
  });

  // #1094-T04
  it("takes repos only as one reference to the repos fact: a target", () => {
    for (const repos of [
      "{{trigger.input.repos}}",
      "{{implement.commits}}",
      "x {{implement.repos}}",
    ])
      expect(
        codes(lane({ repos })).map(([, code]) => code),
        repos,
      ).not.toEqual([]);
    expect(codes(lane({ repos: "{{implement.repos}}" }))).toEqual([]);
    expect(
      codes(lane({ repos: "{{implement.summary}}" })).map(([, code]) => code),
    ).not.toEqual([]);
  });

  // #1094-T05
  it("reads repo.fullName, repo.base and repo.branch in the title and the body, and nowhere else", () => {
    expect(
      codes(
        lane({
          repos: "{{implement.repos}}",
          title: "{{repo.fullName}}: {{repo.branch}} into {{repo.base}}",
          body: "{{repo.fullName}}",
        }),
      ),
    ).toEqual([]);
    expect(
      codes(
        lane({ repos: "{{implement.repos}}", title: "{{repo.owner}}" }),
      ).map(([, code]) => code),
    ).toEqual(["reference_unknown_field"]);
    // Without repos there is no repository being opened: `repo` is no step either.
    expect(
      codes(
        lane({ head: "{{implement.branch}}", title: "{{repo.fullName}}" }),
      ).map(([, code]) => code),
    ).toEqual(["reference_unknown_step"]);
  });

  // #1094-T06
  it("makes the single outputs optional with repos, and the list of pull requests readable", () => {
    const comment = (body: string): Json => ({
      id: "tell",
      kind: "action",
      connector: "ticket.comment",
      ticket: "{{trigger.ticket}}",
      body,
    });
    const withRepos = (body: string) =>
      codes(lane({ repos: "{{implement.repos}}" }, [comment(body)]));
    expect(withRepos("{{pr.url}}").map(([, code]) => code)).toEqual([
      "reference_optional_field",
    ]);
    expect(withRepos('{{pr.url | default "none"}}')).toEqual([]);
    // The single form still always has them.
    expect(
      codes(
        lane(
          { head: "{{implement.branch}}", title: "Fix" },
          [comment("{{pr.url}}")],
          { repos: undefined },
        ),
      ),
    ).toEqual([]);
  });

  // #1094-T07
  it("lets the review request take the number and the repository of the first pull request, with no default", () => {
    const review = (extra: Json = {}): Json => ({
      id: "review",
      kind: "action",
      connector: "ticket.requestReview",
      pullRequest: "{{pr.number}}",
      reviewers: ["octocat"],
      ...extra,
    });
    const pr = { repos: "{{implement.repos}}" };
    expect(
      codes(lane(pr, [review({ repository: "{{pr.repository}}" })])),
    ).toEqual([]);
    // Without a pull request the step skips (`no_pull_request`), so no default is needed; a literal repository of the workspace is a target too.
    expect(codes(lane(pr, [review({ repository: "a/c" })]))).toEqual([]);
    expect(
      codes(
        lane(pr, [review({ repository: "{{trigger.ticket.repo.fullName}}" })]),
      ),
    ).toEqual([]);
  });

  // #1094-T35
  it("refuses a default for the number of a step with repos, and a repository that is not a vouched value", () => {
    const review = (extra: Json): Json => ({
      id: "review",
      kind: "action",
      connector: "ticket.requestReview",
      reviewers: ["octocat"],
      ...extra,
    });
    const pr = { repos: "{{implement.repos}}" };
    expect(
      codes(lane(pr, [review({ pullRequest: "{{pr.number | default 7}}" })])),
    ).toEqual([["/steps/2/pullRequest", "invalid_value"]]);
    expect(
      codes(
        lane(pr, [
          review({
            pullRequest: "{{pr.number}}",
            repository: "{{implement.summary}}",
          }),
        ]),
      ).map(([, code]) => code),
    ).toContain("target_from_untrusted_value");
    // The single form's number is always there: a default stays harmless there.
    expect(
      codes(
        lane(
          { head: "{{implement.branch}}", title: "Fix" },
          [review({ pullRequest: "{{pr.number}}" })],
          {
            repos: undefined,
          },
        ),
      ),
    ).toEqual([]);
  });

  // #1094-T36
  it("does not offer the pull request repository of a single-form step, and refuses the number of a repos step for a comment", () => {
    const single = lane(
      { head: "{{implement.branch}}", title: "Fix" },
      [
        {
          id: "review",
          kind: "action",
          connector: "ticket.requestReview",
          pullRequest: "{{pr.number}}",
          repository: "{{pr.repository}}",
          reviewers: ["octocat"],
        },
      ],
      { repos: undefined },
    );
    expect(codes(single).map(([, code]) => code)).toEqual([
      "reference_unknown_field",
    ]);
    const comment = (pullRequest: string): Json => ({
      id: "note",
      kind: "action",
      connector: "pullRequest.comment",
      pullRequest,
      body: "hi",
    });
    const pr = { repos: "{{implement.repos}}" };
    expect(codes(lane(pr, [comment("{{pr.number}}")])).length).toBeGreaterThan(
      0,
    );
    expect(
      codes(lane(pr, [comment("{{pr.number | default 3}}")])).length,
    ).toBeGreaterThan(0);
  });

  // #1094-T55
  it("keeps `{{repo.…}}` for the repository in the title and the body: a step called repo is valid, and is not read there", () => {
    const stepRepo: Json = {
      id: "repo",
      kind: "agent",
      profile: "implementer",
      environment: "node",
      instruction: "Look.",
    };
    const withStep = lane({ repos: "{{implement.repos}}" });
    (withStep.steps as Json[]).splice(1, 0, stepRepo);
    expect(codes(withStep)).toEqual([]);
    // In the title of the step with repos `repo` is the repository, never that step.
    (withStep.steps as Json[])[2] = {
      id: "pr",
      kind: "action",
      connector: "pullRequest.open",
      repos: "{{implement.repos}}",
      title: "Fix {{repo.summary}}",
    };
    expect(codes(withStep)).toEqual([
      ["/steps/2/title", "reference_unknown_field"],
    ]);
  });
});
