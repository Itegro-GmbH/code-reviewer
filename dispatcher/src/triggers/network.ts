// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /network (#745, step 7): the call by which the Control container of an Implementer VM asks for the VM's network policy
// to be narrowed once the environment's setup script is done, the second wall of the network door. The Dispatcher holds the
// platform's credential and nothing after the hand-over (#487), so the VM gets, in its container's environment, a token that is
// good for this one call (`network/switch-token.ts`), and calls at the right moment.
//
// What the caller can and cannot choose. The token is an HMAC over the app, the VM, the rule and the model provider's host (both
// from the App's claim answer, which the Dispatcher read) and the time the token stops working, so the caller can name no other
// VM, rule or host and cannot use a token after the VM's life: the policy is built here from the rule, the hosts of the App and
// of this Dispatcher (both configuration), the provider's and GitHub's. The body carries the same values the token was made over,
// and a value that is not the signed one is a token that does not verify. The rule `open` is never narrowed.
//
// The call is idempotent, and the caller repeats it: narrowing the policy ends the connections that are open, and the call that
// asked for it is one of them, so an answer may never arrive. The Dispatcher's own host is in the narrowed policy, so the next
// call gets through and is answered. A refusal never says which check failed; nothing here logs a token or a body.
import type { Hono } from "hono";
import { z } from "zod";
import type { Logger } from "../core/types.ts";
import {
  NetworkRuleSchema,
  PLAIN_HOST,
  policyFor,
  type NetworkPolicy,
} from "../network/rule.ts";
import { verifySwitchToken } from "../network/switch-token.ts";
import type { AppSigningKey } from "./signature.ts";

export const NETWORK_PATH = "/network";
/** The rule holds up to 100 hosts of up to 253 characters. */
export const MAX_NETWORK_BODY_BYTES = 64 * 1024;
const RETRY_AFTER_SECONDS = 2;
/** `cr-implementer-<job id>-<suffix>` (`jobVmName`): the only VMs this route narrows. */
const VM_NAME = /^cr-implementer-[0-9a-f-]{36}-[a-z0-9-]{1,16}$/;

const BodySchema = z
  .object({
    vm: z.string().regex(VM_NAME),
    appId: z.string().min(1).max(64),
    network: NetworkRuleSchema,
    modelHost: z.string().max(253).regex(PLAIN_HOST),
    expires: z.number().int().positive(),
    token: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type NetworkRouteOptions = {
  /** The apps this Dispatcher serves: the id and the URL of each (a host the narrowed policy keeps). */
  apps: readonly { id: string; url: string }[];
  /** The signing keys of the apps, the current key first (`Settings.signingKeys`): the token's key is derived from them. */
  keys: readonly AppSigningKey[];
  fleet: {
    setNetworkPolicy(name: string, policy: NetworkPolicy): Promise<void>;
  };
  /** The address this Dispatcher is reached at (the switch call's own host stays reachable). */
  publicUrl: string;
  logger: Logger;
  /** The wall clock in milliseconds, for the expiry of a token; `Date.now` unless a test brings its own. */
  now?: () => number;
};

/**
 * The body of the request as text, read with a byte limit: a body longer than `limit` is not read further (the stream is
 * cancelled), whatever its declared length says or whether it declared one (a chunked body). Null when it is over the limit.
 */
async function readLimited(
  request: Request,
  limit: number,
): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

export function mountNetworkRoute(
  app: Hono,
  options: NetworkRouteOptions,
): void {
  const { logger } = options;
  const dispatcherHost = hostOf(options.publicUrl);

  function refused(c: import("hono").Context, status: 400 | 401 | 404 | 413) {
    // The same words for every refusal of one status: a caller cannot tell which check failed.
    return c.json({ error: "refused" }, status);
  }

  app.post(NETWORK_PATH, async (c) => {
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_NETWORK_BODY_BYTES) return refused(c, 413);
    if (!(c.req.header("content-type") ?? "").startsWith("application/json"))
      return refused(c, 400);
    // Before the token is looked at, on a route anyone can reach: never more than the limit is read.
    const text = await readLimited(c.req.raw, MAX_NETWORK_BODY_BYTES);
    if (text === null) return refused(c, 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return refused(c, 400);
    }
    const body = BodySchema.safeParse(parsed);
    if (!body.success) return refused(c, 400);
    const { vm, appId, network, modelHost, expires, token } = body.data;

    const configured = options.apps.find((candidate) => candidate.id === appId);
    const secrets = options.keys
      .filter((key) => key.appId === appId)
      .map((key) => key.secret);
    if (
      configured === undefined ||
      !verifySwitchToken(
        secrets,
        { appId, vm, rule: network, modelHost, expires },
        token,
        Math.floor((options.now ?? Date.now)() / 1000),
      )
    ) {
      logger.warn("network_refused", { verdict: "unauthorized" });
      return refused(c, 401);
    }

    const policy = policyFor(network, {
      appHost: hostOf(configured.url),
      dispatcherHost,
      modelHost,
    });
    // `open` keeps the policy the VM has: nothing to do, and the caller is told it is as asked.
    if (policy === null) {
      logger.info("network_open", { app: appId, vm });
      return c.json({ version: 1, status: "applied" });
    }
    try {
      await options.fleet.setNetworkPolicy(vm, policy);
    } catch {
      // Only that it failed: the platform's text is not ours to log.
      logger.warn("network_policy_failed", { app: appId, vm });
      return c.body(null, 503, { "retry-after": String(RETRY_AFTER_SECONDS) });
    }
    logger.info("network_policy_applied", {
      app: appId,
      vm,
      mode: network.mode,
      hosts: network.hosts.length,
    });
    return c.json({ version: 1, status: "applied" });
  });
}
