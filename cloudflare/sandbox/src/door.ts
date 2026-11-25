// SPDX-License-Identifier: LicenseRef-Proprietary

import { WorkerEntrypoint } from "cloudflare:workers";
import { decide, targetOf } from "./policy.ts";
import type { Env } from "./env.ts";

/**
 * The outbound handler of every Container: the outer wall. All HTTP and HTTPS of a VM arrives here (`enableInternet: false`); the
 * handler terminates TLS, reads the VM's policy from its Durable Object on every request (so a policy set by `PUT /network` is in
 * effect for the next request, no connection has to be closed) and either refuses with a 403 or fetches. The request URL comes
 * from the Host header, which the Container controls: the decision and the destination are the same name, and a redirect is
 * never followed (`redirect: "manual"`), so it is the Container that asks again and the wall that judges the next name.
 * Private addresses stay refused (policy.ts, and the Workers runtime refuses them too); the reserved `.door` names are not served in
 * layout P1, so nothing a Container sends is ever given a credential here: there is nothing to forge.
 */
export class Door extends WorkerEntrypoint<Env, { vm: string }> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const policy = await this.env.VM.getByName(this.ctx.props.vm).getPolicy();
    const verdict = decide(policy, targetOf(url));
    if (!verdict.allowed) {
      return new Response("door: not allowed", {
        status: 403,
        headers: { "x-door": verdict.reason, "cache-control": "no-store" },
      });
    }
    return fetch(request, { redirect: "manual" });
  }
}
