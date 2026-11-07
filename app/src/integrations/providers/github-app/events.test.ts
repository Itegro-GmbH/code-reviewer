// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down which pull request actions start a review: opened, reopened, ready for review and new
// commits do, everything else does not; a closed pull request is its own event. Whether a draft or a
// disabled setting still stops the review is decided by the automatic trigger policy
// (src/webhooks/automatic-review-policy.ts), so the translation passes the draft flag on.
import { describe, expect, it } from "vitest";
import { webhookFixture } from "../../../../../fakes/github/webhooks.ts";
import { isIntegrationEvent } from "../../normalized.ts";
import { mayHaveWriteAccess, parseGithubEvent } from "./events.ts";

async function eventOfPayload(eventName: string, payload: unknown) {
  return parseGithubEvent({
    integrationId: "integration-1",
    eventName,
    payload,
    hasWriteAccess: async () => {
      throw new Error("a pull request delivery must not ask for permissions");
    },
    headShaOf: async () => {
      throw new Error("a pull request delivery carries its head commit");
    },
  });
}

async function eventOf(fixture: string) {
  return eventOfPayload(
    fixture.split(".")[0] as string,
    webhookFixture(fixture),
  );
}

/** A recorded pull request payload with other values at the given places. */
function pullRequestWith(
  fixture: string,
  changes: { action?: string; pullRequest?: Record<string, unknown> },
) {
  const payload = webhookFixture(fixture) as Record<string, unknown> & {
    pull_request: Record<string, unknown>;
  };
  return {
    ...payload,
    ...(changes.action === undefined ? {} : { action: changes.action }),
    pull_request: { ...payload.pull_request, ...changes.pullRequest },
  };
}

describe("which pull request actions start a review", () => {
  // CR-22-T09, CR-31-T02
  it.each([
    ["pull_request.opened", "opened"],
    ["pull_request.synchronize", "updated"],
    ["pull_request.reopened", "opened"],
    ["pull_request.ready_for_review", "opened"],
  ])("%s becomes a %s trigger", async (fixture, kind) => {
    expect(await eventOf(fixture)).toMatchObject({
      kind: "review_trigger",
      trigger: { kind, draft: false, state: "open" },
    });
  });

  // CR-22-T09, CR-31-T03
  it.each(["edited", "labeled", "assigned", "review_requested"])(
    "the action %s becomes no trigger",
    async (action) => {
      expect(
        await eventOfPayload(
          "pull_request",
          pullRequestWith("pull_request.edited", { action }),
        ),
      ).toMatchObject({ kind: "ignored" });
    },
  );

  // CR-22-T09, CR-31-T03
  it.each(["pull_request.edited", "pull_request.labeled"])(
    "%s becomes no trigger",
    async (fixture) => {
      expect(await eventOf(fixture)).toMatchObject({ kind: "ignored" });
    },
  );

  it("reports a pull request that was converted to a draft as drafted, not as a trigger", async () => {
    expect(await eventOf("pull_request.converted_to_draft")).toMatchObject({
      kind: "pull_request_drafted",
      repo: { externalId: "7001", fullName: "acme/widgets" },
      prNumber: 7,
    });
  });

  // CR-31-T03
  it("reports a closed pull request as closed, merged or not, and as no trigger", async () => {
    expect(await eventOf("pull_request.closed")).toEqual({
      kind: "pull_request_closed",
      repo: {
        integrationId: "integration-1",
        externalId: "7001",
        fullName: "acme/widgets",
        url: "https://github.com/acme/widgets",
      },
      prNumber: 7,
      merged: true,
    });
    expect(
      await eventOfPayload(
        "pull_request",
        pullRequestWith("pull_request.closed", {
          pullRequest: { merged: false },
        }),
      ),
    ).toMatchObject({ kind: "pull_request_closed", merged: false });
  });
});

describe("what a pull request trigger says about the pull request", () => {
  // CR-31-T04
  it("translates a pull request opened as a draft like any other and marks it as a draft", async () => {
    expect(await eventOf("pull_request.opened.draft")).toMatchObject({
      kind: "review_trigger",
      trigger: { kind: "opened", prNumber: 7, draft: true, state: "open" },
    });
  });

  // CR-31-T09
  it("marks the trigger of a late delivery for a closed pull request as closed", async () => {
    for (const fixture of ["pull_request.synchronize", "pull_request.reopened"])
      expect(
        await eventOfPayload(
          "pull_request",
          pullRequestWith(fixture, { pullRequest: { state: "closed" } }),
        ),
      ).toMatchObject({ kind: "review_trigger", trigger: { state: "closed" } });
  });
});

describe("a pull request payload that lacks what the app reads", () => {
  // CR-31-T14
  it("is invalid, and the reason names the missing field but no value", async () => {
    const payload = pullRequestWith("pull_request.opened", {});
    delete (payload.pull_request as { head?: unknown }).head;

    const event = await eventOfPayload("pull_request", payload);

    expect(event).toEqual({
      kind: "invalid_payload",
      reason: expect.stringContaining("pull_request.head.sha"),
    });
  });

  // CR-31-T14
  it("is invalid when the draft flag has the wrong type", async () => {
    expect(
      await eventOfPayload(
        "pull_request",
        pullRequestWith("pull_request.opened", {
          pullRequest: { draft: "yes" },
        }),
      ),
    ).toMatchObject({
      kind: "invalid_payload",
      reason: expect.stringContaining("pull_request.draft"),
    });
  });
});

describe("which comment authors can have write access", () => {
  // CR-32-T08
  it.each([
    ["OWNER", true],
    ["MEMBER", true],
    ["COLLABORATOR", true],
    ["CONTRIBUTOR", false],
    ["FIRST_TIME_CONTRIBUTOR", false],
    ["FIRST_TIMER", false],
    ["NONE", false],
    ["SOMETHING_NEW", false],
    ["owner", false],
    ["", false],
    [undefined, false],
    [null, false],
    [7, false],
  ])("answers %s with %s", (association, expected) => {
    expect(mayHaveWriteAccess(association)).toBe(expected);
  });
});

describe("the order in which a comment is looked at", () => {
  async function commentEvent(changes: {
    body: string;
    association?: string;
    senderType?: string;
  }) {
    const payload = webhookFixture("issue_comment.created.review") as Record<
      string,
      Record<string, unknown>
    >;
    payload.comment = {
      ...payload.comment,
      body: changes.body,
      author_association: changes.association ?? "COLLABORATOR",
    };
    if (changes.senderType !== undefined)
      payload.sender = { ...payload.sender, type: changes.senderType };
    return eventOfPayload("issue_comment", payload);
  }

  // CR-32-T09
  it("reads the text of nobody who cannot have write access", async () => {
    const event = await commentEvent({
      body: "plain words",
      association: "NONE",
    });

    expect(event).toEqual({
      kind: "ignored",
      reason: "the commenter cannot have write access",
    });
  });

  // CR-32-T10
  it("reads the text of no bot", async () => {
    const event = await commentEvent({
      body: "plain words",
      senderType: "Bot",
    });

    expect(event).toEqual({
      kind: "ignored",
      reason: "the comment was written by a bot",
    });
  });

  it("is quick for a hostile comment of a commenter who cannot have write access", async () => {
    const start = performance.now();
    await commentEvent({
      body: `/review ${"![".repeat(32_000)}`,
      association: "NONE",
    });

    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("which issue events start a workflow (#845)", () => {
  /** A recorded `issues.labeled` payload with other values at the given places. */
  function issuePayloadWith(
    changes: {
      action?: string;
      issue?: Record<string, unknown>;
      label?: unknown;
      sender?: Record<string, unknown>;
      drop?: string[];
    } = {},
  ) {
    const payload = webhookFixture("issues.labeled") as Record<
      string,
      unknown
    > & { issue: Record<string, unknown>; sender: Record<string, unknown> };
    const changed: Record<string, unknown> = {
      ...payload,
      ...(changes.action === undefined ? {} : { action: changes.action }),
      ...("label" in changes ? { label: changes.label } : {}),
      issue: { ...payload.issue, ...changes.issue },
      sender: { ...payload.sender, ...changes.sender },
    };
    for (const key of changes.drop ?? []) delete changed[key];
    return changed;
  }

  // #845-T01
  it("turns a label on an open issue into the issue, the label, the repository and who put it on", async () => {
    expect(await eventOf("issues.labeled")).toEqual({
      kind: "issue_labeled",
      labeled: {
        repo: {
          integrationId: "integration-1",
          externalId: "7001",
          fullName: "acme/widgets",
          url: "https://github.com/acme/widgets",
        },
        defaultBranch: "main",
        issue: {
          number: 12,
          title: "Cache the widget list",
          body: "The widget list is rebuilt on every request.\nCache it for a minute.",
          url: "https://github.com/acme/widgets/issues/12",
          labels: ["enhancement", "ready for agent"],
        },
        label: "ready for agent",
        actor: { login: "bob", externalId: "1002" },
      },
    });
  });

  // #845-T02
  it("reads an issue without a description as an empty body", async () => {
    expect(await eventOf("issues.labeled.no-body")).toMatchObject({
      kind: "issue_labeled",
      labeled: { issue: { body: "" } },
    });
    expect(
      await eventOfPayload(
        "issues",
        issuePayloadWith({ issue: { body: undefined } }),
      ),
    ).toMatchObject({
      kind: "issue_labeled",
      labeled: { issue: { body: "" } },
    });
  });

  // #845-T03
  it.each([
    ["a label on a pull request", "issues.labeled.pull-request"],
    ["a label put on by a bot (the App itself included)", "issues.labeled.bot"],
    ["a label on a closed issue", "issues.labeled.closed"],
    ["a label taken off", "issues.unlabeled"],
    ["a new issue", "issues.opened"],
  ])("starts nothing for %s", async (_name, fixture) => {
    expect(await eventOf(fixture)).toMatchObject({ kind: "ignored" });
  });

  // #845-T03a
  it.each(["Bot", "Organization", "Mannequin"])(
    "starts nothing for a label put on by a sender of the type %s, and starts for a User",
    async (type) => {
      expect(
        await eventOfPayload("issues", issuePayloadWith({ sender: { type } })),
      ).toMatchObject({ kind: "ignored" });
      expect(
        await eventOfPayload(
          "issues",
          issuePayloadWith({ sender: { type: "User" } }),
        ),
      ).toMatchObject({ kind: "issue_labeled" });
    },
  );

  // #845-T04
  it.each(["edited", "closed", "reopened", "assigned", "milestoned"])(
    "starts nothing for the action %s",
    async (action) => {
      expect(
        await eventOfPayload("issues", issuePayloadWith({ action })),
      ).toMatchObject({ kind: "ignored" });
    },
  );

  // #845-T05
  it("names the field, never its value, when the label is missing", async () => {
    for (const label of [undefined, {}, { name: "" }, { name: 3 }]) {
      const event = await eventOfPayload("issues", issuePayloadWith({ label }));
      expect(event).toEqual({
        kind: "invalid_payload",
        reason: expect.stringContaining("label.name"),
      });
    }
  });

  // #845-T06
  it("is invalid when a field the app reads is missing: the issue, the default branch or the sender", async () => {
    for (const drop of ["issue", "repository", "sender", "installation"]) {
      expect(
        await eventOfPayload("issues", issuePayloadWith({ drop: [drop] })),
      ).toMatchObject({ kind: "invalid_payload" });
    }
    expect(
      await eventOfPayload(
        "issues",
        issuePayloadWith({ issue: { labels: "enhancement" } }),
      ),
    ).toMatchObject({ kind: "invalid_payload" });
  });

  // #845-T07
  it("takes the names of the labels and leaves out an entry that has none", async () => {
    const event = await eventOfPayload(
      "issues",
      issuePayloadWith({
        issue: {
          labels: [{ name: "a" }, null, "b", { name: 3 }, {}, { name: "c" }],
        },
      }),
    );

    expect(event).toMatchObject({
      kind: "issue_labeled",
      labeled: { issue: { labels: ["a", "c"] } },
    });
  });
});

describe("a comment /answer on an issue or a pull request (#920)", () => {
  function answerPayload(
    fixture: "issue_comment.created.on-issue" | "issue_comment.created.review",
    changes: {
      body: string;
      association?: string;
      senderType?: string;
      issueState?: string;
      createdAt?: string;
    },
  ) {
    const payload = webhookFixture(fixture) as Record<
      string,
      Record<string, unknown>
    >;
    payload.comment = {
      ...payload.comment,
      body: changes.body,
      author_association: changes.association ?? "COLLABORATOR",
      ...(changes.createdAt === undefined
        ? {}
        : { created_at: changes.createdAt }),
    };
    if (changes.senderType !== undefined)
      payload.sender = { ...payload.sender, type: changes.senderType };
    if (changes.issueState !== undefined)
      payload.issue = { ...payload.issue, state: changes.issueState };
    return payload;
  }

  const asking = (writes: boolean | Error) => ({
    hasWriteAccess: async () => {
      if (writes instanceof Error) throw writes;
      return writes;
    },
    headShaOf: async () => {
      throw new Error("an answer needs no head commit");
    },
  });

  const parse = (payload: unknown, writes: boolean | Error = true) =>
    parseGithubEvent({
      integrationId: "integration-1",
      eventName: "issue_comment",
      payload,
      ...asking(writes),
    });

  // #920-T101
  it("is an answer when a commenter with write access writes /answer on an issue, open or not", async () => {
    for (const issueState of ["open", "closed"]) {
      const event = await parse(
        answerPayload("issue_comment.created.on-issue", {
          body: "/answer 2 and log it",
          issueState,
        }),
      );

      expect(event).toMatchObject({
        kind: "ticket_answer",
        answer: {
          choice: 2,
          text: "and log it",
          raw: "2 and log it",
          actor: { login: expect.any(String) as string },
        },
      });
      expect(isIntegrationEvent(event)).toBe(true);
    }
  });

  // #920-T102
  it("is an answer on an open pull request too, and /review there is still a review", async () => {
    const answer = await parse(
      answerPayload("issue_comment.created.review", {
        body: "/answer Use Redis.",
      }),
    );
    expect(answer).toMatchObject({
      kind: "ticket_answer",
      answer: { raw: "Use Redis." },
    });
    const review = await parseGithubEvent({
      integrationId: "integration-1",
      eventName: "issue_comment",
      payload: answerPayload("issue_comment.created.review", {
        body: "/review",
      }),
      hasWriteAccess: async () => true,
      headShaOf: async () => "a".repeat(40),
    });
    expect(review).toMatchObject({ kind: "review_trigger" });
  });

  // #920-T103
  it("is no answer from a bot, from a commenter who cannot have write access, or who has none", async () => {
    expect(
      await parse(
        answerPayload("issue_comment.created.on-issue", {
          body: "/answer 1",
          senderType: "Bot",
        }),
      ),
    ).toMatchObject({ kind: "ignored" });
    expect(
      await parse(
        answerPayload("issue_comment.created.on-issue", {
          body: "/answer 1",
          association: "NONE",
        }),
      ),
    ).toMatchObject({ kind: "ignored" });
    expect(
      await parse(
        answerPayload("issue_comment.created.on-issue", { body: "/answer 1" }),
        false,
      ),
    ).toEqual({ kind: "ignored", reason: "the commenter has no write access" });
    expect(
      await parse(
        answerPayload("issue_comment.created.review", { body: "/answer 1" }),
        false,
      ),
    ).toEqual({ kind: "ignored", reason: "the commenter has no write access" });
  });

  // #920-T104
  it("keeps an ordinary comment on an issue ignored, and asks nobody for permissions for it", async () => {
    const event = await parse(
      answerPayload("issue_comment.created.on-issue", { body: "thanks!" }),
      new Error("must not be asked"),
    );

    expect(event).toEqual({
      kind: "ignored",
      reason: "the comment is on an issue, not on a pull request",
    });
  });

  // #920-T105
  it("asks GitHub for write access only after the text said /answer", async () => {
    const event = await parse(
      answerPayload("issue_comment.created.on-issue", {
        body: "/answer\n",
      }),
      new Error("must not be asked"),
    );

    expect(event).toMatchObject({ kind: "ignored" });
  });

  // #920-T95
  it("is an answer on a closed pull request too, while a closed pull request still starts no review", async () => {
    const answer = await parse(
      answerPayload("issue_comment.created.review", {
        body: "/answer 1",
        issueState: "closed",
      }),
    );
    expect(answer).toMatchObject({
      kind: "ticket_answer",
      answer: { choice: 1 },
    });
    expect(isIntegrationEvent(answer)).toBe(true);

    expect(
      await parse(
        answerPayload("issue_comment.created.review", {
          body: "/review",
          issueState: "closed",
        }),
      ),
    ).toEqual({ kind: "ignored", reason: "the pull request is not open" });
    expect(
      await parse(
        answerPayload("issue_comment.created.review", {
          body: "/answer 1",
          issueState: "closed",
          senderType: "Bot",
        }),
      ),
    ).toEqual({ kind: "ignored", reason: "the pull request is not open" });
    expect(
      await parse(
        answerPayload("issue_comment.created.review", {
          body: "/answer 1",
          issueState: "closed",
        }),
        false,
      ),
    ).toEqual({ kind: "ignored", reason: "the commenter has no write access" });
  });

  // #920-T96
  it("carries the time the comment was written, when the delivery says", async () => {
    const event = await parse(
      answerPayload("issue_comment.created.on-issue", {
        body: "/answer 1",
        createdAt: "2026-11-07T09:30:00Z",
      }),
    );

    expect(event).toMatchObject({
      kind: "ticket_answer",
      answer: { createdAt: "2026-11-07T09:30:00Z" },
    });
    expect(isIntegrationEvent(event)).toBe(true);
  });
});
