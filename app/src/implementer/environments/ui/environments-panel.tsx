// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The list of the workspace's environments with create, edit and delete (#818). Everybody who can open the page sees the list and
// the scripts (they can use them); only a person who may manage (`canManage`, the page asks the matrix) gets the buttons. It talks
// to the routes of #818 only (`api.ts`), reads no secret, and shows no text from an answer: every refusal is a fixed sentence for
// its code (`messages.ts`). The script is sent exactly as typed.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../../components/button.tsx";
import { StatusRegion } from "../../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../../components/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog.tsx";
import { Input } from "../../../components/ui/input.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../../components/ui/radio-group.tsx";
import { Textarea } from "../../../components/ui/textarea.tsx";
import { useProductIdentity } from "../../../product-identity/context.tsx";
import type { RequestResult } from "../../../ui/json-request.ts";
import { FormField } from "../../ui/form-field.tsx";
import { useRequest } from "../../ui/use-request.ts";
import type { EnvironmentIssue } from "../errors.ts";
import { validateEnvironmentInput } from "../input.ts";
import {
  DEFAULT_VCPUS,
  ENVIRONMENT_VCPUS,
  isEnvironmentVcpus,
  SETUP_SCRIPT_MAX_BYTES,
  memoryGbOf,
} from "../limits.ts";
import {
  NETWORK_MODES,
  type NetworkMode,
} from "../../../network-rule/network.ts";
import type { EnvironmentList, EnvironmentView } from "../service.ts";
import {
  browserEnvironmentApi,
  type EnvironmentApi,
  type EnvironmentBody,
} from "./api.ts";
import {
  describeEnvironmentFailure,
  describeFieldIssue,
  PAGE_COPY,
} from "./messages.ts";

const loadList = (api: EnvironmentApi) => api.list();

type Editing = { kind: "new" } | { kind: "edit"; id: string } | null;
type FieldErrors = Partial<Record<EnvironmentIssue["field"], string>>;

const sizeLabel = (vcpus: number) =>
  `${vcpus} vCPU, ${memoryGbOf(vcpus)} GB memory`;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

export function EnvironmentsPanel({
  workspaceSlug,
  canManage,
  api: apiProp,
}: {
  workspaceSlug: string;
  /** Whether the person may create, change and delete (`manage_implementer_environments`). */
  canManage: boolean;
  /** Only tests pass this. */
  api?: EnvironmentApi;
}) {
  const product = useProductIdentity();
  const [defaultApi] = useState(() => browserEnvironmentApi(workspaceSlug));
  const api = apiProp ?? defaultApi;
  const [loaded, reload] = useRequest(api, "list", loadList);

  if (loaded.state === "loading" || loaded.state === "idle")
    return <StatusRegion>{PAGE_COPY.loading}</StatusRegion>;
  if (loaded.state === "failed")
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertDescription>
            {describeEnvironmentFailure(product, {
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
  return <Environments api={api} canManage={canManage} initial={loaded.data} />;
}

function Environments({
  api,
  canManage,
  initial,
}: {
  api: EnvironmentApi;
  canManage: boolean;
  initial: EnvironmentList;
}) {
  const product = useProductIdentity();
  const [items, setItems] = useState(initial.environments);
  const [editing, setEditing] = useState<Editing>(null);
  const [toDelete, setToDelete] = useState<EnvironmentView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A delete is in flight: no second one starts until it has ended.
  const [removing, setRemoving] = useState(false);

  const editedItem =
    editing?.kind === "edit"
      ? items.find((item) => item.id === editing.id)
      : undefined;

  /** The row is gone from the screen, and so is the form when it was the one being edited. */
  function dropRow(item: EnvironmentView) {
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    setEditing((current) =>
      current?.kind === "edit" && current.id === item.id ? null : current,
    );
  }

  async function remove(item: EnvironmentView) {
    setToDelete(null);
    setNotice(null);
    setProblem(null);
    setRemoving(true);
    const result = await api.remove(item.id);
    setRemoving(false);
    if (!result.ok) {
      // It is not there any more (somebody deleted it): the row goes, as the person wanted.
      if (result.code === "ENVIRONMENT_NOT_FOUND") dropRow(item);
      setProblem(
        describeEnvironmentFailure(product, {
          code: result.code,
          status: result.status,
        }),
      );
      return;
    }
    dropRow(item);
    setNotice(PAGE_COPY.deleted);
  }

  function saved(environment: EnvironmentView) {
    setItems((current) => {
      const next = current.some((entry) => entry.id === environment.id)
        ? current.map((entry) =>
            entry.id === environment.id ? environment : entry,
          )
        : [...current, environment];
      return next.sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      );
    });
    setEditing(null);
    setProblem(null);
    setNotice(PAGE_COPY.saved);
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert variant="info" role="status">
        {PAGE_COPY.scriptsRunning}
      </Alert>
      {problem !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <StatusRegion>{notice ?? ""}</StatusRegion>

      {canManage && editing === null ? (
        <div>
          <Button
            onClick={() => {
              setNotice(null);
              setEditing({ kind: "new" });
            }}
          >
            {PAGE_COPY.newEnvironment}
          </Button>
        </div>
      ) : null}

      {editing !== null && (editing.kind === "new" || editedItem) ? (
        <EnvironmentForm
          // A fresh form for each thing edited, so no typed text leaks from one to the next.
          key={editedItem?.id ?? "new"}
          api={api}
          item={editedItem}
          onSaved={saved}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {items.length === 0 ? (
        <p className="text-muted-foreground">
          {canManage ? PAGE_COPY.empty : PAGE_COPY.emptyMember}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="text-lg leading-7 font-semibold break-words">
                    {item.name}
                  </h2>
                  {item.kind === "runner" ? (
                    <p className="text-sm text-muted-foreground">
                      {PAGE_COPY.labelsShown}{" "}
                      <span className="font-mono">
                        {item.labels.join(", ")}
                      </span>
                    </p>
                  ) : item.vcpus !== null && item.sizeSupported ? (
                    <p className="text-sm text-muted-foreground">
                      {sizeLabel(item.vcpus)}
                    </p>
                  ) : (
                    <p className="text-sm text-destructive">
                      {item.vcpus} vCPU. {PAGE_COPY.sizeUnsupportedShort}
                    </p>
                  )}
                </div>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`${PAGE_COPY.edit} ${item.name}`}
                      onClick={() => {
                        setNotice(null);
                        setEditing({ kind: "edit", id: item.id });
                      }}
                    >
                      {PAGE_COPY.edit}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      aria-label={`${PAGE_COPY.delete} ${item.name}`}
                      disabled={removing}
                      onClick={() => setToDelete(item)}
                    >
                      {PAGE_COPY.delete}
                    </Button>
                  </div>
                ) : null}
              </div>
              {item.kind === "runner" ? (
                <p className="text-sm text-muted-foreground">
                  {PAGE_COPY.runnerNote}
                </p>
              ) : null}
              {item.kind === "runner" ? null : (
                <div className="text-sm text-muted-foreground">
                  <p>
                    {item.network.mode === "off"
                      ? PAGE_COPY.networkShownOff
                      : item.network.mode === "open"
                        ? PAGE_COPY.networkShownOpen
                        : PAGE_COPY.networkShownList}
                  </p>
                  {item.network.mode === "list" ? (
                    <ul
                      aria-label={`${PAGE_COPY.networkHosts}: ${item.name}`}
                      className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono"
                    >
                      {item.network.hosts.map((host) => (
                        <li key={host}>{host}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}
              {item.kind === "runner" ? null : item.setupScript === "" ? (
                <p className="text-sm text-muted-foreground">
                  {PAGE_COPY.noScript}
                </p>
              ) : (
                <pre
                  tabIndex={0}
                  aria-label={`${PAGE_COPY.scriptLabelShown}: ${item.name}`}
                  className="max-h-64 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-sm whitespace-pre-wrap"
                >
                  {item.setupScript}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{PAGE_COPY.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete?.name}. {PAGE_COPY.deleteNote}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{PAGE_COPY.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (toDelete !== null) void remove(toDelete);
              }}
            >
              {PAGE_COPY.deleteConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EnvironmentForm({
  api,
  item,
  onSaved,
  onCancel,
}: {
  api: EnvironmentApi;
  item: EnvironmentView | undefined;
  onSaved: (environment: EnvironmentView) => void;
  onCancel: () => void;
}) {
  const product = useProductIdentity();
  const [name, setName] = useState(item?.name ?? "");
  const [kind, setKind] = useState<"hosted" | "runner">(item?.kind ?? "hosted");
  const [labelsText, setLabelsText] = useState((item?.labels ?? []).join(", "));
  const [vcpus, setVcpus] = useState<number>(item?.vcpus ?? DEFAULT_VCPUS);
  const [script, setScript] = useState(item?.setupScript ?? "");
  const [mode, setMode] = useState<NetworkMode>(item?.network.mode ?? "off");
  const [hostsText, setHostsText] = useState(
    (item?.network.hosts ?? []).join("\n"),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const scriptBytes = new TextEncoder().encode(script).length;
  const sizeMessageId = useId();
  const networkMessageId = useId();

  function showIssues(issues: readonly { field: string; code: string }[]) {
    const next: FieldErrors = {};
    for (const issue of issues)
      if (
        issue.field === "name" ||
        issue.field === "vcpus" ||
        issue.field === "setupScript" ||
        issue.field === "network" ||
        issue.field === "networkHosts" ||
        issue.field === "kind" ||
        issue.field === "labels"
      )
        next[issue.field] = describeFieldIssue(issue.field, issue.code);
    setErrors(next);
    return Object.keys(next).length > 0;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    const body: EnvironmentBody =
      kind === "runner"
        ? {
            kind: "runner",
            name,
            // Comma separated; the server brings each to its form and refuses the one that is not a label.
            labels: labelsText
              .split(",")
              .map((label) => label.trim())
              .filter((label) => label !== ""),
          }
        : {
            name,
            vcpus,
            setupScript: script,
            network: {
              mode,
              // One host on each line; the server brings each to its form and refuses the line that is not a host name.
              hosts: mode === "list" ? hostsText.split("\n") : [],
            },
          };
    const checked = validateEnvironmentInput(body);
    if (!checked.ok) {
      showIssues(checked.issues);
      return;
    }
    setErrors({});
    setPending(true);
    const result: RequestResult<{ environment: EnvironmentView }> =
      item === undefined
        ? await api.create(checked.value)
        : await api.update(item.id, checked.value);
    setPending(false);
    if (result.ok) {
      onSaved(result.data.environment);
      return;
    }
    if (showIssues(result.issues)) return;
    setProblem(
      describeEnvironmentFailure(product, {
        code: result.code,
        status: result.status,
        maximum: result.details?.maximum,
      }),
    );
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5"
    >
      <FormField
        name="name"
        label={PAGE_COPY.name}
        hint={PAGE_COPY.nameHint}
        error={errors.name}
      >
        {(control) => (
          <Input
            {...control}
            value={name}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </FormField>

      <fieldset data-field="kind" className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">{PAGE_COPY.kind}</legend>
        <RadioGroup
          value={kind}
          onValueChange={(value) => setKind(value as "hosted" | "runner")}
          aria-invalid={errors.kind !== undefined}
          className="grid-cols-1 sm:grid-cols-2"
        >
          {(
            [
              ["hosted", PAGE_COPY.kindHosted],
              ["runner", PAGE_COPY.kindRunner],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-3 text-sm">
              <RadioGroupItem value={value} aria-label={label} />
              <span aria-hidden="true">{label}</span>
            </label>
          ))}
        </RadioGroup>
        <p className="text-sm text-muted-foreground">
          {errors.kind ?? PAGE_COPY.kindHint}
        </p>
      </fieldset>

      {kind === "runner" ? (
        <FormField
          name="labels"
          label={PAGE_COPY.labels}
          hint={PAGE_COPY.labelsHint}
          error={errors.labels}
        >
          {(control) => (
            <Input
              {...control}
              value={labelsText}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              placeholder="linux, gpu"
              onChange={(event) => setLabelsText(event.target.value)}
            />
          )}
        </FormField>
      ) : null}

      {kind === "runner" ? null : (
        <>
          <fieldset data-field="vcpus" className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold">
              {PAGE_COPY.size}
            </legend>
            {item !== undefined &&
            item.vcpus !== null &&
            !isEnvironmentVcpus(item.vcpus) ? (
              <p className="text-sm text-destructive">
                {PAGE_COPY.sizeUnsupported}
              </p>
            ) : null}
            <RadioGroup
              value={String(vcpus)}
              onValueChange={(value) => setVcpus(Number(value))}
              aria-invalid={errors.vcpus !== undefined}
              aria-describedby={sizeMessageId}
              className="grid-cols-1 sm:grid-cols-2"
            >
              {ENVIRONMENT_VCPUS.map((size) => (
                <label key={size} className="flex items-center gap-3 text-sm">
                  <RadioGroupItem
                    value={String(size)}
                    aria-label={sizeLabel(size)}
                  />
                  <span aria-hidden="true">{sizeLabel(size)}</span>
                </label>
              ))}
            </RadioGroup>
            {errors.vcpus !== undefined ? (
              <p id={sizeMessageId} className="text-sm text-destructive">
                {errors.vcpus}
              </p>
            ) : (
              <p id={sizeMessageId} className="text-sm text-muted-foreground">
                {PAGE_COPY.sizeHint}
              </p>
            )}
          </fieldset>

          <FormField
            name="setupScript"
            label={PAGE_COPY.script}
            hint={PAGE_COPY.scriptHint}
            error={errors.setupScript}
            aside={
              <span className="text-sm text-muted-foreground">
                {kb(scriptBytes)} / {kb(SETUP_SCRIPT_MAX_BYTES)}
              </span>
            }
          >
            {(control) => (
              <Textarea
                {...control}
                value={script}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="min-h-40 font-mono text-sm"
                onChange={(event) => setScript(event.target.value)}
              />
            )}
          </FormField>

          <fieldset data-field="network" className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold">
              {PAGE_COPY.network}
            </legend>
            <RadioGroup
              value={mode}
              onValueChange={(value) => setMode(value as NetworkMode)}
              aria-invalid={errors.network !== undefined}
              aria-describedby={networkMessageId}
              className="grid-cols-1"
            >
              {NETWORK_MODES.map((option) => (
                <label key={option} className="flex items-center gap-3 text-sm">
                  <RadioGroupItem
                    value={option}
                    aria-label={PAGE_COPY.networkModeLabels[option]}
                  />
                  <span aria-hidden="true">
                    {PAGE_COPY.networkModeLabels[option]}
                  </span>
                </label>
              ))}
            </RadioGroup>
            {errors.network !== undefined ? (
              <p id={networkMessageId} className="text-sm text-destructive">
                {errors.network}
              </p>
            ) : (
              <p
                id={networkMessageId}
                className="text-sm text-muted-foreground"
              >
                {PAGE_COPY.networkHint}
              </p>
            )}
            {mode !== "off" ? (
              <p className="text-sm text-muted-foreground">
                {PAGE_COPY.networkRisk}
              </p>
            ) : null}
          </fieldset>

          {mode === "list" ? (
            <FormField
              name="networkHosts"
              label={PAGE_COPY.networkHosts}
              hint={PAGE_COPY.networkHostsHint}
              error={errors.networkHosts}
            >
              {(control) => (
                <Textarea
                  {...control}
                  value={hostsText}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder={"registry.npmjs.org\n*.pythonhosted.org"}
                  className="min-h-28 font-mono text-sm"
                  onChange={(event) => setHostsText(event.target.value)}
                />
              )}
            </FormField>
          ) : null}
        </>
      )}

      {problem !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending} loadingLabel={PAGE_COPY.saving}>
          {PAGE_COPY.save}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {PAGE_COPY.cancel}
        </Button>
      </div>
    </form>
  );
}
