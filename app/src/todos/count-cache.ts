// SPDX-License-Identifier: LicenseRef-Proprietary

// A short memory for the count of open ToDos (#925). The sidebar badge asks on every page change and the count is a pass over the waiting
// runs and the pull requests of the lanes, so the answer is kept for a few seconds per workspace and person, and reads that arrive while one
// is on its way share it. A failure is not kept. A read after an answer asks for a fresh count and replaces what was kept.

export type CountCache<T> = {
  read(
    key: string,
    load: () => Promise<T>,
    options?: { fresh?: boolean },
  ): Promise<T>;
  /** How many entries are held (the ones that are over are dropped on every read). */
  size(): number;
};

export function createCountCache<T>({
  ttlMs,
  now = Date.now,
}: {
  ttlMs: number;
  now?: () => number;
}): CountCache<T> {
  type Entry = { promise: Promise<T>; expiresAt: number };
  const entries = new Map<string, Entry>();

  return {
    read(key, load, { fresh = false } = {}) {
      const at = now();
      for (const [name, entry] of entries)
        if (entry.expiresAt <= at) entries.delete(name);
      const known = entries.get(key);
      if (known !== undefined && !fresh) return known.promise;
      const entry: Entry = {
        promise: new Promise<T>((resolve) => {
          resolve(load());
        }),
        expiresAt: at + ttlMs,
      };
      // A failed read is forgotten, unless a newer read has replaced it by then.
      entry.promise.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      entries.set(key, entry);
      return entry.promise;
    },
    size: () => entries.size,
  };
}
