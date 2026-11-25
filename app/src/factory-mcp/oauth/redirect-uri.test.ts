// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  checkRedirectUri,
  redirectTargetLabel,
  redirectUriMatches,
} from "./redirect-uri.ts";

describe("checkRedirectUri", () => {
  // #1144-T10
  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "http://localhost:6274/oauth/callback",
    "http://127.0.0.1:33418/callback",
    "http://[::1]:8080/cb",
    "cursor://anysphere.cursor-retrieval/oauth/user-mcp/callback",
    "com.example.app:/callback",
  ])("accepts %s", (uri) => {
    expect(checkRedirectUri(uri)).toEqual({ ok: true, uri });
  });

  // #1144-T11
  it.each([
    ["", "empty"],
    ["not a uri", "relative"],
    ["http://example.com/cb", "plain http on a real host"],
    ["http://localhost.evil.com/cb", "a host that only starts with localhost"],
    ["https://example.com/cb#frag", "a fragment"],
    ["https://user:pass@example.com/cb", "credentials"],
    ["javascript:alert(1)", "javascript"],
    ["data:text/html,hi", "data"],
    ["file:///etc/passwd", "file"],
    ["vbscript:x", "vbscript"],
    ["https://example.com/a b", "a space"],
    ["https://example.com\\@evil.com", "a backslash"],
  ])("refuses %s (%s)", (uri) => {
    expect(checkRedirectUri(uri).ok).toBe(false);
  });

  // #1144-T12
  it("refuses a value that is not a string", () => {
    expect(checkRedirectUri(42).ok).toBe(false);
    expect(checkRedirectUri(null).ok).toBe(false);
  });
});

describe("redirectUriMatches", () => {
  // #1144-T13
  it("compares exactly", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback"];
    expect(
      redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback"),
    ).toBe(true);
    expect(
      redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback/"),
    ).toBe(false);
    expect(
      redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback?x=1"),
    ).toBe(false);
    expect(
      redirectUriMatches(registered, "https://claude.ai.evil.com/api/mcp/auth_callback"),
    ).toBe(false);
  });

  // #1144-T14
  it("lets a loopback client choose another port, and nothing else", () => {
    const registered = ["http://127.0.0.1:1111/callback"];
    expect(redirectUriMatches(registered, "http://127.0.0.1:54321/callback")).toBe(true);
    expect(redirectUriMatches(registered, "http://127.0.0.1:54321/other")).toBe(false);
    expect(redirectUriMatches(registered, "http://localhost:54321/callback")).toBe(false);
    expect(redirectUriMatches(registered, "https://127.0.0.1:54321/callback")).toBe(false);
  });
});

describe("redirectTargetLabel", () => {
  // #1144-T15
  it("names the host of a web address and the scheme of an app", () => {
    expect(redirectTargetLabel("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
    expect(redirectTargetLabel("http://localhost:6274/cb")).toBe("localhost:6274");
    expect(redirectTargetLabel("cursor://anysphere.cursor-retrieval/oauth")).toBe(
      "cursor://anysphere.cursor-retrieval",
    );
  });
});
