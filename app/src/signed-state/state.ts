// SPDX-License-Identifier: LicenseRef-Proprietary

// Signed, single-use `state` values for a round trip through the browser and GitHub (see README.md). The
// value that travels is signed and names a nonce; the nonce is a row in `signed_states` that is used up
// once. A state is bound to the person and the session that started it and to what it is for, and it
// expires. Nothing here logs, and a refusal is one code that does not say which check failed.
import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { signValue, verifySignedValue } from "../crypto/sign.ts";
import { decodeJson, encodeJson, formatTimestamp } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";

export const SIGNED_STATE_PURPOSES = [
  "github-manifest",
  "github-link",
  // Binding an installation to a workspace (src/installation-binding/): "Connect GitHub" (the round trip through
  // GitHub's installation page), the user authorization that gives the token for the checks, and the list of
  // installations the person may choose from.
  "github-install",
  "github-authorize",
  "github-picker",
  // Connecting a Jira Cloud site to a workspace (src/jira/): the round trip through Atlassian's consent page (#1037).
  "jira-connect",
  // Connecting a remote MCP server that uses OAuth (src/mcp/oauth/): the round trip through the authorization server's consent page (#1051).
  "mcp-connect",
] as const;
export type SignedStatePurpose = (typeof SIGNED_STATE_PURPOSES)[number];

/** How long a state can be presented after it was issued. */
export const SIGNED_STATE_TTL_MS = 10 * 60 * 1000;

export const SIGNED_STATE_ERROR_CODES = ["state_invalid"] as const;
export type SignedStateErrorCode = (typeof SIGNED_STATE_ERROR_CODES)[number];

export type IssueStateInput = {
  purpose: SignedStatePurpose;
  userId: string;
  /** The id of the session that starts it; the callback must present the same session. */
  sessionId: string;
  /**
   * The workspace the flow is for. It is part of the signed value, so a callback can only act for the workspace
   * the state was issued for.
   */
  workspaceId?: string;
  /** Kept server side with the nonce and handed back when the state is consumed (PKCE). */
  codeVerifier?: string;
  /** JSON-compatible facts of the flow (never a secret), handed back when the state is consumed. */
  data?: unknown;
};

export type ConsumeStateInput = {
  purpose: SignedStatePurpose;
  /** The `state` parameter as received. */
  value: string;
  userId: string;
  sessionId: string;
};

export type ConsumeStateResult =
  | {
      ok: true;
      codeVerifier: string | null;
      data: unknown;
      /** The workspace the state was issued for, or null when it was issued for none. */
      workspaceId: string | null;
    }
  | { ok: false; error: SignedStateErrorCode };

export type SignedStates = {
  issue(input: IssueStateInput): Promise<string>;
  consume(input: ConsumeStateInput): Promise<ConsumeStateResult>;
  /**
   * The same checks as `consume`, but the state stays usable: for a page that shows what a state holds (the list
   * of the picker) before the person acts on it.
   */
  peek(input: ConsumeStateInput): Promise<ConsumeStateResult>;
};

export type SignedStatesOptions = {
  db: Kysely<Database>;
  /** The master key (`APP_SECRET`). */
  appSecret: string;
  now?: () => Date;
  ttlMs?: number;
};

type Payload = {
  p: string;
  n: string;
  e: number;
  u: string;
  s: string;
  /** The workspace; absent when the state is for none. */
  w?: string;
};

const REFUSED: ConsumeStateResult = { ok: false, error: "state_invalid" };

export function hashSession(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function parsePayload(text: string): Payload | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { p, n, e, u, s, w } = value as Record<string, unknown>;
    return typeof p === "string" &&
      typeof n === "string" &&
      typeof e === "number" &&
      typeof u === "string" &&
      typeof s === "string" &&
      (w === undefined || typeof w === "string")
      ? { p, n, e, u, s, ...(w === undefined ? {} : { w }) }
      : null;
  } catch {
    return null;
  }
}

/**
 * What a `state` value says it is for, when its signature is right (and nothing else is checked, nothing is
 * used up): lets a callback that several flows share hand the request to the one the state belongs to. A forged
 * or malformed value gives null.
 */
export function purposeOfState(
  appSecret: string,
  value: string,
): SignedStatePurpose | null {
  const text = verifySignedValue(appSecret, "state-signing", value);
  if (text === null) return null;
  const payload = parsePayload(text);
  return SIGNED_STATE_PURPOSES.find((p) => p === payload?.p) ?? null;
}

export function createSignedStates({
  db,
  appSecret,
  now = () => new Date(),
  ttlMs = SIGNED_STATE_TTL_MS,
}: SignedStatesOptions): SignedStates {
  async function check(
    { purpose, value, userId, sessionId }: ConsumeStateInput,
    use: boolean,
  ): Promise<ConsumeStateResult> {
    const text = verifySignedValue(appSecret, "state-signing", value);
    if (text === null) return REFUSED;
    const payload = parsePayload(text);
    if (payload === null) return REFUSED;
    const at = now();
    const sessionHash = hashSession(sessionId);
    // Cheap checks first, and none of them uses up the nonce: only the person and the session that
    // started the flow can use it up.
    if (
      payload.p !== purpose ||
      payload.e <= at.getTime() ||
      payload.u !== userId ||
      payload.s !== sessionHash
    )
      return REFUSED;
    const workspaceId = payload.w ?? null;
    if (!use) {
      const row = await db
        .selectFrom("signed_states")
        .select(["code_verifier", "data"])
        .where("id", "=", payload.n)
        .where("purpose", "=", purpose)
        .where("user_id", "=", userId)
        .where("session_hash", "=", sessionHash)
        .where("used_at", "is", null)
        .where("expires_at", ">", formatTimestamp(at))
        .executeTakeFirst();
      if (row === undefined) return REFUSED;
      return {
        ok: true,
        codeVerifier: row.code_verifier,
        data: row.data === null ? null : decodeJson(row.data),
        workspaceId,
      };
    }
    // One guarded statement: the first presentation wins, on every instance.
    const row = await db
      .updateTable("signed_states")
      .set({ used_at: formatTimestamp(at) })
      .where("id", "=", payload.n)
      .where("purpose", "=", purpose)
      .where("user_id", "=", userId)
      .where("session_hash", "=", sessionHash)
      .where("used_at", "is", null)
      .where("expires_at", ">", formatTimestamp(at))
      .returning(["code_verifier", "data"])
      .executeTakeFirst();
    if (row === undefined) return REFUSED;
    return {
      ok: true,
      codeVerifier: row.code_verifier,
      data: row.data === null ? null : decodeJson(row.data),
      workspaceId,
    };
  }

  return {
    async issue({
      purpose,
      userId,
      sessionId,
      workspaceId,
      codeVerifier,
      data,
    }) {
      const nonce = randomBytes(16).toString("hex");
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + ttlMs);
      const sessionHash = hashSession(sessionId);
      await db
        .insertInto("signed_states")
        .values({
          id: nonce,
          purpose,
          user_id: userId,
          session_hash: sessionHash,
          code_verifier: codeVerifier ?? null,
          data: data === undefined ? null : encodeJson(data),
          created_at: formatTimestamp(issuedAt),
          expires_at: formatTimestamp(expiresAt),
          used_at: null,
        })
        .execute();
      const payload: Payload = {
        p: purpose,
        n: nonce,
        e: expiresAt.getTime(),
        u: userId,
        s: sessionHash,
        ...(workspaceId === undefined ? {} : { w: workspaceId }),
      };
      return signValue(appSecret, "state-signing", JSON.stringify(payload));
    },

    consume: (input) => check(input, true),
    peek: (input) => check(input, false),
  };
}
