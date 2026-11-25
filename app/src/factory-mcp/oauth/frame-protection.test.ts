// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config.ts";
import { createOAuthHandlers } from "./http.ts";
import {
  FRAME_PROTECTED_SOURCES,
  FRAME_PROTECTION_HEADERS,
} from "./frame-protection.ts";
import {
  ISSUER,
  authorizeParams,
  createWorld,
  registerClient,
} from "./test-harness.ts";

describe("frame protection of the pages of the OAuth server", () => {
  // #1144-T250
  it("sends frame-ancestors 'none' and X-Frame-Options DENY for the consent page, the authorization page and the connected apps page", async () => {
    const entries = (await nextConfig.headers?.()) ?? [];
    for (const path of [
      "/oauth/consent",
      "/oauth/authorize",
      "/w/acme/settings/ai-apps",
    ]) {
      const matching = entries.filter((entry) => matches(entry.source, path));
      const headers = Object.fromEntries(
        matching.flatMap((entry) => entry.headers).map((h) => [h.key, h.value]),
      );
      expect(headers["Content-Security-Policy"], path).toBe(
        "frame-ancestors 'none'",
      );
      expect(headers["X-Frame-Options"], path).toBe("DENY");
    }
  });

  // #1144-T251
  it("holds the same two headers in one list the config reads, for every protected source", async () => {
    expect(FRAME_PROTECTION_HEADERS.map((h) => h.key)).toEqual([
      "Content-Security-Policy",
      "X-Frame-Options",
    ]);
    const entries = (await nextConfig.headers?.()) ?? [];
    for (const source of FRAME_PROTECTED_SOURCES) {
      const entry = entries.find((candidate) => candidate.source === source);
      expect(entry?.headers, source).toEqual([...FRAME_PROTECTION_HEADERS]);
    }
  });

  // #1144-T252
  it("also puts them on the error page of the authorization endpoint", async () => {
    const world = createWorld();
    const handlers = createOAuthHandlers({
      service: world.service,
      baseUrl: ISSUER,
      allowRegistration: async () => true,
      currentUser: async () => null,
    });
    const { clientId } = await registerClient(world);
    const response = await handlers.authorize(
      new Request(
        `${ISSUER}/oauth/authorize?${authorizeParams(clientId, { redirect_uri: "https://evil.example/cb" })}`,
      ),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

/** Whether a Next.js header source (`/oauth/:path*`, `/w/:workspace/settings/ai-apps`) matches a path: enough of the syntax for these sources. */
function matches(source: string, path: string): boolean {
  const pattern = source
    .replace(/\/:path\*$/, "(?:/.*)?")
    .replace(/:[a-z]+/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(path);
}
