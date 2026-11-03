// SPDX-License-Identifier: LicenseRef-Proprietary

// The token of the network switch call (#745, step 7). The Launcher gives it to the Control container of one VM; Control sends
// it back with the call that narrows that VM's network policy. It is an HMAC over the app, the VM and the rule the Dispatcher
// read in the claim, so a call can narrow one VM to the rule the App chose and to nothing else, and only the Dispatcher can make
// one. The key is derived from the app's signing secret for this one purpose (domain separation), so the signature of a wake-up
// call is not a token and a token is not a signature.
//
// It is not a secret of the VM's: it is in the environment of the Control container, which the agent never reaches, and it opens
// nothing but this call for this VM. A copy of it narrows the VM that the Dispatcher meant to narrow, to the same rule.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NetworkRule } from "./rule.ts";

const PURPOSE = "code-reviewer/network-switch/v1";

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update(PURPOSE).digest();
}

function message(appId: string, vm: string, rule: NetworkRule): string {
  return JSON.stringify([PURPOSE, appId, vm, rule.mode, rule.hosts]);
}

export function switchToken(
  secret: string,
  appId: string,
  vm: string,
  rule: NetworkRule,
): string {
  return createHmac("sha256", key(secret))
    .update(message(appId, vm, rule))
    .digest("hex");
}

/** Whether `token` is the token of one of `secrets` (the current key and the previous one while a rotation is in progress). */
export function verifySwitchToken(
  secrets: readonly string[],
  appId: string,
  vm: string,
  rule: NetworkRule,
  token: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const given = Buffer.from(token, "hex");
  return secrets.some((secret) => {
    const expected = Buffer.from(switchToken(secret, appId, vm, rule), "hex");
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}
