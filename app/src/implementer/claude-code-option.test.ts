// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the harness claude-code can log in, for the model list (#1150): the token of the workspace, and the logins of its online runners.
import { describe, expect, it } from "vitest";
import type { OnlineRunner } from "../runner-identity/announced.ts";
import { claudeCodeOptionFor } from "./claude-code-option.ts";

const login = (models?: string[]): OnlineRunner => ({
  labels: ["box"],
  access: [
    { harness: "opencode", version: "1", auth: "app-key" },
    {
      harness: "claude-code",
      version: "2",
      auth: "subscription",
      ...(models === undefined ? {} : { models }),
    },
  ],
});
const tokenOnly: OnlineRunner = {
  labels: ["box"],
  access: [{ harness: "claude-code", version: "2", auth: "app-key" }],
};
const ask = (token: boolean, runners: OnlineRunner[]) =>
  claudeCodeOptionFor({
    token: async () => token,
    runners: async () => runners,
  });

describe("where claude-code can log in", () => {
  // #1150-T15
  it("offers the three aliases for the token of the workspace", async () => {
    expect(await ask(true, [])).toEqual({
      harness: "claude-code",
      models: ["sonnet", "opus", "haiku"],
      source: "workspace_token",
    });
  });

  // #1150-T15
  it("offers the models a runner's own login announces, or any model when it names none", async () => {
    expect(await ask(false, [login(["opus"])])).toEqual({
      harness: "claude-code",
      models: ["opus"],
      source: "runner_login",
    });
    expect(await ask(false, [login()])).toMatchObject({
      models: ["sonnet", "opus", "haiku"],
      source: "runner_login",
    });
  });

  // #1150-T15
  it("joins both without repeating a model", async () => {
    expect(await ask(true, [login(["opus", "claude-opus-5-5"])])).toEqual({
      harness: "claude-code",
      models: ["sonnet", "opus", "haiku", "claude-opus-5-5"],
      source: "both",
    });
  });

  // #1150-T15
  it("offers nothing when there is neither: a runner that can only use the token has no login to add", async () => {
    expect(await ask(false, [])).toBeNull();
    expect(await ask(false, [tokenOnly])).toBeNull();
  });
});
