// SPDX-License-Identifier: LicenseRef-Proprietary

// The content of the Connections page of a workspace (#176): the GitHub installations linked to it, what an
// Owner or Admin can do (connect GitHub, link an existing installation, disconnect, and the requests the
// instance admin still has to decide), and what a flow just ended with. Connections is its own area root
// (lead decision 2026-10-13, epic #165), so the page is one h1 and three cards, each rendered by its own
// component (`installations-card`, `connect-card`, `requests-card`). `loadConnectionsPage` gathers the data
// from the services (passed in, so a test uses the real ones against a test database),
// `ConnectionsPageContent` renders it. The page file only wires the real services. Names that come from
// GitHub (account logins) are untrusted and rendered as text.
import type { ProductIdentity } from "../../product-identity/identity.ts";
import type { InstallationLinkRequestsRepository } from "../../db/repositories/installation-link-requests-repository.ts";
import type { IntegrationsRepository } from "../../db/repositories/integrations-repository.ts";
import type { RepositoriesRepository } from "../../db/repositories/repositories-repository.ts";
import type { IntegrationStatus } from "../../integrations/types.ts";
import { githubAvatarUrl } from "../../shell/user-display.ts";
import { isBindingResultCode } from "../errors.ts";
import type { InstallationLinkRequestStatus } from "../../db/installation-link-request.ts";
import type {
  ConnectAvailability,
  InstallationBindingService,
  PickerEntry,
} from "../service.ts";
import type { BindingApi } from "./api.ts";
import { ConnectionsPanel } from "./connections-panel.tsx";
import { describeResultCode, type ResultTone } from "./messages.ts";

export type ConnectionView = {
  id: string;
  accountLogin: string;
  accountType: string;
  status: IntegrationStatus;
  /** Repositories GitHub lists for the installation now. */
  repositoryCount: number;
  /** The avatar of the account on GitHub's avatar host, from its stored id; null without one (#638). */
  avatarUrl: string | null;
};

export type RequestView = {
  id: string;
  accountLogin: string;
  status: InstallationLinkRequestStatus;
  createdAt: string;
  decidedAt: string | null;
};

export type ConnectionsPageData = {
  connect: ConnectAvailability;
  picker: boolean;
  connections: ConnectionView[];
  /** Null for a Member: the requests are not theirs to see. */
  requests: RequestView[] | null;
  /** What the flow that just ended said, or null. */
  notice: { tone: ResultTone; text: string } | null;
  /** The installations to choose from, with the signed value that names the list, or null. */
  choices: { picker: string; entries: PickerEntry[] } | null;
};

export async function loadConnectionsPage(deps: {
  /** Who the notice of the result page speaks for. */
  product: ProductIdentity;
  canManage: boolean;
  integrations: Pick<IntegrationsRepository, "list">;
  repositories: Pick<RepositoriesRepository, "list">;
  linkRequests: Pick<InstallationLinkRequestsRepository, "list">;
  service: Pick<InstallationBindingService, "availability" | "readPicker">;
  /** What the browser came back with (`?github=<code>&picker=<value>`). */
  query: { github?: unknown; picker?: unknown };
  /** For the list of installations: the person and the session it was made for. */
  actor: { id: string; sessionId: string } | null;
  workspaceId: string;
}): Promise<ConnectionsPageData> {
  const [availability, integrations, repositories, requests] =
    await Promise.all([
      deps.service.availability(),
      deps.integrations.list(),
      deps.repositories.list({ active: true }),
      deps.canManage ? deps.linkRequests.list(10) : Promise.resolve(null),
    ]);
  const code =
    typeof deps.query.github === "string" &&
    isBindingResultCode(deps.query.github)
      ? deps.query.github
      : null;
  let choices: ConnectionsPageData["choices"] = null;
  if (
    deps.canManage &&
    typeof deps.query.picker === "string" &&
    deps.actor !== null
  ) {
    const entries = await deps.service.readPicker(
      deps.actor,
      deps.workspaceId,
      deps.query.picker,
    );
    if (entries !== null) choices = { picker: deps.query.picker, entries };
  }
  return {
    connect: availability.connect,
    picker: availability.picker,
    connections: integrations.map((integration) => ({
      id: integration.id,
      accountLogin: integration.displayName,
      accountType:
        typeof integration.config.accountType === "string"
          ? integration.config.accountType
          : "",
      status: integration.status,
      repositoryCount: repositories.filter(
        (repository) => repository.integrationId === integration.id,
      ).length,
      avatarUrl: githubAvatarUrl(
        typeof integration.config.accountId === "number"
          ? integration.config.accountId
          : null,
      ),
    })),
    requests:
      requests === null
        ? null
        : requests.map((request) => ({
            id: request.id,
            accountLogin: request.accountLogin,
            status: request.status,
            createdAt: request.createdAt,
            decidedAt: request.decidedAt,
          })),
    // A flow that ended without a usable list says nothing about a list.
    notice: code === null ? null : describeResultCode(deps.product, code),
    choices,
  };
}

export function ConnectionsPageContent({
  workspaceSlug,
  canManage,
  data,
  api,
}: {
  workspaceSlug: string;
  /** Whether the person may connect and disconnect (an Admin or an Owner). */
  canManage: boolean;
  data: ConnectionsPageData;
  /** Only tests pass this: a server component cannot hand functions to the client panel. */
  api?: BindingApi;
}) {
  return (
    <ConnectionsPanel
      workspaceSlug={workspaceSlug}
      canManage={canManage}
      data={data}
      {...(api === undefined ? {} : { api })}
    />
  );
}
