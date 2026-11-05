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

export type EnvironmentInfo = { name: string };

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
