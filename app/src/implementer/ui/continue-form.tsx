// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The "Continue" form on the run page of the newest turn of a session (#841, part of #745): the next instruction for the agent, on the
// same branch, in a new sandbox. What it offers comes from `GET .../runs/:id/continuation`:
//  - the session is idle: the instruction starts the next turn at once;
//  - a turn runs: the instruction is queued and starts when the turn ends. Exactly one can wait; when one does, the form shows it and is
//    disabled (the server says 409 otherwise);
//  - an instruction that waited could not start (the branch was deleted, the model is not allowed any more...): the page says why and
//    shows the text, so it is not lost.
// Model, cost limit and environment are those of the last turn unless the person changes them; a field left alone is not sent, and the
// server then uses the last turn's own copy (so an environment that was deleted since still works). The profile of the last turn is
// kept and only shown. It reads no secret and shows no text of GitHub: every refusal is a fixed sentence for its code.
//
// One body is one instruction: the client request id belongs to what is sent. The same body again (after a lost answer) carries the
// same id, so a retry that reaches the server twice makes one turn; an edited body is another instruction and gets a new id.
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Button } from "../../components/button.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { useProductIdentity } from "../../product-identity/context.tsx";
import {
  ModelSelect,
  type ModelOption,
} from "../../review-settings/ui/model-select.tsx";
import { PERMANENT_FAILURE_CODES } from "../../ui/use-live-snapshot.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import { INSTRUCTION_MAX_LENGTH } from "../start-input.ts";
import {
  browserContinueApi,
  type Continuation,
  type ContinueApi,
  type ContinueRequest,
} from "./continue-api.ts";
import {
  CONTINUE_COPY,
  describeDiscard,
  roundTokens,
} from "./continue-messages.ts";
import { costLimitPlaceholder, parseCostLimit } from "./cost-limit.ts";
import { FormField } from "./form-field.tsx";
import { describeFieldIssue, describeImplementerFailure } from "./messages.ts";
import { ModelPicker, modelChoiceOf, type ModelPick } from "./model-picker.tsx";
import { useRequest } from "./use-request.ts";

/** How often the form asks again while a turn runs (the session may end, or the waiting instruction may start). */
const POLL_MS = 3000;
/** What the environment picker's "as in the last turn" and "no environment" options are called; an environment's id is never one. */
const SAME = "__same";
const STANDARD = "__standard";

const loadModels = (api: ContinueApi) => api.models();
const loadEnvironments = (api: ContinueApi) => api.environments();

function newClientRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** The picks that stand for the model of the last turn. */
function pickOf(defaults: Continuation["defaults"]): ModelPick {
  return "entryId" in defaults.model
    ? { provider: "", model: defaults.model.entryId }
    : { provider: defaults.model.provider, model: defaults.model.model };
}

/** The cost limit of the last turn as the field shows it: dollars, empty for none. */
function costTextOf(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

type Loaded =
  | { state: "loading" }
  /** The run is not the newest turn of a session (or the person may not see it): there is nothing to continue. */
  | { state: "gone" }
  | { state: "failed"; code: string }
  | { state: "ready"; data: Continuation };

export function ContinueForm({
  workspaceSlug,
  runId,
  operatorMaximumCents,
  api: apiProp,
  pollMs = POLL_MS,
}: {
  /** The workspace of the page: the calls are made in it, and the run a turn starts is linked in it. */
  workspaceSlug: string;
  /** The run (job id) of the turn the page shows. */
  runId: string;
  /** The operator's maximum cost per task in whole US cents: the placeholder of the cost field and its upper bound. */
  operatorMaximumCents: number;
  /** Only tests pass this. */
  api?: ContinueApi;
  /** Only tests pass this. */
  pollMs?: number;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const [defaultApi] = useState(() => browserContinueApi(workspaceSlug));
  const api = apiProp ?? defaultApi;

  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [instruction, setInstruction] = useState("");
  // Null while the person has not touched the field: the last turn's value stands and is not sent.
  const [modelPick, setModelPick] = useState<ModelPick | null>(null);
  const [environmentPick, setEnvironmentPick] = useState(SAME);
  const [cost, setCost] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [problem, setProblem] = useState<{
    sentence: string;
    runId?: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState<"queued" | { runId: string } | null>(
    null,
  );
  const sending = useRef(false);
  const requestIds = useRef(new Map<string, string>());
  const stopped = useRef(false);

  const [models, reloadModels] = useRequest(api, "all", loadModels);
  const [environments, reloadEnvironments] = useRequest(
    api,
    "all",
    loadEnvironments,
  );

  const refresh = useCallback(async () => {
    const result: RequestResult<Continuation> = await api.continuation(runId);
    if (result.ok) {
      setLoaded({ state: "ready", data: result.data });
      return;
    }
    if (
      result.status === 404 ||
      result.code === "IMPLEMENTER_SESSION_NOT_FOUND"
    ) {
      stopped.current = true;
      setLoaded({ state: "gone" });
      return;
    }
    if ((PERMANENT_FAILURE_CODES as readonly string[]).includes(result.code))
      stopped.current = true;
    // A failed poll keeps what is on screen; only a form that never had its facts says so.
    setLoaded((current) =>
      current.state === "ready"
        ? current
        : { state: "failed", code: result.code },
    );
  }, [api, runId]);

  // The facts are read when the form shows, and again every few seconds while a turn runs (it may end, and the instruction that waits
  // may start). A session that is idle does not change by itself, so the form stops asking.
  const running =
    loaded.state === "ready" && loaded.data.sessionStatus === "running";
  const queuedWhileIdle =
    loaded.state === "ready" &&
    loaded.data.sessionStatus === "idle" &&
    loaded.data.queued !== null;
  const keepAsking = loaded.state === "loading" || running || queuedWhileIdle;
  useEffect(() => {
    stopped.current = false;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      await refresh();
      if (!current || stopped.current || !keepAsking) return;
      timer = setTimeout(() => void tick(), pollMs);
    }
    void tick();
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [refresh, keepAsking, pollMs]);

  if (loaded.state === "loading" || loaded.state === "gone") return null;
  if (loaded.state === "failed")
    return (
      <section data-slot="continue" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{CONTINUE_COPY.title}</h2>
        <Alert variant="destructive">{CONTINUE_COPY.loadFailed}</Alert>
        <Button
          variant="secondary"
          onClick={() => {
            setLoaded({ state: "loading" });
            void refresh();
          }}
        >
          {CONTINUE_COPY.tryAgain}
        </Button>
      </section>
    );

  const facts = loaded.data;
  const runPath = (id: string) =>
    workspacePath(workspaceSlug, `/runs/${encodeURIComponent(id)}`);
  const modelOptions = models.state === "ready" ? models.data : undefined;
  const environmentList =
    environments.state === "ready" ? environments.data.environments : [];
  const waiting = facts.queued !== null;
  const lastEnvironment = facts.defaults.environment;
  const shownPick = modelPick ?? pickOf(facts.defaults);
  const shownCost = cost ?? costTextOf(facts.defaults.costLimitCents);

  const environmentOptions: ModelOption[] = [
    {
      id: SAME,
      label:
        lastEnvironment === null
          ? CONTINUE_COPY.environmentSame
          : CONTINUE_COPY.environmentSameNamed(lastEnvironment.name),
    },
    { id: STANDARD, label: CONTINUE_COPY.environmentNone },
    ...environmentList.map((candidate) => ({
      id: candidate.id,
      label: candidate.sizeSupported
        ? `${candidate.name} (${candidate.vcpus} vCPU, ${candidate.memoryGb} GB memory${candidate.hasScript ? ", setup script" : ""})`
        : `${candidate.name} (${candidate.vcpus} vCPU, no longer offered)`,
    })),
  ];

  function clear(...keys: FieldKey[]) {
    setErrors((current) => {
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
    setProblem(null);
  }

  /** What is wrong with the form, or the body (without the request id) when nothing is. */
  function check():
    | { body: Omit<ContinueRequest, "clientRequestId"> }
    | { errors: Partial<Record<FieldKey, string>> } {
    const found: Partial<Record<FieldKey, string>> = {};
    if (instruction.trim() === "")
      found.instruction = describeFieldIssue("instruction", "required");
    else if (instruction.length > INSTRUCTION_MAX_LENGTH)
      found.instruction = describeFieldIssue("instruction", "too_long");
    const body: Omit<ContinueRequest, "clientRequestId"> = { instruction };
    if (modelPick !== null) {
      const choice = modelChoiceOf(modelOptions, modelPick);
      if (choice === undefined)
        found.model = describeFieldIssue("model", "required");
      else body.model = choice;
    }
    if (cost !== null) {
      const parsed = parseCostLimit(cost, operatorMaximumCents);
      if (!parsed.ok)
        found.cost =
          parsed.code === "invalid"
            ? describeFieldIssue("costLimitCents", "invalid")
            : describeImplementerFailure(product, {
                code: "EXCEEDS_OPERATOR_MAXIMUM",
                status: 422,
                maximumCents: parsed.maximumCents,
              });
      else body.costLimitCents = parsed.cents;
    }
    if (environmentPick === STANDARD) body.environmentId = null;
    else if (environmentPick !== SAME) body.environmentId = environmentPick;
    if (Object.keys(found).length > 0) return { errors: found };
    return { body };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || waiting) return;
    const checked = check();
    if ("errors" in checked) {
      setErrors(checked.errors);
      setProblem(null);
      return;
    }
    sending.current = true;
    setPending(true);
    setErrors({});
    setProblem(null);
    const fingerprint = JSON.stringify(checked.body);
    const clientRequestId =
      requestIds.current.get(fingerprint) ?? newClientRequestId();
    requestIds.current.set(fingerprint, clientRequestId);
    const result = await api.continueSession(facts.sessionId, {
      ...checked.body,
      clientRequestId,
    });
    if (result.ok && result.data.status === "started" && result.data.runId) {
      // Stay "sending" until the page changes: a second click on the way must not start a second turn.
      setAccepted({ runId: result.data.runId });
      try {
        router.push(runPath(result.data.runId));
        return;
      } catch {
        // The navigation failed: the run exists, so the link under the form stays, and the form is released again (a send of the same
        // body finds that run by its request id).
        sending.current = false;
        setPending(false);
        return;
      }
    }
    sending.current = false;
    setPending(false);
    if (result.ok) {
      // Queued: the instruction waits on the server; the form shows it from there.
      setAccepted("queued");
      setInstruction("");
      setCost(null);
      setModelPick(null);
      setEnvironmentPick(SAME);
      await refresh();
      return;
    }
    const failure = {
      code: result.code,
      status: result.status,
      reason: result.details?.reason,
      maximumCents: result.details?.maximumCents,
    };
    const sentence = describeImplementerFailure(product, failure);
    if (
      result.code === "IMPLEMENTER_REQUEST_REUSED" &&
      typeof result.details?.runId === "string"
    ) {
      setProblem({ sentence, runId: result.details.runId });
    } else if (
      result.code === "IMPLEMENTER_REQUEST_INVALID" &&
      result.issues.length > 0
    ) {
      const found: Partial<Record<FieldKey, string>> = {};
      let rest = false;
      for (const issue of result.issues) {
        const key = FIELD_OF_ISSUE[issue.field];
        if (key === undefined) rest = true;
        else
          found[key] ??= describeFieldIssue(
            issue.field as Parameters<typeof describeFieldIssue>[0],
            issue.code as Parameters<typeof describeFieldIssue>[1],
          );
      }
      setErrors(found);
      setProblem(rest ? { sentence } : null);
    } else {
      setProblem({ sentence });
      // Somebody queued an instruction, or the turn ended: look again.
      if (
        result.code === "IMPLEMENTER_SESSION_BUSY" ||
        result.code === "IMPLEMENTER_BRANCH_GONE"
      )
        await refresh();
    }
  }

  const tokens = facts.historyTokens;
  return (
    <section data-slot="continue" className="flex max-w-2xl flex-col gap-4">
      <h2 className="text-lg font-semibold">{CONTINUE_COPY.title}</h2>
      <p className="text-sm text-muted-foreground">
        {facts.sessionStatus === "running"
          ? CONTINUE_COPY.runningIntro
          : CONTINUE_COPY.intro}
      </p>
      {facts.discarded === null ? null : (
        <Alert variant="warning" data-slot="continue-discarded">
          <p className="font-semibold">{CONTINUE_COPY.discardedTitle}</p>
          <p>{describeDiscard(facts.discarded.reason)}</p>
          <p className="mt-2 text-sm">{CONTINUE_COPY.discardedInstruction}</p>
          <p className="text-sm break-words whitespace-pre-wrap">
            {facts.discarded.instruction}
          </p>
        </Alert>
      )}
      {facts.queued === null ? null : (
        <div
          data-slot="continue-queued"
          className="flex flex-col gap-2 rounded-md border p-4"
        >
          <p className="font-semibold">{CONTINUE_COPY.queuedTitle}</p>
          <p className="text-sm break-words whitespace-pre-wrap">
            {facts.queued.instruction}
          </p>
          <p className="text-sm text-muted-foreground">
            {facts.sessionStatus === "running"
              ? CONTINUE_COPY.queuedNote
              : CONTINUE_COPY.queuedStarting}
          </p>
        </div>
      )}
      {tokens === null ? null : (
        <p
          data-slot="continue-history"
          className="text-sm text-muted-foreground"
        >
          {CONTINUE_COPY.history(roundTokens(tokens))}.{" "}
          {CONTINUE_COPY.historyWarning}
        </p>
      )}
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => void submit(event)}
      >
        <fieldset disabled={pending || waiting} className="flex flex-col gap-6">
          <FormField
            name="instruction"
            label={CONTINUE_COPY.instruction}
            error={errors.instruction}
            aside={
              <span
                className={
                  instruction.length > INSTRUCTION_MAX_LENGTH
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {`${instruction.length.toLocaleString("en-US")} / ${INSTRUCTION_MAX_LENGTH.toLocaleString("en-US")}`}
              </span>
            }
          >
            {(control) => (
              <Textarea
                {...control}
                rows={6}
                placeholder={CONTINUE_COPY.instructionPlaceholder}
                value={instruction}
                onChange={(event) => {
                  setInstruction(event.target.value);
                  clear("instruction");
                }}
              />
            )}
          </FormField>
          <ModelPicker
            workspaceSlug={workspaceSlug}
            options={modelOptions}
            pick={shownPick}
            error={errors.model}
            loading={models.state === "loading"}
            onPick={(next) => {
              setModelPick(next);
              clear("model");
            }}
          />
          {models.state === "failed" ? (
            <LoadFailure
              sentence={describeImplementerFailure(product, {
                code: models.failure.code,
                status: models.failure.status,
              })}
              onRetry={reloadModels}
            />
          ) : (
            <p className="-mt-3 text-sm text-muted-foreground">
              {CONTINUE_COPY.modelHint}
            </p>
          )}
          <ModelSelect
            name="environment"
            label={CONTINUE_COPY.environment}
            value={environmentPick}
            options={environmentOptions}
            onChange={(id) => {
              setEnvironmentPick(id);
              clear("environment");
            }}
            error={errors.environment}
            disabled={environments.state === "loading"}
            placeholder={CONTINUE_COPY.environmentSame}
          />
          <p className="-mt-3 text-sm text-muted-foreground">
            {CONTINUE_COPY.environmentHint}
          </p>
          {environments.state === "failed" ? (
            <LoadFailure
              sentence={CONTINUE_COPY.environmentLoadFailed}
              onRetry={reloadEnvironments}
            />
          ) : null}
          {facts.defaults.profile === null ? null : (
            <p
              data-slot="continue-profile"
              className="text-sm text-muted-foreground"
            >
              {CONTINUE_COPY.profile(facts.defaults.profile)}
            </p>
          )}
          <FormField
            name="cost"
            label={CONTINUE_COPY.costLimit}
            hint={CONTINUE_COPY.costLimitHint}
            error={errors.cost}
          >
            {(control) => (
              <Input
                {...control}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                placeholder={costLimitPlaceholder(operatorMaximumCents)}
                value={shownCost}
                onChange={(event) => {
                  setCost(event.target.value);
                  clear("cost");
                }}
              />
            )}
          </FormField>
        </fieldset>
        {accepted === "queued" ? (
          <Alert variant="success" role="status">
            {CONTINUE_COPY.queuedAccepted}
          </Alert>
        ) : accepted !== null ? (
          <Alert variant="success" role="status">
            <Link
              href={runPath(accepted.runId)}
              className="font-semibold underline underline-offset-4"
            >
              {CONTINUE_COPY.startedLink}
            </Link>
          </Alert>
        ) : null}
        {problem === null ? null : (
          <div className="flex flex-col items-start gap-3">
            <Alert variant="destructive">{problem.sentence}</Alert>
            {problem.runId === undefined ? null : (
              <Link
                href={runPath(problem.runId)}
                className="font-semibold underline underline-offset-4"
              >
                {CONTINUE_COPY.openThatTask}
              </Link>
            )}
          </div>
        )}
        <div>
          <Button
            type="submit"
            disabled={waiting}
            loading={pending}
            loadingLabel={CONTINUE_COPY.sending}
          >
            {facts.sessionStatus === "running"
              ? CONTINUE_COPY.sendQueued
              : CONTINUE_COPY.send}
          </Button>
        </div>
      </form>
    </section>
  );
}

type FieldKey = "instruction" | "model" | "environment" | "cost";

const FIELD_OF_ISSUE: Partial<Record<string, FieldKey>> = {
  instruction: "instruction",
  model: "model",
  environmentId: "environment",
  costLimitCents: "cost",
};

/** A load that failed: its sentence, and a way to ask again. */
function LoadFailure({
  sentence,
  onRetry,
}: {
  sentence: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <Alert variant="destructive">{sentence}</Alert>
      <Button variant="secondary" onClick={onRetry}>
        {CONTINUE_COPY.tryAgain}
      </Button>
    </div>
  );
}
