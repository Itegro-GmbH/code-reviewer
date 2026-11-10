// SPDX-License-Identifier: LicenseRef-Proprietary

// The question the validator asks of the runners of a workspace (#973): does an online runner with the labels of the environment announce what the
// profile asks for?
import { describe, expect, it } from "vitest";
import { demandOfProfile, type HarnessAccess } from "./access.ts";
import { announcedBy, type OnlineRunner } from "./announced.ts";

const OPENCODE: HarnessAccess = {
  harness: "opencode",
  version: "1",
  auth: "app-key",
};
const CLAUDE: HarnessAccess = {
  harness: "claude-code",
  version: "2",
  auth: "subscription",
  models: ["sonnet"],
};
const runner = (
  labels: string[],
  ...access: HarnessAccess[]
): OnlineRunner => ({
  labels,
  access,
});
const OPUS = demandOfProfile({ harness: "claude-code", model: "opus" });

describe("the profile's demand", () => {
  it("is derived from the harness, whether the model is the platform's and, for a login, the model", () => {
    expect(demandOfProfile({})).toEqual({
      harness: "opencode",
      auth: "app-key",
      model: null,
    });
    expect(
      demandOfProfile({ harness: "opencode", managedModel: true }),
    ).toEqual({
      harness: "opencode",
      auth: "managed",
      model: null,
    });
    expect(OPUS).toEqual({
      harness: "claude-code",
      auth: "subscription",
      model: "opus",
    });
  });
});

describe("the runners that announce a demand", () => {
  // #973-T01
  it("are asked only among the online runners that have every label of the environment", () => {
    const runners = [
      runner(["box"], OPENCODE, CLAUDE),
      runner(["box", "gpu"], OPENCODE, { ...CLAUDE, models: ["opus"] }),
      runner(["other"], OPENCODE, { ...CLAUDE, models: ["opus"] }),
    ];

    expect(announcedBy(runners, ["box"], OPUS)).toBe("announced");
    expect(announcedBy(runners, ["box", "gpu"], OPUS)).toBe("announced");
    expect(announcedBy(runners.slice(0, 1), ["box"], OPUS)).toBe(
      "not_announced",
    );
    expect(announcedBy(runners.slice(2), ["box"], OPUS)).toBe("unknown");
  });

  it("cannot say anything when no runner with the labels is online", () => {
    expect(announcedBy([], ["box"], OPUS)).toBe("unknown");
    expect(announcedBy([runner(["a"], OPENCODE)], ["b"], OPUS)).toBe("unknown");
  });

  it("find a turn on the workspace's key announced by the base alone", () => {
    expect(
      announcedBy([runner(["box"], OPENCODE)], ["box"], demandOfProfile({})),
    ).toBe("announced");
  });

  it("never announce the platform's keys: a managed model has no runner", () => {
    expect(
      announcedBy(
        [runner(["box"], OPENCODE)],
        ["box"],
        demandOfProfile({ managedModel: true }),
      ),
    ).toBe("not_announced");
  });
});
