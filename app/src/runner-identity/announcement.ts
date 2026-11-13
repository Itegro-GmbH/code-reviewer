// SPDX-License-Identifier: LicenseRef-Proprietary

// What a runner on a customer's machine says about itself (#854): its name, its labels, the version of the base, the manifest (the
// harnesses it announces, with their version and whether they are ready, and the capabilities such as `agent-docker`) and its limits.
// It comes from the runner, which is outside our control, so nothing here trusts a type: the check is pure, never throws and reports
// the fields that are wrong by name (`RunnerApiFieldError`-shaped, no value in it). A field the format does not know is dropped, so a
// newer runner can say more than this app reads; a field it does know and gets wrong is refused.
//
// The labels, the harness entries (#973: harness, auth and models) and the version are what the routing reads. The labels are lower case and sorted,
// so two runners that say the same thing store the same text.

import {
  ACCESS_AUTHS,
  DEVICE_AUTHS,
  legacyAccessOf,
  MODEL_NAME_PATTERN,
  MODELS_MAX,
  type AccessAuth,
  type HarnessAccess,
} from "./access.ts";

export type FieldIssue = { field: string; code: "required" | "invalid" };

export const LABELS_MAX = 20;
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,39}$/;
export const NAME_MAX_LENGTH = 80;
export const HARNESSES_MAX = 16;
export const CAPABILITIES_MAX = 16;
/** `opencode`, or `custom/name` for a harness the runner describes itself. */
export const HARNESS_NAME_PATTERN =
  /^[a-z][a-z0-9_-]{0,31}(?:\/[a-z0-9][a-z0-9_-]{0,31})?$/;
export const CAPABILITY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const HARNESS_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;
/** `1.4.0`, or `1.4.0-rc1`: three numbers and an optional pre-release tag. */
export const BASE_VERSION_PATTERN =
  /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

/** The limits a runner may report, each a whole number from 1 up. Any other key is dropped. */
export const LIMIT_KEYS = [
  "cpus",
  "memoryMb",
  "diskGb",
  "parallelRuns",
] as const;
const LIMIT_MAX = 1_000_000;

/**
 * What the runner adds to the base. `harnesses` is the list of entries (#973): an entry is announced only while the dispatcher can run it, so
 * "ready" is no field any more; a dispatcher that cannot run an entry for a while (all its subscriptions rate limited) leaves it out of its next
 * announcement, and the app uses the last one.
 */
export type RunnerManifest = {
  harnesses: HarnessAccess[];
  capabilities: string[];
};

export type RunnerLimits = Partial<Record<(typeof LIMIT_KEYS)[number], number>>;

export type Announcement = {
  labels: string[];
  baseVersion: string;
  manifest: RunnerManifest;
  limits: RunnerLimits;
};

export type AnnouncementCheck =
  { ok: true; value: Announcement } | { ok: false; fields: FieldIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// Control and format characters (bidi overrides, zero-width marks), private use and the line and paragraph separators: a name in the
// list and in the revoke dialog must look like what it is.
const CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;

/** A name for the list: one line of text, at most 80 characters. Null when it is not one. */
export function checkRunnerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name === "" || name.length > NAME_MAX_LENGTH) return null;
  if (CONTROL.test(name) || LONE_SURROGATE.test(name)) return null;
  return name;
}

/** The labels as stored: lower case, no duplicates, sorted. */
export function normalizeLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map((label) => label.trim().toLowerCase()))].sort();
}

/** One label on each line, as the database holds them. */
export function labelsToText(labels: readonly string[]): string {
  return labels.join("\n");
}

export function labelsFromText(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function checkLabels(
  value: unknown,
  issues: FieldIssue[],
): string[] | undefined {
  if (value === undefined) {
    issues.push({ field: "labels", code: "required" });
    return undefined;
  }
  if (!Array.isArray(value) || value.length > LABELS_MAX) {
    issues.push({ field: "labels", code: "invalid" });
    return undefined;
  }
  const labels: string[] = [];
  for (const [index, label] of value.entries()) {
    const text = typeof label === "string" ? label.trim().toLowerCase() : "";
    if (!LABEL_PATTERN.test(text)) {
      issues.push({ field: `labels[${String(index)}]`, code: "invalid" });
      continue;
    }
    labels.push(text);
  }
  return normalizeLabels(labels);
}

/** One entry of the list form: a harness with its version, the source of its access and, for a device's access, the models it allows. */
function checkHarnessEntry(
  entry: unknown,
  index: number,
  issues: FieldIssue[],
): HarnessAccess | undefined {
  const where = `manifest.harnesses[${String(index)}]`;
  if (!isRecord(entry)) {
    issues.push({ field: where, code: "invalid" });
    return undefined;
  }
  const { harness, version, auth, models } = entry;
  if (typeof harness !== "string" || !HARNESS_NAME_PATTERN.test(harness)) {
    issues.push({ field: `${where}.harness`, code: "invalid" });
    return undefined;
  }
  if (typeof version !== "string" || !HARNESS_VERSION_PATTERN.test(version)) {
    issues.push({ field: `${where}.version`, code: "invalid" });
    return undefined;
  }
  if (
    typeof auth !== "string" ||
    !(ACCESS_AUTHS as readonly string[]).includes(auth)
  ) {
    issues.push({ field: `${where}.auth`, code: "invalid" });
    return undefined;
  }
  const checked: HarnessAccess = { harness, version, auth: auth as AccessAuth };
  if (models === undefined) return checked;
  // Only an access that exists on the device says which models it allows: the app's catalog decides for a key of the app and for the platform's.
  if (
    !DEVICE_AUTHS.includes(checked.auth) ||
    !Array.isArray(models) ||
    models.length < 1 ||
    models.length > MODELS_MAX ||
    !models.every(
      (model) => typeof model === "string" && MODEL_NAME_PATTERN.test(model),
    )
  ) {
    issues.push({ field: `${where}.models`, code: "invalid" });
    return undefined;
  }
  checked.models = [...new Set(models as string[])].sort();
  return checked;
}

/** The old map form `{ "<harness>": { version, ready } }`: an entry that is ready is read as the access its harness had (see `legacyAccessOf`), one that is not is left out. */
function checkLegacyHarnesses(
  announced: Record<string, unknown>,
  issues: FieldIssue[],
): HarnessAccess[] {
  const entries: HarnessAccess[] = [];
  for (const [name, entry] of Object.entries(announced)) {
    // A name that is not of the form is not echoed: the field names only what the app itself would accept.
    if (!HARNESS_NAME_PATTERN.test(name)) {
      issues.push({ field: "manifest.harnesses", code: "invalid" });
      continue;
    }
    const where = `manifest.harnesses.${name}`;
    if (!isRecord(entry)) {
      issues.push({ field: where, code: "invalid" });
      continue;
    }
    const { version, ready } = entry;
    if (typeof version !== "string" || !HARNESS_VERSION_PATTERN.test(version))
      issues.push({ field: `${where}.version`, code: "invalid" });
    else if (typeof ready !== "boolean")
      issues.push({ field: `${where}.ready`, code: "invalid" });
    else if (ready) entries.push(legacyAccessOf(name, version));
  }
  return entries;
}

function checkHarnesses(
  announced: unknown,
  issues: FieldIssue[],
): HarnessAccess[] {
  if (Array.isArray(announced)) {
    if (announced.length > HARNESSES_MAX) {
      issues.push({ field: "manifest.harnesses", code: "invalid" });
      return [];
    }
    const entries: HarnessAccess[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of announced.entries()) {
      const checked = checkHarnessEntry(entry, index, issues);
      if (checked === undefined) continue;
      // A harness with one source of access is one entry: the same pair twice says nothing more and is not stored twice.
      const key = `${checked.harness}\n${checked.auth}`;
      if (seen.has(key))
        issues.push({
          field: `manifest.harnesses[${String(index)}]`,
          code: "invalid",
        });
      else entries.push(checked);
      seen.add(key);
    }
    return entries;
  }
  if (!isRecord(announced) || Object.keys(announced).length > HARNESSES_MAX) {
    issues.push({ field: "manifest.harnesses", code: "invalid" });
    return [];
  }
  return checkLegacyHarnesses(announced, issues);
}

function checkManifest(
  value: unknown,
  issues: FieldIssue[],
): RunnerManifest | undefined {
  if (value === undefined) return { harnesses: [], capabilities: [] };
  if (!isRecord(value)) {
    issues.push({ field: "manifest", code: "invalid" });
    return undefined;
  }
  const harnesses = checkHarnesses(value.harnesses ?? [], issues);
  const capabilities: string[] = [];
  const listed = value.capabilities ?? [];
  if (!Array.isArray(listed) || listed.length > CAPABILITIES_MAX)
    issues.push({ field: "manifest.capabilities", code: "invalid" });
  else
    for (const [index, capability] of listed.entries())
      if (
        typeof capability !== "string" ||
        !CAPABILITY_PATTERN.test(capability)
      )
        issues.push({
          field: `manifest.capabilities[${String(index)}]`,
          code: "invalid",
        });
      else capabilities.push(capability);
  return { harnesses, capabilities: [...new Set(capabilities)].sort() };
}

function checkLimits(
  value: unknown,
  issues: FieldIssue[],
): RunnerLimits | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    issues.push({ field: "limits", code: "invalid" });
    return undefined;
  }
  const limits: RunnerLimits = {};
  for (const key of LIMIT_KEYS) {
    const limit = value[key];
    if (limit === undefined) continue;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > LIMIT_MAX
    )
      issues.push({ field: `limits.${key}`, code: "invalid" });
    else limits[key] = limit;
  }
  return limits;
}

/** Checks the part of a body that every call of a runner can carry (the registration and the claim). */
export function checkAnnouncement(body: unknown): AnnouncementCheck {
  const fields: Record<string, unknown> = isRecord(body) ? body : {};
  const issues: FieldIssue[] = [];
  const labels = checkLabels(fields.labels, issues);
  const baseVersion = fields.baseVersion;
  if (baseVersion === undefined)
    issues.push({ field: "baseVersion", code: "required" });
  else if (
    typeof baseVersion !== "string" ||
    !BASE_VERSION_PATTERN.test(baseVersion)
  )
    issues.push({ field: "baseVersion", code: "invalid" });
  const manifest = checkManifest(fields.manifest, issues);
  const limits = checkLimits(fields.limits, issues);
  if (
    issues.length > 0 ||
    labels === undefined ||
    manifest === undefined ||
    limits === undefined
  )
    return { ok: false, fields: issues.slice(0, 10) };
  return {
    ok: true,
    value: { labels, baseVersion: baseVersion as string, manifest, limits },
  };
}

/** The manifest and limits as the database holds them (JSON text), and back. A stored text that does not read gives the empty value. */
export function manifestFromText(text: string): RunnerManifest {
  try {
    const checked = checkManifestOnly(JSON.parse(text) as unknown);
    return checked ?? { harnesses: [], capabilities: [] };
  } catch {
    return { harnesses: [], capabilities: [] };
  }
}

function checkManifestOnly(value: unknown): RunnerManifest | undefined {
  const issues: FieldIssue[] = [];
  const manifest = checkManifest(value, issues);
  return issues.length > 0 ? undefined : manifest;
}

export function limitsFromText(text: string): RunnerLimits {
  try {
    const issues: FieldIssue[] = [];
    const limits = checkLimits(JSON.parse(text) as unknown, issues);
    return issues.length > 0 || limits === undefined ? {} : limits;
  } catch {
    return {};
  }
}
