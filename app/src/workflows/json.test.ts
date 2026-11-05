// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: the canonical text of a JSON value, which two requests with the same content share.
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./json.ts";

describe("the canonical text of a JSON value", () => {
  // #844-T289
  it("does not depend on the order of the keys, at any depth", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }),
    ).toBe(canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  });

  // #844-T290
  it("tells a different content apart: values, list order and types", () => {
    const text = canonicalJson;
    expect(text({ a: 1 })).not.toBe(text({ a: 2 }));
    expect(text({ a: [1, 2] })).not.toBe(text({ a: [2, 1] }));
    expect(text({ a: 1 })).not.toBe(text({ a: "1" }));
    expect(text({ a: undefined })).toBe('{"a":null}');
    expect(text({})).toBe("{}");
    expect(text([])).toBe("[]");
  });
});
