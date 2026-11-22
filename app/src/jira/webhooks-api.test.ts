// SPDX-License-Identifier: LicenseRef-Proprietary

// The dynamic webhook API of Jira Cloud (#1039) behind `JiraTokens.request`: what is sent, and how each answer is read.
import { describe, expect, it } from "vitest";
import { createJiraWebhookApi } from "./webhooks-api.ts";
import type { JiraRequestResult, JiraTokens } from "./tokens.ts";

type Call = { connectionId: string; path: string; init?: RequestInit };

function apiAnswering(
  answers: (call: Call) => JiraRequestResult | Promise<JiraRequestResult>,
) {
  const calls: Call[] = [];
  const tokens: JiraTokens = {
    use: () => Promise.reject(new Error("not used")),
    async request(connectionId, path, init) {
      const call: Call = {
        connectionId,
        path,
        ...(init === undefined ? {} : { init }),
      };
      calls.push(call);
      return answers(call);
    },
  };
  return { calls, api: createJiraWebhookApi({ tokens }) };
}

const reply = (status: number, body?: unknown): JiraRequestResult => ({
  ok: true,
  response: new Response(body === undefined ? null : JSON.stringify(body), {
    status,
  }),
});

describe("registering a webhook", () => {
  // #1039-T03
  it("posts the address, the JQL filter and the events, and reads the id of the new webhook", async () => {
    const { api, calls } = apiAnswering(() =>
      reply(200, { webhookRegistrationResult: [{ createdWebhookId: 1000 }] }),
    );
    const result = await api.register("conn-1", {
      url: "https://app.test/api/webhooks/jira?w=x&s=y",
      jql: "project = PROJ",
      events: ["jira:issue_updated"],
    });
    expect(result).toEqual({ ok: true, webhookId: "1000" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.connectionId).toBe("conn-1");
    expect(calls[0]?.path).toBe("/rest/api/3/webhook");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      url: "https://app.test/api/webhooks/jira?w=x&s=y",
      webhooks: [
        { jqlFilter: "project = PROJ", events: ["jira:issue_updated"] },
      ],
    });
  });

  // #1039
  it("reads the plain array of results Jira's guide shows as well", async () => {
    const { api } = apiAnswering(() => reply(200, [{ createdWebhookId: 7 }]));
    expect(
      await api.register("c", { url: "https://a.test", jql: "x", events: [] }),
    ).toEqual({ ok: true, webhookId: "7" });
  });

  // #1039
  it("tells the limit of webhooks from any other rejection", async () => {
    const limit = apiAnswering(() =>
      reply(200, {
        webhookRegistrationResult: [
          { errors: ["You can only register 5 webhooks per app"] },
        ],
      }),
    );
    expect(
      await limit.api.register("c", { url: "u", jql: "x", events: [] }),
    ).toEqual({ ok: false, error: "jira_webhook_limit" });
    const other = apiAnswering(() =>
      reply(200, {
        webhookRegistrationResult: [{ errors: ["The clause is unsupported"] }],
      }),
    );
    expect(
      await other.api.register("c", { url: "u", jql: "x", events: [] }),
    ).toEqual({ ok: false, error: "jira_webhook_rejected" });
    const nothing = apiAnswering(() => reply(200, {}));
    expect(
      await nothing.api.register("c", { url: "u", jql: "x", events: [] }),
    ).toEqual({ ok: false, error: "jira_webhook_rejected" });
  });

  // #1131-T08
  it("tells Jira's refusal of a second address from every other rejection, in a 400 and in the results", async () => {
    const text =
      "Only a single URL per user is allowed to be registered via REST API.";
    for (const answer of [
      () => reply(400, { errorMessages: [text], errors: {} }),
      () => reply(200, { webhookRegistrationResult: [{ errors: [text] }] }),
      () => reply(400, { message: text.replace("user", "app") }),
    ]) {
      const { api } = apiAnswering(answer);
      expect(
        await api.register("c", { url: "u", jql: "x", events: [] }),
      ).toEqual({ ok: false, error: "jira_webhook_url_conflict" });
    }
    // The text is Jira's: nothing of it is passed on.
    const { api } = apiAnswering(() => reply(400, { errorMessages: [text] }));
    expect(
      JSON.stringify(
        await api.register("c", { url: "u", jql: "x", events: [] }),
      ),
    ).not.toContain("single");
  });

  // #1039
  it("maps an answer that is no success to a code and holds nothing of the body", async () => {
    for (const [status, error] of [
      [401, "jira_forbidden"],
      [403, "jira_forbidden"],
      [400, "jira_webhook_rejected"],
      [500, "jira_unavailable"],
      [503, "jira_unavailable"],
    ] as const) {
      const { api } = apiAnswering(() =>
        reply(status, { message: "secret-token-abc" }),
      );
      const result = await api.register("c", {
        url: "u",
        jql: "x",
        events: [],
      });
      expect(result).toEqual({ ok: false, error });
    }
  });

  // #1039
  it("passes a failure of the connection through", async () => {
    const { api } = apiAnswering(() => ({
      ok: false,
      error: "jira_connection_broken",
    }));
    expect(await api.register("c", { url: "u", jql: "x", events: [] })).toEqual(
      { ok: false, error: "jira_connection_broken" },
    );
  });
});

describe("extending and deleting webhooks", () => {
  // #1039-T03
  it("extends by the ids and reads the new end of life", async () => {
    const { api, calls } = apiAnswering(() =>
      reply(200, { expirationDate: "2026-12-14T10:00:00.000+0000" }),
    );
    expect(await api.extend("conn-1", ["1000"])).toEqual({
      ok: true,
      expiresAt: "2026-12-14T10:00:00.000Z",
    });
    expect(calls[0]?.path).toBe("/rest/api/3/webhook/refresh");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      webhookIds: [1000],
    });
  });

  // #1039
  it("is unavailable when the answer holds no usable end of life", async () => {
    const { api } = apiAnswering(() => reply(200, { expirationDate: "soon" }));
    expect(await api.extend("c", ["1"])).toEqual({
      ok: false,
      error: "jira_webhook_rejected",
    });
  });

  // #1039-T03
  it("deletes by the ids", async () => {
    const { api, calls } = apiAnswering(() => reply(202));
    expect(await api.remove("conn-1", ["1000", "1001"])).toEqual({ ok: true });
    expect(calls[0]?.path).toBe("/rest/api/3/webhook");
    expect(calls[0]?.init?.method).toBe("DELETE");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      webhookIds: [1000, 1001],
    });
  });

  // #1039
  it("treats a webhook that is gone at Jira as removed, and a refusal as a failure", async () => {
    expect(await apiAnswering(() => reply(404)).api.remove("c", ["1"])).toEqual(
      { ok: true },
    );
    expect(await apiAnswering(() => reply(403)).api.remove("c", ["1"])).toEqual(
      { ok: false, error: "jira_forbidden" },
    );
  });

  // #1039
  it("says a webhook is gone when Jira refuses to extend an id it does not know", async () => {
    const { api } = apiAnswering(() => reply(404));
    expect(await api.extend("c", ["1"])).toEqual({
      ok: false,
      error: "jira_webhook_gone",
    });
  });
});

describe("listing the webhooks of the app", () => {
  // #1039
  it("reads every page and answers the id, the filter and the end of each webhook", async () => {
    const { api, calls } = apiAnswering((call) =>
      call.path.includes("startAt=0")
        ? reply(200, {
            values: [
              {
                id: 1000,
                jqlFilter: "project = A",
                expirationDate: "2026-12-14T10:00:00.000+0000",
              },
            ],
            isLast: false,
          })
        : reply(200, {
            values: [
              {
                id: 1001,
                jqlFilter: "project = B",
                expirationDate: "2026-12-15T10:00:00.000+0000",
              },
              { id: "no", jqlFilter: 3 },
            ],
            isLast: true,
          }),
    );
    expect(await api.list("conn-1")).toEqual({
      ok: true,
      webhooks: [
        {
          id: "1000",
          jql: "project = A",
          expiresAt: "2026-12-14T10:00:00.000Z",
        },
        {
          id: "1001",
          jql: "project = B",
          expiresAt: "2026-12-15T10:00:00.000Z",
        },
      ],
    });
    expect(calls.map((call) => call.init?.method)).toEqual(["GET", "GET"]);
    expect(calls[0]?.path).toBe("/rest/api/3/webhook?startAt=0&maxResults=100");
  });

  // #1039
  it("is a failure when Jira refuses or is not reachable", async () => {
    expect(await apiAnswering(() => reply(403)).api.list("c")).toEqual({
      ok: false,
      error: "jira_forbidden",
    });
    expect(await apiAnswering(() => reply(503)).api.list("c")).toEqual({
      ok: false,
      error: "jira_unavailable",
    });
  });
});
