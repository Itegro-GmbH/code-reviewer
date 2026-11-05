// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the runtime guards for the normalized types. They are what keeps a raw platform payload
// from travelling through the app disguised as a RepoRef, ReviewTrigger or GitAccess.
import { describe, expect, it } from "vitest";
import {
  createGitAccess,
  isGitAccess,
  isIntegrationEvent,
  isPullRequestRef,
  isRepoRef,
  isReviewTrigger,
  revealGitAccess,
} from "./normalized.ts";
import type {
  GitAccess,
  PullRequestRef,
  RepoRef,
  ReviewTrigger,
} from "./types.ts";

const repo: RepoRef = {
  integrationId: "int-1",
  externalId: "42",
  fullName: "acme/widgets",
  url: "https://example.test/acme/widgets",
};

const opened: ReviewTrigger = {
  kind: "opened",
  repo,
  prNumber: 7,
  prUrl: "https://example.test/acme/widgets/pull/7",
  headSha: "abc123",
  command: null,
  args: null,
  actor: { login: "alice", externalId: "1" },
  draft: false,
  state: "open",
};

/** A command trigger: it knows nothing about drafts or the state of the pull request. */
const openedFields = {
  repo,
  prNumber: 7,
  prUrl: "https://example.test/acme/widgets/pull/7",
  headSha: "abc123",
  command: null,
  args: null,
  actor: { login: "alice", externalId: "1" },
};
const commandTrigger: ReviewTrigger = {
  ...openedFields,
  kind: "command",
  command: "review",
  args: "",
  commentId: "99001",
};

const accessFields: GitAccess = {
  provider: "github",
  baseUrl: "https://api.example.test",
  token: "dummy-token",
  authType: "token",
  botLogin: "reviewer[bot]",
  expiresAt: "2026-10-10T13:00:00.000Z",
};
const makeAccess = (overrides: Partial<GitAccess> = {}) =>
  createGitAccess({ ...accessFields, ...overrides });

const pullRequest: PullRequestRef = {
  number: 7,
  title: "Add widgets",
  url: "https://example.test/acme/widgets/pull/7",
  headSha: "abc123",
  baseRef: "main",
  headRef: "feature",
  draft: false,
  state: "open",
  author: { login: "alice", externalId: "1" },
};

describe("the normalized type guards", () => {
  it("accepts a well formed repo reference", () => {
    expect(isRepoRef(repo)).toBe(true);
  });

  it("rejects a repo reference with a missing field, a wrong type or an extra platform field", () => {
    expect(isRepoRef({ ...repo, fullName: undefined })).toBe(false);
    expect(isRepoRef({ ...repo, externalId: 42 })).toBe(false);
    expect(isRepoRef({ ...repo, node_id: "MDEwOlJlcG9zaXRvcnkx" })).toBe(false);
    expect(isRepoRef(null)).toBe(false);
  });

  it("accepts opened, updated and command triggers", () => {
    expect(isReviewTrigger(opened)).toBe(true);
    expect(isReviewTrigger({ ...opened, kind: "updated" })).toBe(true);
    expect(isReviewTrigger(commandTrigger)).toBe(true);
  });

  it("requires a command trigger to name its comment", () => {
    expect(isReviewTrigger({ ...commandTrigger, commentId: undefined })).toBe(
      false,
    );
    expect(isReviewTrigger({ ...commandTrigger, commentId: "" })).toBe(false);
    expect(isReviewTrigger({ ...commandTrigger, commentId: 99001 })).toBe(
      false,
    );
  });

  it("requires a pull request trigger to say whether the pull request is a draft and open", () => {
    expect(isReviewTrigger({ ...opened, draft: undefined })).toBe(false);
    expect(isReviewTrigger({ ...opened, draft: "no" })).toBe(false);
    expect(isReviewTrigger({ ...opened, state: "merged" })).toBe(false);
    expect(isReviewTrigger({ ...openedFields })).toBe(false);
    expect(isReviewTrigger({ ...commandTrigger, draft: false })).toBe(false);
  });

  it("rejects a trigger whose kind and command do not fit together", () => {
    expect(isReviewTrigger({ ...opened, command: "review", args: "" })).toBe(
      false,
    );
    expect(isReviewTrigger({ ...openedFields, kind: "command" })).toBe(false);
    expect(
      isReviewTrigger({ ...commandTrigger, command: "deploy", args: "" }),
    ).toBe(false);
    expect(isReviewTrigger({ ...opened, kind: "labeled" })).toBe(false);
  });

  it("rejects a trigger with a bad pull request number, a nested raw payload or an extra field", () => {
    expect(isReviewTrigger({ ...opened, prNumber: 0 })).toBe(false);
    expect(isReviewTrigger({ ...opened, prNumber: 1.5 })).toBe(false);
    expect(isReviewTrigger({ ...opened, repo: { ...repo, owner: {} } })).toBe(
      false,
    );
    expect(isReviewTrigger({ ...opened, payload: { action: "opened" } })).toBe(
      false,
    );
  });

  it("rejects a trigger without a pull request url", () => {
    expect(isReviewTrigger({ ...opened, prUrl: "" })).toBe(false);
  });

  it("accepts git access with and without a bot login or an expiry", () => {
    expect(isGitAccess(makeAccess())).toBe(true);
    expect(isGitAccess(makeAccess({ botLogin: null, expiresAt: null }))).toBe(
      true,
    );
  });

  it("rejects git access with an unknown platform or auth type, an empty token or an extra field", () => {
    expect(isGitAccess(makeAccess({ provider: "svn" as never }))).toBe(false);
    expect(isGitAccess(makeAccess({ authType: "basic" as never }))).toBe(false);
    expect(isGitAccess(makeAccess({ token: "" }))).toBe(false);
    expect(
      isGitAccess(Object.assign(makeAccess(), { installationId: 9 })),
    ).toBe(false);
  });

  it("rejects git access whose token is a plain visible field", () => {
    expect(isGitAccess({ ...accessFields })).toBe(false);
  });

  it("accepts a pull request reference and rejects an incomplete or unknown-state one", () => {
    expect(isPullRequestRef(pullRequest)).toBe(true);
    expect(isPullRequestRef({ ...pullRequest, state: "merged" })).toBe(true);
    expect(isPullRequestRef({ ...pullRequest, state: "locked" })).toBe(false);
    expect(isPullRequestRef({ ...pullRequest, draft: "no" })).toBe(false);
    expect(isPullRequestRef({ ...pullRequest, number: 0 })).toBe(false);
    expect(isPullRequestRef({ ...pullRequest, base: { ref: "main" } })).toBe(
      false,
    );
  });

  it("accepts the three kinds of integration event and rejects a malformed one", () => {
    expect(
      isIntegrationEvent({ kind: "review_trigger", trigger: opened }),
    ).toBe(true);
    expect(
      isIntegrationEvent({
        kind: "installation_changed",
        externalId: "9",
        action: "deleted",
      }),
    ).toBe(true);
    expect(isIntegrationEvent({ kind: "ignored", reason: "closed" })).toBe(
      true,
    );
    expect(
      isIntegrationEvent({
        kind: "pull_request_closed",
        repo,
        prNumber: 7,
        merged: true,
      }),
    ).toBe(true);
    expect(
      isIntegrationEvent({ kind: "invalid_payload", reason: "no head" }),
    ).toBe(true);
    expect(
      isIntegrationEvent({ kind: "pull_request_drafted", repo, prNumber: 7 }),
    ).toBe(true);
    expect(
      isIntegrationEvent({ kind: "pull_request_drafted", repo, prNumber: 0 }),
    ).toBe(false);

    // #845-T08
    const labeled = {
      repo,
      defaultBranch: "main",
      issue: {
        number: 12,
        title: "Cache",
        body: "",
        url: "https://github.test/acme/widgets/issues/12",
        labels: ["a"],
      },
      label: "a",
      actor: { login: "bob", externalId: "1002" },
    };
    expect(isIntegrationEvent({ kind: "issue_labeled", labeled })).toBe(true);
    expect(
      isIntegrationEvent({
        kind: "issue_labeled",
        labeled: { ...labeled, issue: { ...labeled.issue, number: 0 } },
      }),
    ).toBe(false);
    expect(
      isIntegrationEvent({
        kind: "issue_labeled",
        labeled: { ...labeled, issue: { ...labeled.issue, labels: [1] } },
      }),
    ).toBe(false);
    expect(
      isIntegrationEvent({
        kind: "issue_labeled",
        labeled: { ...labeled, label: "" },
      }),
    ).toBe(false);
    expect(
      isIntegrationEvent({
        kind: "issue_labeled",
        labeled: { ...labeled, raw: {} },
      }),
    ).toBe(false);

    expect(
      isIntegrationEvent({
        kind: "pull_request_closed",
        repo,
        prNumber: 0,
        merged: true,
      }),
    ).toBe(false);
    expect(
      isIntegrationEvent({ kind: "pull_request_closed", repo, prNumber: 7 }),
    ).toBe(false);
    expect(isIntegrationEvent({ kind: "invalid_payload" })).toBe(false);
    expect(isIntegrationEvent(opened)).toBe(false);
    expect(isIntegrationEvent({ kind: "review_trigger", trigger: {} })).toBe(
      false,
    );
    expect(
      isIntegrationEvent({
        kind: "installation_changed",
        externalId: "9",
        action: "renamed",
      }),
    ).toBe(false);
    expect(isIntegrationEvent({ kind: "ignored" })).toBe(false);
  });
});

describe("git access and its token", () => {
  it("leaves the token out of JSON, spreads, entries and console output", async () => {
    const { inspect } = await import("node:util");
    const access = makeAccess({ token: "ghs_dummy_token_value" });

    expect(JSON.stringify(access)).not.toContain("ghs_dummy_token_value");
    expect(JSON.stringify({ ...access })).not.toContain(
      "ghs_dummy_token_value",
    );
    expect(Object.entries(access).flat()).not.toContain(
      "ghs_dummy_token_value",
    );
    expect(inspect(access)).not.toContain("ghs_dummy_token_value");
  });

  it("still lets the code read the token", () => {
    expect(makeAccess({ token: "abc" }).token).toBe("abc");
  });

  it("hands the token out only through the explicit reveal for the runner API", () => {
    const revealed = revealGitAccess(makeAccess({ token: "abc" }));

    expect(JSON.parse(JSON.stringify(revealed))).toEqual({
      ...accessFields,
      token: "abc",
    });
  });
});

describe("revealing git access without a token", () => {
  // CR-23 (lead decision): a missing or empty token is a stable error, never an empty string sent on.
  it("throws a stable code when the token is missing or empty", () => {
    const withoutToken = { ...accessFields } as Partial<GitAccess>;
    delete withoutToken.token;

    for (const access of [
      createGitAccess({ ...accessFields, token: "" }),
      withoutToken as GitAccess,
    ])
      expect(() => revealGitAccess(access)).toThrow(
        expect.objectContaining({ code: "INTEGRATION_ACCESS_TOKEN_MISSING" }),
      );
  });
});
