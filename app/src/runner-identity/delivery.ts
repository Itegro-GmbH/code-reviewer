// SPDX-License-Identifier: LicenseRef-Proprietary

// How a dispatcher wants to learn of a job (#972, Runner v2, ADR 0005): it polls `POST /claim` itself, or it announces a webhook and the
// app rings it, with the signed doorbell of `contracts/dispatch-webhook.v1.json`, when a job it could take is waiting. The announcement
// comes from the dispatcher (`delivery` of `contracts/runner-registration.v1.json`), which is outside our control, so the check is pure,
// never throws and names the fields that are wrong, never a value. The signing secret is not the dispatcher's to choose: the app makes it
// (`mintDeliverySecret`), shows it once and keeps it encrypted (`sealDeliverySecret`), so no two dispatchers share one and a secret
// never travels twice.
import { randomBytes } from "node:crypto";
import { isIPv6 } from "node:net";
import {
  decryptSecret,
  encryptSecret,
  type SealedSecret,
  type SecretLocation,
} from "../crypto/secret-box.ts";
import type { FieldIssue } from "./announcement.ts";

export const DELIVERY_MODES = ["poll", "webhook"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** What a dispatcher announced; `poll` is the default and the meaning of a missing `delivery`. */
export type DeliveryAnnouncement =
  { mode: "poll" } | { mode: "webhook"; url: string; rotateSecret: boolean };

export type DeliveryCheck =
  | { ok: true; value: DeliveryAnnouncement }
  | { ok: false; fields: FieldIssue[] };

export const DELIVERY_URL_MAX_LENGTH = 2048;
export const DELIVERY_SECRET_PREFIX = "crw_";
export const DELIVERY_SECRET_PATTERN = /^crw_[A-Za-z0-9_-]{43}$/;
export const DELIVERY_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Names that only mean something inside a network: the app never rings them. */
const INTERNAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".lan",
  ".home.arpa",
  ".corp",
  ".intranet",
] as const;

/** What the app may be made to call. Loopback is no destination of a hosted app: only the fakes, the E2E and local development ask for it. */
export type DeliveryPolicy = {
  /** `RUNNER_DELIVERY_ALLOW_LOOPBACK=1`: this machine (and plain http to it) is a usable address. Never the default. */
  allowLoopback?: boolean;
};

function ipv4Octets(host: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/** An address that is no destination of the public internet: private, loopback, link-local (the metadata service), shared or reserved. */
function privateOrReserved(octets: readonly number[]): boolean {
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address in any spelling (compressed, with an IPv4 tail), or undefined for text that is none. */
function ipv6Groups(address: string): number[] | undefined {
  if (!isIPv6(address)) return undefined;
  let text = address;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)?.[1];
  if (tail !== undefined) {
    const octets = ipv4Octets(tail);
    if (octets === undefined) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, -tail.length)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const side = (part: string | undefined): number[] =>
    part === undefined || part === ""
      ? []
      : part.split(":").map((group) => Number.parseInt(group, 16));
  const head = side(halves[0]);
  const rest = side(halves[1]);
  const gap = 8 - head.length - rest.length;
  if (halves.length === 1 ? gap !== 0 : gap < 1) return undefined;
  const groups = [
    ...head,
    ...new Array<number>(halves.length === 1 ? 0 : gap).fill(0),
    ...rest,
  ];
  return groups.length === 8 &&
    groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
}

/**
 * Whether an IPv6 address is no destination of the public internet. Only a global unicast address (2000::/3) is one, and even of
 * that range not 6to4 (2002::/16, it embeds any IPv4 address), Teredo (2001::/32) or documentation (2001:db8::/32). Everything else
 * is refused, the IPv4-mapped (`::ffff:0:0/96`) and the IPv4-compatible forms among it: they name an IPv4 address by another route.
 */
function ipv6NotPublic(groups: readonly number[]): boolean {
  const [first = 0, second = 0] = groups;
  if (first < 0x2000 || first > 0x3fff) return true;
  if (first === 0x2002) return true;
  if (first === 0x2001 && (second === 0 || second === 0x0db8)) return true;
  return false;
}

/**
 * Whether the address a name resolved to (or a literal in a URL) is a place the app must never be made to call: the one check of a
 * connection, after the name was resolved. Text that is no address counts as internal.
 */
export function isInternalAddress(
  address: string,
  { allowLoopback = false }: DeliveryPolicy = {},
): boolean {
  const text = address.startsWith("[") ? address.slice(1, -1) : address;
  const octets = ipv4Octets(text);
  if (octets !== undefined) {
    if (octets[0] === 127) return !allowLoopback;
    return privateOrReserved(octets);
  }
  const groups = ipv6Groups(text);
  if (groups === undefined) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1)
    return !allowLoopback;
  return ipv6NotPublic(groups);
}

/**
 * Whether the host is a place the app must never be made to call (SSRF): a private, link-local or reserved address, an IPv6 address
 * that is not a public one, a name that only means something inside a network or has no dot at all. This machine counts, too, unless
 * `allowLoopback` (the Dispatcher beside a local app, the fakes). A trailing dot names the same host (`localhost.`), so it is not a way round.
 * A check of the text only: a public-looking name can still resolve to a private address; the connection checks that (`guarded-fetch.ts`).
 */
export function isInternalHost(
  hostname: string,
  { allowLoopback = false }: DeliveryPolicy = {},
): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") return true;
  if (LOOPBACK_HOSTS.has(host)) return !allowLoopback;
  if (host.startsWith("[")) return isInternalAddress(host, { allowLoopback });
  if (ipv4Octets(host) !== undefined)
    return isInternalAddress(host, { allowLoopback });
  // A number the URL parser did not turn into dotted form, or a name with no dot, is not a public host name.
  if (/^[\d.x]+$/.test(host) || !host.includes(".")) return true;
  return INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Https without credentials to a host of the public internet. Plain http, and this machine, only with `allowLoopback` (the fakes, the E2E
 * and local development). The app sends a signed request to this address, so it is never one that names the app's own network.
 */
export function deliveryUrlIsUsable(
  text: string,
  policy: DeliveryPolicy = {},
): boolean {
  if (text.length > DELIVERY_URL_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (isInternalHost(url.hostname, policy)) return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    policy.allowLoopback === true &&
    LOOPBACK_HOSTS.has(url.hostname.replace(/\.+$/, ""))
  );
}

/** Reads the `delivery` of a body. A body without one is a dispatcher that polls. A field the format does not know is dropped. */
export function checkDelivery(
  value: unknown,
  policy: DeliveryPolicy = {},
): DeliveryCheck {
  if (value === undefined) return { ok: true, value: { mode: "poll" } };
  if (!isRecord(value))
    return { ok: false, fields: [{ field: "delivery", code: "invalid" }] };
  const { mode, url, rotateSecret } = value;
  if (mode === undefined)
    return {
      ok: false,
      fields: [{ field: "delivery.mode", code: "required" }],
    };
  if (mode === "poll") return { ok: true, value: { mode: "poll" } };
  if (mode !== "webhook")
    return {
      ok: false,
      fields: [{ field: "delivery.mode", code: "invalid" }],
    };
  const issues: FieldIssue[] = [];
  if (url === undefined)
    issues.push({ field: "delivery.url", code: "required" });
  else if (typeof url !== "string" || !deliveryUrlIsUsable(url, policy))
    issues.push({ field: "delivery.url", code: "invalid" });
  if (rotateSecret !== undefined && typeof rotateSecret !== "boolean")
    issues.push({ field: "delivery.rotateSecret", code: "invalid" });
  if (issues.length > 0) return { ok: false, fields: issues };
  return {
    ok: true,
    value: {
      mode: "webhook",
      url: url as string,
      rotateSecret: rotateSecret === true,
    },
  };
}

/** The signing secret of one dispatcher and the id that names it in `X-Dispatch-Key-Id`. Shown once; never logged. */
export type DeliveryKey = { keyId: string; secret: string };

export function mintDeliverySecret(): DeliveryKey {
  return {
    keyId: `d-${randomBytes(4).toString("hex")}`,
    secret: `${DELIVERY_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`,
  };
}

/** Where the sealed secret of a runner's delivery lives; bound into the ciphertext, so it opens nowhere else. */
export function deliverySecretLocation(runnerId: string): SecretLocation {
  return { table: "runners", rowId: runnerId, field: "delivery_secret" };
}

/** The text the database keeps: the sealed secret as JSON. */
export function sealDeliverySecret(
  appSecret: string,
  runnerId: string,
  secret: string,
): string {
  return JSON.stringify(
    encryptSecret(appSecret, deliverySecretLocation(runnerId), secret),
  );
}

/** The secret of a stored text. Throws `SecretBoxError` for one that cannot be read (another `APP_SECRET`, a changed row). */
export function openDeliverySecret(
  appSecret: string,
  runnerId: string,
  stored: string,
): string {
  return decryptSecret(
    appSecret,
    deliverySecretLocation(runnerId),
    JSON.parse(stored) as SealedSecret,
  );
}
