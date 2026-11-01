// SPDX-License-Identifier: LicenseRef-Proprietary

// The implementer variant of the Runs views (#758, part of #745): a turn of the Implementer is a job with a repository, a base
// branch, a branch, an instruction and commits, not a pull request. The views carry exactly the listed fields, all text from the
// task, the commits and the agent is cleaned and cut, the links are made only from the repository's own https url, and the views
// of Diff and Dynamic runs are not changed by any of it.
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../integrations/types.ts";
import type { Job } from "../jobs/job-types.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import { describeTurnErrorCode, errorCopy } from "./error-copy.ts";
import {
  cleanLog,
  githubBranchUrl,
  githubCommitUrl,
  toCustomerRunDetailView,
  toRunDetailView,
  toRunRowView,
  type ImplementerDetailSource,
} from "./run-view.ts";

const PRODUCT = getProductIdentity();
const NOW = new Date("2026-10-10T12:10:00.000Z");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

const GIT_TOKEN = ["ghs", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
const LEASE = "lease-token-secret";
const RUNNER = "runner-secret-name";
const DELIVERY = "implementer:workspace-1:request-1";

function turn(overrides: Partial<Job> = {}): Job {
  return {
    id: "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11",
    workspaceId: "workspace-1",
    repositoryId: "repo-1",
    prNumber: -1,
    prUrl: "https://github.com/acme/widgets/tree/implementer/abc123",
    headSha: SHA_A,
    reviewKind: "implementer",
    command: "review",
    args: "",
    triggerKind: "manual",
    actorLogin: "octocat",
    deliveryId: DELIVERY,
    status: "succeeded",
    runAfter: "2026-10-10T12:00:00.000Z",
    attempts: 0,
    runnerId: RUNNER,
    claimedAt: "2026-10-10T12:00:10.000Z",
    heartbeatAt: "2026-10-10T12:00:40.000Z",
    leaseExpiresAt: "2026-10-10T12:02:40.000Z",
    result: null,
    errorCode: null,
    supersededBy: null,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:01:00.000Z",
    finishedAt: "2026-10-10T12:01:00.000Z",
    ...overrides,
  };
}

function source(
  overrides: Partial<ImplementerDetailSource> = {},
): ImplementerDetailSource {
  return {
    branch: "implementer/abc123",
    baseBranch: "main",
    instruction: "Add a health endpoint.",
    repositoryUrl: "https://github.com/acme/widgets",
    ...overrides,
  };
}

function resultWith(
  block: Record<string, JsonValue>,
  more: Record<string, JsonValue> = {},
): JsonValue {
  return {
    ok: true,
    commentUrl: null,
    logTail: "",
    logTruncated: false,
    implementer: {
      baseCommit: SHA_A,
      headCommit: SHA_B,
      pushed: true,
      commits: [{ sha: SHA_B, subject: "Add a health endpoint" }],
      filesChanged: [{ path: "src/health.ts", status: "added" }],
      summary: "Added a health endpoint.",
      opencode: { sessionId: "ses_1", version: "1.19.0" },
      ...block,
    },
    ...more,
  };
}

const view = (job: Job, implementer: ImplementerDetailSource | null) =>
  toRunDetailView(
    PRODUCT,
    job,
    "acme/widgets",
    NOW,
    undefined,
    false,
    implementer,
  );

describe("the row of an implementer run", () => {
  // #758-T01
  it("names the repository and the branch with a link to it, and has no pull request number or link", () => {
    const row = toRunRowView(PRODUCT, turn(), "acme/widgets", NOW, {
      branch: "implementer/abc123",
      repositoryUrl: "https://github.com/acme/widgets",
    });

    expect(row).toMatchObject({
      project: "acme/widgets",
      reviewKind: "implementer",
      status: "succeeded",
      startedAt: "2026-10-10T12:00:10.000Z",
      durationMs: 50_000,
      prUrl: null,
      implementer: {
        branch: "implementer/abc123",
        branchUrl: "https://github.com/acme/widgets/tree/implementer/abc123",
      },
    });
  });

  // #758-T01
  it("takes the placeholder pull request address of the job for nothing: the link is made from the repository url", () => {
    const row = toRunRowView(
      PRODUCT,
      turn({ prUrl: "https://github.com/evil/other/tree/x" }),
      "acme/widgets",
      NOW,
      {
        branch: "implementer/abc123",
        repositoryUrl: "https://github.com/acme/widgets",
      },
    );

    expect(row.prUrl).toBeNull();
    expect(row.implementer?.branchUrl).toBe(
      "https://github.com/acme/widgets/tree/implementer/abc123",
    );
  });

  // #758-T01
  it("still has the implementer variant when the turn of the job cannot be read, without a branch", () => {
    const row = toRunRowView(PRODUCT, turn(), "acme/widgets", NOW);

    expect(row.implementer).toEqual({ branch: null, branchUrl: null });
  });

  // #758-T09
  it("leaves the row of a Diff or Dynamic run exactly as it was: no implementer key", () => {
    for (const reviewKind of ["diff", "dynamic"] as const) {
      const row = toRunRowView(
        PRODUCT,
        turn({
          reviewKind,
          prNumber: 7,
          prUrl: "https://github.com/acme/widgets/pull/7",
        }),
        "acme/widgets",
        NOW,
      );

      expect("implementer" in row).toBe(false);
      expect(row.prUrl).toBe("https://github.com/acme/widgets/pull/7");
    }
  });

  // #758-T03
  it("words a failed row with the sentence for a task, which promises no pull request and no new run on the next push", () => {
    const row = toRunRowView(
      PRODUCT,
      turn({ status: "failed", errorCode: "time_limit_reached" }),
      "acme/widgets",
      NOW,
    );

    expect(row.problem).toMatch(/time limit/);
    expect(row.problem).not.toMatch(/pull request|next push|review/i);
  });
});

describe("the detail of an implementer run", () => {
  // #758-T02
  it("holds the base branch, the branch with its link, the instruction, the commits, the number of files and the summary", () => {
    const run = view(
      turn({
        result: resultWith({
          commits: [
            { sha: SHA_B, subject: "Add a health endpoint" },
            { sha: SHA_C, subject: "Test the health endpoint" },
          ],
          filesChanged: [
            { path: "src/health.ts", status: "added" },
            { path: "src/health.test.ts", status: "added" },
            { path: "README.md", status: "modified" },
          ],
          headCommit: SHA_C,
        }),
      }),
      source(),
    ).implementer;

    expect(run).toMatchObject({
      branch: "implementer/abc123",
      branchUrl: "https://github.com/acme/widgets/tree/implementer/abc123",
      baseBranch: "main",
      instruction: { preview: "Add a health endpoint.", full: null },
      summary: "Added a health endpoint.",
      commits: {
        shown: [
          {
            shortSha: SHA_B.slice(0, 7),
            subject: "Add a health endpoint",
            url: `https://github.com/acme/widgets/commit/${SHA_B}`,
          },
          {
            shortSha: SHA_C.slice(0, 7),
            subject: "Test the health endpoint",
            url: `https://github.com/acme/widgets/commit/${SHA_C}`,
          },
        ],
        more: 0,
      },
      files: { count: 3, more: 0 },
      head: {
        shortSha: SHA_C.slice(0, 7),
        url: `https://github.com/acme/widgets/commit/${SHA_C}`,
      },
    });
    expect(run?.files.shown.map((file) => file.path)).toEqual([
      "src/health.ts",
      "src/health.test.ts",
      "README.md",
    ]);
  });

  // #758-T02
  it("shows the first 20 commits and says how many more there are", () => {
    const commits = Array.from({ length: 27 }, (_, index) => ({
      sha: index.toString(16).padStart(40, "0"),
      subject: `Commit ${String(index)}`,
    }));

    const run = view(
      turn({ result: resultWith({ commits }) }),
      source(),
    ).implementer;

    expect(run?.commits.shown).toHaveLength(20);
    expect(run?.commits.shown[19]?.subject).toBe("Commit 19");
    expect(run?.commits.more).toBe(7);
  });

  // #758-T02
  it("cuts the instruction at 500 characters and keeps the whole text for the expander", () => {
    const instruction = `${"Refactor the parser. ".repeat(60)}END`;

    const shown = view(turn(), source({ instruction })).implementer
      ?.instruction;

    expect(shown?.preview).toHaveLength(500);
    expect(instruction.startsWith(shown?.preview ?? "?")).toBe(true);
    expect(shown?.full).toBe(instruction);
  });

  // #758-T02
  it("reads the model and the usage of the result like those of a Dynamic Review", () => {
    const run = view(
      turn({
        result: resultWith(
          {},
          {
            usage: {
              model: "vendor/coder",
              totalTokens: 52_000,
              aiCalls: 31,
              costUsd: 0.42,
            },
          },
        ),
      }),
      source(),
    );

    expect(run.usage).toMatchObject({
      model: "vendor/coder",
      totalTokens: 52_000,
      aiCalls: 31,
      costUsd: 0.42,
    });
    expect(run.implementer).toBeDefined();
    expect(run.commentMissing).toBe(false);
    expect(run.commentUrl).toBeNull();
  });

  // #758-T02
  it("has an empty variant, not a missing one, for a turn that has no result yet", () => {
    const run = view(
      turn({ status: "running", result: null, finishedAt: null }),
      source(),
    ).implementer;

    expect(run).toMatchObject({
      commits: { shown: [], more: 0 },
      files: { count: 0, shown: [], more: 0 },
      summary: null,
      head: null,
      pushedNote: null,
    });
  });

  // #758-T03
  it("says for a failed turn that pushed work how many commits are on the branch, and links the pushed head", () => {
    const run = view(
      turn({ status: "failed", errorCode: "cost_limit_reached" }),
      source(),
    );
    const withWork = view(
      turn({
        status: "failed",
        errorCode: "cost_limit_reached",
        result: resultWith({
          commits: [
            { sha: SHA_B, subject: "First" },
            { sha: SHA_C, subject: "Second" },
          ],
          headCommit: SHA_C,
        }),
      }),
      source(),
    );

    expect(run.implementer?.pushedNote).toBeNull();
    expect(withWork.implementer?.pushedNote).toBe(
      "2 commits were pushed to implementer/abc123.",
    );
    expect(withWork.implementer?.head).toEqual({
      shortSha: SHA_C.slice(0, 7),
      url: `https://github.com/acme/widgets/commit/${SHA_C}`,
    });
    expect(withWork.problem).toMatch(/cost limit/);
    expect(withWork.errorCode).toBe("cost_limit_reached");
  });

  // #758-T03
  it("says '1 commit was pushed' for one, and says nothing of a failed turn whose commits were not pushed", () => {
    const one = view(
      turn({
        status: "failed",
        errorCode: "time_limit_reached",
        result: resultWith({ headCommit: SHA_B }),
      }),
      source(),
    );
    const notPushed = view(
      turn({
        status: "failed",
        errorCode: "push_rejected",
        result: resultWith({ pushed: false, headCommit: null }),
      }),
      source(),
    );

    expect(one.implementer?.pushedNote).toBe(
      "1 commit was pushed to implementer/abc123.",
    );
    expect(notPushed.implementer?.pushedNote).toBeNull();
    expect(notPushed.implementer?.head).toBeNull();
    // The commits exist in the work area, not on GitHub: listed, but not linked.
    expect(notPushed.implementer?.commits.shown[0]).toMatchObject({
      subject: "Add a health endpoint",
      url: null,
    });
  });

  // #758-T03
  it("has no pushed-work sentence for a turn that succeeded", () => {
    expect(
      view(turn({ result: resultWith({}) }), source()).implementer?.pushedNote,
    ).toBeNull();
  });

  // #758-T04
  it("cleans control characters, escapes and bidi marks from the instruction, the summary, the subjects and the paths", () => {
    const dirty = "ok\u0000\u001b[31m red\u001b[0m\u0007‮ evil⁦";
    const run = view(
      turn({
        result: resultWith({
          summary: `${dirty}\nsecond line`,
          commits: [{ sha: SHA_B, subject: `${dirty}\nnot a second subject` }],
          filesChanged: [{ path: `src/${dirty}.ts`, status: "modified" }],
        }),
      }),
      source({ instruction: dirty }),
    ).implementer;

    expect(run?.instruction.preview).toBe("ok red evil");
    expect(run?.summary).toBe("ok red evil\nsecond line");
    expect(run?.commits.shown[0]?.subject).toBe(
      "ok red evil not a second subject",
    );
    expect(run?.files.shown[0]?.path).toBe("src/ok red evil.ts");
  });

  // #758-T04
  it("keeps HTML and markdown links in the text as they are: the page renders text", () => {
    const hostile =
      '<img src=x onerror="alert(1)"> [click](javascript:alert(1))';
    const run = view(
      turn({
        result: resultWith({
          summary: hostile,
          commits: [{ sha: SHA_B, subject: hostile }],
        }),
      }),
      source({ instruction: hostile }),
    ).implementer;

    expect(run?.summary).toBe(hostile);
    expect(run?.commits.shown[0]?.subject).toBe(hostile);
    expect(run?.instruction.preview).toBe(hostile);
  });

  // #758-T04
  it("cuts text of a megabyte to the limits of the contract", () => {
    const huge = "x".repeat(1_000_000);
    const run = view(
      turn({
        result: resultWith({
          summary: huge,
          commits: [{ sha: SHA_B, subject: huge }],
          filesChanged: [{ path: huge, status: "added" }],
        }),
      }),
      source({ instruction: huge }),
    ).implementer;

    expect(run?.summary).toHaveLength(8192);
    expect(run?.commits.shown[0]?.subject.length).toBeLessThanOrEqual(500);
    expect(run?.files.shown[0]?.path.length).toBeLessThanOrEqual(300);
    expect(run?.instruction.preview).toHaveLength(500);
    expect(run?.instruction.full?.length).toBe(20_000);
  });

  // #758-T04
  it("takes the known secrets out of the summary, the subjects and the paths, and never names a provider on a managed key", () => {
    const redact = (text: string) => text.replaceAll(GIT_TOKEN, "[redacted]");
    const run = toRunDetailView(
      PRODUCT,
      turn({
        result: resultWith({
          summary: `token ${GIT_TOKEN}`,
          commits: [{ sha: SHA_B, subject: `uses ${GIT_TOKEN}` }],
          filesChanged: [{ path: `${GIT_TOKEN}.txt`, status: "added" }],
        }),
      }),
      "acme/widgets",
      NOW,
      redact,
      true,
      source(),
    ).implementer;

    expect(JSON.stringify(run)).not.toContain(GIT_TOKEN);
    expect(run?.summary).toBe("token [redacted]");
  });

  // #758-T05
  it("serialises to exactly the listed fields: no lease token, runner id, delivery id, git token or key", () => {
    const failed = turn({
      status: "failed",
      errorCode: "push_rejected",
      result: resultWith(
        {},
        {
          logTail: `log with ${GIT_TOKEN}`,
          usage: { model: "m", totalTokens: 1, aiCalls: 1, costUsd: 0.1 },
        },
      ),
    });

    const row = toRunRowView(PRODUCT, failed, "acme/widgets", NOW, {
      branch: "implementer/abc123",
      repositoryUrl: "https://github.com/acme/widgets",
    });
    const detail = toCustomerRunDetailView(
      PRODUCT,
      failed,
      "acme/widgets",
      NOW,
      (text) => text.replaceAll(GIT_TOKEN, "[redacted]"),
      false,
      null,
      source(),
    );
    const serialised = JSON.stringify([row, detail]);

    for (const secret of [LEASE, RUNNER, DELIVERY, GIT_TOKEN]) {
      expect(serialised).not.toContain(secret);
    }
    expect(Object.keys(detail.implementer ?? {}).sort()).toEqual(
      [
        "baseBranch",
        "branch",
        "branchUrl",
        "commits",
        "files",
        "head",
        "instruction",
        "pushedNote",
        "reported",
        "summary",
      ].sort(),
    );
    expect(Object.keys(row.implementer ?? {}).sort()).toEqual([
      "branch",
      "branchUrl",
    ]);
    // The OpenCode session of the result and the base commit stay on the server.
    expect(serialised).not.toContain("ses_1");
    expect(serialised).not.toContain("opencode");
    // A member never receives the log of the runner.
    expect(serialised).not.toContain("log with");
  });

  // #758-T05
  it("reads only well-formed commits, files and a summary of the stored block", () => {
    const run = view(
      turn({
        result: resultWith({
          commits: [
            { sha: "not-a-sha", subject: "bad sha" },
            { sha: SHA_B, subject: 42 },
            { sha: SHA_C, subject: "good" },
            "nonsense",
          ] as unknown as JsonValue,
          filesChanged: [
            { path: "ok.ts", status: "added" },
            { path: "weird.ts", status: "exploded" },
            { path: 7, status: "added" },
          ] as unknown as JsonValue,
          summary: 12 as unknown as JsonValue,
          headCommit: "<script>" as unknown as JsonValue,
        }),
      }),
      source(),
    ).implementer;

    expect(run?.commits.shown.map((commit) => commit.subject)).toEqual([
      "good",
    ]);
    expect(run?.files.shown.map((file) => file.path)).toEqual(["ok.ts"]);
    expect(run?.summary).toBeNull();
    expect(run?.head).toBeNull();
  });

  // #758-T09
  it("leaves the detail of a Diff or Dynamic run exactly as it was: no implementer key", () => {
    for (const reviewKind of ["diff", "dynamic"] as const) {
      const run = toRunDetailView(
        PRODUCT,
        turn({
          reviewKind,
          prNumber: 7,
          prUrl: "https://github.com/acme/widgets/pull/7",
          result: resultWith({}),
        }),
        "acme/widgets",
        NOW,
      );

      expect("implementer" in run).toBe(false);
      expect(run.commentMissing).toBe(true);
    }
  });
});

describe("the links of an implementer run", () => {
  // #758-T06
  it("builds the branch link from the repository url and the branch name, each part of a name with a slash encoded", () => {
    expect(
      githubBranchUrl("https://github.com/acme/widgets", "implementer/abc123"),
    ).toBe("https://github.com/acme/widgets/tree/implementer/abc123");
    expect(
      githubBranchUrl("https://github.com/acme/widgets/", "feature/a b#c?d%e"),
    ).toBe("https://github.com/acme/widgets/tree/feature/a%20b%23c%3Fd%25e");
  });

  // #758-T06
  it("gives no link for a repository url that is not the https url of a repository on github.com", () => {
    for (const url of [
      "http://github.com/acme/widgets",
      "https://evil.example/acme/widgets",
      "https://github.com.evil.example/acme/widgets",
      "https://user:pw@github.com/acme/widgets",
      "https://github.com:8443/acme/widgets",
      "https://github.com/acme",
      "https://github.com/acme/widgets/pull/7",
      "https://github.com/acme/widgets?x=1",
      "https://github.com/acme/widgets#top",
      "javascript:alert(1)",
      "git@github.com:acme/widgets.git",
      "",
    ]) {
      expect(githubBranchUrl(url, "main"), url).toBeNull();
      expect(githubCommitUrl(url, SHA_B), url).toBeNull();
    }
  });

  // #758-T06
  it("gives no link for a branch name that would leave the tree path, and none for a sha that is not one", () => {
    for (const branch of [
      "../../evil",
      "a/../../b",
      "a//b",
      "./x",
      "",
      "a/.",
    ]) {
      expect(
        githubBranchUrl("https://github.com/acme/widgets", branch),
        branch,
      ).toBeNull();
    }
    expect(
      githubCommitUrl("https://github.com/acme/widgets", "../evil"),
    ).toBeNull();
    expect(
      githubCommitUrl("https://github.com/acme/widgets", "abc"),
    ).toBeNull();
    expect(
      githubCommitUrl("https://github.com/acme/widgets", SHA_B.toUpperCase()),
    ).toBe(`https://github.com/acme/widgets/commit/${SHA_B.toUpperCase()}`);
  });
});

// The review of #792: the cases a mutant of the implementer variant passed.
const INVISIBLE = "\u200b\u200c\u200d\u200e\u200f\u061c\ufeff";
const redactToken = (text: string) => text.replaceAll(GIT_TOKEN, "[redacted]");
const detailOf = (
  job: Job,
  implementer: ImplementerDetailSource | null,
  options: { redact?: (text: string) => string; managed?: boolean } = {},
) =>
  toRunDetailView(
    PRODUCT,
    job,
    "acme/widgets",
    NOW,
    options.redact,
    options.managed ?? false,
    implementer,
  );

describe("whether a task reported its result", () => {
  // #758-T02 (review of #792, 1)
  it("tells a result without an implementer block from a block that is empty", () => {
    const reportedEmpty = detailOf(
      turn({
        result: resultWith({
          commits: [],
          filesChanged: [],
          summary: "",
          headCommit: null,
          pushed: false,
        }),
      }),
      source(),
    ).implementer;
    const none = detailOf(
      turn({ status: "failed", errorCode: "lease_lost", result: null }),
      source(),
    ).implementer;
    const noBlock = detailOf(
      turn({
        status: "failed",
        errorCode: "runner_error",
        result: { ok: false, commentUrl: null, logTail: "" },
      }),
      source(),
    ).implementer;
    const garbage = detailOf(
      turn({ result: { implementer: "nonsense" } }),
      source(),
    ).implementer;

    expect(reportedEmpty?.reported).toBe(true);
    expect(none?.reported).toBe(false);
    expect(noBlock?.reported).toBe(false);
    expect(garbage?.reported).toBe(false);
  });
});

describe("the text of a task is stripped of invisible characters", () => {
  // #758-T04 (review of #792, 5)
  it("removes zero-width and direction marks from every field of the variant", () => {
    const dirty = `a${INVISIBLE}b`;
    const run = detailOf(
      turn({
        result: resultWith({
          summary: `sum${INVISIBLE}mary`,
          commits: [{ sha: SHA_B, subject: dirty }],
          filesChanged: [{ path: `src/${dirty}.ts`, status: "added" }],
        }),
      }),
      source({
        branch: `feat/${dirty}`,
        baseBranch: `base${INVISIBLE}`,
        instruction: `do${INVISIBLE}it`,
      }),
    ).implementer;
    const row = toRunRowView(PRODUCT, turn(), "acme/widgets", NOW, {
      branch: `feat/${dirty}`,
      repositoryUrl: "https://github.com/acme/widgets",
    });

    expect(run?.summary).toBe("summary");
    expect(run?.commits.shown[0]?.subject).toBe("ab");
    expect(run?.files.shown[0]?.path).toBe("src/ab.ts");
    expect(run?.branch).toBe("feat/ab");
    expect(run?.baseBranch).toBe("base");
    expect(run?.instruction.preview).toBe("doit");
    expect(row.implementer?.branch).toBe("feat/ab");
  });

  // #758-T09
  it("leaves the cleaner of the logs and reviews as it was", () => {
    expect(cleanLog(`a${INVISIBLE}b`)).toBe(`a${INVISIBLE}b`);
  });
});

describe("the branch names of a task are text from outside", () => {
  // #758-T04 (review of #792, 4, 7)
  it("cleans, redacts and, on the operator's key, masks the branch and the base branch for display, and links the raw branch", () => {
    const dirty = `x\u001b[31m${GIT_TOKEN}\u0000/anthropic-fix\u202e`;
    const run = detailOf(turn(), source({ branch: dirty, baseBranch: dirty }), {
      redact: redactToken,
      managed: true,
    }).implementer;

    expect(run?.branch).toBe("x[redacted]/[provider]-fix");
    expect(run?.baseBranch).toBe("x[redacted]/[provider]-fix");
    expect(run?.pushedNote).toBeNull();
    // The link is made from the raw name, encoded.
    expect(run?.branchUrl).toContain("/tree/");
  });

  // #758-T04, mutant "branch not cleaned"
  it("cleans the branch of a row and of a detail (control characters, escapes, bidi marks)", () => {
    const dirty = "feat/\u001b[31mred\u0000\u202e";
    const row = toRunRowView(PRODUCT, turn(), "acme/widgets", NOW, {
      branch: dirty,
      repositoryUrl: "https://github.com/acme/widgets",
    });
    const detail = detailOf(
      turn(),
      source({ branch: dirty, baseBranch: dirty }),
    );

    expect(row.implementer?.branch).toBe("feat/red");
    expect(detail.implementer?.branch).toBe("feat/red");
    expect(detail.implementer?.baseBranch).toBe("feat/red");
  });

  // #758-T04
  it("redacts the branch of a row when the service hands the redaction in", () => {
    const row = toRunRowView(
      PRODUCT,
      turn(),
      "acme/widgets",
      NOW,
      {
        branch: `b-${GIT_TOKEN}`,
        repositoryUrl: "https://github.com/acme/widgets",
      },
      redactToken,
    );

    expect(row.implementer?.branch).toBe("b-[redacted]");
  });

  // #758-T04
  it("names the displayed branch in the pushed-work sentence", () => {
    const run = detailOf(
      turn({
        status: "failed",
        errorCode: "time_limit_reached",
        result: resultWith({}),
      }),
      source({ branch: `b-${GIT_TOKEN}` }),
      { redact: redactToken },
    ).implementer;

    expect(run?.pushedNote).toBe("1 commit was pushed to b-[redacted].");
  });
});

describe("secrets and providers in the text of a task", () => {
  // #758-T04, mutant "no redaction on the instruction"
  it("redacts known secrets from the instruction, the preview and the whole text", () => {
    const instruction = `${"fix it. ".repeat(100)}use ${GIT_TOKEN}`;
    const run = detailOf(turn(), source({ instruction }), {
      redact: redactToken,
    }).implementer;

    expect(run?.instruction.full).not.toContain(GIT_TOKEN);
    expect(run?.instruction.full).toContain("[redacted]");
    const short = detailOf(
      turn(),
      source({ instruction: `use ${GIT_TOKEN}` }),
      {
        redact: redactToken,
      },
    ).implementer;
    expect(short?.instruction.preview).toBe("use [redacted]");
  });

  // #758-T04, mutant "no managed-key provider mask"
  it("names no provider in the summary, the subjects and the paths of a task on the operator's key, and keeps the names on the own key", () => {
    const text = "Switched to Anthropic and openrouter";
    const block = {
      summary: text,
      commits: [{ sha: SHA_B, subject: text }],
      filesChanged: [{ path: "src/anthropic.ts", status: "added" }],
    };

    const managed = detailOf(turn({ result: resultWith(block) }), source(), {
      managed: true,
    }).implementer;
    const own = detailOf(
      turn({ result: resultWith(block) }),
      source(),
    ).implementer;

    expect(JSON.stringify(managed)).not.toMatch(/anthropic|openrouter/i);
    expect(managed?.summary).toBe("Switched to [provider] and [provider]");
    expect(own?.summary).toBe(text);
    expect(own?.files.shown[0]?.path).toBe("src/anthropic.ts");
  });
});

describe("the sentences of a task are the ones that are shown", () => {
  // #758-T03, mutant "task sentences never used"
  it("uses the sentence for a task in the row and in the detail, not the one for a review", () => {
    for (const code of [
      "cost_limit_reached",
      "time_limit_reached",
      "branch_violation",
      "push_rejected",
      "dynamic_accounting_failed",
    ]) {
      const failed = turn({ status: "failed", errorCode: code });
      const task = describeTurnErrorCode(PRODUCT, code).text;
      const review = errorCopy(PRODUCT)[code];

      expect(task, code).not.toBe(review);
      expect(
        toRunRowView(PRODUCT, failed, "acme/widgets", NOW).problem,
        code,
      ).toBe(task);
      expect(detailOf(failed, source()).problem, code).toBe(task);
    }
  });

  // #758-T03
  it("does not take the stopped-early limit of a review for a task: one sentence for the limit of a task", () => {
    const run = detailOf(
      turn({
        status: "failed",
        errorCode: "cost_limit_reached",
        result: resultWith(
          {},
          {
            usage: {
              model: "m",
              totalTokens: 1,
              aiCalls: 1,
              costUsd: 0.1,
              stoppedEarly: "project_cost_limit",
            },
          },
        ),
      }),
      source(),
    );

    expect(run.problem).toBe(
      describeTurnErrorCode(PRODUCT, "cost_limit_reached").text,
    );
  });
});

describe("the checkout reason is a Dynamic Review's", () => {
  // #758-T09, mutant "errorReason shown for tasks"
  it("shows no checkout reason for a failed task, and still shows it for a failed Dynamic Review", () => {
    const result = {
      ok: false,
      commentUrl: null,
      logTail: "",
      errorReason: "ref_moved",
    };

    const task = detailOf(
      turn({ status: "failed", errorCode: "runner_error", result }),
      source(),
    );
    const dynamic = detailOf(
      turn({
        reviewKind: "dynamic",
        prNumber: 7,
        status: "failed",
        errorCode: "checkout_incomplete",
        result,
      }),
      null,
    );

    expect(task.errorReason).toBeNull();
    expect(dynamic.errorReason).toMatchObject({ code: "ref_moved" });
  });
});
