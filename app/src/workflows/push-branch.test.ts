// SPDX-License-Identifier: LicenseRef-Proprietary

// #1177 (epic #1175): the `pushBranch` of an agent step, the branch the session works on and pushes to instead of the platform's
// `workflow/<run id>/<step id>`: a literal or an input of a manual trigger (a target, never text an agent wrote), a valid branch name, and
// the exclusions with `canPush: false`, `session.continue` and `repos`.
import { describe, expect, it } from "vitest";
import { FAKE_RESOLVER, tiny } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const PROFILE_STEP: Json = {
  id: "work",
  kind: "agent",
  profile: "implementer",
  environment: "node",
  instruction: "Do the thing.",
};

function lane(step: Json, more: Json[] = [], base: Json = PROFILE_STEP): Json {
  return {
    ...tiny(),
    trigger: {
      kind: "manual",
      input: {
        type: "object",
        required: ["repo", "branch"],
        properties: { repo: { type: "string" }, branch: { type: "string" } },
      },
    },
    budgetUsd: 20,
    steps: [{ ...base, ...step }, ...more],
  };
}

function inline(step: Json): Json {
  return lane(step, [], {
    id: "work",
    kind: "agent",
    model: { provider: "anthropic", model: "claude-sonnet-5-5" },
    canPush: true,
    environment: "node",
    instruction: "Do the thing.",
  });
}

function codes(document: unknown): string[][] {
  return validateWorkflow(document, FAKE_RESOLVER).errors.map((e) => [
    e.path,
    e.code,
  ]);
}

const AT = "/steps/0/pushBranch";

describe("the pushBranch of an agent step", () => {
  // #1177-T01
  it("takes a literal or an input of a manual trigger", () => {
    expect(codes(lane({ pushBranch: "agent/handoff-1" }))).toEqual([]);
    expect(codes(lane({ pushBranch: "{{trigger.input.branch}}" }))).toEqual([]);
    expect(
      codes(lane({ pushBranch: "agent/{{trigger.input.branch}}" })),
    ).toEqual([]);
  });

  // #1177-T02
  it("leaves a step without it exactly as it was", () => {
    expect(codes(lane({}))).toEqual([]);
    expect(codes(lane({ branch: "main" }))).toEqual([]);
  });

  // #1177-T03
  it("goes with a branch the session starts from", () => {
    expect(
      codes(
        lane({
          branch: "{{trigger.input.repo}}",
          pushBranch: "{{trigger.input.branch}}",
        }),
      ),
    ).toEqual([]);
  });

  // #1177-T04
  it("is a target: no result or branch of an earlier agent step, no text around one", () => {
    for (const value of ["{{work.summary}}", "x/{{work.branch}}"])
      expect(
        codes(
          lane({}, [
            {
              id: "second",
              kind: "agent",
              profile: "implementer",
              environment: "node",
              instruction: "Again.",
              pushBranch: value,
            },
          ]),
        ).map(([, code]) => code),
        value,
      ).toContain("target_from_untrusted_value");
  });

  // #1177-T05
  it("refuses a value that is no text, an empty one and a literal that is no branch name", () => {
    expect(codes(lane({ pushBranch: 5 }))).toEqual([[AT, "wrong_type"]]);
    expect(codes(lane({ pushBranch: "  " }))).toContainEqual([
      AT,
      "invalid_value",
    ]);
    for (const name of ["bad..name", "-dash", "with space", "end.lock", "a~b"])
      expect(codes(lane({ pushBranch: name })), name).toContainEqual([
        AT,
        "invalid_value",
      ]);
  });

  // #1177-T06
  it("is refused with canPush false, in the settings of the step and in the profile", () => {
    expect(codes(inline({ canPush: false, pushBranch: "x/y" }))).toEqual([
      [AT, "push_branch_without_push"],
    ]);
    expect(codes(inline({ canPush: true, pushBranch: "x/y" }))).toEqual([]);
    expect(
      codes(lane({ profile: "reviewer", pushBranch: "x/y" })).map(
        ([, code]) => code,
      ),
    ).toContain("push_branch_without_push");
  });

  // #1177-T07
  it("is refused on a step that goes on in a session, and together with repos", () => {
    expect(
      codes(
        lane({}, [
          {
            id: "again",
            kind: "agent",
            profile: "implementer",
            environment: "node",
            instruction: "More.",
            session: { continue: "work" },
            pushBranch: "x/y",
          },
        ]),
      ),
    ).toContainEqual(["/steps/1/pushBranch", "session_target_invalid"]);
    expect(
      codes(lane({ pushBranch: "x/y", repos: [{ repo: "acme/app" }] })),
    ).toContainEqual([AT, "push_branch_with_repos"]);
  });

  // #1177-T08
  it("is an input the validator knows only on a manual trigger", () => {
    const document = lane({ pushBranch: "{{trigger.input.branch}}" });
    document.trigger = { kind: "ticket.labeled", label: "ready" };
    expect(codes(document).length).toBeGreaterThan(0);
  });
});
