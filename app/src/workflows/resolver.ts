// SPDX-License-Identifier: LicenseRef-Proprietary

// What the validator needs to know about the world (#833), as plain data so it can be tested with fakes and the core stays free of
// the database: which profiles, environments and connectors exist. The service builds a resolver per request.
//
// Profiles are user data (#843): the rows of the workspace's profiles table, each with its versions. The validator asks of a reference
// `name` or `name@n` whether the profile and the version exist and, for the version the step runs (the one named, else the newest),
// whether it may push and whether it brings a default result schema. A name no list knows is an error with the list of names that
// exist; it is never accepted unseen, because the push facts and the version cannot be checked for a profile nobody knows.
import { BUILT_IN_CONNECTORS, type ConnectorSpec } from "./connectors.ts";
import type { OnlineRunner } from "../runner-identity/announced.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import type { ResultSchema } from "./result-schema.ts";

/** What a run with one version of a profile is, as far as the validator is concerned. */
export type ProfileVersionFacts = {
  /** Whether a run with this version may push a branch. Without it a step yields no `branch` and no `commits`. */
  canPush: boolean;
  /** The result schema the version brings; a step that declares none yields this one. */
  defaultResult?: ResultSchema;
  /** Whether the version's model is a managed one (an entry of the catalog, on the platform's key), as opposed to one of the workspace's own key (#854). */
  managedModel?: boolean;
  /** The harness the version runs with (#854, #856); left out: OpenCode. */
  harness?: string;
  /** The model a harness on a login reads (#973); left out for a model of the catalog or of the workspace's own key. */
  model?: string;
  /** The environment of the workspace the version runs in (#919); left out or null: a version saved before it, whose step names the environment. */
  environmentId?: string | null;
};

export type ProfileInfo = {
  name: string;
  /** The versions that exist, oldest first. A reference without a version means the newest. */
  versions: readonly number[];
  /**
   * The facts of the versions the document names (the newest, for a reference without a version). A version with no entry is not
   * known: a step that runs it is taken as one that may push and brings no default, so nothing is refused on a guess.
   */
  facts: Readonly<Record<number, ProfileVersionFacts>>;
};

export type EnvironmentInfo = {
  /** The id a profile version names its environment by (#919); left out: no profile can point at it. */
  id?: string;
  name: string;
  /** #854: a runner environment is a customer's runner with labels; left out: a platform VM. */
  kind?: "hosted" | "runner";
  /** #973: the labels of a runner environment: the runners that can take its turns have all of them. */
  labels?: readonly string[];
};

/**
 * #1105 (ADR 0007, decisions 6, 14 and 16): a concrete runner a step may name, by the id the lane stores. A hosted runner is one type of the
 * provided Vercel Sandbox (a fixed size); a self-hosted one is a machine the customer registered. A revoked runner is still known, so the
 * validator can say "revoked" instead of "unknown"; it is listed in no `available`.
 */
export type RunnerInfo = {
  id: string;
  name: string;
  kind: "hosted" | "self_hosted";
  /** A self-hosted runner a member revoked. */
  revoked?: boolean;
  /**
   * #1158: a hosted runner the operator switched off (a Cloudflare size not in `CLOUDFLARE_RUNNER_SIZES`). It is still known, so the validator says
   * `runner_unavailable` and not `runner_unknown`; it is listed in no `available`.
   */
  unavailable?: boolean;
};

/** An MCP server of the workspace as a lane may name it (#1052). */
export type McpServerInfo = {
  /** The id a lane names the server by. */
  id: string;
  name: string;
  /** The result of the last connection test; `failed` is a broken server (a warning where a lane names it). */
  status: "untested" | "ok" | "failed";
  /** An OAuth server's connection (#1051); left out for a server that does not use OAuth. `broken` and `unconnected` are warned about like `failed`. */
  oauth?: "unconnected" | "connected" | "broken";
};

export type WorkflowResolver = {
  profiles(): readonly ProfileInfo[];
  /** The names of the profiles of the workspace that are archived: a reference to one is not "unknown" (#843). */
  archivedProfiles?(): readonly string[];
  environments(): readonly EnvironmentInfo[];
  /**
   * #1105: the runners of the workspace a step may name: the hosted runners (smallest first), then the self-hosted ones (a revoked one with
   * `revoked`). Left out: the workspace's runners are not known, and a step that names one is refused (it fails closed).
   */
  runners?(): readonly RunnerInfo[];
  connectors(): readonly ConnectorSpec[];
  /**
   * #1052: the MCP servers of the workspace, so a lane can name only those. Left out: the workspace has none (a lane that names a server is
   * refused, never accepted unseen).
   */
  mcpServers?(): readonly McpServerInfo[];
  /**
   * #973: the runners of the workspace that are online now, with what each announces. Left out (a resolver that does not know the runners): no
   * combination is refused for lacking one. See `no_runner_announces`.
   */
  onlineRunners?(): readonly OnlineRunner[];
  /**
   * #1150: whether the workspace has a Claude Code OAuth token it can use. With one, a step on the harness `claude-code` runs on a hosted
   * environment or runner too (its Sandbox VM runs on the token); without one (or from a resolver that does not know), the harness needs a
   * self-hosted runner, as it did. See `harness_needs_runner`.
   */
  claudeCodeToken?(): boolean;
  /**
   * #1105: why the workspace cannot run a model a step names itself (an agent step with settings of its own), or null when it can: the
   * rule of the Implementer form (`ImplementerModels.check`), the same a profile is held to when it is saved. The service asks it for
   * the models the document names before the validator runs (it is async, the validator is not). Left out, or `undefined` for a model
   * it did not look at: not refused on a guess.
   */
  modelCheck?(model: ModelChoice): string | null | undefined;
};

/** The resolver of the running server: the workspace's profiles and environments, and the built-in connectors. */
export function createResolver(options: {
  profiles: readonly ProfileInfo[];
  archivedProfiles?: readonly string[];
  environments: readonly EnvironmentInfo[];
  runners?: readonly RunnerInfo[];
  onlineRunners?: readonly OnlineRunner[];
  claudeCodeToken?: boolean;
  mcpServers?: readonly McpServerInfo[];
  modelCheck?: (model: ModelChoice) => string | null | undefined;
}): WorkflowResolver {
  const runners = options.onlineRunners;
  const servers = options.mcpServers;
  const named = options.runners;
  return {
    ...(named === undefined ? {} : { runners: () => named }),
    ...(servers === undefined ? {} : { mcpServers: () => servers }),
    ...(runners === undefined ? {} : { onlineRunners: () => runners }),
    ...(options.claudeCodeToken === undefined
      ? {}
      : { claudeCodeToken: () => options.claudeCodeToken === true }),
    ...(options.modelCheck === undefined
      ? {}
      : { modelCheck: options.modelCheck }),
    profiles: () => options.profiles,
    archivedProfiles: () => options.archivedProfiles ?? [],
    environments: () => options.environments,
    connectors: () => BUILT_IN_CONNECTORS,
  };
}

/** `implementer@2` is `{ name: "implementer", version: 2 }`; `implementer` is the newest. */
export const PROFILE_REF =
  /^([a-z0-9][a-z0-9_-]{0,63})(?:@([1-9][0-9]{0,5}))?$/;

export function parseProfileRef(
  ref: string,
): { name: string; version?: number } | undefined {
  const match = PROFILE_REF.exec(ref);
  if (match === null) return undefined;
  return match[2] === undefined
    ? { name: match[1] as string }
    : { name: match[1] as string, version: Number(match[2]) };
}
