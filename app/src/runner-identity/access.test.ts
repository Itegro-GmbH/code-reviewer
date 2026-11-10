// SPDX-License-Identifier: LicenseRef-Proprietary

// What a dispatcher can run and what a job asks for (#973): the rule in memory, the demand of a turn, the platform's own manifest and the
// refusal of `managed` for a customer. The same rule in the database is proven against this one in `access.integration.test.ts`.
import { describe, expect, it } from "vitest";
import {
  accessMatches,
  announcesHarness,
  authOfTurn,
  demandOfTurn,
  legacyAccessOf,
  PLATFORM_ACCESS,
  reservedAccessIssues,
  runnerCanServe,
  type HarnessAccess,
} from "./access.ts";

const OPENCODE: HarnessAccess = {
  harness: "opencode",
  version: "1",
  auth: "app-key",
};
const CLAUDE: HarnessAccess = {
  harness: "claude-code",
  version: "2",
  auth: "subscription",
  models: ["sonnet", "opus", "haiku"],
};
const OWN = { provider: "anthropic", model: "claude-sonnet-5-5" };
const CATALOG = { entryId: "entry-1" };
const OPUS = { provider: "claude-code", model: "opus" };

describe("the demand of a turn", () => {
  // #973-T01
  it("is the harness of its profile (OpenCode when it names none), the auth its model implies and, for a subscription, the model", () => {
    expect(demandOfTurn({ modelChoice: OWN })).toEqual({
      harness: "opencode",
      auth: "app-key",
      model: null,
    });
    expect(demandOfTurn({ harness: null, modelChoice: CATALOG })).toEqual({
      harness: "opencode",
      auth: "managed",
      model: null,
    });
    expect(demandOfTurn({ harness: "claude-code", modelChoice: OPUS })).toEqual(
      { harness: "claude-code", auth: "subscription", model: "opus" },
    );
  });

  it("asks for a subscription whatever the model says, for a harness that runs on a login", () => {
    expect(authOfTurn("claude-code", OWN)).toBe("subscription");
    expect(authOfTurn("claude-code", CATALOG)).toBe("subscription");
  });

  it("cannot be served by a runner when it asks for the platform's keys", () => {
    expect(runnerCanServe(demandOfTurn({ modelChoice: CATALOG }))).toBe(false);
    expect(runnerCanServe(demandOfTurn({ modelChoice: OWN }))).toBe(true);
    expect(
      runnerCanServe(
        demandOfTurn({ harness: "claude-code", modelChoice: OPUS }),
      ),
    ).toBe(true);
  });
});

describe("the rule", () => {
  // #973-T01
  it("needs an entry with the harness, the auth and, when the demand has a model, a model the entry allows", () => {
    const opus = demandOfTurn({ harness: "claude-code", modelChoice: OPUS });

    expect(accessMatches([OPENCODE, CLAUDE], opus)).toBe(true);
    expect(accessMatches([OPENCODE], opus)).toBe(false);
    expect(
      accessMatches([OPENCODE, { ...CLAUDE, models: ["sonnet"] }], opus),
    ).toBe(false);
    expect(accessMatches([{ ...CLAUDE, auth: "local-key" }], opus)).toBe(false);
  });

  it("lets an entry without models allow any, and an empty manifest allow nothing", () => {
    const { models: _models, ...open } = CLAUDE;
    const any = demandOfTurn({
      harness: "claude-code",
      modelChoice: { provider: "claude-code", model: "whatever-1" },
    });

    expect(accessMatches([open], any)).toBe(true);
    expect(accessMatches([], any)).toBe(false);
    expect(accessMatches([], demandOfTurn({ modelChoice: OWN }))).toBe(false);
  });

  it("does not let a key of the app stand in for the platform's keys, or the other way round", () => {
    expect(
      accessMatches([OPENCODE], demandOfTurn({ modelChoice: CATALOG })),
    ).toBe(false);
    expect(
      accessMatches(
        [{ ...OPENCODE, auth: "managed" }],
        demandOfTurn({ modelChoice: OWN }),
      ),
    ).toBe(false);
  });

  it("is what the platform's dispatcher says for itself: OpenCode on its keys and on a key of the app, never a subscription", () => {
    expect(
      accessMatches(PLATFORM_ACCESS, demandOfTurn({ modelChoice: CATALOG })),
    ).toBe(true);
    expect(
      accessMatches(PLATFORM_ACCESS, demandOfTurn({ modelChoice: OWN })),
    ).toBe(true);
    expect(
      accessMatches(
        PLATFORM_ACCESS,
        demandOfTurn({ harness: "claude-code", modelChoice: OPUS }),
      ),
    ).toBe(false);
  });

  it("finds a harness in a manifest by name alone (the base of every runner holds OpenCode)", () => {
    expect(announcesHarness([OPENCODE, CLAUDE], "opencode")).toBe(true);
    expect(announcesHarness([CLAUDE], "opencode")).toBe(false);
    expect(announcesHarness([], "opencode")).toBe(false);
  });
});

describe("the old map form", () => {
  // #973-T04
  it("reads OpenCode as a key of the app and Claude Code as a subscription", () => {
    expect(legacyAccessOf("opencode", "1.19.0")).toEqual({
      harness: "opencode",
      version: "1.19.0",
      auth: "app-key",
    });
    expect(legacyAccessOf("claude-code", "2.1.311")).toEqual({
      harness: "claude-code",
      version: "2.1.311",
      auth: "subscription",
    });
  });
});

describe("the access managed", () => {
  // #973-T02
  it("is named by position for each entry that claims it, and for no other", () => {
    expect(
      reservedAccessIssues({
        harnesses: [
          OPENCODE,
          { ...OPENCODE, auth: "managed" },
          CLAUDE,
          { harness: "x", version: "1", auth: "managed" },
        ],
      }),
    ).toEqual([
      { field: "manifest.harnesses[1].auth", code: "reserved" },
      { field: "manifest.harnesses[3].auth", code: "reserved" },
    ]);
    expect(reservedAccessIssues(undefined)).toEqual([]);
    expect(reservedAccessIssues({ harnesses: { opencode: {} } })).toEqual([]);
    expect(reservedAccessIssues({ harnesses: [null, "managed", 3] })).toEqual(
      [],
    );
  });
});
