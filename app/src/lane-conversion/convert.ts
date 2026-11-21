// SPDX-License-Identifier: LicenseRef-Proprietary

// The conversion of one lane document (#1105, ADR 0007, "Migration path", release A, steps 2 and 3): every agent step that names a profile
// (or, written between the inline settings and the runner, an environment) gets the profile's values and a concrete runner written into it.
// Pure but for the lookups `ConversionWorld` answers; it never saves, never validates (the caller does, with the validator of a save) and
// never guesses: a step it cannot convert gives a reason, and then no part of the document is returned.
import { agentNodesOf, isInlineStep } from "../workflows/agent-settings.ts";
import { isRecord } from "../workflows/json.ts";
import { parseProfileRef } from "../workflows/resolver.ts";
import type {
  ConversionReason,
  ConversionWorld,
  EnvironmentValues,
  ProfileValues,
  RunnerCandidate,
} from "./types.ts";

export type DocumentConversion = {
  /** The converted document; undefined when nothing needed converting or when a reason was found. */
  document?: Record<string, unknown>;
  /** How many agent steps were written inline. */
  steps: number;
  /** Empty when the document converted (or had nothing to convert). */
  reasons: ConversionReason[];
};

/** The description of the version the conversion saves, as the ADR words it. */
export const CONVERSION_CHANGE_DESCRIPTION =
  "Profile values and runner written into the steps (ADR 0007)";

/** The keys of a converted step come first, in this order, so the lane reads the way a lane written by hand does. */
const KEY_ORDER = [
  "id",
  "description",
  "kind",
  "harness",
  "model",
  "canPush",
  "instructions",
  "runner",
  "setupScript",
  "network",
] as const;

function stepIdOf(node: Record<string, unknown>): string {
  return typeof node.id === "string" ? node.id : "?";
}

/** Whether the conversion has anything to do with a step: it names a profile, or settings of its own and an environment but no runner. */
function needsConversion(node: Record<string, unknown>): boolean {
  if (node.profile !== undefined) return true;
  return (
    isInlineStep(node) &&
    node.environment !== undefined &&
    node.runner === undefined
  );
}

type Found<T> =
  { ok: true; value: T } | { ok: false; reason: ConversionReason };

async function profileOf(
  node: Record<string, unknown>,
  world: ConversionWorld,
): Promise<Found<ProfileValues | undefined>> {
  if (node.profile === undefined) return { ok: true, value: undefined };
  const stepId = stepIdOf(node);
  const ref =
    typeof node.profile === "string"
      ? parseProfileRef(node.profile)
      : undefined;
  const text = typeof node.profile === "string" ? node.profile : "?";
  if (ref === undefined)
    return {
      ok: false,
      reason: {
        code: "profile_missing",
        stepId,
        message: `The profile reference "${text}" is not a profile name or name@version.`,
      },
    };
  const found = await world.profile(ref.name, ref.version);
  if (found.kind === "found") return { ok: true, value: found.profile };
  const messages = {
    archived: `The profile "${ref.name}" is archived.`,
    missing: `There is no profile "${ref.name}" in the workspace.`,
    version_missing: `The profile "${ref.name}" has no version ${String(ref.version)}.`,
  } as const;
  return {
    ok: false,
    reason: {
      code: `profile_${found.kind}`,
      stepId,
      message: messages[found.kind],
    },
  };
}

async function environmentOf(
  node: Record<string, unknown>,
  profile: ProfileValues | undefined,
  world: ConversionWorld,
): Promise<Found<EnvironmentValues>> {
  const stepId = stepIdOf(node);
  const byId = profile?.environmentId ?? undefined;
  const byName =
    byId === undefined && typeof node.environment === "string"
      ? node.environment
      : undefined;
  if (byId === undefined && byName === undefined)
    return {
      ok: false,
      reason: {
        code: "environment_missing",
        stepId,
        message:
          "Neither the step nor its profile version names an environment, so the runner cannot be told.",
      },
    };
  const environment = await world.environment(
    byId === undefined ? { name: byName as string } : { id: byId },
  );
  if (environment === undefined)
    return {
      ok: false,
      reason: {
        code: "environment_not_found",
        stepId,
        message:
          byId === undefined
            ? `The environment "${String(byName)}" is not in the workspace.`
            : "The environment of the profile version is not in the workspace any more.",
      },
    };
  return { ok: true, value: environment };
}

/** The runner a step moves to: a hosted runner of the environment's size, or the one self-hosted runner that has all its labels. */
function runnerOf(
  environment: EnvironmentValues,
  stepId: string,
  world: ConversionWorld,
): Found<{ id: string }> {
  if (environment.kind === "hosted") {
    const hosted = world
      .hostedRunners()
      .find((runner) => runner.vcpus === environment.vcpus);
    if (hosted !== undefined) return { ok: true, value: { id: hosted.id } };
    return {
      ok: false,
      reason: {
        code: "environment_size_unsupported",
        stepId,
        message: `The environment "${environment.name}" has ${String(environment.vcpus)} vCPU, a size no hosted runner type offers (${world
          .hostedRunners()
          .map((runner) => String(runner.vcpus))
          .join(", ")}).`,
      },
    };
  }
  const matches: RunnerCandidate[] = world
    .selfHostedRunners()
    .filter((runner) =>
      environment.labels.every((label) => runner.labels.includes(label)),
    )
    .map((runner) => ({ id: runner.id, name: runner.name }));
  const labels = environment.labels.join(", ");
  if (matches.length === 1)
    return { ok: true, value: { id: (matches[0] as RunnerCandidate).id } };
  if (matches.length === 0)
    return {
      ok: false,
      reason: {
        code: "runner_none_match",
        stepId,
        message: `The environment "${environment.name}" asks for a runner with the labels ${labels}; no runner of the workspace has all of them.`,
        candidates: [],
      },
    };
  return {
    ok: false,
    reason: {
      code: "runner_several_match",
      stepId,
      message: `The environment "${environment.name}" asks for a runner with the labels ${labels}; ${String(matches.length)} runners have all of them. Choose one, or split the lane.`,
      candidates: matches,
    },
  };
}

function networkOf(
  environment: EnvironmentValues,
): Record<string, unknown> | undefined {
  const { mode, hosts } = environment.network;
  if (mode === "off") return undefined;
  return mode === "list" ? { mode, hosts: [...hosts] } : { mode };
}

/** Writes the values into the step, in place. The step is a copy of the stored document's. */
function write(
  node: Record<string, unknown>,
  profile: ProfileValues | undefined,
  environment: EnvironmentValues,
  runnerId: string,
): void {
  const next: Record<string, unknown> = { ...node };
  delete next.profile;
  delete next.environment;
  if (profile !== undefined) {
    next.harness = profile.harness;
    next.model = profile.model;
    next.canPush = profile.canPush;
    if (profile.instructions !== "") next.instructions = profile.instructions;
    // A step that declared no result yields its profile's default: written out, so the step still does.
    if (next.result === undefined && profile.defaultResult !== null)
      next.result = JSON.parse(profile.defaultResult) as unknown;
    if (next.description === undefined && profile.description.trim() !== "")
      next.description = profile.description;
  }
  next.runner = runnerId;
  if (environment.kind === "hosted") {
    // The script and the network rule of a hosted environment are the step's now; what the step already says is its own.
    if (next.setupScript === undefined && environment.setupScript !== "")
      next.setupScript = environment.setupScript;
    const network = networkOf(environment);
    if (next.network === undefined && network !== undefined)
      next.network = network;
  }
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER)
    if (next[key] !== undefined) ordered[key] = next[key];
  for (const [key, value] of Object.entries(next))
    if (!(key in ordered)) ordered[key] = value;
  for (const key of Object.keys(node)) delete node[key];
  Object.assign(node, ordered);
}

/**
 * Converts the agent steps of a document. Every step that cannot be converted adds its reasons (all of them are found, so the operator
 * sees the whole list at once); the document is returned only when none had one and at least one step changed.
 */
export async function convertDocument(
  stored: unknown,
  world: ConversionWorld,
): Promise<DocumentConversion> {
  if (!isRecord(stored))
    return {
      steps: 0,
      reasons: [
        {
          code: "document_unreadable",
          message: "The stored document is not a JSON object.",
        },
      ],
    };
  const copy = structuredClone(stored);
  // Collected first: the steps are changed below, and the walk must not read what it wrote.
  const nodes = [...agentNodesOf(copy)].filter(needsConversion);
  const reasons: ConversionReason[] = [];
  const done: (() => void)[] = [];
  for (const node of nodes) {
    const profile = await profileOf(node, world);
    if (!profile.ok) {
      reasons.push(profile.reason);
      continue;
    }
    const environment = await environmentOf(node, profile.value, world);
    if (!environment.ok) {
      reasons.push(environment.reason);
      continue;
    }
    const runner = runnerOf(environment.value, stepIdOf(node), world);
    if (!runner.ok) {
      reasons.push(runner.reason);
      continue;
    }
    done.push(() =>
      write(node, profile.value, environment.value, runner.value.id),
    );
  }
  if (reasons.length > 0) return { steps: 0, reasons };
  if (done.length === 0) return { steps: 0, reasons: [] };
  for (const apply of done) apply();
  return { document: copy, steps: done.length, reasons: [] };
}
