// SPDX-License-Identifier: LicenseRef-Proprietary

// What the checks of a workflow and of a result schema share about untrusted JSON (#833).

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON type of a value in the words of a message: `a text`, `a number`, `true/false`, `a list`, `an object`, `null`. */
export function jsonTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (isRecord(value)) return "an object";
  return typeof value === "string"
    ? "a text"
    : typeof value === "number"
      ? "a number"
      : "true/false";
}

/**
 * The length of a text in characters (code points), as JSON Schema's `maxLength` and `minLength` count it and as Postgres'
 * `char_length` does. `String.length` counts UTF-16 units, which is twice as many for an emoji.
 */
export function textLength(text: string): number {
  let length = 0;
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    // A high surrogate followed by a low one is one character.
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) at += 1;
    }
    length += 1;
  }
  return length;
}
