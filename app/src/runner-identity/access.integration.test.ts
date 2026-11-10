// SPDX-License-Identifier: LicenseRef-Proprietary

// The rule of what a dispatcher can run (#973) in the database against the same rule in memory: every manifest against every turn, the two answers
// must be the same. The claim and the pairing of the rings both write their condition with `accessRule`, so this is the proof that there is one
// rule. A real Postgres, but no table of the app: the turn is a row of `values`.
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { createEmptyTestDatabase } from "../test-support/test-database.ts";
import {
  accessMatches,
  accessRule,
  demandOfTurn,
  entriesParam,
  PLATFORM_ACCESS,
  storedEntries,
  type HarnessAccess,
} from "./access.ts";

const OPENCODE: HarnessAccess = {
  harness: "opencode",
  version: "1",
  auth: "app-key",
};
const MANAGED: HarnessAccess = { ...OPENCODE, auth: "managed" };
const CLAUDE: HarnessAccess = {
  harness: "claude-code",
  version: "2",
  auth: "subscription",
};

const MANIFESTS: Record<string, readonly HarnessAccess[]> = {
  none: [],
  opencode: [OPENCODE],
  "opencode and managed": [OPENCODE, MANAGED],
  platform: PLATFORM_ACCESS,
  "claude code, any model": [OPENCODE, CLAUDE],
  "claude code, sonnet and opus": [
    OPENCODE,
    { ...CLAUDE, models: ["opus", "sonnet"] },
  ],
  "claude code, haiku": [OPENCODE, { ...CLAUDE, models: ["haiku"] }],
  "claude code on a key of the device": [
    OPENCODE,
    { ...CLAUDE, auth: "local-key", models: ["opus"] },
  ],
  "opencode on a key of the device": [
    { ...OPENCODE, auth: "local-key", models: ["gpt-5"] },
  ],
  "claude code alone": [CLAUDE],
};

const TURNS: Record<
  string,
  { harness: string | null; choice: Record<string, string> }
> = {
  "a turn on the workspace's key, no harness named": {
    harness: null,
    choice: { provider: "anthropic", model: "claude-sonnet-5-5" },
  },
  "a turn on OpenCode and the workspace's key": {
    harness: "opencode",
    choice: { provider: "openai", model: "gpt-5" },
  },
  "a turn on a catalog entry": {
    harness: null,
    choice: { entryId: "entry-1" },
  },
  "a turn on Claude Code with opus": {
    harness: "claude-code",
    choice: { provider: "claude-code", model: "opus" },
  },
  "a turn on Claude Code with sonnet": {
    harness: "claude-code",
    choice: { provider: "claude-code", model: "sonnet" },
  },
  "a turn on Claude Code with a model no list names": {
    harness: "claude-code",
    choice: { provider: "claude-code", model: "claude-opus-9" },
  },
  "a turn on a harness nobody announces": {
    harness: "custom/tool",
    choice: { provider: "x", model: "y" },
  },
};

describe("the rule in the database and in memory", () => {
  const databases: Awaited<ReturnType<typeof createEmptyTestDatabase>>[] = [];
  afterAll(async () => {
    for (const database of databases) await database.db.destroy();
  });

  // #973-T01
  it("gives the same answer for every manifest against every turn", async () => {
    const database = await createEmptyTestDatabase();
    databases.push(database);
    let compared = 0;
    let taken = 0;

    for (const [manifest, entries] of Object.entries(MANIFESTS))
      for (const [turn, { harness, choice }] of Object.entries(TURNS)) {
        const { rows } = await sql<{ ok: boolean }>`
          select ${accessRule(entriesParam(entries), "t")} as ok
          from (values (${harness}::text, ${JSON.stringify(choice)}::text)) as t(profile_harness, model_choice)`.execute(
          database.db,
        );
        const inMemory = accessMatches(
          entries,
          demandOfTurn({
            harness,
            modelChoice:
              "entryId" in choice
                ? { entryId: choice.entryId as string }
                : {
                    provider: choice.provider as string,
                    model: choice.model as string,
                  },
          }),
        );
        expect({ manifest, turn, sql: rows[0]?.ok }).toEqual({
          manifest,
          turn,
          sql: inMemory,
        });
        compared += 1;
        if (inMemory) taken += 1;
      }

    expect(compared).toBe(70);
    // The table must not be one-sided: some pairs match and some do not.
    expect(taken).toBeGreaterThan(10);
    expect(taken).toBeLessThan(60);
  });

  // #973-T04
  it("reads the entries of a stored manifest: a list, and nothing from the old map form or from text that holds no list", async () => {
    const database = await createEmptyTestDatabase();
    databases.push(database);
    const turn = sql`(values (${null}::text, ${JSON.stringify({ provider: "anthropic", model: "m" })}::text)) as t(profile_harness, model_choice)`;
    const stored = async (manifest: string) => {
      const { rows } = await sql<{ ok: boolean }>`
        select ${accessRule(storedEntries("r.manifest"), "t")} as ok
        from ${turn}, (values (${manifest}::text)) as r(manifest)`.execute(
        database.db,
      );
      return rows[0]?.ok;
    };

    expect(await stored(JSON.stringify({ harnesses: [OPENCODE] }))).toBe(true);
    expect(await stored(JSON.stringify({ harnesses: [] }))).toBe(false);
    expect(await stored(JSON.stringify({ harnesses: [CLAUDE] }))).toBe(false);
    // A row the migration has not rewritten yet (the old map) matches nothing instead of failing the statement.
    expect(
      await stored(
        JSON.stringify({
          harnesses: { opencode: { version: "1", ready: true } },
        }),
      ),
    ).toBe(false);
    expect(await stored(JSON.stringify({ capabilities: [] }))).toBe(false);
  });
});
