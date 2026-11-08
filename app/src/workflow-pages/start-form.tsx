// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The form that starts a run of a workflow by hand (#873). Its fields are those of the `input` of the workflow's manual trigger (the
// page reads them from the saved document and hands them in); the repository comes first, every run works on one. Every member may
// start, the same right as starting an Implementer task. A submit carries a `clientRequestId`: the same input is the same request, so
// a retry after a lost answer starts one run, not two, and an input that was edited is another request. The server judges the input
// again; this form only keeps a person from sending what cannot work (an empty required field, text where a number is asked).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "../components/button.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Input } from "../components/ui/input.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { FormField } from "../implementer/ui/form-field.tsx";
import { useProductIdentity } from "../product-identity/context.tsx";
import { ModelSelect } from "../review-settings/ui/model-select.tsx";
import { workspacePath } from "../workspaces/paths.ts";
import { browserWorkflowRunsApi, type WorkflowRunsApi } from "./api.ts";
import { describeStartFailure, START_COPY } from "./messages.ts";
import type { StartField } from "./start-form-spec.ts";

type Values = Record<string, string | boolean>;
type Errors = Record<string, string>;

function newClientRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** The input the values stand for, or the problems that keep them from being sent. Fields left empty are left out. */
export function inputOf(
  fields: readonly StartField[],
  values: Values,
): { input: Record<string, unknown> } | { errors: Errors } {
  const input: Record<string, unknown> = {};
  const errors: Errors = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === "boolean") {
      if (value === true || field.required) input[field.name] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (text.trim() === "") {
      if (field.required) errors[field.name] = START_COPY.required;
      continue;
    }
    if (field.kind === "string") input[field.name] = text;
    else if (field.kind === "ticket") input[field.name] = text.trim();
    else if (field.kind === "integer") {
      if (!/^-?\d+$/.test(text.trim()) || !Number.isSafeInteger(Number(text)))
        errors[field.name] = START_COPY.notInteger;
      else input[field.name] = Number(text);
    } else if (field.kind === "number") {
      // Decimal notation only: `Number()` would also take `0x10`, `1e3` and `Infinity`.
      if (
        !/^-?(\d+\.?\d*|\.\d+)$/.test(text.trim()) ||
        !Number.isFinite(Number(text))
      )
        errors[field.name] = START_COPY.notNumber;
      else input[field.name] = Number(text);
    } else {
      try {
        input[field.name] = JSON.parse(text) as unknown;
      } catch {
        errors[field.name] = START_COPY.notJson;
      }
    }
  }
  return Object.keys(errors).length > 0 ? { errors } : { input };
}

/** The top-level field a problem of the server names (`/repo`, `/labels/0`), or undefined. */
function fieldOfPath(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const name = path.split("/")[1];
  return name === undefined || name === "" ? undefined : name;
}

function labelOf(field: StartField): string {
  if (field.kind === "ticket") return START_COPY.fieldTicket;
  return field.name === "repo" ? START_COPY.fieldRepo : field.name;
}

export function StartForm({
  workspaceSlug,
  workflowId,
  fields,
  trigger,
  api: apiProp,
}: {
  /** The workspace of the page: the call is made in it, and the run it starts is linked in it. */
  workspaceSlug: string;
  workflowId: string;
  fields: readonly StartField[];
  /** The id of the trigger this form starts, when the workflow has several (#916). */
  trigger?: string;
  /** Only tests pass this. */
  api?: WorkflowRunsApi;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const [defaultApi] = useState(() => browserWorkflowRunsApi(workspaceSlug));
  const api = apiProp ?? defaultApi;
  const [values, setValues] = useState<Values>({});
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<{
    sentence: string;
    runId?: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  const sending = useRef(false);
  /** One id per input: the same input is the same request, an edited input is another one. */
  const requestIds = useRef(new Map<string, string>());

  const runPath = (runId: string) =>
    workspacePath(
      workspaceSlug,
      `/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`,
    );

  function set(name: string, value: string | boolean) {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    const checked = inputOf(fields, values);
    if ("errors" in checked) {
      setErrors(checked.errors);
      setProblem(null);
      return;
    }
    sending.current = true;
    setPending(true);
    setErrors({});
    setProblem(null);
    setStarted(null);
    const fingerprint = JSON.stringify(checked.input);
    const clientRequestId =
      requestIds.current.get(fingerprint) ?? newClientRequestId();
    requestIds.current.set(fingerprint, clientRequestId);
    const result = await api.start(workflowId, {
      ...(trigger === undefined ? {} : { trigger }),
      input: checked.input,
      clientRequestId,
    });
    if (result.ok) {
      // With Cache Components this page stays mounted when the person goes on to the run and comes back, so the form is released
      // here, not left "sending" for a page change that may never unmount it. The next start is another request, even with the
      // same input: the ids of the finished one are dropped, or it would be answered with the run that was started before.
      sending.current = false;
      setPending(false);
      requestIds.current.clear();
      setStarted(result.data.run.id);
      router.push(runPath(result.data.run.id));
      return;
    }
    sending.current = false;
    setPending(false);
    if (result.code === "WORKFLOW_RUN_INPUT_INVALID") {
      const found: Errors = {};
      const list = result.details?.errors;
      if (Array.isArray(list))
        for (const entry of list as unknown[]) {
          const name = fieldOfPath(
            typeof entry === "object" && entry !== null
              ? (entry as { path?: unknown }).path
              : undefined,
          );
          if (name !== undefined && fields.some((f) => f.name === name))
            found[name] = START_COPY.invalidValue;
        }
      setErrors(found);
    }
    const reused = result.details?.runId;
    setProblem({
      sentence: describeStartFailure(product, result),
      ...(result.code === "WORKFLOW_RUN_REQUEST_REUSED" &&
      typeof reused === "string"
        ? { runId: reused }
        : {}),
    });
  }

  return (
    <form
      noValidate
      className="flex max-w-2xl flex-col gap-6"
      onSubmit={(event) => void submit(event)}
    >
      <p className="text-sm text-muted-foreground">{START_COPY.intro}</p>
      <fieldset disabled={pending} className="flex flex-col gap-6">
        {fields.map((field) => (
          <FieldControl
            key={field.name}
            field={field}
            value={values[field.name]}
            error={errors[field.name]}
            onChange={(value) => set(field.name, value)}
          />
        ))}
      </fieldset>
      {started !== null ? (
        <Alert variant="success" role="status">
          {START_COPY.started}{" "}
          <Link
            href={runPath(started)}
            className="font-semibold underline underline-offset-4"
          >
            {START_COPY.openRun}
          </Link>
        </Alert>
      ) : null}
      {problem !== null ? (
        <div className="flex flex-col items-start gap-3">
          <Alert variant="destructive">{problem.sentence}</Alert>
          {problem.runId === undefined ? null : (
            <Link
              href={runPath(problem.runId)}
              className="font-semibold underline underline-offset-4"
            >
              {START_COPY.openThatRun}
            </Link>
          )}
        </div>
      ) : null}
      <div>
        <Button
          type="submit"
          loading={pending}
          loadingLabel={START_COPY.starting}
        >
          {START_COPY.start}
        </Button>
      </div>
    </form>
  );
}

function FieldControl({
  field,
  value,
  error,
  onChange,
}: {
  field: StartField;
  value: string | boolean | undefined;
  error: string | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const label = labelOf(field);
  // The description is a note from the workflow document: text. The repository has a hint of its own.
  const hint =
    field.kind === "ticket"
      ? START_COPY.ticketHint
      : field.name === "repo"
        ? START_COPY.repoHint
        : field.description;
  if (field.choices !== undefined)
    return (
      <ModelSelect
        name={field.name}
        label={label}
        value={typeof value === "string" ? value : ""}
        options={field.choices.map((choice) => ({ id: choice, label: choice }))}
        onChange={onChange}
        error={error}
        placeholder={START_COPY.choose}
      />
    );
  return (
    <FormField name={field.name} label={label} hint={hint} error={error}>
      {(control) => {
        if (field.kind === "boolean")
          return (
            <Checkbox
              id={control.id}
              aria-invalid={control["aria-invalid"]}
              aria-describedby={control["aria-describedby"]}
              checked={value === true}
              onCheckedChange={(checked) => onChange(checked === true)}
            />
          );
        if (field.kind === "json")
          return (
            <Textarea
              {...control}
              rows={4}
              className="font-mono"
              value={typeof value === "string" ? value : ""}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                onChange(event.target.value)
              }
            />
          );
        return (
          <Input
            {...control}
            type="text"
            inputMode={
              field.kind === "integer" || field.kind === "number"
                ? "decimal"
                : "text"
            }
            autoComplete="off"
            value={typeof value === "string" ? value : ""}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onChange(event.target.value)
            }
          />
        );
      }}
    </FormField>
  );
}
