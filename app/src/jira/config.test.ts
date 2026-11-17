// SPDX-License-Identifier: LicenseRef-Proprietary

// The settings of the Jira connection (#1037): both values or the feature is off, the test-only addresses need their flag, and nothing
// that is read back names a value.
import { describe, expect, it } from "vitest";
import {
  atlassianConfigProblems,
  jiraCallbackUrl,
  jiraStateLine,
  readAtlassianConfig,
} from "./config.ts";

const BOTH = {
  ATLASSIAN_CLIENT_ID: "client-id-value",
  ATLASSIAN_CLIENT_SECRET: "client-secret-value",
};

describe("the Atlassian settings", () => {
  // #1037
  it("are off without the client id and secret, and say which variable is missing", () => {
    expect(readAtlassianConfig({})).toEqual({
      configured: false,
      kind: "missing",
      variables: ["ATLASSIAN_CLIENT_ID", "ATLASSIAN_CLIENT_SECRET"],
    });
    expect(
      readAtlassianConfig({
        ATLASSIAN_CLIENT_ID: "x",
        ATLASSIAN_CLIENT_SECRET: "  ",
      }),
    ).toMatchObject({
      configured: false,
      variables: ["ATLASSIAN_CLIENT_SECRET"],
    });
  });

  // #1037
  it("are on with both values and use the real Atlassian by default", () => {
    expect(readAtlassianConfig(BOTH)).toEqual({
      configured: true,
      clientId: "client-id-value",
      clientSecret: "client-secret-value",
      authBaseUrl: "https://auth.atlassian.com",
      apiBaseUrl: "https://api.atlassian.com",
    });
  });

  // #1037
  it("take another Atlassian address only with the test flag", () => {
    const fake = {
      ...BOTH,
      ATLASSIAN_AUTH_BASE_URL: "http://127.0.0.1:4020",
      ATLASSIAN_API_BASE_URL: "http://127.0.0.1:4020",
    };
    expect(readAtlassianConfig(fake)).toEqual({
      configured: false,
      kind: "invalid",
      variables: ["ATLASSIAN_AUTH_BASE_URL", "ATLASSIAN_API_BASE_URL"],
    });
    expect(
      readAtlassianConfig({ ...fake, ALLOW_TEST_ATLASSIAN_ENDPOINTS: "true" }),
    ).toMatchObject({
      configured: true,
      authBaseUrl: "http://127.0.0.1:4020",
      apiBaseUrl: "http://127.0.0.1:4020",
    });
    // Naming the real address is fine without the flag.
    expect(
      readAtlassianConfig({
        ...BOTH,
        ATLASSIAN_AUTH_BASE_URL: "https://auth.atlassian.com/",
      }),
    ).toMatchObject({ configured: true });
  });

  // #1037
  it("stop the start for one value without the other, and never contain a value", () => {
    expect(atlassianConfigProblems({})).toEqual([]);
    expect(atlassianConfigProblems(BOTH)).toEqual([]);
    const problems = atlassianConfigProblems({
      ATLASSIAN_CLIENT_ID: "client-id-value",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ATLASSIAN_CLIENT_SECRET");
    expect(JSON.stringify(problems)).not.toContain("client-id-value");
    expect(
      atlassianConfigProblems({
        ...BOTH,
        ATLASSIAN_API_BASE_URL: "http://127.0.0.1:1",
      }),
    ).toEqual([expect.stringContaining("ATLASSIAN_API_BASE_URL")]);
  });

  // #1037
  it("make the callback address from the public address, without a doubled slash", () => {
    expect(jiraCallbackUrl("https://factory-app-omega-eight.vercel.app")).toBe(
      "https://factory-app-omega-eight.vercel.app/api/jira/callback",
    );
    expect(jiraCallbackUrl("http://localhost:3000/")).toBe(
      "http://localhost:3000/api/jira/callback",
    );
  });

  // #1037
  it("make one start line that names variables only", () => {
    expect(jiraStateLine({})).toBe(
      "[jira] off: ATLASSIAN_CLIENT_ID, ATLASSIAN_CLIENT_SECRET not set.",
    );
    expect(jiraStateLine(BOTH)).toBe("[jira] on.");
    expect(jiraStateLine(BOTH)).not.toContain("client-secret-value");
  });
});
