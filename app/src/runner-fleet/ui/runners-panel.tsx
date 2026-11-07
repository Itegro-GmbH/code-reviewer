// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The runners of the workspace (#854, #925): the two kinds of environment (the hosted sandbox of the platform and the runners on the
// customer's own machines), the list of the runners with name, labels, version of the base, the harnesses and capabilities the runner
// announces, last seen and state, a button that revokes one, and "Connect your own runner", which makes a registration token. The token is
// shown once, in a dialog, with the command to register a runner; the page keeps it only in memory. It talks to the routes of #854 only (`api.ts`), and shows
// no text from an answer: every refusal is a fixed sentence for its code (`messages.ts`).
import Link from "next/link";
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { CopyButton } from "../../components/copy-button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
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
import { useProductIdentity } from "../../product-identity/context.tsx";
import { useRequest } from "../../implementer/ui/use-request.ts";
import { formatUtc } from "../../ui/format-time.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import type { NewTokenView, RunnerList, RunnerView } from "../service.ts";
import { browserRunnerFleetApi, type RunnerFleetApi } from "./api.ts";
import {
  describeRunnerFleetFailure,
  PAGE_COPY,
  registerCommand,
  STATUS_COPY,
} from "./messages.ts";

const loadList = (api: RunnerFleetApi) => api.list();

/** The two kinds of environment of the prototype: both talk the Runner API, and a profile says on which of them it runs. */
const RUNNER_KINDS = [
  {
    name: PAGE_COPY.hostedName,
    description: PAGE_COPY.hostedDescription,
    capabilities: ["Provided per run", "opencode", "Billed from the balance"],
  },
  {
    name: PAGE_COPY.ownName,
    description: PAGE_COPY.ownDescription,
    capabilities: [
      "Your machine",
      "opencode",
      "Claude Code on your subscription",
    ],
  },
] as const;

export function RunnersPanel({
  workspaceSlug,
  canManage,
  api: apiProp,
}: {
  workspaceSlug: string;
  /** Whether the person may add and revoke runners (`manage_runners`); the page asks the matrix. */
  canManage: boolean;
  /** Only tests pass this. */
  api?: RunnerFleetApi;
}) {
  const product = useProductIdentity();
  const [defaultApi] = useState(() => browserRunnerFleetApi(workspaceSlug));
  const api = apiProp ?? defaultApi;
  const [loaded, reload] = useRequest(api, "list", loadList);

  if (loaded.state === "loading" || loaded.state === "idle")
    return <StatusRegion>{PAGE_COPY.loading}</StatusRegion>;
  if (loaded.state === "failed")
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertDescription>
            {describeRunnerFleetFailure(product, {
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
    <Runners
      api={api}
      canManage={canManage}
      initial={loaded.data}
      workspaceSlug={workspaceSlug}
    />
  );
}

function Runners({
  api,
  canManage,
  initial,
  workspaceSlug,
}: {
  api: RunnerFleetApi;
  canManage: boolean;
  initial: RunnerList;
  workspaceSlug: string;
}) {
  const product = useProductIdentity();
  const [runners, setRunners] = useState(initial.runners);
  const [token, setToken] = useState<NewTokenView | null>(null);
  const [toRevoke, setToRevoke] = useState<RunnerView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function makeToken() {
    setNotice(null);
    setProblem(null);
    setBusy(true);
    const result = await api.createToken();
    setBusy(false);
    if (!result.ok) {
      setProblem(
        describeRunnerFleetFailure(product, {
          code: result.code,
          status: result.status,
          maximum: result.details?.maximum,
        }),
      );
      return;
    }
    setToken(result.data);
  }

  async function revoke(runner: RunnerView) {
    setToRevoke(null);
    setNotice(null);
    setProblem(null);
    setBusy(true);
    const result = await api.revoke(runner.id);
    setBusy(false);
    // A runner that is gone already is gone from the list too, as the person wanted.
    if (result.ok || result.code === "RUNNER_FLEET_NOT_FOUND")
      setRunners((current) =>
        current.filter((entry) => entry.id !== runner.id),
      );
    if (!result.ok) {
      setProblem(
        describeRunnerFleetFailure(product, {
          code: result.code,
          status: result.status,
        }),
      );
      return;
    }
    setNotice(PAGE_COPY.revoked);
  }

  return (
    <div className="flex flex-col gap-6">
      {initial.minBaseVersion !== null ? (
        <Alert variant="info" role="status">
          {PAGE_COPY.minimum(initial.minBaseVersion)}
        </Alert>
      ) : null}
      {problem !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <StatusRegion>{notice ?? ""}</StatusRegion>

      <section
        aria-labelledby="runner-kinds-heading"
        className="flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="runner-kinds-heading"
            className="text-lg leading-7 font-semibold"
          >
            {PAGE_COPY.kindsTitle}
          </h2>
          <p className="text-sm text-muted-foreground">{PAGE_COPY.kindsHint}</p>
        </div>
        <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2">
          {RUNNER_KINDS.map((kind) => (
            <li
              key={kind.name}
              className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-6 py-4"
            >
              <span className="font-semibold">{kind.name}</span>
              <span className="text-sm text-muted-foreground">
                {kind.description}
              </span>
              <ul className="m-0 flex list-none flex-wrap gap-1.5 border-t border-border p-0 pt-2">
                {kind.capabilities.map((capability) => (
                  <li
                    key={capability}
                    className="rounded-full bg-raised px-2.5 py-1 text-xs font-semibold text-muted-foreground"
                  >
                    {capability}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          {PAGE_COPY.environmentsNote}{" "}
          <Link href={workspacePath(workspaceSlug, "/environments")}>
            {PAGE_COPY.environmentsLink}
          </Link>
        </p>
      </section>

      {canManage ? (
        <div>
          <Button disabled={busy} onClick={() => void makeToken()}>
            {PAGE_COPY.addRunner}
          </Button>
        </div>
      ) : null}

      <Dialog
        open={token !== null}
        onOpenChange={(open) => {
          if (!open) setToken(null);
        }}
      >
        <DialogContent aria-label={PAGE_COPY.tokenTitle}>
          <DialogHeader>
            <DialogTitle>{PAGE_COPY.tokenTitle}</DialogTitle>
            <DialogDescription>{PAGE_COPY.tokenNote}</DialogDescription>
          </DialogHeader>
          {token === null ? null : (
            <>
              <p className="text-sm font-semibold">{PAGE_COPY.tokenRunOn}</p>
              <div className="flex flex-wrap items-center gap-2">
                <code
                  aria-label={PAGE_COPY.tokenCommandLabel}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background p-3 font-mono text-sm break-all"
                >
                  {registerCommand(token.token)}
                </code>
                <CopyButton
                  value={registerCommand(token.token)}
                  label="Copy the register command"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {PAGE_COPY.tokenExpires} {formatUtc(token.expiresAt)}
              </p>
            </>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setToken(null)}>
              {PAGE_COPY.tokenDismiss}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <h2 className="text-lg leading-7 font-semibold">
        {PAGE_COPY.connected(runners.length)}
      </h2>
      {runners.length === 0 ? (
        <p className="text-muted-foreground">{PAGE_COPY.empty}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {runners.map((runner) => (
            <li
              key={runner.id}
              className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="text-lg leading-7 font-semibold break-words">
                    {runner.name}
                  </h2>
                  <p
                    className={
                      runner.status === "update_needed"
                        ? "text-sm text-destructive"
                        : "text-sm text-muted-foreground"
                    }
                  >
                    {STATUS_COPY[runner.status]}
                  </p>
                </div>
                {canManage ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    aria-label={`${PAGE_COPY.revoke} ${runner.name}`}
                    disabled={busy}
                    onClick={() => setToRevoke(runner)}
                  >
                    {PAGE_COPY.revoke}
                  </Button>
                ) : null}
              </div>
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">{PAGE_COPY.labels}</dt>
                <dd className="font-mono break-words">
                  {runner.labels.length === 0
                    ? PAGE_COPY.noLabels
                    : runner.labels.join(", ")}
                </dd>
                <dt className="text-muted-foreground">{PAGE_COPY.base}</dt>
                <dd className="font-mono">{runner.baseVersion}</dd>
                <dt className="text-muted-foreground">{PAGE_COPY.harnesses}</dt>
                <dd className="font-mono break-words">
                  {Object.keys(runner.manifest.harnesses).length === 0
                    ? PAGE_COPY.noHarnesses
                    : Object.entries(runner.manifest.harnesses)
                        .map(
                          ([name, harness]) =>
                            `${name} ${harness.version} (${harness.ready ? PAGE_COPY.ready : PAGE_COPY.notReady})`,
                        )
                        .join(", ")}
                </dd>
                {runner.manifest.capabilities.length > 0 ? (
                  <>
                    <dt className="text-muted-foreground">
                      {PAGE_COPY.capabilities}
                    </dt>
                    <dd className="font-mono break-words">
                      {runner.manifest.capabilities.join(", ")}
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">{PAGE_COPY.lastSeen}</dt>
                <dd>{formatUtc(runner.lastSeenAt)}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={toRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setToRevoke(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{PAGE_COPY.revokeTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {toRevoke?.name}. {PAGE_COPY.revokeNote}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{PAGE_COPY.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (toRevoke !== null) void revoke(toRevoke);
              }}
            >
              {PAGE_COPY.revokeConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
