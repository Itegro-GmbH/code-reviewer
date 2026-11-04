// SPDX-License-Identifier: LicenseRef-Proprietary

// Which profiles a workflow document names, and the profiles of the resolver built from them (#843). The validator needs the facts
// (may it push, does it bring a default result) of the versions a document runs, not of every version of every profile of the workspace:
// the service reads the names first, asks the database for exactly those versions, and builds the resolver's list from the answer.
// Pure: no database. The document is untrusted, so the walk is iterative (no depth to overflow) and takes no key but `profile`.
import { isRecord } from "./json.ts";
import { parseProfileRef, type ProfileInfo } from "./resolver.ts";
import type { ResultSchema } from "./result-schema.ts";

/** `profile` of every object in the document that has one that is a reference: the name, and the versions named or `latest`. */
export function profileRefsIn(
  document: unknown,
): Map<string, Set<number | "latest">> {
  const found = new Map<string, Set<number | "latest">>();
  const pending: unknown[] = [document];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === "profile" && typeof child === "string") {
        const parsed = parseProfileRef(child);
        if (parsed === undefined) continue;
        const versions = found.get(parsed.name) ?? new Set();
        versions.add(parsed.version ?? "latest");
        found.set(parsed.name, versions);
      } else if (typeof child === "object" && child !== null) {
        pending.push(child);
      }
    }
  }
  return found;
}

export type LiveProfile = { id: string; name: string; version: number };

export type ProfileFactsRow = {
  profileId: string;
  version: number;
  canPush: boolean;
  /** The JSON text of the default result schema, or null. */
  defaultResult: string | null;
};

/**
 * The versions whose facts the validator can ask for (`wanted`: the newest of every profile the document names, and each version it
 * pins that exists), and the function that makes the resolver's list from the rows read for them. Versions are numbered from 1 without
 * a gap, so a profile at version 3 has the versions 1, 2 and 3.
 */
export function profileInfosOf(
  live: readonly LiveProfile[],
  refs: ReadonlyMap<string, ReadonlySet<number | "latest">>,
): {
  wanted: { profileId: string; version: number }[];
  build(rows: readonly ProfileFactsRow[]): ProfileInfo[];
} {
  const wanted: { profileId: string; version: number }[] = [];
  for (const profile of live) {
    const named = refs.get(profile.name);
    if (named === undefined) continue;
    const versions = new Set<number>([profile.version]);
    for (const version of named)
      if (version !== "latest" && version >= 1 && version <= profile.version)
        versions.add(version);
    for (const version of [...versions].sort((a, b) => a - b))
      wanted.push({ profileId: profile.id, version });
  }
  return {
    wanted,
    build(rows) {
      return live.map((profile) => {
        const facts: ProfileInfo["facts"] = Object.fromEntries(
          rows
            .filter((row) => row.profileId === profile.id)
            .map((row) => [
              row.version,
              {
                canPush: row.canPush,
                ...(row.defaultResult === null
                  ? {}
                  : {
                      defaultResult: JSON.parse(
                        row.defaultResult,
                      ) as ResultSchema,
                    }),
              },
            ]),
        );
        return {
          name: profile.name,
          versions: Array.from({ length: profile.version }, (_, i) => i + 1),
          facts,
        };
      });
    },
  };
}
