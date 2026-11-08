// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the control endpoint with which a Playwright journey adds an issue to the fake GitHub that runs as its own
// process: what it adds is what the app's real client reads back over HTTP (the start of a lane reads the ticket there),
// adding the same number again replaces the issue, and a body that is not an issue is refused.
import { describe, expect, it } from "vitest";
import { startSyncHarness } from "../../src/test-support/integration-sync-harness.ts";

async function setup() {
  const h = await startSyncHarness();
  h.fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
  await h.sync.syncAll();
  const integration = (await h.integrations.list())[0];
  const repository = (await h.repositories.list())[0];
  if (integration === undefined || repository === undefined)
    throw new Error("seeding failed");
  const provider = h.registry.resolve("github_app");
  if (provider.readIssue === undefined) throw new Error("seeding failed");
  const read = provider.readIssue.bind(provider);
  const repo = {
    integrationId: integration.id,
    externalId: repository.externalId,
    fullName: repository.fullName,
    url: repository.url,
  };
  return {
    readIssue: (number: number) => read(integration, repo, number),
    post: (body: unknown) =>
      fetch(`${h.fake.baseUrl}/__fake/issues`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A text is sent as it is: the body of a request that is not even JSON.
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
  };
}

describe("the issues control endpoint of the fake GitHub", () => {
  it("adds an issue that the app's client reads back, and replaces one with the same number", async () => {
    const { readIssue, post } = await setup();

    const first = await post({
      repository: "acme/widgets",
      issue: { number: 5, title: "First title", labels: ["bug"] },
    });
    const second = await post({
      repository: "acme/widgets",
      issue: { number: 5, title: "Second title", body: "More words." },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await readIssue(5)).toMatchObject({
      number: 5,
      title: "Second title",
      body: "More words.",
      labels: [],
    });
  });

  it("refuses a body that is not an issue", async () => {
    const { post } = await setup();

    for (const body of [
      "not json",
      { repository: "acme/widgets" },
      { repository: "acme/widgets", issue: { number: "5", title: "Title" } },
      { repository: "acme/widgets", issue: { number: 5, title: 7 } },
      {
        repository: "acme/widgets",
        issue: { number: 5, title: "Title", labels: "bug" },
      },
      { issue: { number: 5, title: "Title" } },
    ]) {
      const response = await post(body);
      expect(response.status).toBe(400);
    }
  });
});
