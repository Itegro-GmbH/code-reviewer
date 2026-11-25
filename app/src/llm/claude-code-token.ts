// SPDX-License-Identifier: LicenseRef-Proprietary

// The Claude Code OAuth token of ONE workspace (#1150): what `claude setup-token` prints and Claude Code reads as
// `CLAUDE_CODE_OAUTH_TOKEN`. It is kept like the LLM keys of the workspace, in its own slot of the encrypted store of the
// workspace (`src/secrets/workspace-store.ts`; AES-256-GCM, bound to the workspace and the slot) and it is a secret of the
// same kind: write-only (the answers hold the last four characters of it for an Admin or an Owner and nothing else), never
// logged, never in a result or a snapshot (`currentKeysFor` masks it with the keys), and removed with its workspace.
//
// It is **not an LLM provider**: it has no models to list, no price and no address of ours to ask, so it is not a member of
// the registry (`src/llm/providers/`) and no part of the page, the selection or the claim that works on providers sees it.
// Only the runs of the harness `claude-code` read it (`tokenForJob`), and only the Worker that holds such a job receives it.
//
// Owner decision 2026-11-25 (issue #1150): a workspace stores the token the way a repository stores a secret for its CI,
// and **no further restriction** applies: no scope per person, no limit on who may start a run that uses it. Whoever may
// manage the LLM keys of the workspace (`manage_llm_key`) may set it, replace it and remove it.
import type { WorkspaceSecretStore } from "../secrets/workspace-store.ts";
import type { SecretValue } from "../secrets/secret-value.ts";

/** The slot of the token in the encrypted store of the workspace. The name never changes: the ciphertext is bound to it. */
export const CLAUDE_CODE_TOKEN_SECRET_NAME = "claude_code_oauth_token";
export type ClaudeCodeTokenSecretName = typeof CLAUDE_CODE_TOKEN_SECRET_NAME;

/** What the token is made for (the binding stored beside it, compared again when it is used). */
export const CLAUDE_CODE_TOKEN_BINDING = "claude-code";

/** The runner reads one printable token of at most this many characters (`implementer/claude_code/login.py`). */
export const CLAUDE_CODE_TOKEN_MAX_CHARS = 4096;

/** What `claude setup-token` prints today: `sk-ant-oat01-…`. Only the test button says whether a token has this shape. */
const KNOWN_SHAPE = /^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{16,}$/;

export const CLAUDE_CODE_TOKEN_ISSUE_CODES = [
  /** The token is not text, or has whitespace, a control or a non-ASCII character in it, or is too long. */
  "token_invalid",
  /** There is no token stored (or it cannot be read) and the field is empty. */
  "token_required",
] as const;
export type ClaudeCodeTokenIssueCode =
  (typeof CLAUDE_CODE_TOKEN_ISSUE_CODES)[number];

export type ClaudeCodeTokenIssue = {
  field: "token";
  code: ClaudeCodeTokenIssueCode;
};

/** What the page may know about the token. Never the token. */
export type ClaudeCodeTokenStatus =
  | { state: "not_configured" }
  | {
      state: "configured";
      /** The last four characters, or null. */
      lastFour: string | null;
      updatedAt: string;
      updatedBy: string | null;
    }
  | { state: "unreadable"; updatedAt: string; updatedBy: string | null };

export type SaveClaudeCodeTokenResult =
  | { ok: true; status: ClaudeCodeTokenStatus; changed: boolean }
  | { ok: false; issues: ClaudeCodeTokenIssue[] };

export type RevealedClaudeCodeToken =
  | { ok: true; token: SecretValue }
  | {
      ok: false;
      reason: "no_token" | "token_unreadable" | "token_binding_mismatch";
    };

/** The token as a claim needs it: like `WorkspaceKeyForJob` for the keys, so a stored token that cannot be used is never ignored silently. */
export type ClaudeCodeTokenForJob =
  | { state: "none" }
  | { state: "unreadable" }
  | { state: "token"; token: string };

export type ClaudeCodeTokenService = {
  status(): Promise<ClaudeCodeTokenStatus>;
  /** Saves `token` (as the request had it); an empty or missing token keeps the stored one. */
  save(
    token: unknown,
    updatedBy: string | null,
  ): Promise<SaveClaudeCodeTokenResult>;
  /** Removes the token; false when there was none. */
  remove(): Promise<boolean>;
  /** The token, for code on the server that sends it to a Worker or checks it. Never hand it to a response. */
  reveal(): Promise<RevealedClaudeCodeToken>;
  tokenForJob(): Promise<ClaudeCodeTokenForJob>;
};

/**
 * The one rule for a token: surrounding whitespace is ignored; what is left is one printable ASCII token without a space, of at most
 * 4096 characters. It is the rule the runner reads the token with, so a token saved here is a token the runner accepts, and a paste
 * accident (a line break, a second token, a quoted string) is refused here and not as a failed run. Never puts the value into the result.
 */
export function checkClaudeCodeToken(
  raw: unknown,
): { ok: true; token: string } | { ok: false } {
  if (typeof raw !== "string") return { ok: false };
  const value = raw.trim();
  if (
    value === "" ||
    value.length > CLAUDE_CODE_TOKEN_MAX_CHARS ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    return { ok: false };
  return { ok: true, token: value };
}

/** Whether the token has the shape `claude setup-token` prints (`sk-ant-oat01-…`). A token of another shape may still work. */
export function hasKnownTokenShape(token: string): boolean {
  return KNOWN_SHAPE.test(token);
}

function isEmpty(raw: unknown): boolean {
  return (
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "")
  );
}

export function createClaudeCodeTokenService({
  store,
}: {
  store: WorkspaceSecretStore<ClaudeCodeTokenSecretName>;
}): ClaudeCodeTokenService {
  async function status(): Promise<ClaudeCodeTokenStatus> {
    const stored = await store.status(CLAUDE_CODE_TOKEN_SECRET_NAME);
    switch (stored.state) {
      case "not_configured":
        return { state: "not_configured" };
      case "configured":
        return {
          state: "configured",
          lastFour: stored.lastFour,
          updatedAt: stored.updatedAt,
          updatedBy: stored.updatedBy,
        };
      case "undecryptable":
        return {
          state: "unreadable",
          updatedAt: stored.updatedAt,
          updatedBy: stored.updatedBy,
        };
    }
  }

  async function reveal(): Promise<RevealedClaudeCodeToken> {
    const used = await store.use(CLAUDE_CODE_TOKEN_SECRET_NAME);
    if (!used.ok)
      return {
        ok: false,
        reason:
          used.error === "secret_not_configured"
            ? "no_token"
            : "token_unreadable",
      };
    if (used.binding !== CLAUDE_CODE_TOKEN_BINDING)
      return { ok: false, reason: "token_binding_mismatch" };
    return { ok: true, token: used.value };
  }

  return {
    status,
    reveal,

    async save(token, updatedBy) {
      if (isEmpty(token)) {
        const current = await status();
        if (current.state !== "configured")
          return {
            ok: false,
            issues: [{ field: "token", code: "token_required" }],
          };
        return { ok: true, status: current, changed: false };
      }
      const checked = checkClaudeCodeToken(token);
      if (!checked.ok)
        return {
          ok: false,
          issues: [{ field: "token", code: "token_invalid" }],
        };
      const saved = await store.save(
        CLAUDE_CODE_TOKEN_SECRET_NAME,
        checked.token,
        {
          binding: CLAUDE_CODE_TOKEN_BINDING,
          updatedBy,
          showLastFour: true,
        },
      );
      // The token passed the checks above, so the store has nothing to refuse; keep the answer honest anyway.
      if (!saved.ok)
        return {
          ok: false,
          issues: [{ field: "token", code: "token_invalid" }],
        };
      return { ok: true, status: await status(), changed: true };
    },

    remove: () => store.remove(CLAUDE_CODE_TOKEN_SECRET_NAME),

    async tokenForJob() {
      const revealed = await reveal();
      if (revealed.ok)
        return { state: "token", token: revealed.token.reveal() };
      return revealed.reason === "no_token"
        ? { state: "none" }
        : { state: "unreadable" };
    },
  };
}
