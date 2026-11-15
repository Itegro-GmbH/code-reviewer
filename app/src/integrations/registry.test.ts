// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how a stored integration type is turned into its provider, and that every way of not
// finding one ends in a stable error code.
import { describe, expect, it } from "vitest";
import { fakeIntegrationProvider } from "../test-support/fake-integration-provider.ts";
import { IntegrationError } from "./errors.ts";
import {
  createDefaultIntegrationRegistry,
  createIntegrationRegistry,
  integrationRegistry,
  loadGithubAppConfig,
} from "./registry.ts";
import { fakeIntegration } from "../test-support/fake-integration-provider.ts";

function errorCodeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof IntegrationError) return error.code;
    throw error;
  }
  return undefined;
}

describe("the integration registry", () => {
  it("resolves a registered type to its provider", () => {
    const provider = fakeIntegrationProvider();
    const registry = createIntegrationRegistry({ github_app: provider });

    expect(registry.resolve("github_app")).toBe(provider);
  });

  // CR-20-T03
  it("fails with a stable code for a type it has never heard of", () => {
    const registry = createIntegrationRegistry({
      github_app: fakeIntegrationProvider(),
    });

    expect(errorCodeOf(() => registry.resolve("gitlab"))).toBe(
      "INTEGRATION_TYPE_UNKNOWN",
    );
  });

  // CR-20-T03
  it("fails with a stable code for a reserved type that has no provider yet", () => {
    const registry = createIntegrationRegistry({
      github_app: fakeIntegrationProvider(),
    });

    expect(errorCodeOf(() => registry.resolve("bitbucket_cloud"))).toBe(
      "INTEGRATION_PROVIDER_NOT_IMPLEMENTED",
    );
  });

  // CR-20-T03
  it("fails with a stable code for a known type nobody registered", () => {
    const registry = createIntegrationRegistry({});

    expect(errorCodeOf(() => registry.resolve("github_app"))).toBe(
      "INTEGRATION_PROVIDER_NOT_IMPLEMENTED",
    );
  });

  // CR-20-T03
  it("fails with a stable code for a value that is not even a string", () => {
    const registry = createIntegrationRegistry({});

    expect(errorCodeOf(() => registry.resolve(undefined))).toBe(
      "INTEGRATION_TYPE_UNKNOWN",
    );
  });

  it("refuses a provider registered under a type it does not implement", () => {
    const wrongKey = {
      github_app: { ...fakeIntegrationProvider(), type: "other" },
    } as never;

    expect(() => createIntegrationRegistry(wrongKey)).toThrow(/other/);
  });

  it("lists the types that have a provider", () => {
    const registry = createIntegrationRegistry({
      github_app: fakeIntegrationProvider(),
    });

    expect(registry.registeredTypes()).toEqual(["github_app"]);
  });
});

describe("the default registry", () => {
  it("registers the GitHub App provider and loads without any GitHub App settings", () => {
    expect(integrationRegistry.registeredTypes()).toEqual(["github_app"]);
    expect(integrationRegistry.resolve("github_app").type).toBe("github_app");
  });

  it("fails the first call that needs GitHub with a config error that names the variables", async () => {
    const registry = createDefaultIntegrationRegistry({
      loadConfig: () => loadGithubAppConfig({}),
    });

    const failure = await registry
      .resolve("github_app")
      .listRepositories(fakeIntegration())
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toMatchObject({
      code: "GITHUB_APP_CONFIG_INVALID",
      variables: expect.arrayContaining(["GITHUB_APP_ID", "GITHUB_APP_SLUG"]),
    });
  });
});

describe("the ticket providers registered for the process (#1040)", () => {
  // #1040
  it("finds the provider registered under an id, and the last registration of an id wins", async () => {
    const { registerTicketProvider, registeredTicketProvider } =
      await import("./ticket-provider.ts");
    expect(registeredTicketProvider("registry-test")).toBeUndefined();
    const first = { id: "registry-test" };
    const second = { id: "registry-test" };
    registerTicketProvider(first);
    expect(registeredTicketProvider("registry-test")).toBe(first);
    registerTicketProvider(second);
    expect(registeredTicketProvider("registry-test")).toBe(second);
  });
});
