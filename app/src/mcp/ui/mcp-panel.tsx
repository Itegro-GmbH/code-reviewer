// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The MCP page of the workspace (#1050): the list of the remote MCP servers with their address, transport, the NAMES of their headers (the
// values are shown as a mask and are never sent to the browser), the last connection test and the tools it found; a button that tests the
// connection; and, for an Owner or Admin, the dialogs that add, change and remove a server. It talks to the routes of #1050 only (`api.ts`),
// and shows no text from an answer: every refusal is a fixed sentence for its code (`messages.ts`).
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { useRequest } from "../../implementer/ui/use-request.ts";
import { useProductIdentity } from "../../product-identity/context.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { McpServerView } from "../service.ts";
import { browserMcpApi, type McpApi } from "./api.ts";
import {
  AUTH_COPY,
  describeMcpFailure,
  describeTestFailure,
  PAGE_COPY,
  TRANSPORT_COPY,
} from "./messages.ts";
import { ServerDialog } from "./server-dialog.tsx";

const loadList = (api: McpApi) => api.list();

export function McpPanel({
  workspaceSlug,
  canManage,
  api: apiProp,
}: {
  workspaceSlug: string;
  /** Whether the person may add, change, test and remove servers (`manage_mcp`); the page asks the matrix. */
  canManage: boolean;
  /** Only tests pass this. */
  api?: McpApi;
}) {
  const product = useProductIdentity();
  const [defaultApi] = useState(() => browserMcpApi(workspaceSlug));
  const api = apiProp ?? defaultApi;
  const [loaded, reload] = useRequest(api, "list", loadList);

  if (loaded.state === "loading" || loaded.state === "idle")
    return <StatusRegion>{PAGE_COPY.loading}</StatusRegion>;
  if (loaded.state === "failed")
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertDescription>
            {describeMcpFailure(product, {
              code: loaded.failure.code,
              status: loaded.failure.status,
            })}
          </AlertDescription>
        </Alert>
        <div>
          <Button variant="secondary" onClick={reload}>
            {PAGE_COPY.tryAgain}
          </Button>
        </div>
      </div>
    );
  return (
    <Servers api={api} canManage={canManage} initial={loaded.data.servers} />
  );
}

function ToolList({ server }: { server: McpServerView }) {
  const tools = server.tools;
  if (tools === null) return null;
  return (
    <details className="rounded-lg border border-border bg-background px-3 py-2">
      <summary className="cursor-pointer text-sm font-semibold">
        {tools.tools.length === 0
          ? PAGE_COPY.noTools
          : PAGE_COPY.tools(tools.tools.length, tools.truncated)}
        {tools.serverName === null
          ? ""
          : ` · ${PAGE_COPY.serverIs} ${tools.serverName}${tools.serverVersion === null ? "" : ` ${tools.serverVersion}`}`}
      </summary>
      {tools.tools.length === 0 ? null : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
          {tools.tools.map((tool) => (
            <li key={tool.name} className="flex flex-col gap-0.5">
              <span className="font-mono text-sm break-words">{tool.name}</span>
              {tool.description === "" ? null : (
                <span className="text-sm break-words text-muted-foreground">
                  {tool.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function TestStatus({ server }: { server: McpServerView }) {
  if (server.status === "untested")
    return (
      <p className="text-sm text-muted-foreground">{PAGE_COPY.neverTested}</p>
    );
  const text =
    server.status === "ok"
      ? "Connected."
      : describeTestFailure(server.testErrorCode);
  return (
    <p
      className={
        server.status === "ok"
          ? "text-sm text-muted-foreground"
          : "text-sm text-destructive"
      }
    >
      {text}
      {server.testedAt === null
        ? ""
        : ` ${PAGE_COPY.testedAt} ${formatUtc(server.testedAt)}.`}
    </p>
  );
}

function Servers({
  api,
  canManage,
  initial,
}: {
  api: McpApi;
  canManage: boolean;
  initial: McpServerView[];
}) {
  const product = useProductIdentity();
  const [servers, setServers] = useState(initial);
  const [dialog, setDialog] = useState<"add" | McpServerView | null>(null);
  const [toRemove, setToRemove] = useState<McpServerView | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const replace = (server: McpServerView) =>
    setServers((current) => {
      const known = current.some((entry) => entry.id === server.id);
      const next = known
        ? current.map((entry) => (entry.id === server.id ? server : entry))
        : [...current, server];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });

  async function test(server: McpServerView) {
    setNotice(null);
    setProblem(null);
    setTesting(server.id);
    const result = await api.test(server.id);
    setTesting(null);
    if (!result.ok) {
      setProblem(
        describeMcpFailure(product, {
          code: result.code,
          status: result.status,
        }),
      );
      return;
    }
    replace(result.data.server);
  }

  async function remove(server: McpServerView) {
    setToRemove(null);
    setNotice(null);
    setProblem(null);
    const result = await api.remove(server.id);
    if (result.ok || result.code === "mcp_server_not_found")
      setServers((current) =>
        current.filter((entry) => entry.id !== server.id),
      );
    if (!result.ok) {
      setProblem(
        describeMcpFailure(product, {
          code: result.code,
          status: result.status,
          lanes: readLanes(result.details?.lanes),
        }),
      );
      return;
    }
    setNotice(PAGE_COPY.removed);
  }

  return (
    <div className="flex flex-col gap-6">
      {problem === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <StatusRegion>{notice ?? ""}</StatusRegion>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg leading-7 font-semibold">
          {PAGE_COPY.count(servers.length)}
        </h2>
        {canManage ? (
          <Button onClick={() => setDialog("add")}>{PAGE_COPY.add}</Button>
        ) : null}
      </div>

      {servers.length === 0 ? (
        <p className="text-muted-foreground">{PAGE_COPY.empty}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {servers.map((server) => (
            <li
              key={server.id}
              className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-lg leading-7 font-semibold break-words">
                    {server.name}
                  </h3>
                  <TestStatus server={server} />
                </div>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`${PAGE_COPY.test} ${server.name}`}
                      disabled={testing !== null}
                      onClick={() => void test(server)}
                    >
                      {testing === server.id
                        ? PAGE_COPY.testing
                        : PAGE_COPY.test}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`${PAGE_COPY.edit} ${server.name}`}
                      onClick={() => setDialog(server)}
                    >
                      {PAGE_COPY.edit}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      aria-label={`${PAGE_COPY.remove} ${server.name}`}
                      onClick={() => setToRemove(server)}
                    >
                      {PAGE_COPY.remove}
                    </Button>
                  </div>
                ) : null}
              </div>
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">{PAGE_COPY.address}</dt>
                <dd className="font-mono break-all">{server.url}</dd>
                <dt className="text-muted-foreground">{PAGE_COPY.transport}</dt>
                <dd>{TRANSPORT_COPY[server.transport] ?? server.transport}</dd>
                <dt className="text-muted-foreground">
                  {PAGE_COPY.authentication}
                </dt>
                <dd>{AUTH_COPY[server.auth] ?? server.auth}</dd>
                {server.auth === "header" ? (
                  <>
                    <dt className="text-muted-foreground">
                      {PAGE_COPY.headers}
                    </dt>
                    <dd>
                      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                        {server.headers.map((name) => (
                          <li key={name} className="font-mono break-all">
                            {name}:{" "}
                            <span aria-label="masked value">
                              {PAGE_COPY.mask}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                ) : null}
              </dl>
              <ToolList server={server} />
            </li>
          ))}
        </ul>
      )}

      <ServerDialog
        key={dialog === null || dialog === "add" ? "add" : dialog.id}
        api={api}
        open={dialog !== null}
        server={dialog === null || dialog === "add" ? null : dialog}
        onClose={() => setDialog(null)}
        onSaved={(saved, created) => {
          setDialog(null);
          setProblem(null);
          replace(saved);
          setNotice(created ? PAGE_COPY.added : PAGE_COPY.saved);
          // A new server is tested at once: that is what the person wants to know.
          if (created) void test(saved);
        }}
      />

      <AlertDialog
        open={toRemove !== null}
        onOpenChange={(open) => {
          if (!open) setToRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{PAGE_COPY.removeTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {toRemove?.name}. {PAGE_COPY.removeNote}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{PAGE_COPY.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (toRemove !== null) void remove(toRemove);
              }}
            >
              {PAGE_COPY.removeConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The lanes a refusal named: names only, anything else in the answer is dropped. */
export function readLanes(
  value: unknown,
): { name: string; projectName: string | null }[] {
  if (!Array.isArray(value)) return [];
  const lanes: { name: string; projectName: string | null }[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, projectName } = entry as {
      name?: unknown;
      projectName?: unknown;
    };
    if (typeof name === "string")
      lanes.push({
        name,
        projectName: typeof projectName === "string" ? projectName : null,
      });
  }
  return lanes;
}
