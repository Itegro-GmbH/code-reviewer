// SPDX-License-Identifier: LicenseRef-Proprietary

// The token of the network switch call (#745, step 7). The Launcher gives it to the Control container of one VM; Control sends
// it back with the call that narrows that VM's network policy. It is an HMAC over the app, the VM, the rule the Dispatcher read in
// the claim, the model provider's host the App named in the same claim answer, and the time the token stops working, so a call can
// narrow one VM to the rule the App chose and the provider the App named, for as long as that VM lives, and to nothing else; and
// only the Dispatcher can make one. The key is derived from the app's signing secret for this one purpose (domain separation), so
// the signature of a wake-up call is not a token and a token is not a signature.
//
// It is not a secret of the VM's: it is in the environment of the Control container, which the agent never reaches, and it opens
// nothing but this call for this VM. A copy of it narrows the VM that the Dispatcher meant to narrow, to the same rule, and only
// until it expires (the VM's own lifetime, so never in practice before the end of the longest turn).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NetworkRule } from "./rule.ts";

const PURPOSE = "code-reviewer/network-switch/v2";

/** What a token is for: nothing of it can be changed by the one who holds the token. */
export type SwitchTokenSubject = {
  appId: string;
  vm: string;
  rule: NetworkRule;
  /** The model provider's host name, as the App named it in the claim answer. */
  modelHost: string;
  /** Unix time in seconds after which the token is refused. */
  expires: number;
};

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update(PURPOSE).digest();
}

function message(subject: SwitchTokenSubject): string {
  return JSON.stringify([
    PURPOSE,
    subject.appId,
    subject.vm,
    subject.rule.mode,
    subject.rule.hosts,
    subject.modelHost,
    subject.expires,
  ]);
}

export function switchToken(
  secret: string,
  subject: SwitchTokenSubject,
): string {
  return createHmac("sha256", key(secret))
    .update(message(subject))
    .digest("hex");
}

/**
 * Whether `token` is the token of `subject` made with one of `secrets` (the current key and the previous one while a rotation is
 * in progress), and has not expired at `nowSeconds` (Unix time). The expiry is part of what is signed, so it cannot be moved.
 */
export function verifySwitchToken(
  secrets: readonly string[],
  subject: SwitchTokenSubject,
  token: string,
  nowSeconds: number,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const given = Buffer.from(token, "hex");
  const genuine = secrets.some((secret) => {
    const expected = Buffer.from(switchToken(secret, subject), "hex");
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  return (
    genuine &&
    Number.isSafeInteger(subject.expires) &&
    nowSeconds <= subject.expires
  );
}
