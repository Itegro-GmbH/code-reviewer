// SPDX-License-Identifier: LicenseRef-Proprietary

// The Claude Code OAuth token of a workspace over a real Postgres database (#1150): it is stored encrypted like the LLM keys, belongs to
// its workspace alone, is not listed as a provider key, and is masked in a result with the keys.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createWorkspaceLlm } from "./assemble.ts";
import { CLAUDE_CODE_TOKEN_SECRET_NAME } from "./claude-code-token.ts";

const APP_SECRET = "claude-code-token-app-secret-0123456789-0123";
const TOKEN =
  "sk-" + "ant-" + "oat01-DUMMYDUMMYDUMMYDUMMYDUMMY0123456789-abcdef_WXYZ";
const OPENROUTER_KEY = "sk-or-v1-workspace-key-0000000000000000";

async function start() {
  const { db } = await createTestDatabase();
  const alpha = await addWorkspace(db, "alpha");
  const beta = await addWorkspace(db, "beta");
  const llm = createWorkspaceLlm({
    db,
    appSecret: () => APP_SECRET,
    env: () => ({}),
  });
  return { db, llm, alpha, beta };
}

describe("the Claude Code token over a database", () => {
  // #1150-T05
  it("is stored encrypted: the row holds no part of the token but the last four characters", async () => {
    const { db, llm, alpha } = await start();

    await llm.claudeCodeTokenFor(alpha).save(TOKEN, null);

    const rows = await db.selectFrom("workspace_secrets").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: alpha,
      name: CLAUDE_CODE_TOKEN_SECRET_NAME,
      binding: "claude-code",
      last_four: TOKEN.slice(-4),
    });
    expect(JSON.stringify(rows)).not.toContain(TOKEN.slice(0, -4));
    expect(await llm.claudeCodeTokenFor(alpha).tokenForJob()).toEqual({
      state: "token",
      token: TOKEN,
    });
  });

  // #1150-T05
  it("belongs to its workspace: another workspace has none, and a row copied to it does not decrypt", async () => {
    const { db, llm, alpha, beta } = await start();
    await llm.claudeCodeTokenFor(alpha).save(TOKEN, null);

    expect(await llm.claudeCodeTokenFor(beta).tokenForJob()).toEqual({
      state: "none",
    });

    const row = await db
      .selectFrom("workspace_secrets")
      .selectAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("workspace_secrets")
      .values({ ...row, workspace_id: beta })
      .execute();
    expect(await llm.claudeCodeTokenFor(beta).tokenForJob()).toEqual({
      state: "unreadable",
    });
  });

  // #1150-T05
  it("is no provider: the keys of the workspace do not list it and removing it leaves the keys alone", async () => {
    const { llm, alpha } = await start();
    const keys = llm.keyServiceFor(alpha);
    await keys.save({ provider: "openrouter", apiKey: OPENROUTER_KEY }, null);
    await llm.claudeCodeTokenFor(alpha).save(TOKEN, null);

    expect(
      (await keys.statusAll()).map(({ provider }) => provider),
    ).not.toContain("claude-code");
    expect(await keys.nativeStatuses()).toEqual([]);

    expect(await llm.claudeCodeTokenFor(alpha).remove()).toBe(true);
    expect(await keys.status("openrouter")).toMatchObject({
      state: "configured",
    });
  });

  // #1150-T06
  it("is masked in a result together with the keys, and not before it is stored or after it is removed", async () => {
    const { llm, alpha } = await start();
    await llm
      .keyServiceFor(alpha)
      .save({ provider: "openrouter", apiKey: OPENROUTER_KEY }, null);
    expect(await llm.currentKeysFor(alpha)).toEqual([OPENROUTER_KEY]);

    await llm.claudeCodeTokenFor(alpha).save(TOKEN, null);
    expect(await llm.currentKeysFor(alpha)).toEqual(
      expect.arrayContaining([OPENROUTER_KEY, TOKEN]),
    );

    await llm.claudeCodeTokenFor(alpha).remove();
    expect(await llm.currentKeysFor(alpha)).toEqual([OPENROUTER_KEY]);
  });
});
