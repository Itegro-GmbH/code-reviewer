// SPDX-License-Identifier: LicenseRef-Proprietary

// The limit on `POST /api/oauth/register` (#1144). Anybody may register (that is how an AI app connects), so the endpoint is counted, and
// the count has to be fair: one caller that sends junk must not use up what every other caller needs.
//
// - **Per caller address** (`REGISTRATIONS_PER_ADDRESS_PER_HOUR`): the main limit. The address comes from the platform's headers
//   (`x-real-ip`, else the first entry of `x-forwarded-for`; Vercel sets both and a client cannot choose them there). Only a hash of it is
//   stored in the shared counters, never the address.
// - **For the whole instance** (`REGISTRATIONS_PER_HOUR`): a backstop against many addresses at once. It counts only what the per-address
//   limit let through, so the refused calls of one caller never reach it; when it says no, the address gets its attempt back.
// A request without any address shares one bucket of its own: it is limited like an address, it cannot slip past the limit.
import { createHash } from "node:crypto";

export const REGISTRATIONS_PER_ADDRESS_PER_HOUR = 20;
export const REGISTRATIONS_PER_HOUR = 600;
const WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_KEY = "factory-oauth-register";

/** The part of the shared counters this needs (`RateLimitsRepository` has it). */
export type RegistrationCounters = {
  hit(key: string, windowMs: number): Promise<{ count: number }>;
  refund(key: string): Promise<void>;
};

/** The caller as the platform reports it, or `unknown`. */
export function clientAddressOf(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real !== undefined && real !== "") return real;
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first !== undefined && first !== "" ? first : "unknown";
}

function keyOf(address: string): string {
  const digest = createHash("sha256")
    .update(address)
    .digest("hex")
    .slice(0, 32);
  return `${GLOBAL_KEY}:ip:${digest}`;
}

/** Whether one more registration from this request is allowed now. */
export function createRegistrationLimiter(counters: RegistrationCounters) {
  return async function allowRegistration(request: Request): Promise<boolean> {
    const own = keyOf(clientAddressOf(request));
    if (
      (await counters.hit(own, WINDOW_MS)).count >
      REGISTRATIONS_PER_ADDRESS_PER_HOUR
    ) {
      // A refused call is not counted again: the counter stays at the limit instead of growing with a flood.
      await counters.refund(own);
      return false;
    }
    if (
      (await counters.hit(GLOBAL_KEY, WINDOW_MS)).count > REGISTRATIONS_PER_HOUR
    ) {
      await counters.refund(GLOBAL_KEY);
      await counters.refund(own);
      return false;
    }
    return true;
  };
}
