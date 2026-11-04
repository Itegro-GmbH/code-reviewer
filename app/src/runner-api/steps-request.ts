// SPDX-License-Identifier: LicenseRef-Proprietary

// The checks on a steps request (#745): the batch of records the runner sends while a turn of the Implementer runs. Written by
// hand like requests.ts, and held to `contracts/runner-api.v1.json` (`StepsRequest`, `StepRecord`) by the contract test, which
// requires the same verdict as the schema for a set of good and bad bodies. A refusal lists fields and reasons, never values:
// the records hold what an agent wrote.
//
// Three things are deliberate. A record of a kind this app does not know is not an error: it is counted and left out, because a
// newer runner may send more kinds and a refusal of the whole batch would lose the records beside it. For the same reason the
// fields of such a record are not looked at beyond the ones every record has (`kind`, `partId`, `seq`, `startedAt`, `endedAt`):
// a kind of another shape cannot make the batch fail. And a field the schema does not know is ignored, not refused; only the
// known fields are kept.
import {
  STEP_KINDS,
  STEPS_LIMITS,
  type FieldError,
  type FieldErrorCode,
  type StepRecord,
  type StepTokens,
} from "./contract.ts";
import {
  LEASE_TOKEN_LENGTH,
  isRecord,
  lengthOf,
  type Parsed,
} from "./requests.ts";

/** The part ids the engine makes (`prt_...`); anything else cannot be a key and is refused. */
export const STEP_PART_ID = /^[A-Za-z0-9_.:@-]{1,256}$/;
/** The kind of a record: a lower case word; whether this app knows it is a separate question. */
export const STEP_KIND = /^[a-z][a-z-]{0,31}$/;

/** A batch as read: the records of the kinds the app knows, and how many of another kind were left out. */
export type ParsedSteps = { records: StepRecord[]; unknownKind: number };

type Fields = Record<string, unknown>;

class Problems {
  readonly fields: FieldError[] = [];

  fail(field: string, code: FieldErrorCode): undefined {
    this.fields.push({ field, code });
    return undefined;
  }

  /** A string of at most `max` characters, or left out when `optional`. */
  string(
    source: Fields,
    key: string,
    field: string,
    max: number,
    optional: boolean,
  ): string | undefined {
    const value = source[key];
    if (value === undefined)
      return optional ? undefined : this.fail(field, "required");
    if (typeof value !== "string") return this.fail(field, "invalid");
    if (lengthOf(value) > max) return this.fail(field, "too_long");
    return value;
  }

  /** An integer from `min` to `max`, or left out when `optional`. */
  integer(
    source: Fields,
    key: string,
    field: string,
    range: { min: number; max: number },
    optional: boolean,
  ): number | undefined {
    const value = source[key];
    if (value === undefined)
      return optional ? undefined : this.fail(field, "required");
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < range.min ||
      value > range.max
    )
      return this.fail(field, "invalid");
    return value;
  }
}

function parseTokens(
  problems: Problems,
  value: unknown,
  field: string,
): StepTokens | undefined {
  if (!isRecord(value)) return problems.fail(field, "invalid");
  const range = { min: 0, max: STEPS_LIMITS.count };
  const before = problems.fields.length;
  const tokens = {
    input: problems.integer(value, "input", `${field}.input`, range, false),
    output: problems.integer(value, "output", `${field}.output`, range, false),
    reasoning: problems.integer(
      value,
      "reasoning",
      `${field}.reasoning`,
      range,
      false,
    ),
    cacheRead: problems.integer(
      value,
      "cacheRead",
      `${field}.cacheRead`,
      range,
      false,
    ),
    cacheWrite: problems.integer(
      value,
      "cacheWrite",
      `${field}.cacheWrite`,
      range,
      false,
    ),
  };
  if (problems.fields.length > before) return undefined;
  return tokens as StepTokens;
}

/**
 * One record; `undefined` when it is refused (the reasons are in `problems`). Only the fields the contract knows are kept; a
 * record of a kind the app does not know is read as far as the fields every record has.
 */
function parseRecord(
  problems: Problems,
  value: unknown,
  at: string,
): StepRecord | undefined {
  if (!isRecord(value)) return problems.fail(at, "invalid");
  const before = problems.fields.length;
  const kind = value.kind;
  if (kind === undefined) problems.fail(`${at}.kind`, "required");
  else if (typeof kind !== "string" || !STEP_KIND.test(kind))
    problems.fail(`${at}.kind`, "invalid");
  const partId = value.partId;
  if (partId === undefined) problems.fail(`${at}.partId`, "required");
  else if (typeof partId !== "string" || !STEP_PART_ID.test(partId))
    problems.fail(`${at}.partId`, "invalid");
  const seq = problems.integer(
    value,
    "seq",
    `${at}.seq`,
    { min: 1, max: STEPS_LIMITS.seq },
    false,
  );
  const time = { min: 0, max: STEPS_LIMITS.epochMs };
  const startedAt = problems.integer(
    value,
    "startedAt",
    `${at}.startedAt`,
    time,
    true,
  );
  const endedAt = problems.integer(
    value,
    "endedAt",
    `${at}.endedAt`,
    time,
    true,
  );
  // A kind the app does not know: the common fields are all that is read, the rest is dropped unread (`KnownStepFields`).
  const known =
    typeof kind === "string" &&
    (STEP_KINDS as readonly string[]).includes(kind);
  if (typeof kind === "string" && !known) {
    if (
      problems.fields.length > before ||
      typeof partId !== "string" ||
      seq === undefined
    )
      return undefined;
    return {
      kind,
      partId,
      seq,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
    };
  }
  const text = problems.string(
    value,
    "text",
    `${at}.text`,
    STEPS_LIMITS.textChars,
    true,
  );
  const bytes = problems.integer(
    value,
    "bytes",
    `${at}.bytes`,
    { min: 0, max: Number.MAX_SAFE_INTEGER },
    true,
  );
  const tool = problems.string(
    value,
    "tool",
    `${at}.tool`,
    STEPS_LIMITS.toolChars,
    true,
  );
  const status = problems.string(
    value,
    "status",
    `${at}.status`,
    STEPS_LIMITS.statusChars,
    true,
  );
  const title = problems.string(
    value,
    "title",
    `${at}.title`,
    STEPS_LIMITS.titleChars,
    true,
  );
  const input = problems.string(
    value,
    "input",
    `${at}.input`,
    STEPS_LIMITS.inputChars,
    true,
  );
  const error = problems.string(
    value,
    "error",
    `${at}.error`,
    STEPS_LIMITS.errorChars,
    true,
  );
  const reason = problems.string(
    value,
    "reason",
    `${at}.reason`,
    STEPS_LIMITS.reasonChars,
    true,
  );
  const tokens =
    value.tokens === undefined
      ? undefined
      : parseTokens(problems, value.tokens, `${at}.tokens`);
  let cost: number | undefined;
  if (value.cost !== undefined) {
    if (
      typeof value.cost !== "number" ||
      !Number.isFinite(value.cost) ||
      value.cost < 0 ||
      value.cost > STEPS_LIMITS.cost
    )
      problems.fail(`${at}.cost`, "invalid");
    else cost = value.cost;
  }
  // What a kind needs to be shown at all (the `allOf` of the schema).
  if (kind === "reasoning" || kind === "text") {
    if (value.text === undefined) problems.fail(`${at}.text`, "required");
  } else if (kind === "tool") {
    if (value.tool === undefined) problems.fail(`${at}.tool`, "required");
    if (value.status === undefined) problems.fail(`${at}.status`, "required");
  } else if (kind === "step") {
    if (value.tokens === undefined) problems.fail(`${at}.tokens`, "required");
  }
  if (
    problems.fields.length > before ||
    typeof kind !== "string" ||
    typeof partId !== "string" ||
    seq === undefined
  )
    return undefined;
  return {
    kind,
    partId,
    seq,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(text === undefined ? {} : { text }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(tool === undefined ? {} : { tool }),
    ...(status === undefined ? {} : { status }),
    ...(title === undefined ? {} : { title }),
    ...(input === undefined ? {} : { input }),
    ...(error === undefined ? {} : { error }),
    ...(reason === undefined ? {} : { reason }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(cost === undefined ? {} : { cost }),
  };
}

function parseRecords(
  problems: Problems,
  value: unknown,
): ParsedSteps | undefined {
  if (value === undefined) return problems.fail("records", "required");
  if (!Array.isArray(value)) return problems.fail("records", "invalid");
  const list: unknown[] = value;
  if (list.length === 0) return problems.fail("records", "invalid");
  if (list.length > STEPS_LIMITS.records)
    return problems.fail("records", "too_long");
  const records: StepRecord[] = [];
  let unknownKind = 0;
  list.forEach((item, index) => {
    const record = parseRecord(problems, item, `records[${index}]`);
    if (record === undefined) return;
    if ((STEP_KINDS as readonly string[]).includes(record.kind))
      records.push(record);
    else unknownKind += 1;
  });
  return { records, unknownKind };
}

/** The body of `POST /api/runners/v1/jobs/{id}/steps`. */
export function parseStepsRequest(
  body: unknown,
): Parsed<ParsedSteps & { leaseToken: string }> {
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const problems = new Problems();
  const leaseToken = body.leaseToken;
  if (leaseToken === undefined) problems.fail("leaseToken", "required");
  else if (
    typeof leaseToken !== "string" ||
    lengthOf(leaseToken) < LEASE_TOKEN_LENGTH.min ||
    lengthOf(leaseToken) > LEASE_TOKEN_LENGTH.max
  )
    problems.fail("leaseToken", "invalid");
  const parsed = parseRecords(problems, body.records);
  if (
    problems.fields.length > 0 ||
    parsed === undefined ||
    typeof leaseToken !== "string"
  )
    return { ok: false, fields: problems.fields };
  return { ok: true, value: { ...parsed, leaseToken } };
}

/** The body of `POST /api/workers/v1/jobs/{id}/steps`: the credential identifies the job, so the body holds the records only. */
export function parseWorkerStepsRequest(body: unknown): Parsed<ParsedSteps> {
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const problems = new Problems();
  const parsed = parseRecords(problems, body.records);
  if (problems.fields.length > 0 || parsed === undefined)
    return { ok: false, fields: problems.fields };
  return { ok: true, value: parsed };
}
