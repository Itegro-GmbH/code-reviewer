// SPDX-License-Identifier: LicenseRef-Proprietary

// The dynamic webhook API of Jira Cloud (#1039), the one an OAuth 2.0 (3LO) app registers webhooks with (the admin webhook API refuses OAuth):
// register (`POST /rest/api/3/webhook`), extend (`PUT /rest/api/3/webhook/refresh`: a webhook registered through the REST API ends 30 days
// after it was registered or extended) and delete (`DELETE /rest/api/3/webhook`). All of it goes through `JiraTokens.request`, so the token is
// refreshed, renewed on a 401 and never seen here. Answers are values, never exceptions, and a failure holds nothing of what Jira said.
import type { JiraWebhookErrorCode } from "./errors.ts";
import { jiraTime } from "./issue.ts";
import type { JiraTokens } from "./tokens.ts";

export type JiraWebhookFailure = {
  ok: false;
  error: JiraWebhookErrorCode | "jira_webhook_gone";
};

export type JiraWebhookApi = {
  /** Registers ONE webhook (one JQL filter, these events) calling `url`; answers Jira's id of it. */
  register(
    connectionId: string,
    webhook: { url: string; jql: string; events: readonly string[] },
  ): Promise<{ ok: true; webhookId: string } | JiraWebhookFailure>;
  /** Extends the life of the webhooks by another 30 days; answers the new end of it (ISO UTC). `jira_webhook_gone`: Jira does not know them. */
  extend(
    connectionId: string,
    webhookIds: readonly string[],
  ): Promise<{ ok: true; expiresAt: string } | JiraWebhookFailure>;
  /** The webhooks the app has registered for the person of the connection on the site (Jira does not say their address). */
  list(connectionId: string): Promise<
    | {
        ok: true;
        webhooks: { id: string; jql: string; expiresAt: string }[];
      }
    | JiraWebhookFailure
  >;
  /** Deletes the webhooks; an id Jira does not know counts as deleted. */
  remove(
    connectionId: string,
    webhookIds: readonly string[],
  ): Promise<{ ok: true } | JiraWebhookFailure>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Jira's numeric ids as the numbers its API takes; an id that is none is dropped (the call then refuses it). */
const numbersOf = (ids: readonly string[]): number[] =>
  ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);

/** Pages of the list the factory reads at most; Jira allows five webhooks per app and user, so one page is the rule. */
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 5;

/** The failure an answer that is no success stands for. */
function failureOf(status: number): JiraWebhookFailure {
  if (status === 401 || status === 403)
    return { ok: false, error: "jira_forbidden" };
  if (status >= 400 && status < 500)
    return { ok: false, error: "jira_webhook_rejected" };
  return { ok: false, error: "jira_unavailable" };
}

export function createJiraWebhookApi({
  tokens,
}: {
  tokens: JiraTokens;
}): JiraWebhookApi {
  const send = (
    connectionId: string,
    method: string,
    path: string,
    body: unknown,
  ) =>
    tokens.request(connectionId, path, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });

  return {
    async register(connectionId, webhook) {
      const result = await send(connectionId, "POST", "/rest/api/3/webhook", {
        url: webhook.url,
        webhooks: [{ jqlFilter: webhook.jql, events: [...webhook.events] }],
      });
      if (!result.ok) return { ok: false, error: result.error };
      const { response } = result;
      if (!response.ok) return failureOf(response.status);
      const body = await jsonOf(response);
      // Jira's reference wraps the results, its guide shows the bare array: both are read.
      const results = Array.isArray(body)
        ? body
        : isRecord(body) && Array.isArray(body.webhookRegistrationResult)
          ? body.webhookRegistrationResult
          : [];
      const first: unknown = results[0];
      if (isRecord(first) && first.createdWebhookId !== undefined) {
        const id = Number(first.createdWebhookId);
        if (Number.isSafeInteger(id) && id > 0)
          return { ok: true, webhookId: String(id) };
      }
      const errors =
        isRecord(first) && Array.isArray(first.errors) ? first.errors : [];
      // The limit is the one refusal the caller can name; its text is Jira's, so it is looked at and never passed on.
      const limit = errors.some(
        (error) =>
          typeof error === "string" &&
          /\b(limit|maximum|only register|too many)\b/i.test(error),
      );
      return {
        ok: false,
        error: limit ? "jira_webhook_limit" : "jira_webhook_rejected",
      };
    },

    async extend(connectionId, webhookIds) {
      const result = await send(
        connectionId,
        "PUT",
        "/rest/api/3/webhook/refresh",
        {
          webhookIds: numbersOf(webhookIds),
        },
      );
      if (!result.ok) return { ok: false, error: result.error };
      const { response } = result;
      if (response.status === 404)
        return { ok: false, error: "jira_webhook_gone" };
      if (!response.ok) return failureOf(response.status);
      const body = await jsonOf(response);
      const expiresAt = jiraTime(
        isRecord(body) ? body.expirationDate : undefined,
      );
      return expiresAt === ""
        ? { ok: false, error: "jira_webhook_rejected" }
        : { ok: true, expiresAt };
    },

    async list(connectionId) {
      const webhooks: { id: string; jql: string; expiresAt: string }[] = [];
      for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
        const result = await tokens.request(
          connectionId,
          `/rest/api/3/webhook?startAt=${String(page * LIST_PAGE_SIZE)}&maxResults=${String(LIST_PAGE_SIZE)}`,
          { method: "GET", headers: { accept: "application/json" } },
        );
        if (!result.ok) return { ok: false, error: result.error };
        const { response } = result;
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return failureOf(response.status);
        }
        const body = await jsonOf(response);
        const values =
          isRecord(body) && Array.isArray(body.values) ? body.values : [];
        for (const value of values as unknown[]) {
          if (!isRecord(value)) continue;
          const id = Number(value.id);
          const expiresAt = jiraTime(value.expirationDate);
          if (
            Number.isSafeInteger(id) &&
            id > 0 &&
            typeof value.jqlFilter === "string" &&
            expiresAt !== ""
          )
            webhooks.push({ id: String(id), jql: value.jqlFilter, expiresAt });
        }
        if (!isRecord(body) || body.isLast !== false) break;
      }
      return { ok: true, webhooks };
    },

    async remove(connectionId, webhookIds) {
      const result = await send(connectionId, "DELETE", "/rest/api/3/webhook", {
        webhookIds: numbersOf(webhookIds),
      });
      if (!result.ok) return { ok: false, error: result.error };
      const { response } = result;
      // Jira ignores ids it does not know (and a site that is gone has nothing left to delete).
      if (response.ok || response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: true };
      }
      return failureOf(response.status);
    },
  };
}
