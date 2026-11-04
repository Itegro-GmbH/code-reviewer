// SPDX-License-Identifier: LicenseRef-Proprietary

// The environment's rule for the agent's network (#745, step 7): `off` (the default: no network at all), `list` (the host names the
// owner wrote) or `open` (any public name). The rule is the owner's and the network door of the sandbox enforces it; this is where
// it is written down and checked. The runner holds the same rules (`runner/src/code_reviewer_runner/implementer/network_rule.py`,
// `contracts/runner-api.v1.json` `ImplementerNetworkRule`); a test holds the two to the same cases.
//
// A list entry is a host name, exact (`registry.npmjs.org`) or a suffix (`*.pythonhosted.org`: every name below it, not the name
// itself). It is stored in one form: lower case ASCII, a name written in Unicode converted to punycode, no trailing dot. An entry
// has at least two labels (after the `*.` for a suffix), so `*.com` is not a rule (that is `open` with another name), and its
// last label starts with a letter, which no IP address does: an address is never an entry. A port, a path or a scheme is no part
// of one.
export const NETWORK_MODES = ["off", "list", "open"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];
export type NetworkRule = { mode: NetworkMode; hosts: string[] };

export const NETWORK_HOSTS_MAX = 100;
export const NETWORK_HOST_MAX_LENGTH = 253;
/** What a person may paste: more than the longest list can need, so that a refusal is for the list and not for the paste. */
export const NETWORK_HOSTS_INPUT_MAX = 1000;
export const NETWORK_OFF: NetworkRule = { mode: "off", hosts: [] };

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LAST_LABEL = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isNetworkMode(value: unknown): value is NetworkMode {
  return (NETWORK_MODES as readonly unknown[]).includes(value);
}

/**
 * The host of a name as the WHATWG URL parser reads it: lower case, a name in Unicode converted to punycode. The same parser the
 * browser has, so the form and the server agree without a module of Node's in the client bundle. Null for a name it refuses.
 */
function asciiHost(name: string): string | null {
  try {
    const host = new URL(`http://${name}/`).hostname.toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/** The form an entry is stored and compared in, or null when it is not a host name or a `*.` suffix of one. */
export function normalizeHostEntry(raw: string): string | null {
  const text = raw.trim();
  const wildcard = text.startsWith("*.");
  let body = wildcard ? text.slice(2) : text;
  if (body.endsWith(".")) body = body.slice(0, -1);
  if (body === "" || /[\u0000- \u007f/:@?#\\[\]%*]/.test(body)) return null;
  const ascii = asciiHost(body);
  if (ascii === null || ascii.length > NETWORK_HOST_MAX_LENGTH) return null;
  const labels = ascii.split(".");
  if (labels.length < 2) return null;
  const last = labels[labels.length - 1] ?? "";
  if (!LAST_LABEL.test(last)) return null;
  if (!labels.slice(0, -1).every((label) => LABEL.test(label))) return null;
  return wildcard ? `*.${ascii}` : ascii;
}

/**
 * The host name of a model provider's address, in the form the second wall names it (a plain host name, no address), or null when
 * the address has none. The Dispatcher gets it in the claim answer and signs it into the token of the network switch, so the
 * Worker cannot name another host there.
 */
export function providerHostOf(address: string): string | null {
  try {
    const host = new URL(address).hostname;
    return host.startsWith("*.") ? null : normalizeHostEntry(host);
  } catch {
    return null;
  }
}

export type NetworkCheck =
  | { ok: true; rule: NetworkRule }
  | {
      ok: false;
      field: "network" | "networkHosts";
      code: "required" | "invalid" | "too_long";
    };

/**
 * The rule of a request body. A missing `network` is `off`. The hosts are normalised and made unique, in the order they were
 * written; `list` needs at least one, and the other modes take none.
 */
export function checkNetwork(value: unknown): NetworkCheck {
  if (value === undefined) return { ok: true, rule: NETWORK_OFF };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, field: "network", code: "invalid" };
  const given = value as Record<string, unknown>;
  if (!isNetworkMode(given.mode))
    return { ok: false, field: "network", code: "invalid" };
  const mode = given.mode;
  const raw = given.hosts ?? [];
  if (!Array.isArray(raw))
    return { ok: false, field: "networkHosts", code: "invalid" };
  if (raw.length > NETWORK_HOSTS_INPUT_MAX)
    return { ok: false, field: "networkHosts", code: "too_long" };
  if (mode !== "list")
    // Hosts next to a rule that does not use them are a mistake of the caller, not something to drop quietly.
    return raw.length > 0
      ? { ok: false, field: "networkHosts", code: "invalid" }
      : { ok: true, rule: { mode, hosts: [] } };
  const hosts: string[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "string")
      return { ok: false, field: "networkHosts", code: "invalid" };
    // A blank line between two entries is nothing; an entry that is not a host name is a mistake.
    if (entry.trim() === "") continue;
    const form = normalizeHostEntry(entry);
    if (form === null)
      return { ok: false, field: "networkHosts", code: "invalid" };
    if (!hosts.includes(form)) hosts.push(form);
  }
  if (hosts.length === 0)
    return { ok: false, field: "networkHosts", code: "required" };
  if (hosts.length > NETWORK_HOSTS_MAX)
    return { ok: false, field: "networkHosts", code: "too_long" };
  return { ok: true, rule: { mode, hosts } };
}

/** The hosts as the database keeps them: one on each line. */
export function hostsToText(hosts: readonly string[]): string {
  return hosts.join("\n");
}

/** The rule of a stored mode and hosts text; a mode this version does not know reads `off` (the safe reading). */
export function ruleOf(
  mode: string | null,
  hostsText: string | null,
): NetworkRule {
  if (mode === "open") return { mode: "open", hosts: [] };
  if (mode === "list" && hostsText !== null && hostsText !== "")
    return { mode: "list", hosts: hostsText.split("\n") };
  return NETWORK_OFF;
}
