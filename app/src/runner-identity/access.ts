// SPDX-License-Identifier: LicenseRef-Proprietary

// What a dispatcher can run, and what a job asks for (#973, Runner v2, ADR 0005, decision 4). The manifest of a dispatcher names, for each harness, the
// source of the access it has: `managed` (the platform's keys, the platform identity only), `app-key` (a key the workspace keeps in the app and the app
// hands to the Worker through the Worker API), `local-key` (an API key that exists only on the dispatcher's device) or `subscription` (a login that
// exists only on the device). A device-bound access (`local-key`, `subscription`) may also say which models it allows. The manifest never names a credential.
//
// A job asks for a harness, an auth and (for a device-bound access) a model. It is derived from what the job already carries: the harness of the turn's
// profile and the model it was started with. A dispatcher takes the job when one entry of its manifest has the harness, the auth and the model.
//
// There is ONE rule, written twice only because it runs in two places that cannot share code: `accessMatches` for a value in memory (the validator, the
// tests) and `accessRule` for the database (the claim and the pairing of the rings, which both use this fragment and nothing else). The integration test of
// this rule runs a table of cases through both and demands the same answer.
import { sql, type RawBuilder } from "kysely";
import { CLAUDE_CODE_HARNESS, OPENCODE_HARNESS } from "./harness.ts";

export const ACCESS_AUTHS = [
  "managed",
  "app-key",
  "local-key",
  "subscription",
] as const;
export type AccessAuth = (typeof ACCESS_AUTHS)[number];

/** The accesses that exist only on the dispatcher's device: only these say which models they allow. */
export const DEVICE_AUTHS: readonly AccessAuth[] = [
  "local-key",
  "subscription",
];

/** The auth only the platform identity may announce. */
export const MANAGED_AUTH: AccessAuth = "managed";

/** The harnesses that run on a login of the device, never on a key of the app: their access is a subscription. */
export const SUBSCRIPTION_HARNESSES: readonly string[] = [CLAUDE_CODE_HARNESS];

export const MODELS_MAX = 64;
/** A model as a harness reads it (`sonnet`, `claude-sonnet-5-5`, `vendor/model-name`). */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/;

/** One entry of the manifest: a harness with one source of access. */
export type HarnessAccess = {
  harness: string;
  version: string;
  auth: AccessAuth;
  /** The models this access allows; only for `local-key` and `subscription`. Left out: the device allows any the harness reads. */
  models?: string[];
};

/** What a job asks for. `auth` null: any (a job that no turn describes asks only for the harness); `model` null: no model to match. */
export type AccessDemand = {
  harness: string;
  auth: AccessAuth | null;
  model: string | null;
};

/** The entries of the platform's own dispatcher. It does not announce them (`PUT /self` is the customers'): this is its manifest, in one place. */
export const PLATFORM_ACCESS: readonly HarnessAccess[] = [
  // The version is the one the platform's image pins (`runner/opencode-pin.json`); the app does not read it.
  { harness: OPENCODE_HARNESS, version: "pinned", auth: "managed" },
  { harness: OPENCODE_HARNESS, version: "pinned", auth: "app-key" },
];

export type ReservedAccessIssue = { field: string; code: "reserved" };

/**
 * The entries of an announcement that claim the auth `managed`, by position in the body (a value that is no entry is the form check's). Only the
 * platform identity has the platform's keys, and nothing in the registration API is that identity: a customer's runner is refused whatever it says.
 */
export function reservedAccessIssues(manifest: unknown): ReservedAccessIssue[] {
  const harnesses =
    typeof manifest === "object" && manifest !== null
      ? (manifest as Record<string, unknown>).harnesses
      : undefined;
  if (!Array.isArray(harnesses)) return [];
  const issues: ReservedAccessIssue[] = [];
  for (const [index, entry] of harnesses.entries())
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).auth === MANAGED_AUTH
    )
      issues.push({
        field: `manifest.harnesses[${String(index)}].auth`,
        code: "reserved",
      });
  return issues;
}

/** The entries a manifest written in the old map form (`{ "<harness>": { version, ready } }`) says: OpenCode runs on a key of the app, Claude Code on a subscription. */
export function legacyAccessOf(
  harness: string,
  version: string,
): HarnessAccess {
  return {
    harness,
    version,
    auth: SUBSCRIPTION_HARNESSES.includes(harness) ? "subscription" : "app-key",
  };
}

/** Whether a manifest announces the harness in any way: the base of every runner announces OpenCode. */
export function announcesHarness(
  entries: readonly HarnessAccess[],
  harness: string,
): boolean {
  return entries.some((entry) => entry.harness === harness);
}

/** The auth a turn asks for: a harness on a login is a subscription; a model of the catalog is the platform's (`managed`); any other is a key of the workspace. */
export function authOfTurn(
  harness: string,
  modelChoice: { entryId: string } | { provider: string; model: string },
): AccessAuth {
  if (SUBSCRIPTION_HARNESSES.includes(harness)) return "subscription";
  return "entryId" in modelChoice ? "managed" : "app-key";
}

/** What a turn of the Implementer asks for, from its profile's harness (null: OpenCode) and the model it was started with. */
export function demandOfTurn(turn: {
  harness?: string | null;
  modelChoice: { entryId: string } | { provider: string; model: string };
}): AccessDemand {
  const harness = turn.harness ?? OPENCODE_HARNESS;
  const auth = authOfTurn(harness, turn.modelChoice);
  return {
    harness,
    auth,
    model:
      auth === "subscription" && "model" in turn.modelChoice
        ? turn.modelChoice.model
        : null,
  };
}

/**
 * What a profile version asks for, from the facts the validator holds of it: the harness, whether its model is the platform's (a catalog entry) and,
 * for a harness on a login, the model name Claude Code reads. The same derivation as `demandOfTurn`, from what the profile says before a turn exists.
 */
export function demandOfProfile(profile: {
  harness?: string | null;
  managedModel?: boolean;
  model?: string | null;
}): AccessDemand {
  const harness = profile.harness ?? OPENCODE_HARNESS;
  const auth: AccessAuth = SUBSCRIPTION_HARNESSES.includes(harness)
    ? "subscription"
    : profile.managedModel === true
      ? MANAGED_AUTH
      : "app-key";
  return {
    harness,
    auth,
    model: auth === "subscription" ? (profile.model ?? null) : null,
  };
}

/** Whether a demand can run on a customer's runner at all: a managed model is the platform's and never leaves for a device (`runner_needs_own_key`). */
export function runnerCanServe(demand: AccessDemand): boolean {
  return demand.auth !== MANAGED_AUTH;
}

/** The rule in memory: one entry has the harness, the auth and, when the demand names a model, allows it. */
export function accessMatches(
  entries: readonly HarnessAccess[],
  demand: AccessDemand,
): boolean {
  return entries.some(
    (entry) =>
      entry.harness === demand.harness &&
      (demand.auth === null || entry.auth === demand.auth) &&
      (demand.model === null ||
        entry.models === undefined ||
        entry.models.includes(demand.model)),
  );
}

/** The entries as a JSON parameter for `accessRule`. */
export function entriesParam(
  entries: readonly HarnessAccess[],
): RawBuilder<unknown> {
  return sql`${JSON.stringify(entries)}::jsonb`;
}

/**
 * What a customer's runner can run: its announced entries without any `managed` one. The registration refuses `managed` (`reservedAccessIssues`), but a
 * stored row is read again at every claim and ring, and the platform's keys must not depend on what the table once held (a row written by hand, by an
 * older release or by a bug). The claim and the pairing of the rings both read the manifest with `manifestFromText` and pass it through this.
 */
export function customerAccess(
  entries: readonly HarnessAccess[],
): HarnessAccess[] {
  return entries.filter((entry) => entry.auth !== MANAGED_AUTH);
}

/** The expressions of the demand of a turn of the Implementer, by the alias of its row in `implementer_turns` (the same derivation as `demandOfTurn`). */
function turnDemand(turn: string) {
  const harness = sql`coalesce(${sql.ref(`${turn}.profile_harness`)}, ${OPENCODE_HARNESS})`;
  // `json_or_null`: one turn whose stored choice is no JSON matches no dispatcher (see `accessRule`) and does not fail the statement for the others.
  const choice = sql`json_or_null(${sql.ref(`${turn}.model_choice`)})`;
  const subscription = sql`${harness} = any(array[${sql.join(
    SUBSCRIPTION_HARNESSES.map((name) => sql`${name}`),
    sql`, `,
  )}]::text[])`;
  const auth = sql`(case when ${subscription} then 'subscription' when ${choice} ->> 'entryId' is not null then ${MANAGED_AUTH} else 'app-key' end)`;
  const model = sql`(case when ${subscription} then ${choice} ->> 'model' else null end)`;
  return { harness, auth, model, choice };
}

/**
 * The rule in the database: the dispatcher whose entries are `entries` (a jsonb list from `entriesParam`) can run the turn in the row `turn` of
 * `implementer_turns`. The claim and the pairing of the rings both write their condition with this and nothing else. A turn whose `model_choice` is
 * not a JSON object is nobody's.
 */
export function accessRule(
  entries: RawBuilder<unknown>,
  turn: string,
): RawBuilder<boolean> {
  const demand = turnDemand(turn);
  return sql<boolean>`exists (
    select 1 from jsonb_array_elements(${entries}) as announced
    where jsonb_typeof(${demand.choice}) = 'object'
      and announced ->> 'harness' = ${demand.harness}
      and announced ->> 'auth' = ${demand.auth}
      and (${demand.model} is null
        or announced -> 'models' is null
        or announced -> 'models' @> to_jsonb(${demand.model}::text))
  )`;
}
