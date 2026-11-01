// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the fake provider that other tickets build on, and the conformance suite itself: the
// fake must pass it, and providers that break the contract must fail exactly the matching checks.
import { describe, expect, it } from "vitest";
import { createGitAccess } from "../integrations/normalized.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type { RepoRef, ReviewTrigger } from "../integrations/types.ts";
import {
  fakeIntegration,
  fakeIntegrationProvider,
  fakeWebhookRequest,
  tamperedFakeWebhookRequest,
  type FakeWebhookEvent,
} from "./fake-integration-provider.ts";
import {
  CONFORMANCE_CHECKS,
  describeIntegrationProviderConformance,
  integrationProviderViolations,
  type ConformanceCheck,
  type ConformanceSubject,
} from "./integration-provider-conformance.ts";

const openedEvent: FakeWebhookEvent = {
  action: "opened",
  installation: { id: "installation-1" },
  repository: { id: "100", full_name: "acme/widgets" },
  number: 7,
  head: { sha: "abc123" },
  sender: { login: "alice", id: "1" },
};

const repo: RepoRef = {
  integrationId: "integration-1",
  externalId: "100",
  fullName: "acme/widgets",
  url: "https://fake.test/acme/widgets",
};

function createSubject(provider: IntegrationProvider): ConformanceSubject {
  const integration = fakeIntegration();
  const trigger: ReviewTrigger = {
    kind: "opened",
    repo,
    prNumber: 7,
    prUrl: "https://fake.test/acme/widgets/pull/7",
    headSha: "abc123",
    command: null,
    args: null,
    actor: { login: "alice", externalId: "1" },
    draft: false,
    state: "open",
  };
  return {
    provider,
    integration,
    repo,
    trigger,
    signedOpenedDelivery: () => fakeWebhookRequest(openedEvent),
    badlySignedDelivery: () =>
      fakeWebhookRequest(openedEvent, { secret: "wrong" }),
    tamperedDelivery: () => tamperedFakeWebhookRequest(openedEvent),
    irrelevantDelivery: () =>
      fakeWebhookRequest({ ...openedEvent, action: "closed" }),
    installationRemovedDelivery: () =>
      fakeWebhookRequest({ ...openedEvent, action: "installation_deleted" }),
    existingPullRequestNumber: 7,
    missingPullRequestNumber: 999,
    validConfig: { accountLogin: "acme", accountId: 5 },
    invalidConfig: { accountId: "five" },
  };
}

async function failedChecks(
  provider: IntegrationProvider,
): Promise<ConformanceCheck[]> {
  const subject = createSubject(provider);
  const results = await Promise.all(
    CONFORMANCE_CHECKS.map((check) =>
      integrationProviderViolations(check, subject),
    ),
  );
  return CONFORMANCE_CHECKS.filter((_, index) => results[index]!.length > 0);
}

// CR-20-T01
describeIntegrationProviderConformance("the fake provider", () =>
  createSubject(fakeIntegrationProvider()),
);

describe("the conformance suite", () => {
  // CR-20-T01
  it("fails a provider that hands out the platform's raw payload instead of normalized types", async () => {
    const leaky: IntegrationProvider = {
      ...fakeIntegrationProvider(),
      listRepositories: async () =>
        [{ id: 100, full_name: "acme/widgets", node_id: "MDEw" }] as never,
      parseEvent: async (_integration, request) =>
        (await request.clone().json()) as never,
      getPullRequest: async () =>
        ({ number: 7, base: { ref: "main" } }) as never,
    };

    expect(await failedChecks(leaky)).toEqual([
      "lists repositories as repo references of its integration",
      "turns a delivery into a normalized review trigger",
      "reports a removed connection as an installation change",
      "reports a delivery that is not relevant as ignored",
      "returns pull requests as normalized pull request references",
      "reports an unknown pull request with a stable error code",
      "stops a pull request read when the abort signal has already fired",
    ]);
  });

  it("fails a provider that ignores an aborted signal", async () => {
    const deaf: IntegrationProvider = {
      ...fakeIntegrationProvider(),
      getPullRequest: (integration, repo, prNumber) =>
        fakeIntegrationProvider().getPullRequest(integration, repo, prNumber),
    };

    expect(await failedChecks(deaf)).toEqual([
      "stops a pull request read when the abort signal has already fired",
    ]);
  });

  it("fails a provider that reads the request body instead of a clone", async () => {
    const consuming: IntegrationProvider = {
      ...fakeIntegrationProvider(),
      parseEvent: async (integration, request) =>
        fakeIntegrationProvider().parseEvent(
          integration,
          new Request(request.url, {
            method: "POST",
            body: await request.text(),
          }),
        ),
    };

    expect(await failedChecks(consuming)).toEqual([
      "keeps the request body readable after verifying, identifying and parsing",
    ]);
  });

  it("fails a provider that does not look at the body when it checks the signature", async () => {
    const trusting: IntegrationProvider = {
      ...fakeIntegrationProvider(),
      verifyWebhook: async () => true,
    };

    expect(await failedChecks(trusting)).toEqual([
      "refuses a delivery with a wrong or tampered signature and accepts a genuine one",
    ]);
  });

  it("fails a provider that returns its git access with a visible token", async () => {
    const careless: IntegrationProvider = {
      ...fakeIntegrationProvider(),
      jobAccess: async () => ({
        provider: "github",
        baseUrl: "https://fake.test/api",
        token: "t",
        authType: "token",
        botLogin: null,
        expiresAt: null,
      }),
    };

    expect(await failedChecks(careless)).toEqual([
      "hands out job access as normalized git access with a hidden token",
    ]);
  });

  it("fails a provider that cannot say which connection a delivery belongs to", async () => {
    const wrong: IntegrationProvider = {
      ...fakeIntegrationProvider(),
      identifyWebhook: async () => ({ externalId: "someone-else" }),
    };

    expect(await failedChecks(wrong)).toEqual([
      "identifies the connection of a delivery",
    ]);
  });
});

describe("the fake integration provider", () => {
  const integration = fakeIntegration();
  const parse = async (
    event: Partial<FakeWebhookEvent>,
    provider = fakeIntegrationProvider(),
  ) =>
    provider.parseEvent(
      integration,
      fakeWebhookRequest({ ...openedEvent, ...event }),
    );

  it("turns an opened delivery into a trigger that carries the pull request url", async () => {
    expect(await parse({})).toMatchObject({
      kind: "review_trigger",
      trigger: {
        kind: "opened",
        prNumber: 7,
        prUrl: "https://fake.test/acme/widgets/pull/7",
        headSha: "abc123",
      },
    });
  });

  it("turns a synchronize delivery into an updated trigger", async () => {
    expect(await parse({ action: "synchronize" })).toMatchObject({
      kind: "review_trigger",
      trigger: { kind: "updated" },
    });
  });

  it("turns a /review comment into a command trigger with no arguments", async () => {
    expect(
      await parse({
        action: "comment",
        comment: { body: "/review --pr_reviewer.num_max_findings=99" },
      }),
    ).toMatchObject({
      kind: "review_trigger",
      trigger: { kind: "command", command: "review", args: "" },
    });
  });

  it("ignores a comment that is not a command, including the removed commands and a longer word", async () => {
    for (const body of [
      "looks good",
      "/ask-me later",
      "/ask why?",
      "/improve this",
      "/describe",
      "/reviewer please",
    ]) {
      expect(
        await parse({ action: "comment", comment: { body } }),
      ).toMatchObject({ kind: "ignored" });
    }
  });

  it("reports an installation that was removed or whose repositories changed", async () => {
    expect(await parse({ action: "installation_deleted" })).toEqual({
      kind: "installation_changed",
      externalId: "installation-1",
      action: "deleted",
    });
    expect(await parse({ action: "installation_repositories" })).toEqual({
      kind: "installation_changed",
      externalId: "installation-1",
      action: "repositories_changed",
    });
  });

  it("identifies the installation a delivery belongs to", async () => {
    const provider = fakeIntegrationProvider();

    expect(
      await provider.identifyWebhook(fakeWebhookRequest(openedEvent)),
    ).toEqual({ externalId: "installation-1" });
  });

  it("accepts only a body signed with the secret", async () => {
    const provider = fakeIntegrationProvider();

    expect(
      await provider.verifyWebhook(null, fakeWebhookRequest(openedEvent)),
    ).toBe(true);
    expect(
      await provider.verifyWebhook(
        null,
        fakeWebhookRequest(openedEvent, { secret: "wrong" }),
      ),
    ).toBe(false);
    expect(
      await provider.verifyWebhook(
        null,
        tamperedFakeWebhookRequest(openedEvent),
      ),
    ).toBe(false);
  });

  it("refuses a delivery without a signature header", async () => {
    const provider = fakeIntegrationProvider();
    const unsigned = new Request("https://app.test/hook", {
      method: "POST",
      body: JSON.stringify(openedEvent),
    });

    expect(await provider.verifyWebhook(null, unsigned)).toBe(false);
  });

  it("lets the test decide who may trigger a review", async () => {
    const provider = fakeIntegrationProvider({ allowedActors: ["alice"] });
    const trigger = async (login: string) => {
      const event = await parse({ sender: { login, id: "9" } }, provider);
      if (event.kind !== "review_trigger") throw new Error("not a trigger");
      return event.trigger;
    };

    expect(await provider.canTrigger(integration, await trigger("alice"))).toBe(
      true,
    );
    expect(
      await provider.canTrigger(integration, await trigger("mallory")),
    ).toBe(false);
  });

  it("can be told to fail when job access is requested", async () => {
    const provider = fakeIntegrationProvider({
      jobAccessFailure: new Error("installation removed"),
    });

    await expect(provider.jobAccess(integration, repo)).rejects.toThrow(
      "installation removed",
    );
  });

  it("hands out access whose token does not show up when serialized", async () => {
    const provider = fakeIntegrationProvider({
      access: createGitAccess({
        provider: "github",
        baseUrl: "https://x.test",
        token: "ghs_dummy",
        authType: "token",
        botLogin: null,
        expiresAt: null,
      }),
    });

    const access = await provider.jobAccess(integration, repo);

    expect(JSON.stringify(access)).not.toContain("ghs_");
  });

  it("looks up one pull request and lists the open ones, drafts included", async () => {
    const provider = fakeIntegrationProvider();

    expect(await provider.getPullRequest(integration, repo, 7)).toMatchObject({
      number: 7,
      draft: false,
      url: "https://fake.test/acme/widgets/pull/7",
    });
    expect(
      (await provider.listOpenPullRequests(integration, repo)).map((pr) => [
        pr.number,
        pr.draft,
      ]),
    ).toEqual([
      [7, false],
      [8, true],
    ]);
  });

  // #750
  it("answers the branch reads from its settings: the default branch first, an unknown branch is null", async () => {
    const provider = fakeIntegrationProvider({
      defaultBranch: "trunk",
      branches: { zeta: "z".repeat(40), trunk: "t".repeat(40), alpha: "a" },
    });

    expect(await provider.getRepositoryFacts(integration, repo)).toEqual({
      defaultBranch: "trunk",
    });
    expect(await provider.listBranches(integration, repo)).toEqual({
      names: ["trunk", "alpha", "zeta"],
      truncated: false,
    });
    expect(await provider.getBranch(integration, repo, "zeta")).toEqual({
      sha: "z".repeat(40),
    });
    expect(await provider.getBranch(integration, repo, "nope")).toBeNull();
    expect(
      await fakeIntegrationProvider().getBranch(integration, repo, "main"),
    ).not.toBeNull();
  });

  // #755 (review of #776)
  it("does not grant the write permission unless a test says so", async () => {
    expect(
      await fakeIntegrationProvider().installationPermissions(integration),
    ).toEqual({ contentsWrite: false });
    expect(
      await fakeIntegrationProvider({
        contentsWrite: true,
      }).installationPermissions(integration),
    ).toEqual({ contentsWrite: true });
  });

  it("records the calls it receives", async () => {
    const provider = fakeIntegrationProvider();

    await provider.listRepositories(integration);

    expect(provider.calls.map((call) => call.method)).toEqual([
      "listRepositories",
    ]);
  });
});
