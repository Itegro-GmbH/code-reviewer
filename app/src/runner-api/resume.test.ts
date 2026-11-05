// SPDX-License-Identifier: LicenseRef-Proprietary

// The `resume` block of a follow-up turn (#841): built from the stored reports of the earlier turns, bounded, and data only.
import { describe, expect, it } from "vitest";
import { createContractValidator } from "../test-support/runner-contract.ts";
import type { TurnHistoryEntry } from "../db/repositories/implementer-repository.ts";
import {
  MAX_DIGEST_BYTES,
  MAX_PREVIOUS_SUMMARY_BYTES,
  MAX_RESUME_BRANCHES,
  buildResume,
  cutBytes,
} from "./resume.ts";

const sha = (letter: string) => letter.repeat(40);

function turn(
  number: number,
  implementer: Record<string, unknown> | null,
  instruction = `Instruction ${String(number)}`,
): TurnHistoryEntry {
  return {
    number,
    instruction,
    jobId: `job-${String(number)}`,
    jobStatus: "succeeded",
    result: implementer === null ? null : { implementer },
  };
}

const pushed = (name: string, head: string) => ({
  name,
  head,
  result: "pushed",
  reason: null,
});

function build(
  history: TurnHistoryEntry[],
  extra: Partial<Parameters<typeof buildResume>[0]> = {},
) {
  return buildResume({
    turnNumber: history.length + 1,
    sessionBranch: "feature/x",
    history,
    sessionSummary: null,
    hasSnapshot: false,
    ...extra,
  });
}

describe("the branches of a follow-up turn", () => {
  // #841-U01
  it("names the session branch first, then the others, each with the tip it was pushed at", () => {
    const resume = build([
      turn(1, {
        branches: [pushed("aux", sha("b")), pushed("feature/x", sha("a"))],
      }),
    ]);

    expect(resume.branches).toEqual([
      { name: "feature/x", head: sha("a") },
      { name: "aux", head: sha("b") },
    ]);
  });

  // #841-U02: a turn that touched one branch does not list the others
  it("keeps a branch of an earlier turn that a later turn did not touch, and takes the newest tip of a name", () => {
    const resume = build([
      turn(1, {
        branches: [pushed("feature/x", sha("a")), pushed("aux", sha("b"))],
      }),
      turn(2, { branches: [pushed("feature/x", sha("c"))] }),
    ]);

    expect(resume.branches).toEqual([
      { name: "feature/x", head: sha("c") },
      { name: "aux", head: sha("b") },
    ]);
  });

  // #841-U03
  it("does not count a rejected branch, and reads the session branch from headCommit for a report without a branch list", () => {
    const resume = build([
      turn(1, {
        pushed: true,
        headCommit: sha("d"),
        branches: [
          {
            name: "aux",
            head: sha("b"),
            result: "rejected",
            reason: "non_fast_forward",
          },
        ],
      }),
    ]);

    expect(resume.branches).toEqual([{ name: "feature/x", head: sha("d") }]);
  });

  // #841-U04
  it("is empty when the earlier turns pushed nothing, and when a report is missing or damaged", () => {
    expect(
      build([turn(1, { pushed: false, headCommit: null })]).branches,
    ).toEqual([]);
    expect(build([turn(1, null)]).branches).toEqual([]);
    expect(
      build([turn(1, { branches: "nope", commits: 3, filesChanged: {} })])
        .branches,
    ).toEqual([]);
  });

  // #841-U05
  it("holds the list to 20, the session branch kept first", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      pushed(`b${String(index)}`, sha("a")),
    );
    const resume = build([
      turn(1, { branches: [...many, pushed("feature/x", sha("f"))] }),
    ]);

    expect(resume.branches).toHaveLength(MAX_RESUME_BRANCHES);
    expect(resume.branches[0]).toEqual({ name: "feature/x", head: sha("f") });
  });

  // #841-U06
  it("ignores a head that is not a commit sha", () => {
    const resume = build([
      turn(1, {
        branches: [pushed("aux", "not-a-sha"), pushed("feature/x", sha("a"))],
      }),
    ]);

    expect(resume.branches).toEqual([{ name: "feature/x", head: sha("a") }]);
  });
});

describe("the branch to check out", () => {
  // #841-U07
  it("is the branch the last turn ended on when it is one of the branches or the session branch", () => {
    const history = [
      turn(1, {
        branches: [pushed("feature/x", sha("a")), pushed("aux", sha("b"))],
        checkedOut: "aux",
      }),
    ];
    expect(build(history).checkout).toBe("aux");
    expect(
      build([
        turn(1, {
          branches: [pushed("aux", sha("b"))],
          checkedOut: "feature/x",
        }),
      ]).checkout,
    ).toBe("feature/x");
  });

  // #841-U08: the runner refuses any other name
  it("is null for a name that did not arrive, for a detached head, and for a report without the field", () => {
    expect(
      build([
        turn(1, { branches: [pushed("aux", sha("b"))], checkedOut: "lost" }),
      ]).checkout,
    ).toBeNull();
    expect(
      build([
        turn(1, { branches: [pushed("aux", sha("b"))], checkedOut: null }),
      ]).checkout,
    ).toBeNull();
    expect(
      build([turn(1, { branches: [pushed("aux", sha("b"))] })]).checkout,
    ).toBeNull();
  });

  // #841-U09: only the turn that ran last says where the agent was
  it("is taken from the last turn only", () => {
    const resume = build([
      turn(1, { branches: [pushed("aux", sha("b"))], checkedOut: "aux" }),
      turn(2, null),
    ]);

    expect(resume.checkout).toBeNull();
  });
});

describe("the conversation, the summary and the digest", () => {
  // #841-U10
  it("says whether a conversation is stored, and gives the number of the turn", () => {
    const resume = build([turn(1, {})], { hasSnapshot: true, turnNumber: 2 });

    expect(resume).toMatchObject({ turn: 2, snapshot: true });
  });

  // #841-U11
  it("holds the previous summary to 8 KiB of UTF-8 without cutting a character, and leaves it out when empty", () => {
    const long = "ä".repeat(MAX_PREVIOUS_SUMMARY_BYTES);
    const resume = build([turn(1, {})], { sessionSummary: long });

    expect(
      Buffer.byteLength(resume.previousSummary ?? "", "utf8"),
    ).toBeLessThanOrEqual(MAX_PREVIOUS_SUMMARY_BYTES);
    expect(resume.previousSummary).toMatch(/^ä+$/);
    expect(build([turn(1, {})], { sessionSummary: "  " })).not.toHaveProperty(
      "previousSummary",
    );
    expect(build([turn(1, {})])).not.toHaveProperty("previousSummary");
  });

  // #841-U12
  it("lists the last 5 instructions at 2 KiB each, the last 3 summaries, the commit subjects once and the first 50 files", () => {
    const history = Array.from({ length: 7 }, (_, index) =>
      turn(
        index + 1,
        {
          summary: `Summary ${String(index + 1)}`,
          commits: [
            { sha: sha("a"), subject: "Same commit" },
            {
              sha: String(index + 1)
                .repeat(40)
                .slice(0, 40),
              subject: `Commit ${String(index + 1)}`,
            },
          ],
          filesChanged: Array.from(
            { length: 30 },
            (_, f) => `file-${String(index)}-${String(f)}.ts`,
          ),
        },
        "x".repeat(5000),
      ),
    );
    const digest = build(history).digest ?? "";

    expect(digest).toContain("turn 7:");
    expect(digest).toContain("turn 3:");
    expect(digest).not.toContain("- turn 2: xxx");
    expect(digest.match(/Same commit/g)).toHaveLength(1);
    expect(digest).toContain("Summary 7");
    expect(digest).toContain("Summary 5");
    expect(digest).not.toContain("Summary 4");
    expect(digest.match(/^- file-/gm)).toHaveLength(50);
    // 2 KiB of an instruction, not 5000 characters of it.
    expect(digest).not.toContain("x".repeat(2049));
  });

  // #841-U13
  it("never exceeds 16 KiB", () => {
    const history = Array.from({ length: 5 }, (_, index) =>
      turn(
        index + 1,
        {
          commits: Array.from({ length: 200 }, (_, c) => ({
            sha: `${String(index)}${String(c)}`.padEnd(40, "e").slice(0, 40),
            subject: "s".repeat(300),
          })),
        },
        "y".repeat(2048),
      ),
    );

    expect(
      Buffer.byteLength(build(history).digest ?? "", "utf8"),
    ).toBeLessThanOrEqual(MAX_DIGEST_BYTES);
  });

  // #841-U14: data, never instructions; and nothing that ends a C string
  it("takes control characters out of every text it passes on", () => {
    const resume = build(
      [turn(1, { summary: "a\u0000b\u001bc" }, "do\u0000this")],
      {
        sessionSummary: "x\u0000y",
      },
    );

    expect(resume.previousSummary).toBe("x y");
    expect(resume.digest).not.toMatch(/[\u0000\u001b]/);
  });

  // #841-U15
  it("has no digest for a session without history", () => {
    expect(build([])).not.toHaveProperty("digest");
  });
});

describe("cutting by bytes", () => {
  // #841-U16
  it("cuts on a character boundary", () => {
    expect(cutBytes("aäb", 2)).toBe("a");
    expect(cutBytes("aäb", 3)).toBe("aä");
    expect(cutBytes("😀😀", 5)).toBe("😀");
  });
});

describe("the block against the contract", () => {
  const contract = createContractValidator();

  // #841-U17: the closed object `ImplementerResume` of contracts/runner-api.v1.json takes what the builder makes, also at its bounds
  it("is accepted by ImplementerResume, also with 20 branches, a summary of 8 KiB and a digest of 16 KiB", () => {
    const branches = Array.from({ length: 25 }, (_, index) =>
      pushed(`branch-${String(index)}`, sha("a")),
    );
    const history = Array.from({ length: 6 }, (_, index) =>
      turn(
        index + 1,
        {
          summary: "s".repeat(3000),
          branches,
          checkedOut: "branch-3",
          commits: Array.from({ length: 100 }, (_, c) => ({
            sha: `${String(c).padStart(2, "0")}${"b".repeat(38)}`,
            subject: "subject ".repeat(30),
          })),
        },
        "i".repeat(2500),
      ),
    );

    const resume = build(history, {
      sessionSummary: "ä".repeat(9000),
      hasSnapshot: true,
    });

    expect(resume.branches).toHaveLength(MAX_RESUME_BRANCHES);
    expect(contract.check("ImplementerResume", resume)).toStrictEqual({
      valid: true,
      errors: "",
    });
  });

  // #841-U18
  it("is accepted without the optional fields", () => {
    expect(
      contract.check("ImplementerResume", build([turn(1, {})], {})),
    ).toStrictEqual({ valid: true, errors: "" });
  });
});
