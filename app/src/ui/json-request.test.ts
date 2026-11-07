// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how the pages talk to the app's own JSON routes: a success carries the data, every
// failure becomes a stable code (the route's own, or one for a session that ended, a refused user, a
// lost connection or an answer that is not JSON), and nothing throws.
import { describe, expect, it } from "vitest";
import { requestJson, type FetchLike } from "./json-request.ts";

function answering(status: number, body: unknown, raw?: string): FetchLike {
  return async () =>
    new Response(raw ?? JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("requesting JSON from the app", () => {
  it("returns the data of a successful answer", async () => {
    const result = await requestJson(
      answering(200, { added: 2 }),
      "POST",
      "/api/integrations/sync",
    );

    expect(result).toEqual({ ok: true, data: { added: 2 } });
  });

  it("sends the body as JSON and stays on this site", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const spy: FetchLike = async (url, init) => {
      seen.push({ url, init: init ?? {} });
      return new Response("{}", { status: 200 });
    };

    await requestJson(spy, "PUT", "/api/x", { active: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/api/x");
    expect(seen[0]?.init.method).toBe("PUT");
    expect(seen[0]?.init.body).toBe('{"active":true}');
    expect(new Headers(seen[0]?.init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(seen[0]?.init.credentials).toBe("same-origin");
  });

  it("returns the error code and the field issues of a refusal", async () => {
    const result = await requestJson(
      answering(400, {
        error: "REVIEW_SETTINGS_INVALID",
        issues: [{ field: "maxTokens", code: "TOO_SMALL" }],
      }),
      "PUT",
      "/api/x",
      {},
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "maxTokens", code: "TOO_SMALL" }],
    });
  });

  it("keeps the other fields of a refusal as details, and has none when there are none", async () => {
    const withDetails = await requestJson(
      answering(409, { error: "model_change_not_confirmed", projects: 5 }),
      "PUT",
      "/api/x",
      {},
    );
    const without = await requestJson(
      answering(422, { error: "name_invalid" }),
      "PUT",
      "/api/x",
      {},
    );

    expect(withDetails).toEqual({
      ok: false,
      status: 409,
      code: "model_change_not_confirmed",
      issues: [],
      details: { projects: 5 },
    });
    expect(without).not.toHaveProperty("details");
  });

  it("keeps the codes the access proxy answers with", async () => {
    const unauthenticated = await requestJson(
      answering(401, { error: "UNAUTHENTICATED" }),
      "POST",
      "/api/x",
    );
    const denied = await requestJson(
      answering(403, { error: "ACCESS_DENIED", reason: "not_allowed" }),
      "POST",
      "/api/x",
    );

    expect(unauthenticated).toMatchObject({
      ok: false,
      code: "UNAUTHENTICATED",
    });
    expect(denied).toMatchObject({ ok: false, code: "ACCESS_DENIED" });
  });

  it("reports a lost connection as NETWORK_ERROR", async () => {
    const result = await requestJson(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      "POST",
      "/api/x",
    );

    expect(result).toEqual({
      ok: false,
      status: null,
      code: "NETWORK_ERROR",
      issues: [],
    });
  });

  it("reports an answer that is not JSON as UNEXPECTED_RESPONSE", async () => {
    const result = await requestJson(
      answering(200, null, "<html>login</html>"),
      "POST",
      "/api/x",
    );

    expect(result).toMatchObject({ ok: false, code: "UNEXPECTED_RESPONSE" });
  });

  it("reports an error answer without a code as UNEXPECTED_RESPONSE", async () => {
    const result = await requestJson(
      answering(500, { message: "x" }),
      "POST",
      "/api/x",
    );

    expect(result).toMatchObject({
      ok: false,
      status: 500,
      code: "UNEXPECTED_RESPONSE",
    });
  });

  it("drops issues that are not a field and a code", async () => {
    const result = await requestJson(
      answering(400, {
        error: "REVIEW_SETTINGS_INVALID",
        issues: [{ field: "model", code: "EMPTY" }, 5, { field: 3 }],
      }),
      "PUT",
      "/api/x",
      {},
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [{ field: "model", code: "EMPTY" }],
    });
  });

  it("hands an abort signal to fetch", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const controller = new AbortController();
    await requestJson(
      (_url, init) => {
        seen.push(init?.signal);
        return Promise.resolve(
          new Response(JSON.stringify({}), { status: 200 }),
        );
      },
      "POST",
      "/api/x",
      {},
      controller.signal,
    );
    expect(seen).toEqual([controller.signal]);
  });
});
