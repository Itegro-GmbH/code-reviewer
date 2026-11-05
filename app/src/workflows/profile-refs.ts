// SPDX-License-Identifier: LicenseRef-Proprietary

// Which profiles a workflow document names, and the profiles of the resolver built from them (#843). The validator needs the facts
// (may it push, does it bring a default result) of the versions a document runs, not of every version of every profile of the workspace:
// the service reads the names first, asks the database for exactly those versions, and builds the resolver's list from the answer.
// Pure: no database. The document is untrusted, so the walk is iterative (no depth to overflow) and takes no key but `profile`.
import { isRecord } from "./json.ts";
import { STEPS_MAX } from "./limits.ts";
import { parseProfileRef, type ProfileInfo } from "./resolver.ts";
import type { ResultSchema } from "./result-schema.ts";

/**
 * The most distinct (profile, version) references read from one document. The document is untrusted and every key named `profile` in
 * it counts, steps or not, so the service would otherwise ask the database for as many versions as the sender cares to write. A
 * document may hold `STEPS_MAX` steps, so twice that is more than any real one names. What lies beyond is not read: the validator
 * then knows no such profile or version (`profileInfosOf`).
 */
export const PROFILE_REFS_MAX = STEPS_MAX * 2;

/** `profile` of every object in the document that has one that is a reference: the name, and the versions named or `latest`. */
export function profileRefsIn(
  document: unknown,
): Map<string, Set<number | "latest">> {
  const found = new Map<string, Set<number | "latest">>();
  let count = 0;
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
        const version = parsed.version ?? "latest";
        if (versions.has(version)) continue;
        if (count >= PROFILE_REFS_MAX) return found;
        count++;
        versions.add(version);
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
  /** Whether the version's model is a managed one (a catalog entry; #854). */
  managedModel: boolean;
};

/**
 * The versions whose facts the validator can ask for (`wanted`: the newest of every profile the document names, and each version it
 * pins that exists), and the function that makes the resolver's list from the rows read for them. Versions are numbered from 1 without
 * a gap, so a profile at version 3 has the versions 1, 2 and 3. A document that named `PROFILE_REFS_MAX` references was cut off while it
 * was read (a real one names at most `STEPS_MAX`): the resolver then holds only the profiles and versions that were read, so what
 * was not read is reported as unknown instead of being taken on trust.
 */
export function profileInfosOf(
  live: readonly LiveProfile[],
  refs: ReadonlyMap<string, ReadonlySet<number | "latest">>,
): {
  wanted: { profileId: string; version: number }[];
  build(rows: readonly ProfileFactsRow[]): ProfileInfo[];
} {
  const wanted: { profileId: string; version: number }[] = [];
  let read = 0;
  for (const versions of refs.values()) read += versions.size;
  const cutOff = read >= PROFILE_REFS_MAX;
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
      const shown = cutOff ? live.filter((p) => refs.has(p.name)) : live;
      return shown.map((profile) => {
        const facts: ProfileInfo["facts"] = Object.fromEntries(
          rows
            .filter((row) => row.profileId === profile.id)
            .map((row) => [
              row.version,
              {
                canPush: row.canPush,
                managedModel: row.managedModel,
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
        const numbers = Array.from(
          { length: profile.version },
          (_, i) => i + 1,
        );
        return {
          name: profile.name,
          versions: cutOff
            ? numbers.filter((n) => n === profile.version || n in facts)
            : numbers,
          facts,
        };
      });
    },
  };
}
