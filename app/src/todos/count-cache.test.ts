// SPDX-License-Identifier: LicenseRef-Proprietary

// #925: the badge reads the count on every page change; the server answers from a short cache per workspace and person, and two reads at
// the same time share one pass over the runs. #951: fresh reads at the same time share one more pass, and the key is pinned down.
import { describe, expect, it, vi } from "vitest";
import { createCountCache, openCountKey } from "./count-cache.ts";

const COUNTS = (open: number) => ({ open, projects: {} });

describe("the cache of the open ToDo count", () => {
  // #925
  it("answers a second read within the time from the first one", async () => {
    let now = 1_000;
    const cache = createCountCache({ ttlMs: 10_000, now: () => now });
    const load = vi.fn(async () => COUNTS(3));

    await cache.read("w-1:alice", load);
    now += 9_999;
    expect(await cache.read("w-1:alice", load)).toEqual(COUNTS(3));

    expect(load).toHaveBeenCalledTimes(1);
  });

  // #925
  it("reads again after the time, and keeps people and workspaces apart", async () => {
    let now = 1_000;
    const cache = createCountCache({ ttlMs: 10_000, now: () => now });
    const load = vi.fn(async () => COUNTS(1));

    await cache.read("w-1:alice", load);
    await cache.read("w-1:bob", load);
    await cache.read("w-2:alice", load);
    expect(load).toHaveBeenCalledTimes(3);
    now += 10_000;
    await cache.read("w-1:alice", load);

    expect(load).toHaveBeenCalledTimes(4);
  });

  // #925
  it("lets reads that arrive while one is on its way share it", async () => {
    const cache = createCountCache({ ttlMs: 10_000 });
    let release: (counts: ReturnType<typeof COUNTS>) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<ReturnType<typeof COUNTS>>((resolve) => {
          release = resolve;
        }),
    );

    const first = cache.read("k", load);
    const second = cache.read("k", load);
    release(COUNTS(2));

    expect(await first).toEqual(COUNTS(2));
    expect(await second).toEqual(COUNTS(2));
    expect(load).toHaveBeenCalledTimes(1);
  });

  // #925
  it("does not keep a failure: the next read asks again", async () => {
    const cache = createCountCache({ ttlMs: 10_000 });
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("database down"))
      .mockResolvedValue(COUNTS(4));

    await expect(cache.read("k", load)).rejects.toThrow("database down");

    expect(await cache.read("k", load)).toEqual(COUNTS(4));
  });

  // #925
  it("reads again when asked for a fresh count (after an answer), and the next reads use it", async () => {
    const cache = createCountCache({ ttlMs: 10_000 });
    const load = vi
      .fn()
      .mockResolvedValueOnce(COUNTS(2))
      .mockResolvedValue(COUNTS(1));

    await cache.read("k", load);
    expect(await cache.read("k", load, { fresh: true })).toEqual(COUNTS(1));
    expect(await cache.read("k", load)).toEqual(COUNTS(1));

    expect(load).toHaveBeenCalledTimes(2);
  });

  // #925
  it("does not let an older read that finishes late replace a fresh one", async () => {
    const cache = createCountCache({ ttlMs: 10_000 });
    let releaseOld: (counts: ReturnType<typeof COUNTS>) => void = () =>
      undefined;
    const old = cache.read(
      "k",
      () =>
        new Promise<ReturnType<typeof COUNTS>>((resolve) => {
          releaseOld = resolve;
        }),
    );
    const fresh = await cache.read("k", async () => COUNTS(1), {
      fresh: true,
    });
    releaseOld(COUNTS(5));
    await old;

    expect(fresh).toEqual(COUNTS(1));
    expect(await cache.read("k", async () => COUNTS(9))).toEqual(COUNTS(1));
  });

  // #925
  it("forgets entries that are over, so the cache does not grow with every person who ever asked", async () => {
    let now = 0;
    const cache = createCountCache({ ttlMs: 10, now: () => now });
    for (const key of ["a", "b", "c"])
      await cache.read(key, async () => COUNTS(1));
    now = 100;
    await cache.read("d", async () => COUNTS(1));

    expect(cache.size()).toBe(1);
  });

  // #951
  it("lets fresh reads that arrive while a fresh read is on its way share one more read, started after they arrived", async () => {
    const cache = createCountCache({ ttlMs: 10_000 });
    const releases: Array<(counts: ReturnType<typeof COUNTS>) => void> = [];
    const load = vi.fn(
      () =>
        new Promise<ReturnType<typeof COUNTS>>((resolve) => {
          releases.push(resolve);
        }),
    );

    const first = cache.read("k", load, { fresh: true });
    const second = cache.read("k", load, { fresh: true });
    const third = cache.read("k", load, { fresh: true });
    expect(load).toHaveBeenCalledTimes(1);
    releases[0]?.(COUNTS(2));
    expect(await first).toEqual(COUNTS(2));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    releases[1]?.(COUNTS(1));

    expect(await second).toEqual(COUNTS(1));
    expect(await third).toEqual(COUNTS(1));
    expect(load).toHaveBeenCalledTimes(2);
    expect(await cache.read("k", load)).toEqual(COUNTS(1));
  });

  // #951
  it("reads at once for a fresh read when no fresh read is on its way, and does not wait for an older plain read", async () => {
    const cache = createCountCache({ ttlMs: 10_000 });
    const load = vi.fn(async () => COUNTS(1));

    await cache.read("k", load, { fresh: true });
    await cache.read("k", load, { fresh: true });

    expect(load).toHaveBeenCalledTimes(2);
  });

  // #951
  it("goes on with the queued fresh read when the one before it failed", async () => {
    const cache = createCountCache({ ttlMs: 10_000 });
    let fail: (error: Error) => void = () => undefined;
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof COUNTS>>((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValue(COUNTS(7));

    const first = cache.read("k", load, { fresh: true });
    const second = cache.read("k", load, { fresh: true });
    const failure = expect(first).rejects.toThrow("database down");
    fail(new Error("database down"));
    await failure;

    expect(await second).toEqual(COUNTS(7));
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("the key of the open ToDo count", () => {
  // #951
  it("is the workspace and the lowercased GitHub login", () => {
    expect(openCountKey("w-1", { githubLogin: "Alice" })).toBe(
      openCountKey("w-1", { githubLogin: "alice" }),
    );
    expect(openCountKey("w-1", { githubLogin: "alice" })).not.toBe(
      openCountKey("w-2", { githubLogin: "alice" }),
    );
    expect(openCountKey("w-1", { githubLogin: "alice" })).not.toBe(
      openCountKey("w-1", { githubLogin: "bob" }),
    );
  });

  // #951
  it("has an empty person for an account without a login, which no login equals", () => {
    expect(openCountKey("w-1", { githubLogin: null })).toBe("w-1\u0000");
    expect(openCountKey("w-1", { githubLogin: null })).not.toBe(
      openCountKey("w-1", { githubLogin: "alice" }),
    );
    // The separator keeps a workspace id and a login apart: ("w", "1x") is not ("w1", "x").
    expect(openCountKey("w", { githubLogin: "1x" })).not.toBe(
      openCountKey("w1", { githubLogin: "x" }),
    );
  });
});
