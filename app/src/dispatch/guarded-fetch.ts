// SPDX-License-Identifier: LicenseRef-Proprietary

// The connection to the address a customer's dispatcher announced (#972, ADR 0005). The announcement is checked as text
// (`runner-identity/delivery.ts`), but a name that looks public can resolve to the app's own network (a record that points to 10.x or
// to the metadata service, or one that changes between the check and the call). So the check that counts is made here, at the
// connection: the name is resolved once, every address it resolved to goes through the same rule as a literal one, and the socket
// connects to an address that was checked, never to the name again. No gap is left for a rebinding. This is for the customers'
// dispatchers only; the platform's own `RUNNER_WEBHOOK_URL` is the operator's setting and is called as it always was.
import "server-only";
import dns, { type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { deliveryAllowsLoopback } from "../runner-identity/config.ts";
import { isInternalAddress } from "../runner-identity/delivery.ts";
import type { DispatchFetch } from "./send.ts";

type Resolve = (
  hostname: string,
  options: dns.LookupOptions & { all: true },
  done: (
    error: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

const resolveWithSystem: Resolve = (hostname, options, done) =>
  dns.lookup(hostname, options, done);

export const INTERNAL_ADDRESS_CODE = "DELIVERY_ADDRESS_INTERNAL";

/**
 * The `lookup` of a socket that connects to a customer's dispatcher: resolves the name and refuses it, with one error, when it resolved
 * to nothing or when any one of its addresses is internal (the socket may pick any of them). The error carries a code and no host.
 */
export function createGuardedLookup(options: {
  allowLoopback: boolean;
  /** The resolver (`dns.lookup` with `all`); tests pass their own. */
  resolve?: Resolve;
}): LookupFunction {
  const resolve = options.resolve ?? resolveWithSystem;
  return (hostname, lookupOptions, callback) => {
    resolve(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error !== null) return callback(error, "", 0);
      const [first] = addresses;
      if (
        first === undefined ||
        addresses.some((entry) =>
          isInternalAddress(entry.address, {
            allowLoopback: options.allowLoopback,
          }),
        )
      )
        return callback(
          Object.assign(new Error("delivery address is internal"), {
            code: INTERNAL_ADDRESS_CODE,
          }),
          "",
          0,
        );
      if (lookupOptions.all === true) return callback(null, addresses);
      return callback(null, first.address, first.family);
    });
  };
}

/**
 * A `fetch` whose every connection goes through the guarded lookup. A refusal is an ordinary network error of the call. A socket does not
 * resolve an address literal, so a literal in the address (one stored before the rule was this strict) is judged here, before any connection.
 */
export function createGuardedFetch(options: {
  allowLoopback: boolean;
  resolve?: Resolve;
}): DispatchFetch {
  const agent = new Agent({
    connect: { lookup: createGuardedLookup(options) },
  });
  return async (url, init) => {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (
      isIP(host) !== 0 &&
      isInternalAddress(host, { allowLoopback: options.allowLoopback })
    )
      throw Object.assign(new Error("delivery address is internal"), {
        code: INTERNAL_ADDRESS_CODE,
      });
    return (await undiciFetch(url, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    })) as unknown as Response;
  };
}

const cache = new Map<boolean, DispatchFetch>();

/**
 * The `fetch` for the calls to customers' dispatchers (the doorbell and the stop call). One agent for each setting of
 * `RUNNER_DELIVERY_ALLOW_LOOPBACK`, kept for the life of the process, so its connections are reused.
 */
export function customerDeliveryFetch(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DispatchFetch {
  const allowLoopback = deliveryAllowsLoopback(env);
  let guarded = cache.get(allowLoopback);
  if (guarded === undefined) {
    guarded = createGuardedFetch({ allowLoopback });
    cache.set(allowLoopback, guarded);
  }
  return guarded;
}
