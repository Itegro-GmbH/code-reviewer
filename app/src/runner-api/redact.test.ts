// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the last line of defense against a secret in a stored result. The runner redacts its
// own output; this removes what still looks like a credential, and the secrets the app itself knows.
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  knownSecretsFromEnv,
  redactResult,
  redactText,
} from "./redact.ts";
import type { RunnerResult } from "./contract.ts";

// Token shaped dummies, joined at run time so that no file in the repository holds a string the
// tracked-secrets scan (src/ci/tracked-secrets.test.ts) would flag.
const GHS = ["ghs", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
const GHP = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
const GITHUB_PAT = [
  "github",
  "pat",
  "11AAAAAAA0abcdefghijklmnop_qrstuvwxyz",
].join("_");
const OPENROUTER_KEY = [
  "sk",
  "or",
  "v1",
  "abcdef0123456789abcdef0123456789",
].join("-");

describe("removing secrets from text", () => {
  it("replaces GitHub tokens of every kind", () => {
    const text = `${GHS} ${GHP} ${GITHUB_PAT}`;

    expect(redactText(text, [])).toBe(`${REDACTED} ${REDACTED} ${REDACTED}`);
  });

  it("replaces provider keys and bearer credentials", () => {
    const text = `key ${OPENROUTER_KEY} and Authorization: Bearer abcdefghijklmnop0123456789`;

    expect(redactText(text, [])).toBe(
      `key ${REDACTED} and Authorization: ${REDACTED}`,
    );
  });

  it("replaces the exact secrets it is given, wherever they appear", () => {
    const text =
      "the value hunter2-secret-value appears twice: hunter2-secret-value.";

    expect(redactText(text, ["hunter2-secret-value"])).toBe(
      `the value ${REDACTED} appears twice: ${REDACTED}.`,
    );
  });

  it("removes a secret that was given with white space around it", () => {
    expect(redactText("key=my-llm-secret-key.", ["my-llm-secret-key\n"])).toBe(
      `key=${REDACTED}.`,
    );
  });

  it("removes the URL-encoded form of a secret too", () => {
    const secret = "key/with+special chars=1";

    expect(
      redactText(`GET /v1?k=${encodeURIComponent(secret)} and ${secret}`, [
        secret,
      ]),
    ).toBe(`GET /v1?k=${REDACTED} and ${REDACTED}`);
  });

  it("ignores given secrets that are too short to be real, so ordinary words survive", () => {
    expect(redactText("a short word", ["a", "", "short"])).toBe("a short word");
  });

  it("leaves ordinary text untouched", () => {
    const text =
      "Reviewed 3 files.\nSee https://github.com/acme/widgets/pull/7";

    expect(redactText(text, ["some-longer-secret"])).toBe(text);
  });
});

describe("removing secrets from a result", () => {
  const result: RunnerResult = {
    ok: false,
    durationMs: 10,
    commentUrl: null,
    errorCode: "command_failed",
    errorMessage: `failed with ${GHS}`,
    logTail: `token ${GHS} refused; key my-llm-secret-key`,
    logTruncated: false,
    usage: null,
  };

  it("cleans the free text fields and keeps everything else", () => {
    const cleaned = redactResult(result, ["my-llm-secret-key"]);

    expect(cleaned.logTail).toBe(`token ${REDACTED} refused; key ${REDACTED}`);
    expect(cleaned.errorMessage).toBe(`failed with ${REDACTED}`);
    expect({ ...cleaned, logTail: "", errorMessage: null }).toStrictEqual({
      ...result,
      logTail: "",
      errorMessage: null,
    });
  });

  it("gives the same answer when it is applied twice, so a repeated report compares equal", () => {
    const once = redactResult(result, ["my-llm-secret-key"]);

    expect(redactResult(once, ["my-llm-secret-key"])).toStrictEqual(once);
  });
});

describe("the secrets the app knows", () => {
  it("are the LLM key and the runner token, trimmed, without the empty ones", () => {
    expect(
      knownSecretsFromEnv({
        LLM_API_KEY: "llm-key-value\n",
        RUNNER_TOKEN: "  ",
        OTHER: "x",
      }),
    ).toStrictEqual(["llm-key-value"]);
  });
});

describe("removing a key that was rotated", () => {
  // CR-46-T07
  it("removes the key of the claim and the current key from one text", () => {
    const text =
      "old key claim-key-0123456789 and new key current-key-9876543210";

    expect(
      redactText(text, ["current-key-9876543210", "claim-key-0123456789"]),
    ).toBe(`old key ${REDACTED} and new key ${REDACTED}`);
  });

  it("removes a key in its JSON-escaped and base64 form too", () => {
    const secret = 'key"with\\quote-0123456789';
    const base64 = Buffer.from(secret, "utf8").toString("base64");

    const cleaned = redactText(
      `body ${JSON.stringify({ k: secret })} header Basic ${base64}`,
      [secret],
    );

    expect(cleaned).not.toContain(secret.slice(4));
    expect(cleaned).not.toContain(base64);
  });
});

describe("the credential of a Worker (#320)", () => {
  // #320-T11
  it("is removed by its shape even when the app does not know it", () => {
    const credential = `crj_${"Ab3-_".repeat(9)}Zz`;

    const cleaned = redactText(
      `calling with ${credential} and Authorization: Bearer ${credential}`,
      [],
    );

    expect(cleaned).not.toContain(credential);
    expect(cleaned).not.toContain(credential.slice(4));
    expect(cleaned).toContain("[redacted]");
  });
});

describe("the implementer block of a result (#754)", () => {
  const LLM_KEY = "llm-key-for-the-turn-0123456789";
  const CAPABILITY = `crj_${"Ab3-_".repeat(9)}Zz`;
  const block = {
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    pushed: true,
    commits: [
      { sha: "b".repeat(40), subject: `Use ${GHS} to push` },
      { sha: "c".repeat(40), subject: "Plain subject" },
    ],
    filesChanged: [
      { path: `config/${LLM_KEY}.json`, status: "added" as const },
      { path: `src/${CAPABILITY}/index.ts`, status: "modified" as const },
      { path: "src/plain.ts", status: "deleted" as const },
    ],
    summary: `I used ${GHS}, the key ${LLM_KEY} and Authorization: Bearer ${CAPABILITY}.`,
    opencode: { sessionId: "ses_1", version: "1.19.0" },
  };
  const result: RunnerResult = {
    ok: true,
    durationMs: 1,
    commentUrl: null,
    errorCode: null,
    errorMessage: null,
    logTail: "",
    logTruncated: false,
    usage: null,
    implementer: block,
  };

  // #754-T04
  it("removes the git token, the LLM key and the capability from the summary, the subjects and the paths", () => {
    const cleaned = redactResult(result, [LLM_KEY]);
    const stored = JSON.stringify(cleaned.implementer);

    for (const secret of [GHS, LLM_KEY, CAPABILITY, CAPABILITY.slice(4)])
      expect(stored).not.toContain(secret);
    expect(cleaned.implementer?.summary).toContain(REDACTED);
    expect(cleaned.implementer?.commits[0]?.subject).toBe(
      `Use ${REDACTED} to push`,
    );
    expect(cleaned.implementer?.filesChanged[0]?.path).toBe(
      `config/${REDACTED}.json`,
    );
  });

  // #754-T04
  it("leaves the shas, the numbers, the statuses and the plain text as they were", () => {
    const cleaned = redactResult(result, [LLM_KEY]).implementer;

    expect(cleaned).toMatchObject({
      baseCommit: block.baseCommit,
      headCommit: block.headCommit,
      pushed: true,
      opencode: block.opencode,
    });
    expect(cleaned?.commits.map((commit) => commit.sha)).toEqual(
      block.commits.map((commit) => commit.sha),
    );
    expect(cleaned?.commits[1]?.subject).toBe("Plain subject");
    expect(cleaned?.filesChanged.map((file) => file.status)).toEqual([
      "added",
      "modified",
      "deleted",
    ]);
    expect(cleaned?.filesChanged[2]?.path).toBe("src/plain.ts");
  });

  // #754-T04
  it("leaves a result without the block without one", () => {
    const bare: RunnerResult = { ...result };
    delete bare.implementer;

    expect("implementer" in redactResult(bare, [LLM_KEY])).toBe(false);
  });

  // #754: a zero-width character inside a secret keeps a plain match from finding it.
  it("finds a secret that zero-width characters split, in every text of the block", () => {
    const split = (text: string) =>
      [...text].join("\u200b").replace(/\u200b$/, "");
    const withSplit: RunnerResult = {
      ...result,
      implementer: {
        ...block,
        summary: `key ${split(LLM_KEY)} and token ${split(GHS)}`,
        commits: [{ sha: "b".repeat(40), subject: `Use ${split(LLM_KEY)}` }],
        filesChanged: [
          { path: `src/${split(LLM_KEY)}.ts`, status: "added" as const },
        ],
      },
    };

    const stored = JSON.stringify(
      redactResult(withSplit, [LLM_KEY]).implementer,
    );

    expect(stored).not.toContain(LLM_KEY.slice(4, 14));
    expect(stored).not.toContain(GHS.slice(4, 14));
    expect(stored).toContain(REDACTED);
  });

  // #754: only text that held a secret is rewritten; a ZWJ emoji or a soft hyphen elsewhere stays as it was.
  it("leaves text without a secret exactly as it was, zero-width characters included", () => {
    const plain = "family 👨\u200d👩\u200d👧 and co\u00adoperate";
    const kept = redactResult(
      { ...result, implementer: { ...block, summary: plain } },
      [LLM_KEY],
    );

    expect(kept.implementer?.summary).toBe(plain);
  });
});
