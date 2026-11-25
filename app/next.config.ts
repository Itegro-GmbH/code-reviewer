// SPDX-License-Identifier: LicenseRef-Proprietary

import type { NextConfig } from "next";
import {
  MISSING_PATH,
  PORTAL_API_ROOT,
  PORTAL_DENIED_HEADER,
  PORTAL_PAGE_ROOT,
  PORTAL_REWRITE_HEADER,
  PROXY_SKIPPED_PATHS,
} from "./src/admin/paths.ts";
import {
  FRAME_PROTECTED_SOURCES,
  FRAME_PROTECTION_HEADERS,
} from "./src/factory-mcp/oauth/frame-protection.ts";
import { SETUP_PAGE, SETUP_REWRITE_HEADER } from "./src/setup/paths.ts";

const nextConfig: NextConfig = {
  // The product of this build for the one page that renders outside the root layout and so outside its provider (the page
  // for a crash in the root layout, src/app/global-error.tsx). Inlined at build time: a project of the other product has its
  // own build and its own variables (src/product-identity/public.ts).
  env: { NEXT_PUBLIC_PRODUCT_ID: process.env.PRODUCT_ID ?? "" },
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    return [
      {
        // The address of these pages can carry an invitation link (its token is the credential), so a
        // browser must not pass it on as a referrer to anything the page loads or links to
        // (src/workspaces/README.md). The pages ask for the same in their metadata.
        source: "/:path(invitation|login|sign-up)",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      // The pages where a person decides what an AI app may do (the factory MCP, #1144) cannot be framed: a page that framed the consent
      // page invisibly could click "Approve" for the person (RFC 9700, 4.16). One entry for each, so a test can hold each.
      ...FRAME_PROTECTED_SOURCES.map((source) => ({
        source,
        headers: [...FRAME_PROTECTION_HEADERS],
      })),
    ];
  },
  async rewrites() {
    return {
      // A request for the files of the admin portal by their own address is marked by the proxy
      // (src/admin/paths.ts). Next.js answers it as a path that does not exist, the same as any other,
      // with nothing of the portal in the answer.
      beforeFiles: [
        // A page request the setup gate marked (src/setup/paths.ts) is served from the setup page in
        // place of the page that was asked for, without the proxy building an address (bug #155: the
        // address carried the client's `X-Forwarded-Proto` and Next.js forwarded the rewrite to another
        // origin, which answered 500). Only what the proxy sees: it takes the header off a request from
        // outside, and does not see Next.js's static files, the image route and the favicon.
        {
          source: `/:path((?!${PROXY_SKIPPED_PATHS}).*)`,
          has: [{ type: "header", key: SETUP_REWRITE_HEADER }],
          destination: SETUP_PAGE,
        },
        // The instance admin's request for the portal (`/admin`, `/api/admin`) is marked by the proxy and
        // served from the files of the portal. Not a rewrite made by the proxy: see PORTAL_REWRITE_HEADER.
        // Nobody else carries the header (the proxy takes it off), and the pages and routes of the portal
        // check the admin again themselves.
        {
          source: "/admin/:path*",
          has: [{ type: "header", key: PORTAL_REWRITE_HEADER }],
          destination: `${PORTAL_PAGE_ROOT}/:path*`,
        },
        {
          source: "/api/admin/:path*",
          has: [{ type: "header", key: PORTAL_REWRITE_HEADER }],
          destination: `${PORTAL_API_ROOT}/:path*`,
        },
        {
          // Only what the proxy sees: it is the proxy that takes the header off a request from outside.
          source: `/:path((?!${PROXY_SKIPPED_PATHS}).*)`,
          has: [{ type: "header", key: PORTAL_DENIED_HEADER }],
          destination: MISSING_PATH,
        },
      ],
      afterFiles: [],
      // Every path that is no route gets to the same place, so the answer of a marked request and the
      // answer of a path that was never there are made the same way. On an RSC request Next.js adds
      // `x-nextjs-rewritten-path` to the answer of any rewrite; if only the marked request were rewritten,
      // that header would tell it from a missing path. (Next.js's own files keep their own answer.)
      fallback: [{ source: "/:path((?!_next/).*)", destination: MISSING_PATH }],
    };
  },
};

export default nextConfig;
