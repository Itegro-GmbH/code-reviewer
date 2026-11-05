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
import { checkNetwork, type NetworkRule } from "../../network-rule/network.ts";
import {
  LABEL_PATTERN,
  LABELS_MAX,
  normalizeLabels,
} from "../../runner-identity/announcement.ts";

export type EnvironmentInput =
  | {
      kind: "hosted";
      name: string;
      vcpus: number;
      setupScript: string;
      /** #745, step 7: the rule for the agent's network; `off` when the body names none. */
      network: NetworkRule;
    }
  | {
      /** #854: the labels a runner must have (at least one), instead of a size, a script and a network rule. */
      kind: "runner";
      name: string;
      labels: string[];
    };

export type EnvironmentInputCheck =
  | { ok: true; value: EnvironmentInput }
  | { ok: false; issues: EnvironmentIssue[] };

const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** A name is one line without control characters. */
const NOT_ONE_LINE = /[\u0000-\u001f\u007f]/;

/** The labels of a runner environment: at least one, at most 20, each lower case of the form a runner announces; sorted, once each. */
function checkRunnerLabels(
  value: unknown,
  refuse: (
    field: EnvironmentIssue["field"],
    code: EnvironmentIssue["code"],
  ) => void,
): string[] | undefined {
  if (value === undefined || value === null) {
    refuse("labels", "required");
    return undefined;
  }
  if (!Array.isArray(value)) {
    refuse("labels", "invalid");
    return undefined;
  }
  if (value.length === 0) {
    refuse("labels", "required");
    return undefined;
  }
  if (value.length > LABELS_MAX) {
    refuse("labels", "too_long");
    return undefined;
  }
  const labels: string[] = [];
  for (const label of value) {
    const text = typeof label === "string" ? label.trim().toLowerCase() : "";
    if (!LABEL_PATTERN.test(text)) {
      refuse("labels", "invalid");
      return undefined;
    }
    labels.push(text);
  }
  return normalizeLabels(labels);
}

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

  // #854: the kind. `hosted` when the body names none, as every body was before the kind.
  const kind = fields.kind ?? "hosted";
  if (kind !== "hosted" && kind !== "runner") {
    refuse("kind", "invalid");
    return { ok: false, issues };
  }
  if (kind === "runner") {
    // A runner environment is its labels: a size, a script or a network rule would promise something the runner does not do.
    if (fields.vcpus !== undefined) refuse("vcpus", "invalid");
    if (fields.setupScript !== undefined && fields.setupScript !== "")
      refuse("setupScript", "invalid");
    if (fields.network !== undefined) refuse("network", "invalid");
    const labels = checkRunnerLabels(fields.labels, refuse);
    if (issues.length > 0 || labels === undefined) return { ok: false, issues };
    return {
      ok: true,
      value: { kind: "runner", name: name as string, labels },
    };
  }
  if (
    fields.labels !== undefined &&
    !(Array.isArray(fields.labels) && fields.labels.length === 0)
  )
    refuse("labels", "invalid");

  const vcpus = fields.vcpus;
  if (vcpus === undefined) refuse("vcpus", "required");
  else if (!isEnvironmentVcpus(vcpus)) refuse("vcpus", "invalid");

  const script = fields.setupScript ?? "";
  if (typeof script !== "string") refuse("setupScript", "invalid");
  else if (script.includes("\u0000") || LONE_SURROGATE.test(script))
    refuse("setupScript", "invalid");
  else if (new TextEncoder().encode(script).length > SETUP_SCRIPT_MAX_BYTES)
    refuse("setupScript", "too_long");

  const network = checkNetwork(fields.network);
  if (!network.ok) refuse(network.field, network.code);

  if (issues.length > 0) return { ok: false, issues };
  // The checks above narrowed the fields; the casts only restate what they proved.
  return {
    ok: true,
    value: {
      kind: "hosted",
      name: name as string,
      vcpus: vcpus as number,
      setupScript: script as string,
      network: (network as { ok: true; rule: NetworkRule }).rule,
    },
  };
}
