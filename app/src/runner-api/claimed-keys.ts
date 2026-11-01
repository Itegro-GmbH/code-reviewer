// SPDX-License-Identifier: LicenseRef-Proprietary

// Remembers which LLM keys were handed to the runner with the claim of a job. The key can be rotated while a job
// runs, and the runner's log may then hold the old key: to mask it in the result the app needs the key of the
// claim as well as the current one. A job can be handed a key more than once (a claim again after a lost lease, the
// fetches of a Worker, #276), and the operator's key can be rotated in between, so **every key handed out for the job
// is kept**, up to `CLAIMED_KEYS_PER_JOB` (the fetch budget of a claim); past that the oldest is forgotten. A key
// that is already remembered takes no new place.
//
// The key is kept in the DATABASE, encrypted like every secret (AES-256-GCM, a key derived from `APP_SECRET`,
// the table, the id of the job and the field bound into the ciphertext; the sealed text is the JSON list of the keys,
// and a row of the earlier format, one plain key, is still read), so any app instance can mask a result,
// not only the one that handed the key out (docs/decisions/0001-editions-setup-and-accounts.md, section 2.10).
// The row goes with its job, and the cleanup removes the rows of jobs that finished long ago
// (src/maintenance/cleanup.ts). A key is not forgotten when its job completes: a repeated completion is compared
// on the stored form and must be masked the same way.
//
// #280: next to the keys it remembers the **models** a job was handed on the operator's key (the catalog entries) (`models` in the
// same sealed text). The id of an entry's model is operator data that a workspace must never read, and the runner's
// result may repeat it (the model it reports, a log line); the operator can change an entry at any time, so the model
// the job really got is kept to mask it in the result, whichever app instance serves the completion. An app instance
// of the previous release reads `keys` and ignores `models`.
//
// #578: and whether the claim handed the job a **native** model entry (`native` in the same sealed text), so that the report
// holds a native run to the rules of one (a managed success reports its cost) however the switch of the native path stands by then.
//
// #753: and the **write tokens** a turn of the Implementer was handed (`gitTokens` in the same sealed text, each with the time it
// expires), so that the app can switch them off at the platform when the turn is over, however it ends and whichever app instance
// serves the end. A token is forgotten (`forgetGitTokens`) only after the platform said it is off, or once it has expired on its own:
// one that could not be switched off stays, and is tried again (`write-token.ts`) until then. An app instance of the previous
// release ignores the field.
//
// Every change reads the row under `FOR UPDATE` and writes it back in the same transaction (#790), so two app instances
// changing it at once take turns and neither drops the other's key, model, flag or token.
//
// The value is never logged and never leaves this module except as the lists `keysOf`, `modelsOf` and `gitTokensOf` return
// to the code that masks a result or ends a token. A row that cannot be read (another `APP_SECRET`, a changed row) is skipped: masking is best
// effort, and the shape of a credential is still masked (`redact.ts`).
import type { Kysely } from "kysely";
import { decryptSecret, encryptSecret } from "../crypto/secret-box.ts";
import { createJobClaimedKeysRepository } from "../db/repositories/job-claimed-keys-repository.ts";
import type { Database } from "../db/schema.ts";

const TABLE = "job_claimed_keys";
const FIELD = "api_key";

/** How many keys are remembered for one job: the fetches of one claim (`MAX_WORKER_FETCHES`). */
export const CLAIMED_KEYS_PER_JOB = 3;

export type ClaimedKeys = {
  /**
   * Remembers a key a runner got for `jobId`, next to those handed out for it before (the oldest is forgotten past
   * `CLAIMED_KEYS_PER_JOB`; a key already remembered is not added again).
   */
  remember(jobId: string, apiKey: string): Promise<void>;
  /** The keys handed out for the job, oldest first (empty if unknown or unreadable). */
  keysOf(jobId: string): Promise<string[]>;
  /**
   * Remembers the model of a managed entry that `jobId` was handed (#280), next to those handed out for it before
   * (at most `CLAIMED_KEYS_PER_JOB`, a model already remembered takes no new place).
   */
  rememberModel(jobId: string, model: string): Promise<void>;
  /** The entry models handed out for the job, oldest first (empty if none, unknown or unreadable). */
  modelsOf(jobId: string): Promise<string[]>;
  /**
   * Remembers whether the claim handed the job a native model entry (#578). What the report applies to a native run (a
   * managed success with no cost is not a success) is decided by this, not by the switch of the moment the report arrives:
   * the switch may have been turned off while the run was going. Every claim and every Worker fetch writes it, `false`
   * included: a job claimed again after the switch was turned off is no longer native.
   */
  rememberNative(jobId: string, native: boolean): Promise<void>;
  /** Whether the claim handed the job a native model entry (false if unknown or unreadable). */
  wasNative(jobId: string): Promise<boolean>;
  /**
   * Remembers a write token handed to the Worker of an implementer job (#753) with the time it expires (ISO 8601), next to those
   * handed out for it before. None is ever dropped to make room: a token that is not remembered is never switched off.
   */
  rememberGitToken(
    jobId: string,
    token: string,
    expiresAt: string,
  ): Promise<void>;
  /** The write tokens remembered for the job, oldest first (empty if none, unknown or unreadable). */
  gitTokensOf(jobId: string): Promise<GitTokenEntry[]>;
  /** Whether any write token is remembered for the job, expired or not: whether an input was ever handed out. */
  hasGitTokens(jobId: string): Promise<boolean>;
  /** Forgets these write tokens (they are off, or expired) and keeps every other one, including one remembered meanwhile. */
  forgetGitTokens(jobId: string, tokens: readonly string[]): Promise<void>;
};

/** A write token and when it expires on its own (ISO 8601). */
export type GitTokenEntry = { token: string; expiresAt: string };

type Sealed = {
  keys: string[];
  models: string[];
  native: boolean;
  gitTokens: GitTokenEntry[];
};

function emptySealed(): Sealed {
  return { keys: [], models: [], native: false, gitTokens: [] };
}

function gitTokenEntries(value: unknown): GitTokenEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: GitTokenEntry[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { token, expiresAt } = entry as Record<string, unknown>;
    if (typeof token !== "string" || typeof expiresAt !== "string")
      return undefined;
    entries.push({ token, expiresAt });
  }
  return entries;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string")
    ? value
    : undefined;
}

/** The lists in a sealed text: the current format, or the one plain key of the earlier one. */
function contentOf(text: string): Sealed {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "keys" in parsed) {
      const keys = strings(parsed.keys);
      if (keys !== undefined) {
        const models = "models" in parsed ? strings(parsed.models) : undefined;
        const native = "native" in parsed && parsed.native === true;
        const gitTokens =
          "gitTokens" in parsed ? gitTokenEntries(parsed.gitTokens) : undefined;
        return {
          keys,
          models: models ?? [],
          native,
          gitTokens: gitTokens ?? [],
        };
      }
    }
  } catch {
    // Not JSON: a key of the earlier format.
  }
  return { keys: [text], models: [], native: false, gitTokens: [] };
}

export function createClaimedKeys({
  db,
  appSecret,
  now = () => new Date(),
}: {
  db: Kysely<Database>;
  /** The master key (`APP_SECRET`), asked for when a key is stored or read. */
  appSecret: () => string;
  now?: () => Date;
}): ClaimedKeys {
  const location = (jobId: string) => ({
    table: TABLE,
    rowId: jobId,
    field: FIELD,
  });
  function open(
    jobId: string,
    row: { keyVersion: number; nonce: string; ciphertext: string },
  ): Sealed {
    try {
      return contentOf(
        decryptSecret(appSecret(), location(jobId), {
          keyVersion: row.keyVersion,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
        }),
      );
    } catch {
      return emptySealed();
    }
  }
  async function read(
    rows: ReturnType<typeof createJobClaimedKeysRepository>,
    jobId: string,
  ): Promise<Sealed> {
    const row = await rows.get(jobId);
    return row === undefined ? emptySealed() : open(jobId, row);
  }
  /**
   * Changes what is remembered and writes all of it, in one transaction that holds the row of the job locked from the read to the
   * write: two instances changing it at the same time take turns and neither drops the other's change (#753; at READ COMMITTED
   * the plain read-modify-write lost one of two concurrent changes). A job without a row gets an empty one first, so there is a
   * row to lock.
   */
  async function update(
    jobId: string,
    change: (known: Sealed) => Sealed,
  ): Promise<void> {
    const empty = encryptSecret(
      appSecret(),
      location(jobId),
      JSON.stringify({ keys: [], models: [], native: false, gitTokens: [] }),
    );
    await db.transaction().execute(async (trx) => {
      const rows = createJobClaimedKeysRepository(trx, now);
      await rows.putIfAbsent({
        jobId,
        ciphertext: empty.ciphertext,
        nonce: empty.nonce,
        keyVersion: empty.keyVersion,
      });
      const locked = await rows.getForUpdate(jobId);
      const known = locked === undefined ? emptySealed() : open(jobId, locked);
      const sealed = encryptSecret(
        appSecret(),
        location(jobId),
        JSON.stringify(change(known)),
      );
      await rows.put({
        jobId,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        keyVersion: sealed.keyVersion,
      });
    });
  }
  /** Adds a value to one of the lists: the newest `CLAIMED_KEYS_PER_JOB` are kept, a value already there takes no place. */
  const add = (jobId: string, list: "keys" | "models", value: string) =>
    update(jobId, (known) => ({
      ...known,
      [list]: known[list].includes(value)
        ? known[list]
        : [...known[list], value].slice(-CLAIMED_KEYS_PER_JOB),
    }));
  return {
    remember: (jobId, apiKey) => add(jobId, "keys", apiKey),
    rememberModel: (jobId, model) => add(jobId, "models", model),
    keysOf: async (jobId) =>
      (await read(createJobClaimedKeysRepository(db, now), jobId)).keys,
    modelsOf: async (jobId) =>
      (await read(createJobClaimedKeysRepository(db, now), jobId)).models,
    rememberNative: (jobId, native) =>
      update(jobId, (known) => ({ ...known, native })),
    wasNative: async (jobId) =>
      (await read(createJobClaimedKeysRepository(db, now), jobId)).native,
    rememberGitToken: (jobId, token, expiresAt) =>
      update(jobId, (known) => ({
        ...known,
        gitTokens: known.gitTokens.some((entry) => entry.token === token)
          ? known.gitTokens
          : [...known.gitTokens, { token, expiresAt }],
      })),
    gitTokensOf: async (jobId) =>
      (await read(createJobClaimedKeysRepository(db, now), jobId)).gitTokens,
    hasGitTokens: async (jobId) =>
      (await read(createJobClaimedKeysRepository(db, now), jobId)).gitTokens
        .length > 0,
    forgetGitTokens: (jobId, tokens) =>
      update(jobId, (known) => ({
        ...known,
        gitTokens: known.gitTokens.filter(
          (entry) => !tokens.includes(entry.token),
        ),
      })),
  };
}
