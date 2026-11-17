// SPDX-License-Identifier: LicenseRef-Proprietary

// Keeps the owner's setup guide (docs/jira-cloud-setup.md) and the code together (#1037): the callback address the guide names for the
// factory and for local development is the one the code makes from the configured public address, every scope the code asks for is
// in the guide, and the variables the guide names are the ones the code reads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_CLIENT_ID_VARIABLE,
  ATLASSIAN_CLIENT_SECRET_VARIABLE,
  JIRA_SCOPES,
  jiraCallbackUrl,
} from "./config.ts";

const guide = readFileSync(
  join(import.meta.dirname, "../../../docs/jira-cloud-setup.md"),
  "utf8",
);

describe("the Jira setup guide", () => {
  // #1037
  it("names the callback address of the factory and of local development as the code makes it", () => {
    expect(guide).toContain(
      `\`${jiraCallbackUrl("https://factory-app-omega-eight.vercel.app")}\``,
    );
    expect(guide).toContain(`\`${jiraCallbackUrl("http://localhost:3000")}\``);
  });

  // #1037
  it("names every scope the code asks for", () => {
    for (const scope of JIRA_SCOPES) expect(guide).toContain(`\`${scope}\``);
  });

  // #1037
  it("names the two variables the code reads", () => {
    expect(guide).toContain(`\`${ATLASSIAN_CLIENT_ID_VARIABLE}\``);
    expect(guide).toContain(`\`${ATLASSIAN_CLIENT_SECRET_VARIABLE}\``);
  });
});
