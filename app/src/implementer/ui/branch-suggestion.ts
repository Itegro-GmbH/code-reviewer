// SPDX-License-Identifier: LicenseRef-Proprietary

// The name the form prefills for the new branch (#756): `implementer/` and six random lowercase letters or digits. No rule of the
// server can refuse it (no dot, no dash, no base branch of that shape in practice). A person can change it.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SUFFIX_LENGTH = 6;

/** `random` returns a number in [0, 1); a test hands in its own. */
export function suggestBranchName(random: () => number = Math.random): string {
  let suffix = "";
  for (let i = 0; i < SUFFIX_LENGTH; i += 1)
    suffix += ALPHABET.charAt(Math.floor(random() * ALPHABET.length));
  return `implementer/${suffix}`;
}
