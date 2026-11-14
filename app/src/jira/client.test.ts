// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls to Atlassian (#1037) against a stubbed `fetch`: what is sent, how an answer is read, and that a failure is a value that holds
// nothing of Atlassian's answer, a token or the secret.
import { describe, expect, it } from "vitest";
import { createAtlassianClient, type FetchLike } from "./client.ts";

const SECRET = "the-client-secret-of-the-test";

function clientWith(
  answer: (url: string, init?: RequestInit) => Response | Error,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    const result = answer(url, init);
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    calls,
    client: createAtlassianClient({
      clientId: "the-client-id",
      clientSecret: SECRET,
      authBaseUrl: "https://auth.example.test/",
      apiBaseUrl: "https://api.example.test",
      fetchImpl,
    }),
  };
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe("the Atlassian client", () => {
  // #1037
  it("sends the code and the client credentials as JSON to the token endpoint", async () => {
    const { client, calls } = clientWith(() =>
      reply(200, {
        access_token: "acc",
        refresh_token: "ref",
        expires_in: 3600,
        scope: "read:jira-work offline_access",
      }),
    );

    const result = await client.exchangeCode(
      "the-code",
      "https://app.test/api/jira/callback",
    );

    expect(result).toEqual({
      ok: true,
      accessToken: "acc",
      refreshToken: "ref",
      expiresInSeconds: 3600,
      scopes: ["read:jira-work", "offline_access"],
    });
    expect(calls[0]?.url).toBe("https://auth.example.test/oauth/token");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      client_id: "the-client-id",
      client_secret: SECRET,
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://app.test/api/jira/callback",
    });
  });

  // #1037
  it("reads a refresh that rotated nothing as no new refresh token", async () => {
    const { client } = clientWith(() =>
      reply(200, { access_token: "acc", expires_in: 60 }),
    );

    expect(await client.refresh("old")).toMatchObject({
      ok: true,
      refreshToken: null,
    });
  });

  // #1037
  it("tells a refusal from a failure to reach Atlassian, and returns nothing of the answer", async () => {
    for (const status of [400, 401, 403])
      expect(
        await clientWith(() =>
          reply(status, {
            error: "invalid_grant",
            error_description: "tok-123",
          }),
        ).client.refresh("r"),
      ).toEqual({ ok: false, kind: "refused" });
    for (const status of [429, 500, 503])
      expect(
        await clientWith(() => reply(status, {})).client.refresh("r"),
      ).toEqual({
        ok: false,
        kind: "unavailable",
      });
    expect(
      await clientWith(() => new Error("connect ECONNREFUSED")).client.refresh(
        "r",
      ),
    ).toEqual({
      ok: false,
      kind: "unavailable",
    });
    // An answer that is no token answer.
    expect(
      await clientWith(() => reply(200, { access_token: "" })).client.refresh(
        "r",
      ),
    ).toEqual({
      ok: false,
      kind: "unavailable",
    });
    expect(
      await clientWith(
        () => new Response("<html>", { status: 200 }),
      ).client.refresh("r"),
    ).toEqual({
      ok: false,
      kind: "unavailable",
    });
    expect(
      await clientWith(() =>
        reply(200, { access_token: "a", expires_in: -1 }),
      ).client.refresh("r"),
    ).toEqual({
      ok: false,
      kind: "unavailable",
    });
  });

  // #1037
  it("keeps the Jira sites of a grant and drops the other products' sites and malformed entries", async () => {
    const { client, calls } = clientWith(() =>
      reply(200, [
        {
          id: "1",
          url: "https://a.atlassian.net",
          name: "a",
          scopes: ["read:jira-work", "write:jira-work"],
        },
        {
          id: "2",
          url: "https://b.atlassian.net",
          name: "b",
          scopes: ["read:confluence-content.all"],
        },
        { id: "3", url: "https://c.atlassian.net", scopes: ["read:jira-work"] },
        "nonsense",
      ]),
    );

    expect(await client.sites("tok")).toEqual({
      ok: true,
      sites: [{ id: "1", url: "https://a.atlassian.net", name: "a" }],
    });
    expect(calls[0]?.url).toBe(
      "https://api.example.test/oauth/token/accessible-resources",
    );
    expect(
      (calls[0]?.init?.headers as Record<string, string>).authorization,
    ).toBe("Bearer tok");
  });

  // #1037
  it("reads the account that granted, and a rejected token as a refusal", async () => {
    expect(
      await clientWith(() =>
        reply(200, {
          account_id: "712020:abc",
          name: "Ada",
          email: "a@x.test",
        }),
      ).client.account("t"),
    ).toEqual({ ok: true, account: { id: "712020:abc", name: "Ada" } });
    expect(await clientWith(() => reply(401, {})).client.account("t")).toEqual({
      ok: false,
      kind: "refused",
    });
    expect(
      await clientWith(() => reply(200, { name: "no id" })).client.account("t"),
    ).toEqual({
      ok: false,
      kind: "unavailable",
    });
  });

  // #1037
  it("asks for the consent with the audience, the scopes, the state and the callback", () => {
    const { client } = clientWith(() => reply(200, {}));
    const url = new URL(
      client.authorizeUrl({
        state: "s-1",
        redirectUri: "https://app.test/api/jira/callback",
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://auth.example.test/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      audience: "api.atlassian.com",
      client_id: "the-client-id",
      redirect_uri: "https://app.test/api/jira/callback",
      response_type: "code",
      state: "s-1",
      prompt: "consent",
    });
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.toString()).not.toContain(SECRET);
  });

  // #1037
  it("addresses the Jira API of a site through the gateway", () => {
    const { client } = clientWith(() => reply(200, {}));

    expect(client.jiraBase("cloud/1")).toBe(
      "https://api.example.test/ex/jira/cloud%2F1",
    );
  });
});
