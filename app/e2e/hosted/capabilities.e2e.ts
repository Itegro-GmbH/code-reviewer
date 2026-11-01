// SPDX-License-Identifier: LicenseRef-Proprietary

// The capability set of the deployment (#731-T10). The hosted lane runs its app as the clone: product `factory` with the
// capabilities `review` and `dynamic-review` (playwright.hosted.config.ts), billing off. The other journeys of the lane prove
// that this deployment reviews (webhook to review, Dynamic review, the pool cap) without any balance or credit; this one
// proves what is not there: the health check says which product and capabilities run, every billing page and API and every route of the Implementer form (#755, capability `implementer`) answers as a
// path that does not exist (status, headers, body, for a page request, an RSC request, JSON and writes), and the navigation
// has no entry for it.
import { expect, test, type Page } from "@playwright/test";
import { hostedEnv } from "../helpers/hosted-env";
import { signInAsAdmin } from "../helpers/hosted-instance";
import { rawRequest } from "../helpers/raw-request";

const MISSING = "/there-is-no-such-page";
const MISSING_API = "/api/there-is-no-such-route";
const MISSING_HOOK = "/api/webhooks/there-is-no-such-hook";

function observe(
  page: Page,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
  return rawRequest(page, hostedEnv.appUrl, path, init);
}

const READS: Array<[string, string, Record<string, string>]> = [
  ["a page request", "GET", {}],
  ["an RSC request (client navigation)", "GET", { RSC: "1" }],
  ["an RSC prefetch", "GET", { RSC: "1", "Next-Router-Prefetch": "1" }],
  ["a request for JSON", "GET", { Accept: "application/json" }],
  ["a HEAD request", "HEAD", {}],
];

test.describe("a deployment with the capabilities review and dynamic-review", () => {
  test("the health check says which product and capabilities run", async ({
    page,
  }) => {
    const answer = await observe(page, "/api/health");

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({
      status: "ok",
      product: "factory",
      capabilities: ["dynamic-review", "review"],
    });
  });

  test("answers the billing webhook, which is public, as a hook that does not exist, to a visitor without a session", async ({
    page,
  }) => {
    const expected = await observe(page, MISSING_HOOK, {
      method: "POST",
      body: "{}",
    });
    const answer = await observe(page, "/api/billing/webhook", {
      method: "POST",
      body: "{}",
    });

    expect(expected.status).toBe(404);
    expect(answer.status).toBe(expected.status);
    expect(answer.lines).toEqual(expected.lines);
    expect(answer.body).toBe(expected.body);
  });

  test("answers every billing and Implementer page and API as a path that does not exist, to the admin, in every detail, and lists nothing of billing", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    const slug = /\/w\/([a-z0-9-]+)\//.exec(page.url())?.[1];
    expect(slug).toBeDefined();

    const absent = [
      `/w/${slug}/settings/billing`,
      `/api/w/${slug}/billing/profile`,
      `/api/w/${slug}/billing/top-ups`,
      `/api/w/${slug}/billing/journal`,
      `/api/w/${slug}/llm-key-mode`,
      "/admin/billing",
      "/admin/billing/reviews",
      "/api/admin/billing",
      "/api/admin/billing/workspaces",
      // The routes behind the Implementer form (#755-T10): this deployment has no capability `implementer`.
      `/api/w/${slug}/implementer/repositories`,
      `/api/w/${slug}/implementer/repositories/x/branches`,
      `/api/w/${slug}/implementer/models`,
      `/api/w/${slug}/implementer/tasks`,
      // The page of the form (#756-T09).
      `/w/${slug}/implementer`,
    ];
    for (const [label, method, headers] of READS) {
      const expected = await observe(page, MISSING, { method, headers });
      expect(expected.status, label).toBe(404);
      for (const path of absent) {
        const answer = await observe(page, path, { method, headers });
        expect(answer.status, `${label} ${path}`).toBe(404);
        expect(answer.lines, `${label} ${path}`).toEqual(expected.lines);
        expect(answer.body, `${label} ${path}`).toBe(expected.body);
        expect(answer.headers["x-middleware-rewrite"]).toBeUndefined();
      }
    }
    for (const path of absent) {
      const expected = await observe(page, MISSING_API, {
        method: "POST",
        body: "{}",
      });
      const answer = await observe(page, path, { method: "POST", body: "{}" });
      expect(answer, `POST ${path}`).toEqual(expected);
    }

    // What the deployment has is there, and nothing of billing is offered.
    await page.goto(`/w/${slug}/projects`);
    await expect(page.getByRole("link", { name: "Runs" })).toBeVisible();
    await page.goto(`/w/${slug}/settings`);
    await expect(
      page.getByRole("link", { name: "Review defaults" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Billing" })).toHaveCount(0);
    await page.goto("/admin");
    await expect(
      page.getByRole("link", { name: "Integrations" }).first(),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Billing" })).toHaveCount(0);
  });
});
