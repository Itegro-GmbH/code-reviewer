// SPDX-License-Identifier: LicenseRef-Proprietary

// Takes secrets out of what a runner reports before it is stored. The runner redacts its own
// output (that is the first line of defense); this is the second one, for a runner that got it
// wrong: strings that look like credentials, and the secrets the app itself holds.
import "server-only";
import {
  AGENT_RESULT_MAX_DEPTH,
  AGENT_RESULT_MAX_VALUES,
  type AgentJson,
  type AgentResultValue,
} from "../db/agent-result.ts";
import { maskSecretInText } from "../llm/access.ts";
import type { ImplementerResult, RunnerResult } from "./contract.ts";

export const REDACTED = "[redacted]";

/** A secret shorter than this is more likely an ordinary word than a credential. */
const MIN_SECRET_LENGTH = 8;

// GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_ and fine-grained github_pat_), the `sk-` keys
// of the LLM providers, the per-job credential of a Worker (`crj_`, #320) and the credential of an
// `Authorization: Bearer` line.
const SECRET_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:or-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bcrj_[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

/**
 * The secrets the app itself holds in its environment, as they are used: surrounding white space is not
 * part of a setting (the LLM key is trimmed before it is handed to a runner, the runner token before it is
 * compared), so it is trimmed here as well. Empty settings are left out. (`LLM_API_KEY` is the legacy key of
 * a single-tenant instance; the key of a workspace is added by the caller, see `runner-api/shared.ts`.)
 */
export function knownSecretsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return [env.LLM_API_KEY, env.RUNNER_TOKEN]
    .map((value) => value?.trim())
    .filter((value): value is string => value !== undefined && value !== "");
}

/**
 * `secrets` are the exact values the app knows (see `knownSecretsFromEnv`, and the key of the claim of
 * the job). Each is removed as it is and in its URL-encoded, JSON-escaped and base64 form, which is how
 * it appears in a request line, a logged body or an `Authorization: Basic` header (`maskSecretInText`).
 */
export function redactText(text: string, secrets: readonly string[]): string {
  const usable = secrets
    .map((secret) => secret.trim())
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  let cleaned = maskSecretInText(text, ...usable);
  for (const shape of SECRET_SHAPES) cleaned = cleaned.replace(shape, REDACTED);
  return cleaned;
}

// Format characters (zero-width space and joiners, soft hyphen, bidirectional marks, the byte order mark): invisible, and they let a
// secret be written in a way a plain match does not see.
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * Text of the implementer block, cleaned (#754). The secrets are looked for in the text without its format characters, so a
 * secret split by zero-width characters is found too; a text that held none is returned as it was sent (an emoji sequence keeps
 * its joiners). What this does not catch: a secret written in any other disguise (reversed, spelled in pieces, with look-alike
 * letters, in an encoding other than the ones `redactText` knows).
 */
export function redactBlockText(
  text: string,
  secrets: readonly string[],
): string {
  const visible = text.replace(FORMAT_CHARACTERS, "");
  const cleaned = redactText(visible, secrets);
  return cleaned === visible ? text : cleaned;
}

/**
 * The result the agent handed in (#843), with the secrets taken out of every text in it, keys included (the runner did the same; this
 * is the second look). The walk is bounded like the value is (`agent-result.ts`): it goes no deeper than the levels a result may
 * have and visits no more values than it may hold, and what lies beyond that is replaced, not walked. The keys are made into data
 * properties, so a key named `__proto__` stays a key.
 */
export function redactAgentResult(
  value: AgentResultValue,
  secrets: readonly string[],
): AgentResultValue {
  const budget = { left: AGENT_RESULT_MAX_VALUES };
  const walk = (at: AgentJson, depth: number): AgentJson => {
    budget.left -= 1;
    if (budget.left < 0) return REDACTED;
    if (typeof at === "string") return redactBlockText(at, secrets);
    if (at === null || typeof at !== "object") return at;
    if (depth >= AGENT_RESULT_MAX_DEPTH) return REDACTED;
    if (Array.isArray(at)) return at.map((item) => walk(item, depth + 1));
    return Object.fromEntries(
      Object.entries(at).map(([key, item]) => [
        redactBlockText(key, secrets),
        walk(item, depth + 1),
      ]),
    );
  };
  return walk(value, 0) as AgentResultValue;
}

/**
 * The text of an implementer block that a person or an agent wrote: the summary, the subjects of the commits and the paths of the
 * files (#754), and the result the agent handed in (#843). The shas, the statuses, the flag and the saved agent session are not text of that kind and stay as they are. The names of the branches are the agent's text too.
 */
function redactImplementer(
  block: ImplementerResult,
  secrets: readonly string[],
): ImplementerResult {
  return {
    ...block,
    summary: redactBlockText(block.summary, secrets),
    ...(block.branches === undefined
      ? {}
      : {
          branches: block.branches.map((branch) => ({
            ...branch,
            name: redactBlockText(branch.name, secrets),
          })),
        }),
    commits: block.commits.map((commit) => ({
      ...commit,
      subject: redactBlockText(commit.subject, secrets),
    })),
    filesChanged: block.filesChanged.map((file) => ({
      ...file,
      path: redactBlockText(file.path, secrets),
    })),
    // #843: the result the agent handed in is the agent's text too, every string and every key of it.
    ...(block.agentResult === undefined
      ? {}
      : { agentResult: redactAgentResult(block.agentResult, secrets) }),
    // #745, step 7: the hosts are what the agent asked the network door for, text the agent chose.
    ...(block.network === undefined
      ? {}
      : {
          network: {
            ...block.network,
            connections: block.network.connections.map((connection) => ({
              ...connection,
              host: redactBlockText(connection.host, secrets),
            })),
          },
        }),
  };
}

/** The text fields of a result, cleaned. The structure and the numbers are not touched. */
export function redactResult(
  result: RunnerResult,
  secrets: readonly string[],
): RunnerResult {
  return {
    ...result,
    ...(result.implementer === undefined
      ? {}
      : { implementer: redactImplementer(result.implementer, secrets) }),
    logTail: redactText(result.logTail, secrets),
    errorMessage:
      result.errorMessage === null
        ? null
        : redactText(result.errorMessage, secrets),
    commentUrl:
      result.commentUrl === null
        ? null
        : redactText(result.commentUrl, secrets),
    usage:
      result.usage === null || result.usage.model === null
        ? result.usage
        : { ...result.usage, model: redactText(result.usage.model, secrets) },
  };
}
