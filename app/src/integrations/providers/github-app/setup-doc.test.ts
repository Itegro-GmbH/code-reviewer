// SPDX-License-Identifier: LicenseRef-Proprietary

// Keeps docs/github-app.md (the guide for creating the team's GitHub App) in step with the code: the
// permissions and webhook events the guide tells people to set are exactly the ones the code works
// with, and the webhook path is the route that exists. A change to the code that is not mirrored in the guide fails here.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCapabilitySet } from "../../../capabilities/capability.ts";
import { PRODUCTS } from "../../../capabilities/products.ts";
import {
  IMPLEMENTER_TOKEN_PERMISSIONS,
  JOB_TOKEN_PERMISSIONS,
} from "./job-access.ts";
import {
  ACCOUNT_PERMISSIONS,
  buildAppManifest,
  CHECK_RUN_PERMISSIONS,
  GITHUB_APP_PATHS,
  ORGANIZATION_PERMISSIONS,
  REPOSITORY_PERMISSIONS,
  SUBSCRIBED_EVENTS,
} from "./manifest.ts";
import { WEBHOOK_READ_FIELDS } from "./webhook-fields.ts";
import { getProductIdentity } from "../../../product-identity/current.ts";

const PRODUCT = getProductIdentity();

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const guide = readFileSync(`${repoRoot}docs/github-app.md`, "utf8");

/** The text of the section that starts with the given heading, up to the next heading of that level. */
function section(heading: string): string {
  const start = guide.indexOf(`\n## ${heading}\n`);
  if (start === -1)
    throw new Error(`docs/github-app.md has no "${heading}" section`);
  const rest = guide.slice(start + 1);
  const next = rest.indexOf("\n## ", 3);
  return next === -1 ? rest : rest.slice(0, next);
}

const ACCESS_TEXT = { read: "Read-only", write: "Read and write" } as const;

/** The text below the heading `### <heading>` up to the next heading, within a section. */
function subsection(text: string, heading: string): string {
  const start = text.indexOf(`\n### ${heading}\n`);
  if (start === -1) throw new Error(`no "${heading}" subsection`);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n### ", 3);
  return next === -1 ? rest : rest.slice(0, next);
}

/** `| Name (`api_name`) | Read-only |` rows of a table, by API name. */
function permissionRows(text: string): Record<string, string> {
  const listed: Record<string, string> = {};
  for (const row of text.matchAll(
    /^\|[^|]*\(`(\w+)`\)[^|]*\|\s*(Read-only|Read and write)\s*\|/gm,
  ))
    listed[row[1] as string] = row[2] as string;
  return listed;
}

const expectedRows = (
  permissions: Readonly<Record<string, "read" | "write">>,
) =>
  Object.fromEntries(
    Object.entries(permissions).map(([name, level]) => [
      name,
      ACCESS_TEXT[level],
    ]),
  );

describe("the GitHub App setup guide", () => {
  // #102-GH-18
  // #405-T13
  it("lists exactly the repository permissions the code works with, at the same access level", () => {
    const listed = permissionRows(
      subsection(section("Permissions"), "Repository permissions"),
    );

    expect(listed).toEqual(
      expectedRows({ ...JOB_TOKEN_PERMISSIONS, ...CHECK_RUN_PERMISSIONS }),
    );
    expect(REPOSITORY_PERMISSIONS).toEqual({
      ...JOB_TOKEN_PERMISSIONS,
      ...CHECK_RUN_PERMISSIONS,
    });
  });

  // #102-GH-18
  it("lists the account permission and the organization permission the manifest asks for, read-only", () => {
    const permissions = section("Permissions");

    expect(
      permissionRows(subsection(permissions, "Account permissions")),
    ).toEqual(expectedRows(ACCOUNT_PERMISSIONS));
    expect(
      permissionRows(subsection(permissions, "Organization permissions")),
    ).toEqual(expectedRows(ORGANIZATION_PERMISSIONS));
  });

  // #102-GH-18
  it("is what the manifest asks for, permission by permission and event by event", () => {
    const permissions = section("Permissions");
    const documented = {
      ...permissionRows(subsection(permissions, "Repository permissions")),
      ...permissionRows(subsection(permissions, "Account permissions")),
      ...permissionRows(subsection(permissions, "Organization permissions")),
    };
    const manifest = buildAppManifest({
      product: PRODUCT,
      publicUrl: "https://reviews.example.test",
      tenancy: "single",
      name: "Code Reviewer",
      capabilities: createCapabilitySet(PRODUCTS["code-review-com"].default),
    });

    expect(documented).toEqual(
      expectedRows(
        manifest.default_permissions as Record<string, "read" | "write">,
      ),
    );
    expect(manifest.default_events).toEqual([...SUBSCRIBED_EVENTS]);
    // The events a person ticks are documented as ticked.
    for (const event of SUBSCRIBED_EVENTS)
      expect(section("Events")).toMatch(
        new RegExp(`\`${event}\`[^\\n]*tick`, "i"),
      );
  });

  // #102-GH-18
  it("gives the addresses of the manifest: the webhook, the callback of the sign in and the setup address", () => {
    expect(guide).toContain(GITHUB_APP_PATHS.webhook);
    expect(guide).toContain(GITHUB_APP_PATHS.signInCallback);
    expect(guide).toContain(GITHUB_APP_PATHS.installationSetup);
  });

  // CR-38-T01
  it("lists exactly the webhook events the code reads", () => {
    const listed = [...section("Events").matchAll(/^\|\s*`(\w+)`\s*\|/gm)].map(
      (row) => row[1],
    );

    expect(listed.sort()).toEqual(Object.keys(WEBHOOK_READ_FIELDS).sort());
  });

  // CR-38-T01
  it("says which of the events are ticked by hand and which GitHub always sends", () => {
    const events = section("Events");

    expect(events).toMatch(/`pull_request`[^\n]*tick/i);
    expect(events).toMatch(/`issue_comment`[^\n]*tick/i);
    expect(events).toMatch(/`installation`[^\n]*always/i);
    expect(events).toMatch(/`installation_repositories`[^\n]*always/i);
  });

  // CR-38-T01
  it("gives the webhook path of a route that exists", () => {
    const route = "app/src/app/api/webhooks/github-app/route.ts";

    expect(existsSync(`${repoRoot}${route}`)).toBe(true);
    expect(guide).toContain("/api/webhooks/github-app");
  });
});

describe("the setup guide for a deployment with the Implementer", () => {
  const capabilities = (members: Parameters<typeof createCapabilitySet>[0]) =>
    createCapabilitySet(members);
  const manifestFor = (set: ReturnType<typeof capabilities>) =>
    buildAppManifest({
      product: PRODUCT,
      publicUrl: "https://reviews.example.test",
      tenancy: "single",
      name: "Code Reviewer",
      capabilities: set,
    }).default_permissions;
  const section_ = () => section("The Implementer");

  // #749-T08
  it("lists exactly the permission the manifest raises for the Implementer, at its level", () => {
    const raised = Object.fromEntries(
      Object.entries(
        manifestFor(capabilities(["review", "dynamic-review", "implementer"])),
      ).filter(
        ([name, level]) =>
          manifestFor(capabilities(["review", "dynamic-review"]))[name] !==
          level,
      ),
    );

    expect(permissionRows(section_())).toEqual(expectedRows(raised));
    expect(raised).toEqual({ contents: "write" });
  });

  // #749-T08
  it("is where Contents is write: the tables for every deployment keep it read-only", () => {
    const permissions = section("Permissions");

    expect(
      permissionRows(subsection(permissions, "Repository permissions")),
    ).toMatchObject({ contents: "Read-only" });
  });

  // #749-T08
  it("names the token of the Implementer: Contents write and Metadata read on one repository, nothing else", () => {
    const text = section_();

    expect(IMPLEMENTER_TOKEN_PERMISSIONS).toEqual({
      contents: "write",
      metadata: "read",
    });
    expect(text).toContain("IMPLEMENTER_TOKEN_PERMISSIONS");
    expect(text).toMatch(/one repository/i);
  });

  // #749-T08
  it("says that GitHub rejects pushes to .github/workflows and that no Workflows permission is asked for", () => {
    const text = section_();

    expect(text).toContain(".github/workflows");
    expect(text).toMatch(/reject/i);
    expect(text).toMatch(/Workflows[^\n]*(not|never)/i);
  });

  // #749-T08
  it("describes the update of an App that was created before: raise the permission, then every installation accepts it", () => {
    const text = section_();

    expect(text).toMatch(/Update an existing App/i);
    expect(text).toMatch(/Read and write/);
    expect(text).toMatch(/accept/i);
    expect(text).toContain("INTEGRATION_ACCESS_PERMISSION_NOT_GRANTED");
  });
});
