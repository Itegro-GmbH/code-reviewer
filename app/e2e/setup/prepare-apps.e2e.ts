// SPDX-License-Identifier: LicenseRef-Proprietary

// Not a journey: the first thing a run does. The apps under test start without a database, so each
// one is a new instance that waits for the first-run setup and answers nothing else. This sets the
// ones that the other journeys use up (single-tenant, one admin), through the same routes as the
// wizard, with a code from `pnpm setup-code`. The two that sign people in and review also get the GitHub App,
// entered in their admin portal with the same form an operator uses (the dummy App of the fake GitHub). The
// journeys then see the instance they always saw: a login page, the projects, the runs. The third app is left alone on purpose: e2e/setup/first-run.e2e.ts
// walks through its wizard.
import { expect, test } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import { enterGithubApp, setUpApp } from "../helpers/setup";

test.describe("the apps under test", () => {
  test("the app of the journeys is set up before the first journey runs", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.appUrl, e2eEnv.databaseUrl);
    await enterGithubApp(e2eEnv.appUrl);

    const page = await request.get(e2eEnv.appUrl, { maxRedirects: 0 });
    expect(page.status()).toBe(307);
  });

  test("the app of the sign-up journey is set up before it runs", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.signupAppUrl, e2eEnv.signupDatabaseUrl);

    const page = await request.get(e2eEnv.signupAppUrl, { maxRedirects: 0 });
    expect(page.status()).toBe(307);
  });

  test("the multi-tenant app of the workspace journeys is set up before they run", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.multiAppUrl, e2eEnv.multiDatabaseUrl, "multi");
    await enterGithubApp(e2eEnv.multiAppUrl);

    const page = await request.get(e2eEnv.multiAppUrl, { maxRedirects: 0 });
    expect(page.status()).toBe(307);
  });

  test("the operator app of the limits journey is set up before it runs", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.operatorAppUrl, e2eEnv.operatorDatabaseUrl, "multi");
    await enterGithubApp(e2eEnv.operatorAppUrl);

    const page = await request.get(e2eEnv.operatorAppUrl, {
      maxRedirects: 0,
    });
    expect(page.status()).toBe(307);
  });

  test("the catalog app of the providers and catalog journey is set up before it runs", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.catalogAppUrl, e2eEnv.catalogDatabaseUrl, "multi");
    await enterGithubApp(e2eEnv.catalogAppUrl);

    const page = await request.get(e2eEnv.catalogAppUrl, { maxRedirects: 0 });
    expect(page.status()).toBe(307);
  });

  // #554-T10
  test("the app of the catalog admin journey is set up before it runs", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.catalogAdminAppUrl, e2eEnv.catalogAdminDatabaseUrl);

    const page = await request.get(e2eEnv.catalogAdminAppUrl, {
      maxRedirects: 0,
    });
    expect(page.status()).toBe(307);
  });

  test("the app of the real review journey is set up before it runs", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.pipelineAppUrl, e2eEnv.pipelineDatabaseUrl);
    await enterGithubApp(e2eEnv.pipelineAppUrl);

    const page = await request.get(e2eEnv.pipelineAppUrl, { maxRedirects: 0 });
    expect(page.status()).toBe(307);
  });

  // #951
  test("the factory app of the factory pages journey is set up before it runs", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.factoryAppUrl, e2eEnv.factoryDatabaseUrl);
    await enterGithubApp(e2eEnv.factoryAppUrl);

    const page = await request.get(e2eEnv.factoryAppUrl, { maxRedirects: 0 });
    expect(page.status()).toBe(307);
    // The app is the factory with the Implementer: the health route names the product and the set.
    const health = await request.get(`${e2eEnv.factoryAppUrl}/api/health`);
    expect(await health.json()).toMatchObject({
      product: "factory",
      capabilities: ["dynamic-review", "implementer", "review"],
    });
  });
});
