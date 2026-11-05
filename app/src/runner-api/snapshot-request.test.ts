// SPDX-License-Identifier: LicenseRef-Proprietary

// #839: what a snapshot request is accepted as: the description of the whole file in the query, the bytes of one part as the body.
import { describe, expect, it } from "vitest";
import { SNAPSHOT_LIMITS } from "./contract.ts";
import {
  parseSnapshotPartRequest,
  snapshotPartBytes,
  snapshotPartCount,
} from "./snapshot-request.ts";

const SHA = "a".repeat(64);
const PART = SNAPSHOT_LIMITS.partBytes;

function query(over: Record<string, string | null> = {}): URLSearchParams {
  const base: Record<string, string> = {
    part: "0",
    parts: "1",
    bytes: "1000",
    rawBytes: "4000",
    sha256: SHA,
    opencodeVersion: "1.19.0",
  };
  const merged = { ...base, ...over };
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(merged))
    if (value !== null) params.set(name, value);
  return params;
}

describe("the parts of a snapshot", () => {
  // #839-T21
  it("cuts a file into parts of exactly 3 MiB and what is left, at most three of them", () => {
    expect(snapshotPartCount(1)).toBe(1);
    expect(snapshotPartCount(PART)).toBe(1);
    expect(snapshotPartCount(PART + 1)).toBe(2);
    expect(snapshotPartCount(SNAPSHOT_LIMITS.maxBytes)).toBe(
      SNAPSHOT_LIMITS.maxParts,
    );
    expect(snapshotPartBytes(PART + 5, 0)).toBe(PART);
    expect(snapshotPartBytes(PART + 5, 1)).toBe(5);
    expect(snapshotPartBytes(PART, 0)).toBe(PART);
    // Below the 4.5 MB a function of the platform takes in one request.
    expect(PART).toBeLessThan(4_500_000);
  });
});

describe("parseSnapshotPartRequest", () => {
  // #839-T21
  it("reads a whole small snapshot as one part", () => {
    const parsed = parseSnapshotPartRequest(query(), new Uint8Array(1000));

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        index: 0,
        count: 1,
        size: 1000,
        rawBytes: 4000,
        sha256: SHA,
        opencodeVersion: "1.19.0",
      },
    });
  });

  // #839-T21
  it("reads the last part of a larger one, which is shorter", () => {
    const size = 2 * PART + 700;

    const parsed = parseSnapshotPartRequest(
      query({ part: "2", parts: "3", bytes: String(size) }),
      new Uint8Array(700),
    );

    expect(parsed.ok).toBe(true);
  });

  // #839-T22
  it.each([
    [
      "a missing description",
      { sha256: null },
      [{ field: "sha256", code: "required" }],
    ],
    [
      "a digest in capitals",
      { sha256: SHA.toUpperCase() },
      [{ field: "sha256", code: "invalid" }],
    ],
    [
      "a short digest",
      { sha256: "abc" },
      [{ field: "sha256", code: "invalid" }],
    ],
    [
      "a version with a path",
      { opencodeVersion: "../1" },
      [{ field: "opencodeVersion", code: "invalid" }],
    ],
    ["a size of zero", { bytes: "0" }, [{ field: "bytes", code: "invalid" }]],
    [
      "a size over the cap",
      { bytes: String(SNAPSHOT_LIMITS.maxBytes + 1) },
      [{ field: "bytes", code: "invalid" }],
    ],
    [
      "a size that is not a number",
      { bytes: "12abc" },
      [{ field: "bytes", code: "invalid" }],
    ],
    [
      "a size with a sign",
      { bytes: "-5" },
      [{ field: "bytes", code: "invalid" }],
    ],
    [
      "a size with leading zeros",
      { bytes: "01000" },
      [{ field: "bytes", code: "invalid" }],
    ],
    [
      "a part number past the count",
      { part: "1" },
      [{ field: "part", code: "invalid" }],
    ],
    [
      "a count the size does not make",
      { parts: "2" },
      [{ field: "parts", code: "invalid" }],
    ],
    [
      "a raw size of zero",
      { rawBytes: "0" },
      [{ field: "rawBytes", code: "invalid" }],
    ],
  ])("refuses %s", (_name, over, fields) => {
    const parsed = parseSnapshotPartRequest(query(over), new Uint8Array(1000));

    expect(parsed).toEqual({ ok: false, fields });
  });

  // #839-T22
  it("refuses a body that is not the size its description says", () => {
    for (const length of [0, 999, 1001]) {
      expect(parseSnapshotPartRequest(query(), new Uint8Array(length))).toEqual(
        { ok: false, fields: [{ field: "body", code: "invalid" }] },
      );
    }
    const size = PART + 10;
    expect(
      parseSnapshotPartRequest(
        query({ part: "0", parts: "2", bytes: String(size) }),
        new Uint8Array(PART - 1),
      ),
    ).toEqual({ ok: false, fields: [{ field: "body", code: "invalid" }] });
  });

  // #839-T22
  it("names every wrong field and never a value", () => {
    const parsed = parseSnapshotPartRequest(
      query({ bytes: "x", sha256: "secret-value", part: "9" }),
      new Uint8Array(0),
    );

    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("secret-value");
  });
});
