// SPDX-License-Identifier: LicenseRef-Proprietary

// The rule of what a dispatcher can run (#973) in the database against the same rule in memory: every manifest against every turn, the two answers
// must be the same. The claim and the pairing of the rings both write their condition with `accessRule`, so this is the proof that there is one
// rule. A real Postgres with the migrated schema (the rule calls `json_or_null`), but no row of the app: the turn is a row of `values`.
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  accessMatches,
  accessRule,
  demandOfTurn,
  entriesParam,
  PLATFORM_ACCESS,
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
  // #1150: a runner without a login of its own, and a login that is on the device, together.
  "claude code on the token of the workspace": [
    OPENCODE,
    { ...CLAUDE, auth: "app-key" },
  ],
  "claude code, sonnet only, and the token of the workspace": [
    { ...CLAUDE, models: ["sonnet"] },
    { ...CLAUDE, auth: "app-key" },
  ],
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
  const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
  afterAll(async () => {
    for (const database of databases) await database.db.destroy();
  });

  // #973-T01
  it("gives the same answer for every manifest against every turn", async () => {
    const database = await createTestDatabase();
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

    expect(compared).toBe(84);
    // The table must not be one-sided: some pairs match and some do not.
    expect(taken).toBeGreaterThan(10);
    expect(taken).toBeLessThan(60);
  });

  // #980-T08 (the review of #988)
  it("gives every vector of the alias map the contract's answer, and the same as the rule in memory", async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const { vectors } = JSON.parse(
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
      vectors: { announced: string; demanded: string; match: boolean }[];
    };

    for (const { announced, demanded, match } of vectors) {
      const entries: HarnessAccess[] = [{ ...CLAUDE, models: [announced] }];
      const { rows } = await sql<{ ok: boolean }>`
        select ${accessRule(entriesParam(entries), "t")} as ok
        from (values ('claude-code'::text, ${JSON.stringify({ provider: "claude-code", model: demanded })}::text)) as t(profile_harness, model_choice)`.execute(
        database.db,
      );
      const inMemory = accessMatches(entries, {
        harness: "claude-code",
        auth: "subscription",
        model: demanded,
      });
      expect({ announced, demanded, sql: rows[0]?.ok }).toEqual({
        announced,
        demanded,
        sql: match,
      });
      expect(inMemory).toBe(match);
    }
  });

  // #980-T08
  it("does not fail for a manifest whose models are no list", async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const odd = JSON.stringify([
      {
        harness: "claude-code",
        version: "2",
        auth: "subscription",
        models: "opus",
      },
    ]);
    const { rows } = await sql<{ ok: boolean }>`
      select ${accessRule(sql`${odd}::jsonb`, "t")} as ok
      from (values ('claude-code'::text, ${JSON.stringify({ provider: "claude-code", model: "opus" })}::text)) as t(profile_harness, model_choice)`.execute(
      database.db,
    );

    expect(rows[0]?.ok).toBe(false);
  });

  // #1150-T18
  it("lets the token of the workspace stand in for a login only while the workspace holds one, in the database as in memory", async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const withToken = await addWorkspace(database.db, "with-token");
    const without = await addWorkspace(database.db, "without");
    await database.db
      .insertInto("workspace_secrets")
      .values({
        workspace_id: withToken,
        name: "claude_code_oauth_token",
        binding: "claude-code",
        ciphertext: "AAAA",
        nonce: "AAAA",
        key_version: 1,
        last_four: null,
        updated_by: null,
        updated_at: "2026-11-25T00:00:00.000Z",
      })
      .execute();
    // The slot of another workspace's LLM key is no token.
    await database.db
      .insertInto("workspace_secrets")
      .values({
        workspace_id: without,
        name: "llm_api_key",
        binding: "openrouter",
        ciphertext: "AAAA",
        nonce: "AAAA",
        key_version: 1,
        last_four: null,
        updated_by: null,
        updated_at: "2026-11-25T00:00:00.000Z",
      })
      .execute();
    const manifests = {
      "the token only": [{ ...CLAUDE, auth: "app-key" as const }],
      "a login of the device": [CLAUDE],
      "the token and OpenCode": [
        OPENCODE,
        { ...CLAUDE, auth: "app-key" as const },
      ],
    } satisfies Record<string, readonly HarnessAccess[]>;
    const choice = JSON.stringify({ provider: "claude-code", model: "opus" });

    for (const [name, entries] of Object.entries(manifests))
      for (const [workspace, id, held] of [
        ["with a token", withToken, true],
        ["without", without, false],
      ] as const)
        for (const required of [true, false]) {
          const { rows } = await sql<{ ok: boolean }>`
            select ${accessRule(entriesParam(entries), "t", { requireToken: required })} as ok
            from (values ('claude-code'::text, ${choice}::text, ${id}::text)) as t(profile_harness, model_choice, workspace_id)`.execute(
            database.db,
          );
          const inMemory = accessMatches(
            entries,
            demandOfTurn({
              harness: "claude-code",
              modelChoice: { provider: "claude-code", model: "opus" },
            }),
            required ? { workspaceToken: held } : {},
          );
          expect({ name, workspace, required, sql: rows[0]?.ok }).toEqual({
            name,
            workspace,
            required,
            sql: inMemory,
          });
        }
  });

  // #973-T01
  it("takes a turn whose stored choice is no JSON object for nobody's, and does not fail for the turns beside it", async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const { rows } = await sql<{ name: string; ok: boolean }>`
      select t.name as name, ${accessRule(entriesParam([OPENCODE]), "t")} as ok
      from (values
        ('good', ${null}::text, ${JSON.stringify({ provider: "anthropic", model: "m" })}::text),
        ('broken', ${null}::text, 'not json {'),
        ('empty', ${null}::text, ''),
        ('a list', ${null}::text, '[1]'),
        ('a number', ${null}::text, '5'),
        ('also good', ${"opencode"}::text, ${JSON.stringify({ provider: "openai", model: "gpt-5" })}::text)
      ) as t(name, profile_harness, model_choice)
      order by t.name`.execute(database.db);

    expect(Object.fromEntries(rows.map((row) => [row.name, row.ok]))).toEqual({
      "a list": false,
      "a number": false,
      "also good": true,
      broken: false,
      empty: false,
      good: true,
    });
  });
});
