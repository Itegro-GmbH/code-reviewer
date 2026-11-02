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
  "implementer_setpriv_missing",
  "implementer_egress_rules_missing",
  "implementer_work_dir_missing",
  "implementer_work_dir_not_prepared",
  "implementer_work_dir_not_exec",
  "implementer_docker_unavailable",
  "implementer_docker_socket_open",
  // Written by the Dispatcher's canary, never by the runner (see `IMPLEMENTER_PROBE_FAILED`).
  "implementer_probe_failed",
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
 * The reason the Dispatcher's canary writes itself when the Implementer's half of its probe did not prove the engine: it did not
 * run, or its container failed a check, or its answer was not a verdict (#765). The runner never writes it. It is a reason of
 * `IMPLEMENTER_REASONS`: it says why `implementer` is missing and nothing about `opencode`.
 */
export const IMPLEMENTER_PROBE_FAILED: ProbeReason = "implementer_probe_failed";

/**
 * One verdict line from the two probes the canary VM runs when the deployment serves the Implementer: the Dynamic container's
 * (`first`) and the Implementer's (`second`, absent when it could not be run at all). **`opencode` and its reasons come from
 * the first output only, `implementer` and its reasons from the second only**, so that a failure of one half never makes
 * the other half's engine fall: a Dynamic container that passed stays passed whatever the Implementer's did. `implementer` is
 * in the line only when the first container passed and the second proved it. When it is not, the line carries the reasons of
 * the second output that are the Implementer's, and `implementer_probe_failed` when it has none (it did not run, it was not
 * a verdict, a check of the Dynamic self-check failed in its container, or it held a reason this reader does not know), so a
 * missing proof always has a reason and is never silent. A first output that is not a verdict is returned as it is.
 */
export function mergeVerdictOutputs(
  first: string,
  second: string | undefined,
): { line: string; implementerProven: boolean } {
  const dynamic = parseProbeOutput(first);
  if (dynamic === undefined) return { line: first, implementerProven: false };
  const implementer =
    second === undefined ? undefined : parseProbeOutput(second);
  const proven =
    dynamic.passed && implementer?.engines.includes("implementer") === true;
  const own = (implementer?.reasons ?? []).filter((reason) =>
    IMPLEMENTER_REASONS.includes(reason),
  );
  const reasons = [
    ...dynamic.reasons.filter(
      (reason) => !IMPLEMENTER_REASONS.includes(reason),
    ),
    ...(proven ? [] : own.length > 0 ? own : [IMPLEMENTER_PROBE_FAILED]),
  ];
  const engines = [
    ...dynamic.engines.filter((engine) => engine !== "implementer"),
    ...(proven ? (["implementer"] as const) : []),
  ];
  return {
    line: JSON.stringify({
      version: 1,
      engines: [...new Set(engines)],
      reasons: [...new Set(reasons)],
    }),
    implementerProven: proven,
  };
}
