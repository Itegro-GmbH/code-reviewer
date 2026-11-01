// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the branch reads of the GitHub App provider with an in-memory client (#750): which token scope it asks
// for, that the abort signal reaches the client, and that every failure leaves as a provider neutral code.
import { describe, expect, it } from "vitest";
import { fakeIntegration } from "../../../test-support/fake-integration-provider.ts";
import { testGithubAppEnv } from "../../../test-support/github-app.ts";
import type { Integration, RepoRef } from "../../types.ts";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";
import {
  fakeGithubAppClient,
  type FakeGithubAppClientData,
} from "./fake-client.ts";
import { createGithubAppProvider } from "./provider.ts";

const integration: Integration = fakeIntegration({
  id: "integration-1",
  externalId: "4242",
});
const widgets: RepoRef = {
  integrationId: "integration-1",
  externalId: "7001",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
};
const SCOPE = {
  repositoryIds: [7001],
  permissions: { contents: "read", metadata: "read" },
};

function setup(data: FakeGithubAppClientData = {}) {
  const client = fakeGithubAppClient(data);
  const provider = createGithubAppProvider({
    config: loadGithubAppConfig(testGithubAppEnv()),
    client,
  });
  return { client, provider };
}

const reads = [
  [
    "getRepositoryFacts",
    (p: Provider) => p.getRepositoryFacts(integration, widgets),
  ],
  ["listBranches", (p: Provider) => p.listBranches(integration, widgets)],
  ["getBranch", (p: Provider) => p.getBranch(integration, widgets, "main")],
] as const;
type Provider = ReturnType<typeof setup>["provider"];

describe("the branch reads of the provider", () => {
  it("returns what the client reads, with the default branch first", async () => {
    const { provider } = setup({
      defaultBranch: "trunk",
      branches: { zeta: "z".repeat(40), trunk: "t".repeat(40) },
    });

    expect(await provider.getRepositoryFacts(integration, widgets)).toEqual({
      defaultBranch: "trunk",
    });
    expect(await provider.listBranches(integration, widgets)).toEqual({
      names: ["trunk", "zeta"],
      truncated: false,
    });
    expect(await provider.getBranch(integration, widgets, "zeta")).toEqual({
      sha: "z".repeat(40),
    });
    expect(await provider.getBranch(integration, widgets, "nope")).toBeNull();
  });

  // #750-T05
  it.each(reads)(
    "%s asks the client for a token of the one repository with contents: read",
    async (method, run) => {
      const { client, provider } = setup();

      await run(provider);

      expect(client.calls).toHaveLength(1);
      expect(client.calls[0]).toMatchObject({ method });
      expect(client.calls[0]?.args.slice(0, 3)).toEqual([
        "4242",
        SCOPE,
        "acme/widgets",
      ]);
    },
  );

  // #750-T05
  it("refuses a repository of another integration or without a usable id, without asking GitHub", async () => {
    const { client, provider } = setup();
    const foreign = { ...widgets, integrationId: "integration-2" };
    const unusable = { ...widgets, externalId: "abc" };

    for (const repo of [foreign, unusable]) {
      const refused = { code: "INTEGRATION_ACCESS_SCOPE_REFUSED" };
      await expect(
        provider.getRepositoryFacts(integration, repo),
      ).rejects.toMatchObject(refused);
      await expect(
        provider.listBranches(integration, repo),
      ).rejects.toMatchObject(refused);
      await expect(
        provider.getBranch(integration, repo, "main"),
      ).rejects.toMatchObject(refused);
    }
    expect(client.calls).toEqual([]);
  });

  // #750-T04
  it("hands the abort signal of the caller to the client", async () => {
    const { client, provider } = setup();
    const signal = new AbortController().signal;

    await provider.getRepositoryFacts(integration, widgets, signal);
    await provider.listBranches(integration, widgets, signal);
    await provider.getBranch(integration, widgets, "main", signal);

    expect(client.calls.map((call) => call.args.at(-1))).toEqual([
      signal,
      signal,
      signal,
    ]);
  });

  // #750-T04
  it("stops for a signal that has fired", async () => {
    const { provider } = setup();
    const fired = AbortSignal.abort();
    const unavailable = { code: "INTEGRATION_ACCESS_UNAVAILABLE" };

    await expect(
      provider.getRepositoryFacts(integration, widgets, fired),
    ).rejects.toMatchObject(unavailable);
    await expect(
      provider.listBranches(integration, widgets, fired),
    ).rejects.toMatchObject(unavailable);
    await expect(
      provider.getBranch(integration, widgets, "main", fired),
    ).rejects.toMatchObject(unavailable);
  });
});

describe("the branch reads when GitHub refuses", () => {
  // #750-T04
  it.each([
    [
      new GithubAppError("GITHUB_APP_AUTH_FAILED", "no", { status: 401 }),
      "INTEGRATION_ACCESS_APP_AUTH_FAILED",
    ],
    [
      new GithubAppError("GITHUB_APP_FORBIDDEN", "refused", { status: 403 }),
      "INTEGRATION_ACCESS_CONNECTION_SUSPENDED",
    ],
    [
      new GithubAppError("GITHUB_APP_NOT_FOUND", "gone", { status: 404 }),
      "INTEGRATION_ACCESS_CONNECTION_GONE",
    ],
    [
      new GithubAppError("GITHUB_APP_UNAVAILABLE", "down", { status: 503 }),
      "INTEGRATION_ACCESS_UNAVAILABLE",
    ],
    [
      new GithubAppError("GITHUB_APP_UNAVAILABLE", "timed out"),
      "INTEGRATION_ACCESS_UNAVAILABLE",
    ],
    [
      new GithubAppError("GITHUB_APP_RATE_LIMITED", "slow down", {
        status: 429,
        retryAfterSeconds: 30,
      }),
      "INTEGRATION_ACCESS_RATE_LIMITED",
    ],
  ])("maps %s to %s", async (failure, code) => {
    for (const [, run] of reads) {
      const { provider } = setup({ branchReadFailure: failure });
      await expect(run(provider)).rejects.toMatchObject({ code });
    }
  });

  // #750-T04
  it("keeps the wait time of a rate limit", async () => {
    const { provider } = setup({
      branchReadFailure: new GithubAppError("GITHUB_APP_RATE_LIMITED", "slow", {
        status: 429,
        retryAfterSeconds: 30,
      }),
    });

    await expect(
      provider.listBranches(integration, widgets),
    ).rejects.toMatchObject({ retryAfterSeconds: 30 });
  });
});

describe("the branch reads never read a pull request", () => {
  // #750-T07
  it.each(reads)("%s", async (_method, run) => {
    const { client, provider } = setup();

    await run(provider);

    expect(
      client.calls.filter((call) => /PullRequest|Comment/.test(call.method)),
    ).toEqual([]);
  });
});
