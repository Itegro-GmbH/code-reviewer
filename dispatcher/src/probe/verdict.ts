// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Worker image's `probe` mode prints (contracts/probe-verdict.v1.json, runner/README.md) and how the
// Dispatcher reads it. The output comes from a container that runs next to hostile pull request content, so it
// is data, not an instruction: the Dispatcher reads one line, takes from it only the engines it knows and the
// reasons of the contract's closed list, and drops everything else without ever echoing it. `opencode` counts as
// proven only from a verdict that says it and gives no reason against it (fail closed).
import { z } from "zod";
import type { Engine } from "../core/types.ts";

/** The `SelfCheckReason` values of the runner: the closed list of `ProbeReason` in the contract (a test holds them equal). */
export const PROBE_REASONS = [
  "not_a_dynamic_runner",
  "not_root_supervisor",
  "engine_user_invalid",
  "network_rules_not_installed",
  "capabilities_not_dropped",
  "root_filesystem_writable",
  "ipv6_not_disabled",
  "pin_unreadable",
  "pin_untrusted",
  "engine_binary_missing",
  "engine_binary_untrusted",
  "engine_binary_checksum_mismatch",
  "engine_version_mismatch",
  "ripgrep_missing",
  "ripgrep_untrusted",
  "ripgrep_checksum_mismatch",
  "network_probe_failed",
  "implementer_git_missing",
  "implementer_git_too_old",
  "implementer_setpriv_missing",
  "implementer_guard_files_missing",
  "implementer_egress_rules_missing",
  "implementer_work_dir_missing",
  "implementer_work_dir_not_prepared",
  "implementer_work_dir_not_exec",
] as const;
export type ProbeReason = (typeof PROBE_REASONS)[number];

/**
 * The reasons that say why `implementer` is missing from a container whose Dynamic self-check passed (#765). They are
 * not reasons against `opencode`: a verdict that advertises `opencode` with only these still passes for Dynamic jobs.
 */
export const IMPLEMENTER_REASONS: readonly ProbeReason[] = PROBE_REASONS.filter(
  (reason) => reason.startsWith("implementer_"),
);

const KNOWN_ENGINES: readonly Engine[] = [
  "pr-agent",
  "opencode",
  "implementer",
];
/** A verdict is one short line; more than this is not from our probe. */
const MAX_OUTPUT_BYTES = 64 * 1024;

const LineSchema = z.object({
  version: z.literal(1),
  engines: z.array(z.unknown()).max(16),
  reasons: z.array(z.unknown()).max(64),
});

/** What the Dispatcher keeps of a verdict. Holds engines and stable reasons only. */
export type ParsedVerdict = {
  /** The engines the container may advertise; `opencode` only when it `passed`, `implementer` only on top of it. */
  engines: Engine[];
  reasons: ProbeReason[];
  /** True when `opencode` is advertised and nothing was said against it (the `implementer_*` reasons are not against it). */
  passed: boolean;
};

function isEngine(value: unknown): value is Engine {
  return (KNOWN_ENGINES as readonly unknown[]).includes(value);
}

function isReason(value: unknown): value is ProbeReason {
  return (PROBE_REASONS as readonly unknown[]).includes(value);
}

/** The verdict in the stdout of a probe run, or undefined when there is none to read. Never throws. */
export function parseProbeOutput(stdout: string): ParsedVerdict | undefined {
  if (stdout.length > MAX_OUTPUT_BYTES) return undefined;
  const last = stdout
    .split("\n")
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .at(-1);
  if (last === undefined) return undefined;
  let document: unknown;
  try {
    document = JSON.parse(last);
  } catch {
    return undefined;
  }
  const line = LineSchema.safeParse(document);
  if (!line.success) return undefined;

  const stated = line.data.engines.filter(isEngine);
  const reasons = [...new Set(line.data.reasons.filter(isReason))];
  const droppedReason = reasons.length < new Set(line.data.reasons).size;
  const claimsOpencode = stated.includes("opencode");
  const againstOpencode = reasons.filter(
    (reason) => !IMPLEMENTER_REASONS.includes(reason),
  );
  // A verdict that advertises opencode and in the same breath gives a reason against it, or has a reason
  // this reader does not know, is not a pass.
  const passed =
    claimsOpencode && againstOpencode.length === 0 && !droppedReason;
  // `implementer` stands on `opencode` and on its own check: no pass of the Dynamic check, or a reason of the
  // Implementer's, and it is not proven (fail closed), whatever the line claims.
  const implementerProven = passed && reasons.length === againstOpencode.length;
  const engines = [...new Set(stated)].filter((engine) =>
    engine === "opencode"
      ? passed
      : engine === "implementer"
        ? implementerProven
        : true,
  );
  return { engines, reasons, passed };
}

/**
 * One verdict line from the outputs of several probe runs in the same canary VM (#765): the Dynamic container, and for a
 * deployment that serves the Implementer its container too. Engines and reasons are united, so a container that fails
 * any check leaves its engine out and its reason in; a run whose output is not a verdict makes the whole of it
 * unreadable (its text is returned as it is, and `parseProbeOutput` then reads nothing). Only engines and reasons the
 * reader knows are written.
 */
export function mergeVerdictOutputs(outputs: readonly string[]): string {
  const verdicts: ParsedVerdict[] = [];
  for (const output of outputs) {
    const verdict = parseProbeOutput(output);
    if (verdict === undefined) return output;
    verdicts.push(verdict);
  }
  return JSON.stringify({
    version: 1,
    engines: [...new Set(verdicts.flatMap((verdict) => verdict.engines))],
    reasons: [...new Set(verdicts.flatMap((verdict) => verdict.reasons))],
  });
}
