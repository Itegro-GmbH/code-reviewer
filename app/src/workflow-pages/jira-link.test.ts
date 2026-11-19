// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { jiraIssueLink } from "./jira-link.ts";

describe("the link a workflow page makes to a Jira issue", () => {
  // #1086-T01
  it("is the browse address of the issue on the site of the connection", () => {
    expect(jiraIssueLink("https://acme.atlassian.net", "LAT-58")).toBe(
      "https://acme.atlassian.net/browse/LAT-58",
    );
    expect(jiraIssueLink("https://acme.atlassian.net/", "LAT-58")).toBe(
      "https://acme.atlassian.net/browse/LAT-58",
    );
  });

  // #1086-T02
  it.each([
    ["no site", null],
    ["no site (undefined)", undefined],
    ["plain http", "http://acme.atlassian.net"],
    ["a script address", "javascript:alert(1)"],
    ["a user name in the address", "https://user:pw@acme.atlassian.net"],
    ["a port", "https://acme.atlassian.net:8443"],
    ["a query", "https://acme.atlassian.net?x=1"],
    ["text that is no address", "acme"],
  ])("gives no link for %s", (_name, site) => {
    expect(jiraIssueLink(site, "LAT-58")).toBeUndefined();
  });

  // #1086-T03
  it.each(["../x", "lat-58", "LAT-0", "LAT-1/../../x", ""])(
    "gives no link for the key %j",
    (key) => {
      expect(jiraIssueLink("https://acme.atlassian.net", key)).toBeUndefined();
    },
  );
});
