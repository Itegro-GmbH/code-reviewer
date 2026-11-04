// SPDX-License-Identifier: LicenseRef-Proprietary

// What the validator needs to know about the world (#833), as plain data so it can be tested with fakes and the core stays free of
// the database: which profiles, environments and connectors exist. The service builds a resolver per request.
//
// Profiles are user data from M2 on (a table with versions). Until then the one profile that exists is the Implementer's fixed
// configuration, which the built-in list names `implementer`. The validator asks the same question either way ("does this profile and
// version exist, may it push, does it bring a default result schema?"), so M2 replaces `BUILT_IN_PROFILES` by the rows of the
// workspace and nothing else changes. A name no list knows is an error with the list of names that exist; it is never accepted
// unseen, because the push facts and the version cannot be checked for a profile nobody knows.
import { BUILT_IN_CONNECTORS, type ConnectorSpec } from "./connectors.ts";
import type { ResultSchema } from "./result-schema.ts";

export type ProfileInfo = {
  name: string;
  /** The versions that exist, oldest first. A reference without a version means the newest. */
  versions: readonly number[];
  /** Whether a run with this profile may push a branch. Without it a step yields no `branch` and no `commits`. */
  canPush: boolean;
  /** The result schema the profile brings; a step that declares none yields this one. */
  defaultResult?: ResultSchema;
};

export type EnvironmentInfo = { name: string };

export type WorkflowResolver = {
  profiles(): readonly ProfileInfo[];
  environments(): readonly EnvironmentInfo[];
  connectors(): readonly ConnectorSpec[];
};

/** Today's Implementer: it pushes a branch. It is the only profile until profiles are data (M2). */
export const BUILT_IN_PROFILES: readonly ProfileInfo[] = [
  { name: "implementer", versions: [1], canPush: true },
];

/** The resolver of the running server: the built-in profiles and connectors, and the workspace's environments by name. */
export function createResolver(options: {
  environments: readonly EnvironmentInfo[];
}): WorkflowResolver {
  return {
    profiles: () => BUILT_IN_PROFILES,
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
