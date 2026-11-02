// SPDX-License-Identifier: LicenseRef-Proprietary

// Checks the body that creates or changes an environment (#818). The values come from the browser, so nothing here trusts a type.
// The setup script is literal data: it is kept exactly as written (no trimming, no normalised line ends) and only refused when it
// cannot be stored as text (a NUL byte, a lone surrogate half) or is over 64 KB of UTF-8. What the script does is not judged here:
// the sandbox is the boundary, not a list of what a script may say.
import {
  ENVIRONMENT_NAME_MAX_LENGTH,
  SETUP_SCRIPT_MAX_BYTES,
  isEnvironmentVcpus,
} from "./limits.ts";
import type { EnvironmentIssue } from "./errors.ts";

export type EnvironmentInput = {
  name: string;
  vcpus: number;
  setupScript: string;
};

export type EnvironmentInputCheck =
  | { ok: true; value: EnvironmentInput }
  | { ok: false; issues: EnvironmentIssue[] };

const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** A name is one line without control characters. */
const NOT_ONE_LINE = /[\u0000-\u001f\u007f]/;

export function validateEnvironmentInput(body: unknown): EnvironmentInputCheck {
  const fields: Record<string, unknown> =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const issues: EnvironmentIssue[] = [];
  const refuse = (
    field: EnvironmentIssue["field"],
    code: EnvironmentIssue["code"],
  ) => void issues.push({ field, code });

  const rawName = fields.name;
  const name = typeof rawName === "string" ? rawName.trim() : rawName;
  if (name === undefined || name === null || name === "")
    refuse("name", "required");
  else if (typeof name !== "string") refuse("name", "invalid");
  else if (name.length > ENVIRONMENT_NAME_MAX_LENGTH)
    refuse("name", "too_long");
  else if (NOT_ONE_LINE.test(name) || LONE_SURROGATE.test(name))
    refuse("name", "invalid");

  const vcpus = fields.vcpus;
  if (vcpus === undefined) refuse("vcpus", "required");
  else if (!isEnvironmentVcpus(vcpus)) refuse("vcpus", "invalid");

  const script = fields.setupScript ?? "";
  if (typeof script !== "string") refuse("setupScript", "invalid");
  else if (script.includes("\u0000") || LONE_SURROGATE.test(script))
    refuse("setupScript", "invalid");
  else if (new TextEncoder().encode(script).length > SETUP_SCRIPT_MAX_BYTES)
    refuse("setupScript", "too_long");

  if (issues.length > 0) return { ok: false, issues };
  // The checks above narrowed the fields; the casts only restate what they proved.
  return {
    ok: true,
    value: {
      name: name as string,
      vcpus: vcpus as number,
      setupScript: script as string,
    },
  };
}
