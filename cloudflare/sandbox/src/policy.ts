// SPDX-License-Identifier: LicenseRef-Proprietary

// The network policy of a VM as the outbound handler (the outer wall) applies it: `NetworkPolicy` of dispatcher/src/network/rule.ts
// and the one matching rule that contracts/network-rule-examples.json writes down for every implementation: a name matches an entry
// that is exactly it, or a `*.suffix` entry when it is strictly below the suffix; only the ports 80 and 443 go through; an IP
// address, in any spelling, is never a name. On top of the list the wall refuses what no policy may open: private, loopback and
// link-local addresses, and the reserved `.door` names (the platform's own doors; this Worker serves none in layout P1).
export type NetworkPolicy = "allow-all" | "deny-all" | { allow: string[] };

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const LAST_LABEL = "[a-z]([a-z0-9-]{0,61}[a-z0-9])?";
/** A host name in its ASCII lower-case form, exact or `*.suffix`, at least two labels (after the `*.` for a suffix): `HOST_ENTRY` of rule.ts. */
export const HOST_ENTRY = new RegExp(`^(\\*\\.)?(${LABEL}\\.)+${LAST_LABEL}$`);
export const MAX_POLICY_HOSTS = 200;

/** The policy a value is, or null: the three forms of the contract and nothing else. */
export function parsePolicy(value: unknown): NetworkPolicy | null {
  if (value === "allow-all" || value === "deny-all") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const allow = (value as { allow?: unknown }).allow;
  if (!Array.isArray(allow) || allow.length > MAX_POLICY_HOSTS) return null;
  for (const entry of allow) {
    if (
      typeof entry !== "string" ||
      entry.length > 253 ||
      !HOST_ENTRY.test(entry)
    )
      return null;
  }
  return { allow: [...new Set(allow as string[])] };
}

const NUMERIC_HOST = /^(0x[0-9a-f]*|[0-9]+)(\.(0x[0-9a-f]*|[0-9]+)){0,3}$/i;

/** An IP address in any spelling (dotted, short, hex, octal, decimal) or an IPv6 one. */
export function isAddressLiteral(host: string): boolean {
  return NUMERIC_HOST.test(host) || host.includes(":") || host.includes("[");
}

function ipv4Octets(host: string): number[] | null {
  let normalized: string;
  try {
    normalized = new URL(`http://${host}/`).hostname;
  } catch {
    return null;
  }
  const parts = normalized.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : NaN,
  );
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

/** Whether the address is one no policy may open: not a public unicast IPv4 address. IPv6 literals are refused whole (no tool of a job needs one). */
export function isPrivateAddress(host: string): boolean {
  if (host.includes(":") || host.includes("[")) return true;
  const o = ipv4Octets(host);
  if (o === null) return true;
  const [a = 0, b = 0, c = 0] = o;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isLocalName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

export const DOOR_SUFFIX = ".door";

export type Verdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: "policy" | "address" | "port" | "private" | "reserved";
    };

/** The host as the matcher compares it: lower case, no trailing dot. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function listAllows(list: readonly string[], host: string): boolean {
  return list.some((entry) =>
    entry.startsWith("*.")
      ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
      : host === entry,
  );
}

/** The decision for one request of the Container: its host and port, under the VM's policy. */
export function decide(
  policy: NetworkPolicy,
  target: { host: string; port: number },
): Verdict {
  const host = normalizeHost(target.host);
  if (
    host === "" ||
    host.endsWith(DOOR_SUFFIX) ||
    host === DOOR_SUFFIX.slice(1)
  )
    return { allowed: false, reason: "reserved" };
  if (isAddressLiteral(host) ? isPrivateAddress(host) : isLocalName(host))
    return { allowed: false, reason: "private" };
  if (policy === "deny-all") return { allowed: false, reason: "policy" };
  if (policy === "allow-all") return { allowed: true };
  if (target.port !== 80 && target.port !== 443)
    return { allowed: false, reason: "port" };
  if (isAddressLiteral(host)) return { allowed: false, reason: "address" };
  return listAllows(policy.allow, host)
    ? { allowed: true }
    : { allowed: false, reason: "policy" };
}

/** The host and port of an intercepted request (the URL comes from the Host header; the port is the protocol's default when it names none). */
export function targetOf(url: URL): { host: string; port: number } {
  const port =
    url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return { host: url.hostname, port };
}
