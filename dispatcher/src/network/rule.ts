// SPDX-License-Identifier: LicenseRef-Proprietary

// The environment's rule for the agent's network (#745, step 7) as the Dispatcher meets it: in the App's claim answer, and as the
// second wall, the network policy of the VM (`policyFor`). The rule is the owner's; the runner holds the same bounds
// (`runner/src/code_reviewer_runner/implementer/network_rule.py`, `contracts/runner-api.v1.json` `ImplementerNetworkRule`) and
// the network door enforces it. Here it only decides which names the VM may reach at all.
import { z } from "zod";

export const NETWORK_MODES = ["off", "list", "open"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];
export const MAX_NETWORK_HOSTS = 100;

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
/** The last label starts with a letter, as every top-level domain does and no address does (`10.0.0.1`, `0x7f.1`). */
const LAST_LABEL = "[a-z]([a-z0-9-]{0,61}[a-z0-9])?";
/** A host name in its ASCII lower-case form, exact or `*.suffix`, at least two labels (after the `*.` for a suffix). */
export const HOST_ENTRY = new RegExp(`^(\\*\\.)?(${LABEL}\\.)+${LAST_LABEL}$`);
/** A plain host name (no wildcard): the form of the model provider's host, which the App names in its claim answer and the token signs. */
export const PLAIN_HOST = new RegExp(`^(${LABEL}\\.)+${LAST_LABEL}$`);

export const NetworkRuleSchema = z
  .object({
    mode: z.enum(NETWORK_MODES),
    hosts: z
      .array(z.string().max(253).regex(HOST_ENTRY))
      .max(MAX_NETWORK_HOSTS),
  })
  .strict()
  .refine((rule) => (rule.mode === "list") === rule.hosts.length > 0);

export type NetworkRule = z.infer<typeof NetworkRuleSchema>;

/** The names the VM always needs to reach after the setup: the repository's host (the final push), nothing else of GitHub's. */
export const GITHUB_HOSTS = ["github.com", "api.github.com"] as const;

/** The part of the platform's `NetworkPolicy` this Dispatcher uses: all of it, none of it, or a list of domains (`*.` for a suffix). */
export type NetworkPolicy = "allow-all" | "deny-all" | { allow: string[] };

export type PolicyHosts = {
  /** The host of the App that owns the job: the lease, the result. */
  appHost: string;
  /** This Dispatcher's own host: the switch call is repeated through it until it is answered. */
  dispatcherHost: string;
  /** The model provider's host, as the App named it and the token signs it. */
  modelHost: string;
};

/**
 * The second wall: the policy the VM is narrowed to once the setup is done. GitHub, the model provider, the App and this
 * Dispatcher, plus the rule's own hosts for a list. `open` is not narrowed (null: the policy stays as it is). `off` adds nothing.
 * The platform's `*.suffix` matches the names below it; the door applies the stricter rule (the suffix itself is a name of its
 * own), so a wildcard here can only let the door's refusal be the one that decides.
 */
export function policyFor(
  rule: NetworkRule,
  hosts: PolicyHosts,
): NetworkPolicy | null {
  if (rule.mode === "open") return null;
  const allow = new Set<string>([
    ...GITHUB_HOSTS,
    hosts.modelHost,
    hosts.appHost,
    hosts.dispatcherHost,
  ]);
  for (const entry of rule.hosts) allow.add(entry);
  return { allow: [...allow] };
}
