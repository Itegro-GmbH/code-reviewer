// SPDX-License-Identifier: LicenseRef-Proprietary

// The manifest the admin portal posts to GitHub: every address from the configured public URL, the
// permissions and events of the App, public or private by tenancy, and the helper that names what an
// imported App lacks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCapabilitySet } from "../../../capabilities/capability.ts";
import { PRODUCTS } from "../../../capabilities/products.ts";
import { identityFor } from "../../../product-identity/identities.ts";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENTER_TOKEN_PERMISSIONS,
  JOB_TOKEN_PERMISSIONS,
} from "./job-access.ts";
import {
  APP_NAME_MAX_LENGTH,
  buildAppManifest,
  CHECK_RUN_PERMISSIONS,
  missingPermissions,
  suggestedAppName,
} from "./manifest.ts";
import { getProductIdentity } from "../../../product-identity/current.ts";

const PRODUCT = getProductIdentity();

/** The set of code-review.com, and of the factory with and without the Implementer. */
const CODE_REVIEW_COM = createCapabilitySet(
  PRODUCTS["code-review-com"].default,
);
const FACTORY = createCapabilitySet(PRODUCTS.factory.default);
const FACTORY_IMPLEMENTER = createCapabilitySet([
  "review",
  "dynamic-review",
  "implementer",
]);

const PUBLIC_URL = "https://reviews.example.com";

describe("the GitHub App manifest", () => {
  // #102-GH-01
  it("derives the webhook, redirect, callback and setup addresses from the public URL of a multi-tenant instance", () => {
    const manifest = buildAppManifest({
      capabilities: CODE_REVIEW_COM,
      product: PRODUCT,
      publicUrl: PUBLIC_URL,
      tenancy: "multi",
      name: "Code Reviewer",
    });

    expect(manifest.url).toBe(PUBLIC_URL);
    expect(manifest.hook_attributes).toEqual({
      url: `${PUBLIC_URL}/api/webhooks/github-app`,
      active: true,
    });
    expect(manifest.redirect_url).toBe(
      `${PUBLIC_URL}/api/admin/github/manifest/callback`,
    );
    expect(manifest.callback_urls).toEqual([
      `${PUBLIC_URL}/api/auth/callback/github`,
    ]);
    expect(manifest.setup_url).toBe(`${PUBLIC_URL}/github/connected`);
    expect(manifest.public).toBe(true);
  });

  // #102-GH-01
  it("makes the App private on a single-tenant instance", () => {
    const manifest = buildAppManifest({
      capabilities: CODE_REVIEW_COM,
      product: PRODUCT,
      publicUrl: PUBLIC_URL,
      tenancy: "single",
      name: "Code Reviewer",
    });

    expect(manifest.public).toBe(false);
  });

  // #102-GH-01
  // #405-T13
  it("asks for the repository permissions of a review job plus Checks, Email addresses and Members", () => {
    const manifest = buildAppManifest({
      capabilities: CODE_REVIEW_COM,
      product: PRODUCT,
      publicUrl: PUBLIC_URL,
      tenancy: "single",
      name: "Code Reviewer",
    });

    expect(manifest.default_permissions).toEqual({
      ...JOB_TOKEN_PERMISSIONS,
      checks: "write",
      emails: "read",
      members: "read",
    });
    expect(manifest.default_events).toEqual(["pull_request", "issue_comment"]);
  });

  // #405-T13
  it("asks for the Checks permission on top of a job token's, which a Worker never holds", () => {
    expect(CHECK_RUN_PERMISSIONS).toEqual({ checks: "write" });
    expect(JOB_TOKEN_PERMISSIONS).not.toHaveProperty("checks");
  });

  it("does not ask GitHub to authorize a person during the installation", () => {
    const manifest = buildAppManifest({
      capabilities: CODE_REVIEW_COM,
      product: PRODUCT,
      publicUrl: PUBLIC_URL,
      tenancy: "single",
      name: "x",
    });

    expect(manifest.request_oauth_on_install).toBe(false);
  });

  it("ignores a trailing slash of the public URL", () => {
    const manifest = buildAppManifest({
      capabilities: CODE_REVIEW_COM,
      product: PRODUCT,
      publicUrl: `${PUBLIC_URL}/`,
      tenancy: "single",
      name: "x",
    });

    expect(manifest.hook_attributes.url).toBe(
      `${PUBLIC_URL}/api/webhooks/github-app`,
    );
  });
});

describe("the suggested App name", () => {
  it("names the host of the instance and stays within what GitHub accepts", () => {
    expect(suggestedAppName(PRODUCT, PUBLIC_URL)).toBe(
      "Code Reviewer reviews.example.com",
    );
    const long = suggestedAppName(
      PRODUCT,
      "https://a-very-long-subdomain.example-company.com",
    );
    expect(long.length).toBeLessThanOrEqual(APP_NAME_MAX_LENGTH);
    expect(long.startsWith("Code Reviewer")).toBe(true);
  });
});

describe("the manifest of another product", () => {
  const factory = identityFor("factory");

  // #740-T04
  it("takes the name and the description from the identity and every address from the configured URL", () => {
    const manifest = buildAppManifest({
      capabilities: CODE_REVIEW_COM,
      product: factory,
      publicUrl: PUBLIC_URL,
      tenancy: "single",
      name: suggestedAppName(factory, PUBLIC_URL),
    });

    expect(manifest.name).toBe("Factory reviews.example.com");
    expect(manifest.description).toBe(factory.githubAppDescription);
    expect(JSON.stringify(manifest)).not.toMatch(
      /code-review\.com|code reviewer/i,
    );
    expect(manifest.url).toBe(PUBLIC_URL);
    expect(manifest.callback_urls).toEqual([
      `${PUBLIC_URL}/api/auth/callback/github`,
    ]);
  });

  // #740-T04
  it("suggests a name within what GitHub accepts, whatever the host", () => {
    const long = suggestedAppName(
      factory,
      "https://a-very-long-subdomain.example-company.com",
    );

    expect(long.length).toBeLessThanOrEqual(APP_NAME_MAX_LENGTH);
    expect(long.startsWith("Factory")).toBe(true);
    expect(suggestedAppName(factory, "not a url")).toBe("Factory");
  });
});

describe("the permissions an App lacks", () => {
  // #405-T13
  it("lists the Checks, account and organization permissions of an App that was made by hand without them", () => {
    expect(
      missingPermissions(
        {
          pull_requests: "write",
          issues: "write",
          contents: "read",
          metadata: "read",
        },
        CODE_REVIEW_COM,
      ),
    ).toEqual(["checks", "emails", "members"]);
  });

  it("lists a permission whose level is too low and nothing for a complete App", () => {
    expect(
      missingPermissions(
        {
          pull_requests: "read",
          issues: "write",
          contents: "read",
          metadata: "read",
          checks: "write",
          emails: "read",
          members: "read",
        },
        CODE_REVIEW_COM,
      ),
    ).toEqual(["pull_requests"]);
    expect(
      missingPermissions(
        {
          pull_requests: "write",
          issues: "write",
          contents: "write",
          metadata: "read",
          checks: "write",
          emails: "read",
          members: "write",
        },
        CODE_REVIEW_COM,
      ),
    ).toEqual([]);
  });
});

// The same App code is deployed twice; only a deployment with the Implementer asks GitHub for more.
const ALL_PERMISSIONS = {
  pull_requests: "write",
  issues: "write",
  contents: "read",
  metadata: "read",
  checks: "write",
  emails: "read",
  members: "read",
} as const;

function manifestFor(
  capabilities: Parameters<typeof buildAppManifest>[0]["capabilities"],
  product = PRODUCT,
) {
  return buildAppManifest({
    capabilities,
    product,
    publicUrl: "https://reviews.example.test",
    tenancy: "multi",
    name: suggestedAppName(product, "https://reviews.example.test"),
  });
}

describe("the manifest of a deployment without the Implementer", () => {
  const golden = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../../product-identity/code-review-com-output.golden.json",
      ),
      "utf8",
    ),
  ) as { manifest: { built: unknown } };

  // #749-T01
  it("is byte for byte the one stored for code-review.com", () => {
    expect(JSON.stringify(manifestFor(CODE_REVIEW_COM))).toBe(
      JSON.stringify(golden.manifest.built),
    );
  });

  // #749-T01
  it("is the same for the factory while it has no Implementer", () => {
    expect(JSON.stringify(manifestFor(FACTORY))).toBe(
      JSON.stringify(golden.manifest.built),
    );
  });
});

describe("the manifest of a deployment with the Implementer", () => {
  // #749-T02
  it("raises Contents to write and leaves every other permission and event as it is", () => {
    const manifest = manifestFor(FACTORY_IMPLEMENTER);

    expect(manifest.default_permissions).toEqual({
      ...ALL_PERMISSIONS,
      contents: "write",
    });
    expect(manifest.default_events).toEqual(["pull_request", "issue_comment"]);
    expect(manifest).toEqual({
      ...manifestFor(CODE_REVIEW_COM),
      default_permissions: { ...ALL_PERMISSIONS, contents: "write" },
    });
  });

  // #749-T02
  it("keeps the order of the permissions, so the only difference in the text is the one level", () => {
    expect(JSON.stringify(manifestFor(FACTORY_IMPLEMENTER))).toBe(
      JSON.stringify(manifestFor(CODE_REVIEW_COM)).replace(
        '"contents":"read"',
        '"contents":"write"',
      ),
    );
  });

  // #749-T02
  it("asks for no permission that the token of the Implementer does not name beyond Contents and the review ones", () => {
    expect(
      Object.keys(manifestFor(FACTORY_IMPLEMENTER).default_permissions),
    ).toEqual(Object.keys(ALL_PERMISSIONS));
    expect(IMPLEMENTER_TOKEN_PERMISSIONS).not.toHaveProperty("workflows");
    expect(
      manifestFor(FACTORY_IMPLEMENTER).default_permissions,
    ).not.toHaveProperty("workflows");
  });
});

describe("the permissions an App lacks in a deployment with the Implementer", () => {
  const readOnlyContents = { ...ALL_PERMISSIONS };

  // #749-T03
  it("names Contents for an App that holds it read-only", () => {
    expect(missingPermissions(readOnlyContents, FACTORY_IMPLEMENTER)).toEqual([
      "contents",
    ]);
  });

  // #749-T03
  it("names Contents for an App that does not hold it at all", () => {
    const withoutContents = Object.fromEntries(
      Object.entries(readOnlyContents).filter(([name]) => name !== "contents"),
    );

    expect(missingPermissions(withoutContents, FACTORY_IMPLEMENTER)).toEqual([
      "contents",
    ]);
  });

  // #749-T03
  it("names nothing extra once Contents is write", () => {
    expect(
      missingPermissions(
        { ...readOnlyContents, contents: "write" },
        FACTORY_IMPLEMENTER,
      ),
    ).toEqual([]);
  });

  // #749-T03
  it("names nothing extra for code-review.com or for the factory without the Implementer", () => {
    for (const capabilities of [CODE_REVIEW_COM, FACTORY])
      expect(missingPermissions(readOnlyContents, capabilities)).toEqual([]);
  });
});
