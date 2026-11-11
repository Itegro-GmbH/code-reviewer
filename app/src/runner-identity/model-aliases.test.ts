// SPDX-License-Identifier: LicenseRef-Proprietary

// The alias map of Claude Code models (#980): the app's copy is the contract's and answers its test vectors (the runner's copy runs the same ones).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accessMatches, type HarnessAccess } from "./access.ts";
import {
  aliasOf,
  CLAUDE_MODEL_ALIASES,
  modelsAllow,
  modelsMatch,
} from "./model-aliases.ts";

const contract = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../contracts/claude-model-aliases.v1.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as {
  aliases: { alias: string; idPattern: string }[];
  vectors: { announced: string; demanded: string; match: boolean }[];
};

describe("the alias map of Claude Code models", () => {
  // #980-T08
  it("is the contract's", () => {
    expect([...CLAUDE_MODEL_ALIASES]).toEqual(contract.aliases);
  });

  // #980-T08
  it.each(contract.vectors)(
    "answers $announced ~ $demanded with $match",
    ({ announced, demanded, match }) => {
      expect(modelsMatch(announced, demanded)).toBe(match);
    },
  );

  it("names the alias of an id of its family and of no other name", () => {
    expect(aliasOf("claude-opus-5-5")).toBe("opus");
    expect(aliasOf("claude-3-5-haiku-20241022")).toBe("haiku");
    expect(aliasOf("opus")).toBeNull();
    expect(aliasOf("gpt-5")).toBeNull();
  });

  it("lets a device without a list allow any model, and a list allow what one of its names stands for", () => {
    expect(modelsAllow(undefined, "anything")).toBe(true);
    expect(modelsAllow(["haiku"], "claude-haiku-5-5")).toBe(true);
    expect(modelsAllow(["haiku"], "claude-opus-5-5")).toBe(false);
    expect(modelsAllow([], "opus")).toBe(false);
  });
});

describe("the rule of the manifest with aliases", () => {
  const entry = (models: string[]): HarnessAccess => ({
    harness: "claude-code",
    version: "2",
    auth: "subscription",
    models,
  });
  const turn = (model: string) => ({
    harness: "claude-code",
    auth: "subscription" as const,
    model,
  });

  // #980-T08 (the review of #988)
  it("takes a turn on an id from a runner that announces its alias, and the other way round", () => {
    expect(accessMatches([entry(["opus"])], turn("claude-opus-5-5"))).toBe(
      true,
    );
    expect(accessMatches([entry(["claude-opus-5-5"])], turn("opus"))).toBe(
      true,
    );
    expect(accessMatches([entry(["sonnet"])], turn("claude-opus-5-5"))).toBe(
      false,
    );
    expect(
      accessMatches([entry(["claude-opus-5-4"])], turn("claude-opus-5-5")),
    ).toBe(false);
  });
});
