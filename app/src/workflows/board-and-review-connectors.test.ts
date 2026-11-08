// SPDX-License-Identifier: LicenseRef-Proprietary

// #917: the validator holds `pullRequest.comment`, `ticket.setStatus` and `ticket.requestReview` (and `pullRequest.open`, the new name of
// `github.pullRequest.open`) to their inputs: which targets a pull request may come from, that a board and a status are literals of the
// right form, and that the people to ask are "project members" or logins. Every refusal has a path, a code and a message, and the wrong
// name says what is available.
import { describe, expect, it } from "vitest";
import { FAKE_RESOLVER, issueToPr } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const THEN = "/steps/2/then";

/** The label-triggered example with `extra` after the step that opens the pull request, inside the branch where it exists. */
function afterPullRequest(extra: Json[], rename?: string): Json {
  const document = structuredClone(issueToPr());
  const done = (document.steps as Json[])[2] as Json;
  const branch = done.then as Json[];
  if (rename !== undefined) (branch[0] as Json).connector = rename;
  branch.push(...extra);
  return document;
}

const run = (document: Json) => validateWorkflow(document, FAKE_RESOLVER);
const codes = (document: Json): string[][] =>
  run(document).errors.map((e) => [e.path, e.code]);

const setStatus = (edit: Json = {}): Json => ({
  id: "move",
  kind: "action",
  connector: "ticket.setStatus",
  ticket: "{{trigger.issue}}",
  board: "7",
  status: "In review",
  ...edit,
});
const requestReview = (edit: Json = {}): Json => ({
  id: "ask",
  kind: "action",
  connector: "ticket.requestReview",
  pullRequest: "{{pr.number}}",
  reviewers: "project members",
  ...edit,
});
const commentOnPullRequest = (edit: Json = {}): Json => ({
  id: "say",
  kind: "action",
  connector: "pullRequest.comment",
  pullRequest: "{{pr.number}}",
  body: "Ready: {{pr.url}}",
  ...edit,
});

describe("ticket.setStatus", () => {
  // #917-T300
  it("accepts a board by number or by node id and a literal status", () => {
    expect(codes(afterPullRequest([setStatus()]))).toEqual([]);
    expect(
      codes(afterPullRequest([setStatus({ board: "PVT_kwDOAb-_9" })])),
    ).toEqual([]);
  });

  // #917-T301
  it("takes the ticket as the other ticket actions do", () => {
    expect(
      codes(afterPullRequest([setStatus({ ticket: "{{trigger.ticket}}" })])),
    ).toEqual([]);
    expect(
      codes(
        afterPullRequest([setStatus({ ticket: "{{trigger.issue.title}}" })]),
      ),
    ).toEqual([[`${THEN}/1/ticket`, "target_from_untrusted_value"]]);
  });

  // #917-T302
  it("needs the ticket and the status, and takes the board from the project of the lane when it names none", () => {
    for (const input of ["ticket", "status"]) {
      const step = setStatus();
      delete step[input];
      expect(codes(afterPullRequest([step]))).toEqual([
        [`${THEN}/1/${input}`, "missing_field"],
      ]);
    }
    // #922: the board is an override that stays accepted; left out, the project's board is used.
    const withoutBoard = setStatus();
    delete withoutBoard.board;
    expect(codes(afterPullRequest([withoutBoard]))).toEqual([]);
  });

  // #917-T303
  it("takes the board and the status as literals: a reference to anything is a target from an untrusted value", () => {
    const result = run(
      afterPullRequest([
        setStatus({
          board: "{{trigger.issue.number}}",
          status: "{{implement.summary}}",
        }),
      ]),
    );

    expect(result.errors.map((e) => [e.path, e.code])).toEqual([
      [`${THEN}/1/board`, "target_from_untrusted_value"],
      [`${THEN}/1/status`, "target_from_untrusted_value"],
    ]);
    expect(result.errors[0]?.message).toContain("literal only");
  });

  // #917-T304
  it("refuses a board that is neither a project number nor a node id, and a blank status, as an invalid value", () => {
    for (const board of ["seven", "0", "PVT_", "7/8", "7 "])
      expect(codes(afterPullRequest([setStatus({ board })]))).toEqual([
        [`${THEN}/1/board`, "invalid_value"],
      ]);
    expect(codes(afterPullRequest([setStatus({ status: "  " })]))).toEqual([
      [`${THEN}/1/status`, "invalid_value"],
    ]);
    expect(codes(afterPullRequest([setStatus({ board: 7 })]))).toEqual([
      [`${THEN}/1/board`, "wrong_type"],
    ]);
  });

  // #917-T305
  it("is not allowed after a failure: it is no comment and no label", () => {
    const document = afterPullRequest([]);
    document.onFailure = [setStatus()];

    expect(codes(document)).toEqual([
      ["/onFailure/0/connector", "on_failure_step_not_allowed"],
    ]);
  });

  // #917-T307
  it("is no obstacle for pullRequest.comment after a failure, which is a comment, and still no place for ticket.requestReview", () => {
    const document = afterPullRequest([]);
    document.onFailure = [
      commentOnPullRequest({
        pullRequest: 12,
        body: "Stopped: {{failure.message}}",
      }),
    ];

    expect(codes(document)).toEqual([]);

    document.onFailure = [requestReview({ pullRequest: 12 })];
    expect(codes(document)).toEqual([
      ["/onFailure/0/connector", "on_failure_step_not_allowed"],
    ]);
  });

  // #917-T306
  it("yields the status for later steps", () => {
    expect(
      codes(
        afterPullRequest([
          setStatus(),
          commentOnPullRequest({ body: "Now {{move.status}}" }),
        ]),
      ),
    ).toEqual([]);
  });
});

describe("ticket.requestReview and pullRequest.comment", () => {
  // #917-T310
  it("take the number of the pull request that pullRequest.open or github.pullRequest.open opened", () => {
    for (const connector of ["github.pullRequest.open", "pullRequest.open"])
      expect(
        codes(
          afterPullRequest(
            [requestReview(), commentOnPullRequest()],
            connector,
          ),
        ),
      ).toEqual([]);
  });

  // #917-T311
  it("take a number, and refuse what an agent wrote, a field of another action, text around the number and the number of the issue", () => {
    expect(
      codes(afterPullRequest([requestReview({ pullRequest: 12 })])),
    ).toEqual([]);
    const refused = [
      ["{{implement.summary}}", "target_from_untrusted_value"],
      ["{{pr.url}}", "target_from_untrusted_value"],
      ["{{start.labels}}", "target_from_untrusted_value"],
      ["{{trigger.issue.number}}", "target_from_untrusted_value"],
      ["PR {{pr.number}}", "wrong_type"],
    ] as const;
    for (const [pullRequest, code] of refused)
      expect(
        codes(
          afterPullRequest([
            requestReview({ pullRequest }),
            commentOnPullRequest({ pullRequest }),
          ]),
        ),
      ).toEqual([
        [`${THEN}/1/pullRequest`, code],
        [`${THEN}/2/pullRequest`, code],
      ]);
    expect(
      codes(afterPullRequest([requestReview({ pullRequest: 0 })])),
    ).toEqual([[`${THEN}/1/pullRequest`, "invalid_value"]]);
  });

  // #917-T312
  it("names the pull request step as the root a target may start from", () => {
    const result = run(
      afterPullRequest([
        requestReview({ pullRequest: "{{implement.summary}}" }),
      ]),
    );

    expect(result.errors[0]?.code).toBe("target_from_untrusted_value");
    expect(result.errors[0]?.message).toContain(
      "{{<step id>.number}} of a pullRequest.open step",
    );
  });

  // #917-T313
  it("take people as the text project members or a list of logins", () => {
    expect(
      codes(
        afterPullRequest([requestReview({ reviewers: ["alice", "bob-2"] })]),
      ),
    ).toEqual([]);
  });

  // #917-T314
  it("refuse another text, an empty list and a name that is no login, and name what is available", () => {
    const wrongText = run(
      afterPullRequest([requestReview({ reviewers: "everybody" })]),
    );
    expect(wrongText.errors).toEqual([
      expect.objectContaining({
        path: `${THEN}/1/reviewers`,
        code: "invalid_value",
        available: ["project members"],
      }),
    ]);
    expect(codes(afterPullRequest([requestReview({ reviewers: [] })]))).toEqual(
      [[`${THEN}/1/reviewers`, "invalid_value"]],
    );
    expect(
      codes(
        afterPullRequest([
          requestReview({ reviewers: ["alice", "not a login"] }),
        ]),
      ),
    ).toEqual([[`${THEN}/1/reviewers/1`, "invalid_value"]]);
  });

  // #917-T315
  it("need their inputs", () => {
    for (const input of ["pullRequest", "reviewers"]) {
      const step = requestReview();
      delete step[input];
      expect(codes(afterPullRequest([step]))).toEqual([
        [`${THEN}/1/${input}`, "missing_field"],
      ]);
    }
    for (const input of ["pullRequest", "body"]) {
      const step = commentOnPullRequest();
      delete step[input];
      expect(codes(afterPullRequest([step]))).toEqual([
        [`${THEN}/1/${input}`, "missing_field"],
      ]);
    }
  });

  // #917-T316
  it("refuse an input they do not have, and the old input names of the github connectors", () => {
    expect(
      codes(afterPullRequest([commentOnPullRequest({ issue: 5 })])),
    ).toEqual([[`${THEN}/1/issue`, "unknown_field"]]);
    expect(codes(afterPullRequest([requestReview({ ticket: 5 })]))).toEqual([
      [`${THEN}/1/ticket`, "unknown_field"],
    ]);
  });

  // #917-T317
  it("take a pull request number from a manual input declared integer", () => {
    const document = afterPullRequest([]);
    document.trigger = {
      kind: "manual",
      input: {
        type: "object",
        required: ["repo", "pr"],
        properties: { repo: { type: "string" }, pr: { type: "integer" } },
      },
    };
    document.steps = [requestReview({ pullRequest: "{{trigger.input.pr}}" })];

    expect(codes(document)).toEqual([]);
  });
});
