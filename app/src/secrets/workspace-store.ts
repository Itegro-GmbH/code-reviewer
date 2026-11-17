// SPDX-License-Identifier: LicenseRef-Proprietary

// The encrypted secrets of ONE workspace (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.7 and
// 2.8): today its own LLM key. The same rules as the store of the instance (store.ts), on the table
// `workspace_secrets`:
//
// - `save` encrypts with a key derived from `APP_SECRET` (AES-256-GCM, a random nonce every time). The
//   additional authenticated data is the table, the WORKSPACE ID and the name of the secret, so a ciphertext
//   copied to another workspace or another name does not decrypt.
// - A secret has a `binding`, what it was made for (the provider of an LLM key). It is stored beside the
//   secret and handed back with it, and the caller must compare it with what it is about to use the secret
//   for: a secret is never sent to another provider or endpoint than the one it was entered for.
// - `status` says whether a secret exists, whether it can still be read, and for what it was made. Never the
//   value; the only part of it that can appear is the last four characters, when the caller asked for them.
// - `use` hands the value to code on the server, wrapped in a `SecretValue` that prints as a placeholder. No
//   API route returns it.
//
// A secret that cannot be decrypted is the state `undecryptable` with a stable code. Nothing here throws for
// it and nothing here logs.
import type { Kysely } from "kysely";
import {
  decryptSecret,
  encryptSecret,
  SecretBoxError,
  type SecretBoxErrorCode,
  type SecretLocation,
} from "../crypto/secret-box.ts";
import {
  createWorkspaceSecretsRepository,
  type WorkspaceSecretRow,
} from "../db/repositories/workspace-secrets-repository.ts";
import type { Database } from "../db/schema.ts";
import { SecretValue } from "./secret-value.ts";
import {
  LAST_FOUR_MIN_LENGTH,
  SECRET_MAX_LENGTH,
  type SaveSecretResult,
} from "./store.ts";

const TABLE = "workspace_secrets";

function locationOf(workspaceId: string, name: string): SecretLocation {
  // The workspace id is the row id and the name the field: both are bound into the ciphertext.
  return { table: TABLE, rowId: workspaceId, field: name };
}

export type WorkspaceSecretStatus =
  | { name: string; state: "not_configured" }
  | {
      name: string;
      state: "configured";
      /** What the secret was made for (the provider of an LLM key). */
      binding: string;
      /** The last four characters, if the hint was asked for when it was saved; else null. */
      lastFour: string | null;
      keyVersion: number;
      updatedAt: string;
      updatedBy: string | null;
    }
  | {
      name: string;
      state: "undecryptable";
      binding: string;
      code: SecretBoxErrorCode;
      updatedAt: string;
      updatedBy: string | null;
    };

export type SaveWorkspaceSecretOptions = {
  /** What the secret is made for. It is checked again whenever the secret is used. */
  binding: string;
  /** The id of the user who saves it, or null. */
  updatedBy: string | null;
  /** Keep the last four characters in the clear, for the page to show (only for long values). */
  showLastFour?: boolean;
};

export type UseWorkspaceSecretResult =
  | { ok: true; value: SecretValue; binding: string }
  | {
      ok: false;
      error:
        | "secret_not_configured"
        | "secret_undecryptable"
        | "secret_key_version_unknown";
    };

/** The store of the secrets of one workspace, for the names `Name` (the application says which: they are not listed here). */
export type WorkspaceSecretStore<Name extends string = string> = {
  save(
    name: Name,
    value: string,
    options: SaveWorkspaceSecretOptions,
  ): Promise<SaveSecretResult>;
  status(name: Name): Promise<WorkspaceSecretStatus>;
  /** The value, for code on the server that needs it. Never hand it to a response. */
  use(name: Name): Promise<UseWorkspaceSecretResult>;
  /** Forgets the secret; false when there was none. */
  remove(name: Name): Promise<boolean>;
  /**
   * The value, and the secret is gone in the same step (one statement): of two callers that take it at once only one gets it. For a
   * secret that may be used once. The secret is gone even when it could not be read.
   */
  take(name: Name): Promise<UseWorkspaceSecretResult>;
  /** The names of the secrets the workspace holds (configured or not readable); never a value. */
  names(): Promise<string[]>;
};

export type WorkspaceSecretStoreOptions = {
  db: Kysely<Database>;
  /** The workspace whose secrets these are: every read and write is for this workspace only. */
  workspaceId: string;
  /** The master key (`APP_SECRET`). */
  appSecret: string;
  now?: () => Date;
};

function lastFourOf(value: string): string {
  return [...value].slice(-4).join("");
}

export function createWorkspaceSecretStore<Name extends string>({
  db,
  workspaceId,
  appSecret,
  now = () => new Date(),
}: WorkspaceSecretStoreOptions): WorkspaceSecretStore<Name> {
  const rows = createWorkspaceSecretsRepository(db, workspaceId, now);

  // Decrypts one row; the failure is a value, not an exception.
  function open(
    name: Name,
    row: WorkspaceSecretRow,
  ): { ok: true; value: string } | { ok: false; code: SecretBoxErrorCode } {
    try {
      return {
        ok: true,
        value: decryptSecret(appSecret, locationOf(workspaceId, name), {
          keyVersion: row.keyVersion,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
        }),
      };
    } catch (error) {
      if (error instanceof SecretBoxError)
        return { ok: false, code: error.code };
      // Whatever it was, the caller learns one thing and nothing of the input.
      return { ok: false, code: "secret_undecryptable" };
    }
  }

  return {
    async save(name, value, options) {
      if (value.trim() === "") return { ok: false, error: "secret_empty" };
      if (value.length > SECRET_MAX_LENGTH)
        return { ok: false, error: "secret_too_long" };
      const sealed = encryptSecret(
        appSecret,
        locationOf(workspaceId, name),
        value,
      );
      await rows.put({
        name,
        binding: options.binding,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        keyVersion: sealed.keyVersion,
        lastFour:
          options.showLastFour === true && value.length >= LAST_FOUR_MIN_LENGTH
            ? lastFourOf(value)
            : null,
        updatedBy: options.updatedBy,
      });
      return { ok: true };
    },

    async status(name) {
      const row = await rows.get(name);
      if (row === undefined) return { name, state: "not_configured" };
      const opened = open(name, row);
      if (!opened.ok)
        return {
          name,
          state: "undecryptable",
          binding: row.binding,
          code: opened.code,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        };
      return {
        name,
        state: "configured",
        binding: row.binding,
        lastFour: row.lastFour,
        keyVersion: row.keyVersion,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      };
    },

    async use(name) {
      const row = await rows.get(name);
      if (row === undefined)
        return { ok: false, error: "secret_not_configured" };
      const opened = open(name, row);
      if (!opened.ok) return { ok: false, error: opened.code };
      return {
        ok: true,
        value: new SecretValue(opened.value),
        binding: row.binding,
      };
    },

    async take(name) {
      const row = await rows.take(name);
      if (row === undefined)
        return { ok: false, error: "secret_not_configured" };
      const opened = open(name, row);
      if (!opened.ok) return { ok: false, error: opened.code };
      return {
        ok: true,
        value: new SecretValue(opened.value),
        binding: row.binding,
      };
    },

    remove: (name) => rows.remove(name),

    names: () => rows.names(),
  };
}
