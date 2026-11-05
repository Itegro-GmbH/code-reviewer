// SPDX-License-Identifier: LicenseRef-Proprietary

// The checks on a snapshot request (#839): one part of the session snapshot of a turn of the Implementer, as the runner puts it
// (`PUT /api/workers/v1/jobs/{id}/session?part=&parts=&bytes=&rawBytes=&sha256=&opencodeVersion=`, the bytes of the part as the
// body). Written by hand like requests.ts and held to `contracts/worker-api.v1.json` (`SessionPartQuery`) by the contract test. A
// refusal lists fields and reasons, never values.
//
// Every part carries the description of the whole file, so a part is judged on its own and a part sent twice is the same call.
// The body must be exactly the size the description says: `partBytes` for every part but the last, what is left for the last.
import { SNAPSHOT_LIMITS, type FieldError } from "./contract.ts";
import type { Parsed } from "./requests.ts";

export const SNAPSHOT_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;
export const SNAPSHOT_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]{0,15})$/;

/** A part as read: the description of the whole file and the bytes of this part. */
export type ParsedSnapshotPart = {
  index: number;
  count: number;
  size: number;
  rawBytes: number;
  sha256: string;
  opencodeVersion: string;
  data: Uint8Array;
};

/** How many requests a file of `size` bytes takes; the last one is the shortest. */
export function snapshotPartCount(size: number): number {
  return Math.max(1, Math.ceil(size / SNAPSHOT_LIMITS.partBytes));
}

/** How long part `index` of a file of `size` bytes is. */
export function snapshotPartBytes(size: number, index: number): number {
  const count = snapshotPartCount(size);
  return index < count - 1
    ? SNAPSHOT_LIMITS.partBytes
    : size - SNAPSHOT_LIMITS.partBytes * (count - 1);
}

function integer(
  query: URLSearchParams,
  name: string,
  range: { min: number; max: number },
  fields: FieldError[],
): number | undefined {
  const raw = query.get(name);
  if (raw === null) {
    fields.push({ field: name, code: "required" });
    return undefined;
  }
  const value = DIGITS.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= range.min && value <= range.max)) {
    fields.push({ field: name, code: "invalid" });
    return undefined;
  }
  return value;
}

function text(
  query: URLSearchParams,
  name: string,
  pattern: RegExp,
  fields: FieldError[],
): string | undefined {
  const raw = query.get(name);
  if (raw === null) {
    fields.push({ field: name, code: "required" });
    return undefined;
  }
  if (!pattern.test(raw)) {
    fields.push({ field: name, code: "invalid" });
    return undefined;
  }
  return raw;
}

/** The part a request is: its query and its body. */
export function parseSnapshotPartRequest(
  query: URLSearchParams,
  body: Uint8Array,
): Parsed<ParsedSnapshotPart> {
  const fields: FieldError[] = [];
  const size = integer(
    query,
    "bytes",
    { min: 1, max: SNAPSHOT_LIMITS.maxBytes },
    fields,
  );
  const rawBytes = integer(
    query,
    "rawBytes",
    { min: 1, max: SNAPSHOT_LIMITS.maxRawBytes },
    fields,
  );
  const sha256 = text(query, "sha256", SNAPSHOT_SHA256_PATTERN, fields);
  const opencodeVersion = text(
    query,
    "opencodeVersion",
    SNAPSHOT_VERSION_PATTERN,
    fields,
  );
  const count = integer(
    query,
    "parts",
    { min: 1, max: SNAPSHOT_LIMITS.maxParts },
    fields,
  );
  const index = integer(
    query,
    "part",
    { min: 0, max: SNAPSHOT_LIMITS.maxParts - 1 },
    fields,
  );
  if (
    size !== undefined &&
    count !== undefined &&
    count !== snapshotPartCount(size)
  )
    fields.push({ field: "parts", code: "invalid" });
  if (count !== undefined && index !== undefined && index >= count)
    fields.push({ field: "part", code: "invalid" });
  if (
    fields.length === 0 &&
    size !== undefined &&
    index !== undefined &&
    body.byteLength !== snapshotPartBytes(size, index)
  )
    fields.push({ field: "body", code: "invalid" });
  if (
    fields.length > 0 ||
    size === undefined ||
    rawBytes === undefined ||
    sha256 === undefined ||
    opencodeVersion === undefined ||
    count === undefined ||
    index === undefined
  )
    return { ok: false, fields };
  return {
    ok: true,
    value: {
      index,
      count,
      size,
      rawBytes,
      sha256,
      opencodeVersion,
      data: body,
    },
  };
}
