// SPDX-License-Identifier: LicenseRef-Proprietary

// #922: the boards of a repository through the real GitHub App provider on an in-memory client: the token holds the board permission and
// nothing else, a repository of another installation is refused before GitHub is asked, and a failure is a read error of the integration.
import { describe, expect, it } from "vitest";
import { IntegrationError } from "../../errors.ts";
import type { RepoRef } from "../../types.ts";
import { fakeIntegration } from "../../../test-support/fake-integration-provider.ts";
import { testGithubAppEnv } from "../../../test-support/github-app.ts";
import { loadGithubAppConfig } from "./config.ts";
import {
  fakeGithubAppClient,
  type FakeGithubAppClientData,
} from "./fake-client.ts";
import { createGithubAppProvider } from "./provider.ts";

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

function setup(data: FakeGithubAppClientData = {}) {
  const client = fakeGithubAppClient(data);
  const provider = createGithubAppProvider({
    config: loadGithubAppConfig(testGithubAppEnv()),
    client,
  });
  return { client, provider };
}

describe("the boards of a repository", () => {
  // #922-T43
  it("lists them with a token of this repository that holds the board permission and nothing else", async () => {
    const boards = [
      {
        projectV2Id: "PVT_1",
        number: 1,
        title: "Roadmap",
        statusFieldId: "PVTSSF_1",
        statuses: ["Todo", "Done"],
      },
    ];
    const { client, provider } = setup({
      repositoryBoards: { "acme/widgets": boards },
    });

    const answer = await provider.listBoards?.(integration, widgets);

    expect(answer).toEqual({ available: true, boards });
    const [call] = client.calls.filter(
      (c) => c.method === "listRepositoryBoards",
    );
    expect(call?.args.slice(0, 3)).toEqual([
      "4242",
      {
        repositoryIds: [7001],
        permissions: { organization_projects: "read", metadata: "read" },
      },
      "acme/widgets",
    ]);
  });

  // #922-T44
  it("is not available for a repository whose boards the App may not read", async () => {
    const { provider } = setup();

    expect(await provider.listBoards?.(integration, widgets)).toEqual({
      available: false,
      boards: [],
    });
  });

  // #922-T45
  it("refuses a repository of another installation before GitHub is asked, and turns a failure into a read error", async () => {
    const refused = setup();
    const failing = setup({ trackerFailure: new Error("GitHub is down") });

    await expect(
      refused.provider.listBoards?.(integration, {
        ...widgets,
        integrationId: "another",
      }),
    ).rejects.toMatchObject({ code: "INTEGRATION_ACCESS_SCOPE_REFUSED" });
    expect(refused.client.calls).toEqual([]);
    await expect(
      failing.provider.listBoards?.(integration, widgets),
    ).rejects.toBeInstanceOf(IntegrationError);
  });
});
