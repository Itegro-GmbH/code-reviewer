// SPDX-License-Identifier: LicenseRef-Proprietary

// Which redirect URIs a dynamically registered client may have (RFC 7591, OAuth 2.1 section 2.3.1, RFC 8252). The authorization
// code goes to one of them and nowhere else, so the rule is strict and the comparison is exact.
//
// - `https` addresses: any host, no fragment, no user name or password.
// - `http` only for a loopback address (`127.0.0.1`, `[::1]`, `localhost`), with any port: what a native app listens on (Claude Code).
//   When the request is made, a loopback client may use another port than the one it registered (RFC 8252 section 7.3), see
//   `redirectUriMatches`.
// - A private-use scheme (`cursor://...`, `com.example.app:/cb`) for a native app: the scheme must be a name with letters, digits,
//   `+`, `-` or `.` and must not be one a browser runs or shows as content (`javascript`, `data`, `file`, `blob`, `vbscript`, `about`,
//   `ws`, `wss`, `ftp`, `chrome`, ...).
// A redirect URI never carries a fragment, and a plain `http` address of a real host is refused: the code would travel in the clear.

const FORBIDDEN_SCHEMES: ReadonlySet<string> = new Set([
  "javascript",
  "data",
  "file",
  "blob",
  "vbscript",
  "about",
  "ws",
  "wss",
  "ftp",
  "chrome",
  "chrome-extension",
  "view-source",
  "intent",
  "mailto",
  "tel",
  "sms",
]);

export const REDIRECT_URI_MAX_LENGTH = 2048;

export type RedirectUriCheck =
  { ok: true; uri: string } | { ok: false; reason: string };

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function checkRedirectUri(value: unknown): RedirectUriCheck {
  if (typeof value !== "string" || value === "")
    return { ok: false, reason: "A redirect URI must be a non-empty string." };
  if (value.length > REDIRECT_URI_MAX_LENGTH)
    return { ok: false, reason: "A redirect URI is too long." };
  // Control characters and spaces make two readers see two addresses.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(value))
    return {
      ok: false,
      reason:
        "A redirect URI may not hold spaces, control characters or backslashes.",
    };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "A redirect URI must be an absolute URI." };
  }
  if (url.hash !== "" || value.includes("#"))
    return { ok: false, reason: "A redirect URI may not have a fragment." };
  if (url.username !== "" || url.password !== "")
    return {
      ok: false,
      reason: "A redirect URI may not hold a user name or password.",
    };
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === "https") {
    if (url.hostname === "")
      return { ok: false, reason: "A redirect URI needs a host." };
    return { ok: true, uri: value };
  }
  if (scheme === "http") {
    if (!isLoopbackHost(url.hostname))
      return {
        ok: false,
        reason:
          "A redirect URI with http is allowed for localhost, 127.0.0.1 and [::1] only; use https.",
      };
    return { ok: true, uri: value };
  }
  if (FORBIDDEN_SCHEMES.has(scheme) || !/^[a-z][a-z0-9+.-]*$/.test(scheme))
    return { ok: false, reason: `The scheme ${scheme} is not allowed.` };
  return { ok: true, uri: value };
}

/**
 * Whether the redirect URI of an authorization request is one the client registered. Exact comparison of the text, except that a
 * loopback address with an `http` scheme may use any port (the app picks a free one when it starts, RFC 8252 section 7.3): scheme,
 * host (`localhost` and the two literal addresses do not stand for each other), path and query must still be equal.
 */
export function redirectUriMatches(
  registered: readonly string[],
  requested: string,
): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== "http:" || !isLoopbackHost(want.hostname)) return false;
  return registered.some((entry) => {
    let have: URL;
    try {
      have = new URL(entry);
    } catch {
      return false;
    }
    return (
      have.protocol === "http:" &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

/** The part of a redirect URI a person can judge on the consent page: where the code goes (host, or the scheme of an app). */
export function redirectTargetLabel(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:" || url.protocol === "http:") return url.host;
    return `${url.protocol}//${url.host}`.replace(/\/\/$/, "//");
  } catch {
    return "an unknown address";
  }
}
