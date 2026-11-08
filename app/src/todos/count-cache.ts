// SPDX-License-Identifier: LicenseRef-Proprietary

// A short memory for the count of open ToDos (#925). The sidebar badge asks on every page change and the count is a pass over the waiting
// runs and the pull requests of the lanes, so the answer is kept for a few seconds per workspace and person, and reads that arrive while one
// is on its way share it. A failure is not kept. A read after an answer asks for a fresh count and replaces what was kept; fresh reads that
// arrive while a fresh read is on its way share one more read that starts when it is over (never one read each), because the one on its way may
// have looked before their answer; a read that does not end within `flightTimeoutMs` no longer holds them back (a hung query must not stall
// the fresh reads after it for as long as it hangs). The cache lives in one server instance: another instance has its own and its own seconds.

export type CountCache<T> = {
  read(
    key: string,
    load: () => Promise<T>,
    options?: { fresh?: boolean },
  ): Promise<T>;
  /** How many entries are held (the ones that are over are dropped on every read). */
  size(): number;
};

/** The key of a count: the workspace and the person's GitHub login without case (`""` for an account without one, whose reviews match nobody). */
export function openCountKey(
  workspaceId: string,
  viewer: { githubLogin: string | null },
): string {
  return `${workspaceId}\u0000${viewer.githubLogin?.toLowerCase() ?? ""}`;
}

/** How long a fresh read holds the fresh reads that came after it back: about as long as a request is allowed to take. */
export const FLIGHT_TIMEOUT_MS = 15_000;

export function createCountCache<T>({
  ttlMs,
  now = Date.now,
  flightTimeoutMs = FLIGHT_TIMEOUT_MS,
}: {
  ttlMs: number;
  now?: () => number;
  flightTimeoutMs?: number;
}): CountCache<T> {
  type Entry = { promise: Promise<T>; expiresAt: number };
  const entries = new Map<string, Entry>();
  // The fresh read of a key that is on its way, and the one read that the fresh reads which came meanwhile share.
  type Flight = { settled: Promise<void>; next?: Promise<T> };
  const flights = new Map<string, Flight>();

  function begin(key: string, load: () => Promise<T>): Promise<T> {
    const entry: Entry = {
      promise: new Promise<T>((resolve) => {
        resolve(load());
      }),
      expiresAt: now() + ttlMs,
    };
    // A failed read is forgotten, unless a newer read has replaced it by then.
    entry.promise.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
    entries.set(key, entry);
    return entry.promise;
  }

  function beginFresh(key: string, load: () => Promise<T>): Promise<T> {
    const promise = begin(key, load);
    // Over when the read ended, however it ended, or when it has taken too long to be waited for.
    const flight: Flight = {
      settled: new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, flightTimeoutMs);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        promise.then(done, done);
      }),
    };
    flights.set(key, flight);
    void flight.settled.then(() => {
      if (flights.get(key) === flight) flights.delete(key);
    });
    return promise;
  }

  return {
    read(key, load, { fresh = false } = {}) {
      const at = now();
      for (const [name, entry] of entries)
        if (entry.expiresAt <= at) entries.delete(name);
      if (fresh) {
        const flight = flights.get(key);
        if (flight === undefined) return beginFresh(key, load);
        flight.next ??= flight.settled.then(() => beginFresh(key, load));
        return flight.next;
      }
      return entries.get(key)?.promise ?? begin(key, load);
    },
    size: () => entries.size,
  };
}
