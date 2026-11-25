// SPDX-License-Identifier: LicenseRef-Proprietary

// Frame protection for the pages where a person decides what an AI app may do (#1144; OAuth security best current practice, RFC 9700
// section 4.16: the authorization and consent page must not be framed, or a page that frames it invisibly can click "Approve" for the
// person). `Content-Security-Policy: frame-ancestors 'none'` is the modern header, `X-Frame-Options: DENY` the one older browsers know;
// both are sent. `next.config.ts` applies them to the addresses below; the error page of the authorization endpoint (`http.ts`) carries them
// itself because it is not a Next.js page.

export const FRAME_PROTECTION_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
] as const;

/**
 * The route patterns (Next.js `headers()` sources) that carry them: every page of the OAuth server (`/oauth/authorize`, `/oauth/consent`)
 * and the page that lists and revokes the connected apps. A new page of the OAuth server below `/oauth/` is covered without an edit.
 */
export const FRAME_PROTECTED_SOURCES = [
  "/oauth/:path*",
  "/w/:workspace/settings/ai-apps",
] as const;
