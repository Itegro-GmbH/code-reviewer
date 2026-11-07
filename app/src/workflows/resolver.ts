// SPDX-License-Identifier: LicenseRef-Proprietary

// What the validator needs to know about the world (#833), as plain data so it can be tested with fakes and the core stays free of
// the database: which profiles, environments and connectors exist. The service builds a resolver per request.
//
// Profiles are user data (#843): the rows of the workspace's profiles table, each with its versions. The validator asks of a reference
// `name` or `name@n` whether the profile and the version exist and, for the version the step runs (the one named, else the newest),
// whether it may push and whether it brings a default result schema. A name no list knows is an error with the list of names that
// exist; it is never accepted unseen, because the push facts and the version cannot be checked for a profile nobody knows.
import { BUILT_IN_CONNECTORS, type ConnectorSpec } from "./connectors.ts";
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
};

export type WorkflowResolver = {
  profiles(): readonly ProfileInfo[];
  /** The names of the profiles of the workspace that are archived: a reference to one is not "unknown" (#843). */
  archivedProfiles?(): readonly string[];
  environments(): readonly EnvironmentInfo[];
  connectors(): readonly ConnectorSpec[];
};

/** The resolver of the running server: the workspace's profiles and environments, and the built-in connectors. */
export function createResolver(options: {
  profiles: readonly ProfileInfo[];
  archivedProfiles?: readonly string[];
  environments: readonly EnvironmentInfo[];
}): WorkflowResolver {
  return {
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
