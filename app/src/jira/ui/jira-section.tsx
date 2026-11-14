// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The Jira card of the Integrations tab (#1037): the Jira Cloud sites connected to the workspace (the site, who connected it, whether it
// works), and for an Owner or Admin Connect Jira, Reconnect for a connection that is broken, and Remove (asked for in a dialog). When a
// grant covers several sites the list to choose from is here too. Names and addresses come from Atlassian: text, truncated, an address
// only as a link when it is https. The page never has a token to show: it does not get one.
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { Button } from "../../components/button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { goTo } from "../../github-config/ui/api.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import type { JiraConnectionView, SiteChoice } from "../service.ts";
import { browserJiraApi, type JiraApi } from "./api.ts";
import {
  describeBrokenConnection,
  describeJiraFailure,
  type ResultTone,
} from "./messages.ts";

export type JiraSectionData = {
  /** Whether the Atlassian app's client id and secret are set: Connect Jira is offered only then. */
  configured: boolean;
  connections: JiraConnectionView[];
  /** The sites of the person's waiting grant, or null while there is none. */
  choices: SiteChoice[] | null;
  /** What a flow that just ended said. */
  notice: { tone: ResultTone; text: string } | null;
};

function noticeVariant(tone: ResultTone): "success" | "info" | "destructive" {
  if (tone === "success") return "success";
  if (tone === "error") return "destructive";
  return "info";
}

/** A site address is a link only when it is https; anything else is shown as text. */
function isHttps(address: string): boolean {
  try {
    return new URL(address).protocol === "https:";
  } catch {
    return false;
  }
}

export function JiraSection({
  workspaceSlug,
  canManage,
  data,
  api: apiProp,
  go = goTo,
}: {
  workspaceSlug: string;
  canManage: boolean;
  data: JiraSectionData;
  /** Only tests pass these. */
  api?: JiraApi;
  go?: (url: string) => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const defaultApi = useMemo(
    () => browserJiraApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function failed(result: Extract<RequestResult<unknown>, { ok: false }>) {
    const projects = result.details?.projects;
    setProblem(
      describeJiraFailure(
        result.code,
        Array.isArray(projects)
          ? (projects as { id: string; name: string }[])
          : undefined,
      ),
    );
  }

  /** Starts the round trip: the answer is the address of the consent page at Atlassian, where the browser goes. */
  async function begin(connectionId?: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await api.connect(connectionId);
    if (!result.ok) {
      setBusy(false);
      failed(result);
      return;
    }
    go(result.data.url);
  }

  async function choose(cloudId: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await api.choose(cloudId);
    setBusy(false);
    if (!result.ok) failed(result);
    router.replace(`/w/${workspaceSlug}/settings/integrations`);
    router.refresh();
  }

  async function remove(connectionId: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await api.remove(connectionId);
    setBusy(false);
    if (!result.ok) failed(result);
    router.refresh();
  }

  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle>
          <h2
            id={titleId}
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            Jira Cloud
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data.notice !== null ? (
          <Alert variant={noticeVariant(data.notice.tone)} role="status">
            <AlertDescription>{data.notice.text}</AlertDescription>
          </Alert>
        ) : null}
        {problem !== null ? (
          <Alert variant="destructive" role="status">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}
        {!data.configured ? (
          <Alert variant="warning" role="note">
            <AlertDescription>
              Jira is not set up on this installation, so a site cannot be
              connected: the client id and secret of the Atlassian app are
              missing.
            </AlertDescription>
          </Alert>
        ) : null}

        {data.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Jira Cloud site is connected yet.
          </p>
        ) : (
          <ul
            aria-label="Jira sites"
            className="flex flex-col divide-y divide-border"
          >
            {data.connections.map((connection) => (
              <li
                key={connection.id}
                data-connection={connection.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-4 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="min-w-0 truncate font-semibold text-foreground">
                    {connection.siteName}
                  </span>
                  <span className="min-w-0 truncate text-sm text-muted-foreground">
                    {isHttps(connection.siteUrl) ? (
                      <a
                        href={connection.siteUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="underline"
                      >
                        {connection.siteUrl}
                      </a>
                    ) : (
                      connection.siteUrl
                    )}
                    {" · connected by "}
                    {connection.accountName}
                  </span>
                  {connection.status === "broken" ? (
                    <span className="text-sm text-destructive">
                      {describeBrokenConnection(connection.errorCode)}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <Badge
                    variant={
                      connection.status === "connected" ? "success" : "danger"
                    }
                  >
                    {connection.status === "connected"
                      ? "Connected"
                      : "Needs reconnecting"}
                  </Badge>
                  {canManage && connection.status === "broken" ? (
                    <Button
                      size="sm"
                      disabled={busy || !data.configured}
                      aria-label={`Reconnect ${connection.siteName}`}
                      onClick={() => void begin(connection.id)}
                    >
                      Reconnect
                    </Button>
                  ) : null}
                  {canManage ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          aria-label={`Remove ${connection.siteName}`}
                        >
                          Remove
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Remove{" "}
                            <span className="break-all">
                              {connection.siteName}
                            </span>
                            ?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            The stored access is deleted. Nothing changes in
                            Jira; to end the access completely, remove the app
                            in your Atlassian account. A connection that a
                            project uses cannot be removed.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            disabled={busy}
                            aria-label={`Confirm removing ${connection.siteName}`}
                            onClick={() => void remove(connection.id)}
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canManage && data.choices !== null ? (
          <ul
            aria-label="Jira sites you can connect"
            className="flex flex-col divide-y divide-border rounded-md border border-border px-4"
          >
            {data.choices.map((site) => (
              <li
                key={site.cloudId}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="min-w-0 truncate font-semibold text-foreground">
                    {site.siteName}
                  </span>
                  <span className="min-w-0 truncate text-sm text-muted-foreground">
                    {site.siteUrl}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  aria-label={`Connect ${site.siteName}`}
                  onClick={() => void choose(site.cloudId)}
                >
                  Connect this site
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !data.configured}
              onClick={() => void begin()}
            >
              {data.connections.length === 0
                ? "Connect Jira"
                : "Connect another site"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
