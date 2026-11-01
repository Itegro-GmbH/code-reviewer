// SPDX-License-Identifier: LicenseRef-Proprietary

// Not a journey: the second app of the privileged Dynamic e2e lane, the factory's (#767), is set up the way the first one is
// (prepare-app.e2e.ts): a new instance on a migrated, empty database, the first-run setup through the routes of the wizard and
// the GitHub App of the fake GitHub in its admin portal.
import { expect, test } from "@playwright/test";
import { factoryDatabaseUrls, factoryEnv } from "../helpers/hosted-env";
import { enterGithubApp, setUpApp } from "../helpers/setup";

test("the factory app of the Implementer journeys is set up before they run", async ({
  request,
}) => {
  await setUpApp(factoryEnv.appUrl, factoryDatabaseUrls().app);
  await enterGithubApp(factoryEnv.appUrl);

  const page = await request.get(factoryEnv.appUrl, { maxRedirects: 0 });
  expect(page.status()).toBe(307);
  // The app is the factory with the Implementer: the health route names the product and the set.
  const health = await request.get(`${factoryEnv.appUrl}/api/health`);
  expect(await health.json()).toMatchObject({
    product: "factory",
    capabilities: ["dynamic-review", "implementer", "review"],
  });
});
