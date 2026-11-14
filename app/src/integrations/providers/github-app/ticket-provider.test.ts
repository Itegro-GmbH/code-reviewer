// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub App as a TicketProvider (#1035): the key of a ticket is the number of its issue as text, a key that is no number names no
// ticket, and the calls are the ones the git provider's ticket methods made before.
import { describe, expect, it } from "vitest";
import { IntegrationError } from "../../errors.ts";
import type { RepoRef } from "../../types.ts";
import { fakeIntegration } from "../../../test-support/fake-integration-provider.ts";
import { testGithubAppEnv } from "../../../test-support/github-app.ts";
import { createGithubClientSource } from "./client-source.ts";
import { loadGithubAppConfig } from "./config.ts";
import {
  fakeGithubAppClient,
  type FakeGithubAppClientData,
} from "./fake-client.ts";
import { createGithubTicketProvider } from "./ticket-provider.ts";

const integration = fakeIntegration({
  id: "integration-1",
  externalId: "4242",
});
const widgets: RepoRef = {
  integrationId: "integration-1",
  externalId: "7001",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
};
const scope = { integration, repo: widgets };

function setup(data: FakeGithubAppClientData = {}) {
  const client = fakeGithubAppClient(data);
  const provider = createGithubTicketProvider(
    createGithubClientSource({
      config: loadGithubAppConfig(testGithubAppEnv()),
      client,
    }),
  );
  return { client, provider };
}

describe("the GitHub ticket provider", () => {
  // #1035-T01
  it("is named github and takes a whole number as the key of a ticket", () => {
    const { provider } = setup();

    expect(provider.id).toBe("github");
    expect(provider.isTicketKey?.("15")).toBe(true);
    expect(provider.isTicketKey?.("PROJ-123")).toBe(false);
    expect(provider.isTicketKey?.("0")).toBe(false);
    expect(provider.isTicketKey?.("1.5")).toBe(false);
  });

  // #1035-T01
  it("reads the issue the key names, with the key as text next to the number, and none for a key that is no number", async () => {
    const { client, provider } = setup({
      issues: {
        "acme/widgets#15": {
          number: 15,
          title: "Cache it",
          body: "Words.",
          url: "https://github.com/acme/widgets/issues/15",
          labels: ["bug"],
          assignees: [],
          type: "",
        },
      },
    });

    expect(await provider.readTicket?.(scope, "15")).toMatchObject({
      key: "15",
      number: 15,
      title: "Cache it",
    });
    expect(await provider.readTicket?.(scope, "16")).toBeNull();
    client.calls.length = 0;
    expect(await provider.readTicket?.(scope, "PROJ-123")).toBeNull();
    expect(client.calls).toEqual([]);
  });

  // #1035-T01
  it("writes below the issue of the key, and refuses a key that is no number before GitHub is asked", async () => {
    const { client, provider } = setup();

    await provider.commentOnTicket?.(scope, "15", "Hello");
    await provider.changeTicketLabels?.(scope, "15", {
      add: ["agent working"],
      remove: [],
    });

    expect(
      client.calls
        .filter((call) => call.method === "createIssueComment")
        .map((call) => call.args.slice(2, 4)),
    ).toEqual([["acme/widgets", 15]]);
    expect(
      client.calls
        .filter((call) => call.method === "changeIssueLabels")
        .map((call) => call.args.slice(2, 4)),
    ).toEqual([["acme/widgets", 15]]);
    client.calls.length = 0;
    await expect(
      provider.commentOnTicket?.(scope, "PROJ-123", "Hello"),
    ).rejects.toBeInstanceOf(IntegrationError);
    await expect(
      provider.changeTicketLabels?.(scope, "PROJ-123", {
        add: ["x"],
        remove: [],
      }),
    ).rejects.toMatchObject({ code: "INTEGRATION_REQUEST_REFUSED" });
    expect(
      await provider.setTicketStatus?.(scope, "PROJ-123", {
        board: "1",
        status: "Done",
      }),
    ).toEqual({
      kind: "issue_not_found",
    });
    expect(client.calls).toEqual([]);
  });
});
