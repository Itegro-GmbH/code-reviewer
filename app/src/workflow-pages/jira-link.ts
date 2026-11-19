// SPDX-License-Identifier: LicenseRef-Proprietary

// The one place a workflow page makes a link to a Jira issue (#1086). The site address comes from the stored Jira connection (Atlassian's
// answer when the site was connected) and the key from the reference of the run: both are data from outside the page, so a link is made only
// for an https address without credentials, port, query or fragment and for a key of the form `PROJ-12`; the link is `<site>/browse/<KEY>`.
// Anything else gives `undefined` and the page shows the ticket as text.
import { JIRA_ISSUE_KEY } from "../workflows/ticket-ref.ts";

/** The address of the Jira issue, or undefined when the site or the key is not usable. */
export function jiraIssueLink(
  siteUrl: string | null | undefined,
  key: string,
): string | undefined {
  if (siteUrl === null || siteUrl === undefined) return undefined;
  if (!JIRA_ISSUE_KEY.test(key)) return undefined;
  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    return undefined;
  }
  if (site.protocol !== "https:" || site.hostname === "") return undefined;
  if (site.username !== "" || site.password !== "" || site.port !== "")
    return undefined;
  if (site.search !== "" || site.hash !== "") return undefined;
  const base = site.pathname.replace(/\/+$/, "");
  return `${site.origin}${base}/browse/${key}`;
}
