// SPDX-License-Identifier: LicenseRef-Proprietary

// The issuer of an authorization server as the registry keeps it for an OAuth client an Owner or Admin entered (#1051): the same form discovery
// gives an issuer (origin and path, no trailing slash), so the two can be compared as text. Pure.

/**
 * The issuer a person typed, in the form discovery uses; null when it is not an https address (plain http only for the test flag) or has a
 * user name, password, query or fragment.
 */
export function normalizeIssuer(
  text: string,
  allowPlainHttp: boolean,
): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" &&
    !(allowPlainHttp && url.protocol === "http:")
  )
    return null;
  if (url.username !== "" || url.password !== "" || url.search !== "")
    return null;
  if (url.hash !== "" || text.includes("#") || text.includes("?")) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The host of an issuer for the page that asks the person to go there (the consent page is on this host). */
export function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}
