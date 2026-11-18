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
  it("lets the review request take the number of the first pull request", () => {
    const review: Json = {
      id: "review",
      kind: "action",
      connector: "ticket.requestReview",
      pullRequest: "{{pr.number}}",
      reviewers: ["octocat"],
    };
    expect(
      codes(lane({ repos: "{{implement.repos}}" }, [review])).map(
        ([, code]) => code,
      ),
    ).not.toContain("target_from_untrusted_value");
  });
});
