// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  REGISTRATIONS_PER_ADDRESS_PER_HOUR,
  REGISTRATIONS_PER_HOUR,
  clientAddressOf,
  createRegistrationLimiter,
} from "./registration-limit.ts";

function counters() {
  const counts = new Map<string, number>();
  return {
    counts,
    async hit(key: string) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { count: counts.get(key) as number };
    },
    async refund(key: string) {
      counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
    },
  };
}
const request = (address: string | null) =>
  new Request("https://factory.example.test/api/oauth/register", {
    method: "POST",
    headers: address === null ? {} : { "x-forwarded-for": address },
  });

describe("the registration limit", () => {
  // #1144-T290
  it("limits each caller address on its own, so one caller cannot block the others", async () => {
    const store = counters();
    const allow = createRegistrationLimiter(store);
    const outcomes: boolean[] = [];
    for (let n = 0; n < REGISTRATIONS_PER_ADDRESS_PER_HOUR + 30; n += 1)
      outcomes.push(await allow(request("203.0.113.7")));
    expect(outcomes.filter(Boolean)).toHaveLength(
      REGISTRATIONS_PER_ADDRESS_PER_HOUR,
    );
    // Somebody else registers as usual.
    expect(await allow(request("198.51.100.9"))).toBe(true);
  });

  // #1144-T291
  it("does not count the refused calls of one caller against everybody (the backstop counts what was let through)", async () => {
    const store = counters();
    const allow = createRegistrationLimiter(store);
    for (let n = 0; n < 500; n += 1) await allow(request("203.0.113.7"));
    const global = [...store.counts.entries()].filter(
      ([key]) => !key.includes(":ip:"),
    );
    expect(global).toEqual([
      ["factory-oauth-register", REGISTRATIONS_PER_ADDRESS_PER_HOUR],
    ]);
  });

  // #1144-T292
  it("keeps a global cap as a backstop against many addresses, and gives the address its attempt back when the cap says no", async () => {
    const store = counters();
    store.counts.set("factory-oauth-register", REGISTRATIONS_PER_HOUR);
    const allow = createRegistrationLimiter(store);
    expect(await allow(request("203.0.113.7"))).toBe(false);
    const own = [...store.counts.entries()].find(([key]) =>
      key.includes(":ip:"),
    );
    expect(own?.[1]).toBe(0);
  });

  // #1144-T293
  it("reads the caller from the platform's headers, the first address of the chain, and stores no address in the clear", async () => {
    expect(clientAddressOf(request("203.0.113.7, 10.0.0.1"))).toBe(
      "203.0.113.7",
    );
    expect(
      clientAddressOf(
        new Request("https://x.test", {
          headers: {
            "x-real-ip": "198.51.100.1",
            "x-forwarded-for": "203.0.113.7",
          },
        }),
      ),
    ).toBe("198.51.100.1");
    expect(clientAddressOf(request(null))).toBe("unknown");
    const store = counters();
    await createRegistrationLimiter(store)(request("203.0.113.7"));
    expect(JSON.stringify([...store.counts.keys()])).not.toContain(
      "203.0.113.7",
    );
  });

  // #1144-T294
  it("puts callers without an address into one bucket of their own, never into the global one only", async () => {
    const store = counters();
    const allow = createRegistrationLimiter(store);
    for (let n = 0; n < REGISTRATIONS_PER_ADDRESS_PER_HOUR; n += 1)
      expect(await allow(request(null))).toBe(true);
    expect(await allow(request(null))).toBe(false);
    expect(await allow(request("198.51.100.9"))).toBe(true);
  });
});
