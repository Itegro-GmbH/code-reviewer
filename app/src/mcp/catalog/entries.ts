// SPDX-License-Identifier: LicenseRef-Proprietary

// The catalog of MCP server presets (#1054): remote servers that vendors run themselves, as a prefilled form for the add dialog. Nothing in
// here is stored for a workspace; a preset becomes a server only when an Owner or Admin saves the dialog, through the same route as a server
// typed by hand (`presetToForm`).
//
// What an entry may hold, and what not:
// - Only an endpoint that the vendor's own public documentation names, read on `checkedOn` at `docsUrl`. A vendor whose page could not be
//   read, or does not name the endpoint, is not here.
// - No address with a query string or a key in it: the registry refuses those (`url.ts`), so the variants some vendors document for a
//   read-only or a scoped server by query (`?readonly=true`, `?project_id=`, `?read_only=true`, `?features=`, `?experimental=1`, `?tools=all`)
//   are not presets. A path the vendor documents (`/mcp/readonly`) is fine.
// - One kind of authentication per entry: the one that suits an agent in a lane, where the vendor documents it. A header entry names the
//   header; the value is entered by the person and sealed like any other (the catalog never holds one).
// - A monogram instead of a logo: no brand artwork is copied; a vendor name is only a name.
// - "http" in a vendor's client configuration (`--transport http`, `"type": "http"`) is the MCP Streamable HTTP transport.
//
// Changing an entry, or adding one, changes `CATALOG_VERSION` and `checkedOn` of that entry.
import type { McpTransport } from "../input.ts";

/** Bumped on every change of the list or of an entry. */
export const CATALOG_VERSION = 1;

export type McpCatalogAuth =
  | { kind: "none" }
  | {
      kind: "header";
      /** The header the vendor documents for the token. */
      headerName: string;
      /** What the value looks like (shown as a hint, never a value). */
      valueHint: string;
    }
  | { kind: "oauth" };

export type McpCatalogEntry = {
  /** Stable slug. */
  id: string;
  /** The name the server gets in the dialog; a person may change it. */
  name: string;
  description: string;
  /** One to three letters shown instead of a logo. */
  monogram: string;
  url: string;
  transport: McpTransport;
  auth: McpCatalogAuth;
  /** The vendor's own page this entry was verified against. */
  docsUrl: string;
  /** The day (UTC) the page was read. */
  checkedOn: string;
  /** What access the connection gives, and how to narrow it. */
  scopeNote: string;
};

const CHECKED = "2026-11-17";

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description:
      "Repositories, issues, pull requests and Actions of GitHub, from the server GitHub runs.",
    monogram: "GH",
    url: "https://api.githubcopilot.com/mcp/",
    transport: "streamable-http",
    auth: {
      kind: "header",
      headerName: "Authorization",
      valueHint: "Bearer <personal access token>",
    },
    docsUrl:
      "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server",
    checkedOn: CHECKED,
    scopeNote:
      "The token decides what the agent may do: give a personal access token only the scopes the lane needs. The docs describe OAuth too, without naming dynamic client registration, so this preset uses the token.",
  },
  {
    id: "github-readonly",
    name: "GitHub read-only",
    description:
      "The same GitHub server, restricted to the tools that only read.",
    monogram: "GH",
    url: "https://api.githubcopilot.com/mcp/readonly",
    transport: "streamable-http",
    auth: {
      kind: "header",
      headerName: "Authorization",
      valueHint: "Bearer <personal access token>",
    },
    docsUrl:
      "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server",
    checkedOn: CHECKED,
    scopeNote:
      "GitHub documents /readonly as the address that only exposes tools that read. The token's scopes still apply: a read-only token is the second lock. Fits a review step.",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, projects and comments of Linear.",
    monogram: "Li",
    url: "https://mcp.linear.app/mcp",
    transport: "streamable-http",
    auth: { kind: "oauth" },
    docsUrl: "https://linear.app/docs/mcp",
    checkedOn: CHECKED,
    scopeNote:
      "OAuth 2.1 with dynamic client registration, as the docs say. The agent gets what the person who connects may do in Linear; the read-only entry below narrows it.",
  },
  {
    id: "linear-readonly",
    name: "Linear read-only",
    description: "The same Linear server, restricted to the tools that read.",
    monogram: "Li",
    url: "https://mcp.linear.app/mcp/readonly",
    transport: "streamable-http",
    auth: { kind: "oauth" },
    docsUrl: "https://linear.app/docs/mcp",
    checkedOn: CHECKED,
    scopeNote:
      "Linear documents /mcp/readonly as an address that only ever exposes read tools. Fits a review step.",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Issues, events and releases of Sentry.",
    monogram: "Se",
    url: "https://mcp.sentry.dev/mcp",
    transport: "streamable-http",
    auth: { kind: "oauth" },
    docsUrl: "https://mcp.sentry.dev/",
    checkedOn: CHECKED,
    scopeNote:
      "Sentry says all connections use OAuth. Its docs do not describe a read-only mode, and do not say whether clients register dynamically: if Connect cannot register, enter an OAuth client in the dialog.",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Pages and databases of a Notion workspace.",
    monogram: "No",
    url: "https://mcp.notion.com/mcp",
    transport: "streamable-http",
    auth: { kind: "oauth" },
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    checkedOn: CHECKED,
    scopeNote:
      "The agent can read and update what the person who connects can access in the chosen Notion workspace. Only workspace members can connect. Notion's docs do not say whether clients register dynamically: if Connect cannot register, enter an OAuth client in the dialog.",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    description:
      "Jira, Confluence and Bitbucket through Atlassian's remote server.",
    monogram: "At",
    url: "https://mcp.atlassian.com/v2/mcp",
    transport: "streamable-http",
    auth: { kind: "oauth" },
    docsUrl:
      "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    checkedOn: CHECKED,
    scopeNote:
      "OAuth 2.1; the agent acts with the connecting person's existing permissions in each product. Atlassian says v1 switches to the v2 tools on 1 March 2027. An API token is optional and has to be enabled by an organization admin; it is not a preset.",
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Projects, deployments, logs and documentation of Vercel.",
    monogram: "Ve",
    url: "https://mcp.vercel.com",
    transport: "streamable-http",
    auth: { kind: "oauth" },
    docsUrl: "https://vercel.com/docs/mcp/vercel-mcp",
    checkedOn: CHECKED,
    scopeNote:
      "OAuth only. Vercel says the connected AI system gets the same access as the person's Vercel account, within their team permissions. Its docs describe client ID metadata documents and do not name dynamic registration: if Connect cannot register, enter an OAuth client in the dialog.",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Stripe's API as tools, with read and write tools apart.",
    monogram: "St",
    url: "https://mcp.stripe.com",
    transport: "streamable-http",
    auth: {
      kind: "header",
      headerName: "Authorization",
      valueHint: "Bearer <agent API key>",
    },
    docsUrl: "https://docs.stripe.com/mcp",
    checkedOn: CHECKED,
    scopeNote:
      "Use an agent API key with only the permissions the lane needs, for a sandbox account first. Stripe stops accepting full-access secret keys and restricted keys without the agent tag from December 2026. OAuth exists for interactive clients; it is not the preset.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "The Cloudflare API and its documentation as tools.",
    monogram: "Cf",
    url: "https://mcp.cloudflare.com/mcp",
    transport: "streamable-http",
    auth: { kind: "oauth" },
    docsUrl:
      "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    checkedOn: CHECKED,
    scopeNote:
      "The permissions are chosen on the consent page (or on an API token, which the docs also allow as an Authorization bearer header). Cloudflare's docs do not name a read-only mode or dynamic registration. Its product servers are not presets.",
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Projects, databases and documentation of Supabase.",
    monogram: "Su",
    url: "https://mcp.supabase.com/mcp",
    transport: "streamable-http",
    auth: { kind: "oauth" },
    docsUrl: "https://supabase.com/docs/guides/getting-started/mcp",
    checkedOn: CHECKED,
    scopeNote:
      "OAuth with dynamic client registration, as the docs say. The agent reaches every project of the organization the person picks: Supabase's read-only and single-project modes are query parameters, which a registry address cannot hold.",
  },
  {
    id: "neon",
    name: "Neon",
    description: "Projects, branches and SQL of Neon Postgres.",
    monogram: "Ne",
    url: "https://mcp.neon.tech/mcp",
    transport: "streamable-http",
    auth: { kind: "oauth" },
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
    checkedOn: CHECKED,
    scopeNote:
      "Neon recommends this server for development and testing, not production. Read-only and single-project modes are query parameters, which a registry address cannot hold (read-only can be chosen on Neon's consent page).",
  },
  {
    id: "posthog",
    name: "PostHog",
    description: "Insights, feature flags, errors and data of PostHog.",
    monogram: "PH",
    url: "https://mcp.posthog.com/mcp",
    transport: "streamable-http",
    auth: { kind: "oauth" },
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    checkedOn: CHECKED,
    scopeNote:
      "OAuth is the path PostHog recommends; its docs do not say whether clients register dynamically, so enter an OAuth client if Connect cannot register. A personal API key as an Authorization bearer header is documented too. A read-only mode exists as a header or a query parameter, not as an address.",
  },
];

export function findCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id);
}
