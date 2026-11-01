// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The instance settings of the portal (#181): the tenancy and the workspace limit as two cards of one
// form, with one explicit save named after what it saves ("Save settings") and the saved state
// inline next to each card. The tenancy copy is shared with the first-run wizard
// (`signup/ui/tenancy-copy.ts`); the rules are the server's (src/admin/tenancy.ts and
// src/admin/service.ts). A save sends only the settings that changed, runs all of them (a refusal of one
// card never drops the other change), shows each card's own result or error, and moves focus to the
// first invalid control (rulebook R20).
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import { cn } from "../../lib/utils";
import {
  TENANCY_OPTIONS,
  type TenancyKind,
} from "../../signup/ui/tenancy-copy.ts";
import type { AdminSettingsView } from "../service.ts";
import type { AdminApi, SettingChange } from "./api.ts";
import { useFocusFirstError } from "./focus-first-error.tsx";
import { LastChanged } from "./last-changed.tsx";
import { formatUsdFixed, parseUsd } from "./billing-money.ts";
import { describeAdminIssue } from "./messages.ts";
import { SaveResult, useSave, type SaveStatus } from "./use-save.tsx";

function isTenancy(value: string): value is TenancyKind {
  return value === "single" || value === "multi";
}

/** US dollars as typed ("1.50") to whole cents, or null when it is no amount of at most two decimals. */
function centsOfDollars(text: string): number | null {
  const micro = parseUsd(text);
  return micro !== null && micro % 10_000 === 0 ? micro / 10_000 : null;
}

/** Whole cents as the amount the field shows: 100 is "1.00". */
function dollarsOfCents(cents: number): string {
  return formatUsdFixed(cents * 10_000);
}

function workspaces(count: number): string {
  return `${String(count)} ${count === 1 ? "workspace" : "workspaces"}`;
}

export function InstanceForm({
  settings,
  api,
}: {
  settings: AdminSettingsView;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const ids = useId();
  const tenancyHeadingId = `${ids}-tenancy-heading`;
  const limitsHeadingId = `${ids}-limits-heading`;
  const dynamicHeadingId = `${ids}-dynamic-heading`;
  const planHeadingId = `${ids}-plan-heading`;
  const [tenancy, setTenancy] = useState<TenancyKind>(settings.tenancy.value);
  const [limitText, setLimitText] = useState(
    String(settings.maxWorkspacesPerUser.value),
  );
  const [tokenCapText, setTokenCapText] = useState(
    String(settings.ownKeyTokenCap.value),
  );
  const [maxCostText, setMaxCostText] = useState(
    dollarsOfCents(settings.reviewMaxCostCents.value),
  );
  const [dynamicEnabled, setDynamicEnabled] = useState(
    settings.dynamicReview.value,
  );
  const [planUrl, setPlanUrl] = useState(
    settings.planManagementUrl.value ?? "",
  );
  const [rolloutConfirmed, setRolloutConfirmed] = useState(false);
  const [dynamicRefusal, setDynamicRefusal] = useState(false);
  const [results, setResults] = useState<{
    tenancy: SaveStatus;
    limits: SaveStatus;
    dynamic: SaveStatus;
    plan: SaveStatus;
  }>({ tenancy: null, limits: null, dynamic: null, plan: null });
  const { pending, save } = useSave(api, settings.workspaceCount);
  const focusTargetRef = useFocusFirstError();

  /** The control of the Limits card the refusal is about. */
  function limitsFocusTarget(outcome: SaveStatus | undefined): string {
    const field =
      outcome?.kind === "failed" ? outcome.issues[0]?.field : undefined;
    if (field === "reviewMaxCostCents") return `${ids}-max-cost`;
    if (field === "ownKeyTokenCap") return `${ids}-token-cap`;
    return `${ids}-max`;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Only what changed is sent, so a save does not touch the other setting's "last changed".
    const wanted: Array<"tenancy" | "limits" | "dynamic" | "plan"> = [];
    const changes: SettingChange[] = [];
    if (tenancy !== settings.tenancy.value) {
      wanted.push("tenancy");
      changes.push({ tenancy });
    }
    if (limitText !== String(settings.maxWorkspacesPerUser.value)) {
      wanted.push("limits");
      changes.push({ limits: { maxWorkspacesPerUser: Number(limitText) } });
    }
    if (tokenCapText !== String(settings.ownKeyTokenCap.value)) {
      wanted.push("limits");
      changes.push({ ownKeyTokenCap: Number(tokenCapText) });
    }
    if (maxCostText !== dollarsOfCents(settings.reviewMaxCostCents.value)) {
      wanted.push("limits");
      changes.push({ reviewMaxCostCents: centsOfDollars(maxCostText) });
    }
    // Turning the gate on needs the operator's confirmation of the rollout order (contracts/README.md).
    const turningOn = dynamicEnabled && !settings.dynamicReview.value;
    const blocked = turningOn && !rolloutConfirmed;
    setDynamicRefusal(blocked);
    if (dynamicEnabled !== settings.dynamicReview.value && !blocked) {
      wanted.push("dynamic");
      changes.push({ dynamicReview: { enabled: dynamicEnabled } });
    }
    // An empty field removes the page: no button, no route.
    if (planUrl.trim() !== (settings.planManagementUrl.value ?? "")) {
      wanted.push("plan");
      changes.push({
        planManagementUrl: planUrl.trim() === "" ? null : planUrl.trim(),
      });
    }
    const outcomes = await save(...changes);
    const next: typeof results = {
      tenancy: null,
      limits: null,
      dynamic: null,
      plan: null,
    };
    wanted.forEach((key, index) => {
      const outcome = outcomes[index] ?? null;
      // Three settings share the Limits card: a refusal of one stays visible when a later one is saved.
      const earlier = next[key];
      if (earlier?.kind === "failed" && outcome?.kind === "failed")
        next[key] = {
          ...earlier,
          issues: [...earlier.issues, ...outcome.issues],
        };
      else if (earlier?.kind !== "failed") next[key] = outcome;
    });
    setResults(next);
    // The confirmation belongs to this save: the next time the gate is turned on it is asked again.
    const dynamicIndex = wanted.indexOf("dynamic");
    if (dynamicIndex !== -1 && outcomes[dynamicIndex]?.kind === "saved")
      setRolloutConfirmed(false);
    const failed = outcomes.findIndex((outcome) => outcome.kind === "failed");
    if (failed !== -1)
      focusTargetRef.current =
        wanted[failed] === "limits"
          ? limitsFocusTarget(outcomes[failed])
          : wanted[failed] === "dynamic"
            ? `${ids}-dynamic`
            : wanted[failed] === "plan"
              ? `${ids}-plan`
              : `${ids}-tenancy`;
    else if (blocked) focusTargetRef.current = `${ids}-rollout`;
  }

  const limitIssue =
    results.limits?.kind === "failed"
      ? results.limits.issues.find(
          (issue) => issue.field === "maxWorkspacesPerUser",
        )
      : undefined;

  const tokenCapIssue =
    results.limits?.kind === "failed"
      ? results.limits.issues.find((issue) => issue.field === "ownKeyTokenCap")
      : undefined;

  const maxCostIssue =
    results.limits?.kind === "failed"
      ? results.limits.issues.find(
          (issue) => issue.field === "reviewMaxCostCents",
        )
      : undefined;

  const planIssue =
    results.plan?.kind === "failed"
      ? results.plan.issues.find((issue) => issue.field === "planManagementUrl")
      : undefined;

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label="General settings"
      className="flex max-w-[44rem] flex-col gap-6"
    >
      <Card role="group" aria-labelledby={tenancyHeadingId}>
        <CardHeader>
          <CardTitle>
            <h2
              id={tenancyHeadingId}
              className="text-lg font-semibold tracking-tight"
            >
              Tenancy
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <RadioGroup
            id={`${ids}-tenancy`}
            value={tenancy}
            onValueChange={(value) => {
              if (isTenancy(value)) setTenancy(value);
            }}
            aria-label="Tenancy"
            className="gap-2"
          >
            {TENANCY_OPTIONS.map((option) => {
              const optionId = `${ids}-${option.value}`;
              const selected = option.value === tenancy;
              return (
                <Field
                  key={option.value}
                  className={cn(
                    "gap-1 rounded-lg border border-border bg-card p-4 transition-colors",
                    "hover:border-ring focus-within:ring-2 focus-within:ring-ring/50",
                    selected && "border-primary bg-accent",
                  )}
                >
                  <FieldLabel
                    htmlFor={optionId}
                    className="flex w-full cursor-pointer items-start gap-3"
                  >
                    <RadioGroupItem
                      value={option.value}
                      id={optionId}
                      className="mt-0.5"
                    />
                    <span className="font-medium text-foreground">
                      {option.title}
                    </span>
                  </FieldLabel>
                  <FieldDescription className="pl-7">
                    {option.text}
                  </FieldDescription>
                </Field>
              );
            })}
          </RadioGroup>
          <FieldDescription>
            There {settings.workspaceCount === 1 ? "is" : "are"}{" "}
            {workspaces(settings.workspaceCount)} now.
          </FieldDescription>
          <LastChanged setting={settings.tenancy} />
          <SaveResult status={results.tenancy} />
        </CardContent>
      </Card>

      <Card role="group" aria-labelledby={limitsHeadingId}>
        <CardHeader>
          <CardTitle>
            <h2
              id={limitsHeadingId}
              className="text-lg font-semibold tracking-tight"
            >
              Limits
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${ids}-max`}>
              Maximum number of workspaces one user may own
            </FieldLabel>
            <Input
              id={`${ids}-max`}
              inputMode="numeric"
              value={limitText}
              onChange={(event) => setLimitText(event.target.value)}
              aria-invalid={limitIssue !== undefined}
              aria-describedby={`${ids}-max-hint`}
            />
            <FieldDescription id={`${ids}-max-hint`}>
              The default is 10. It limits the workspaces a user creates in a
              multi-tenant setup.
            </FieldDescription>
            {limitIssue ? (
              <FieldError>{describeAdminIssue(limitIssue)}</FieldError>
            ) : null}
          </Field>
          <LastChanged setting={settings.maxWorkspacesPerUser} />
          <Field>
            <FieldLabel htmlFor={`${ids}-token-cap`}>
              Token limit for a run on a workspace&apos;s own key
            </FieldLabel>
            <Input
              id={`${ids}-token-cap`}
              inputMode="numeric"
              value={tokenCapText}
              onChange={(event) => setTokenCapText(event.target.value)}
              aria-invalid={tokenCapIssue !== undefined}
              aria-describedby={`${ids}-token-cap-hint`}
            />
            <FieldDescription id={`${ids}-token-cap-hint`}>
              The default is 4,000,000 tokens. It bounds a Dynamic run on a
              workspace&apos;s own key when the price of its model is not known,
              so the dollar limit cannot apply. Between 100,000 and 100,000,000.
            </FieldDescription>
            {tokenCapIssue ? (
              <FieldError>{describeAdminIssue(tokenCapIssue)}</FieldError>
            ) : null}
          </Field>
          <LastChanged setting={settings.ownKeyTokenCap} />
          <Field>
            <FieldLabel htmlFor={`${ids}-max-cost`}>
              Maximum cost per review (USD)
            </FieldLabel>
            <Input
              id={`${ids}-max-cost`}
              inputMode="decimal"
              value={maxCostText}
              onChange={(event) => setMaxCostText(event.target.value)}
              aria-invalid={maxCostIssue !== undefined}
              aria-describedby={`${ids}-max-cost-hint`}
            />
            <FieldDescription id={`${ids}-max-cost-hint`}>
              The default is $1.00. The most one review may cost, for Diff and
              Dynamic Review alike. Customers see it as the maximum for their
              own cost limit and cannot save a higher one; a limit they saved
              earlier that is above it is cut to it. A review that reaches it is
              stopped and bills what its model requests really cost. Between
              $0.01 and $100.00.
            </FieldDescription>
            {maxCostIssue ? (
              <FieldError>{describeAdminIssue(maxCostIssue)}</FieldError>
            ) : null}
          </Field>
          <LastChanged setting={settings.reviewMaxCostCents} />
          <SaveResult status={results.limits} />
        </CardContent>
      </Card>

      <Card role="group" aria-labelledby={dynamicHeadingId}>
        <CardHeader>
          <CardTitle>
            <h2
              id={dynamicHeadingId}
              className="text-lg font-semibold tracking-tight"
            >
              Dynamic Review
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <span className="flex items-start gap-2">
              <Checkbox
                id={`${ids}-dynamic`}
                checked={dynamicEnabled}
                onCheckedChange={(checked) =>
                  setDynamicEnabled(checked === true)
                }
                aria-describedby={`${ids}-dynamic-hint`}
              />
              <Label htmlFor={`${ids}-dynamic`} className="font-normal">
                Allow Dynamic Review
              </Label>
            </span>
            <FieldDescription id={`${ids}-dynamic-hint`}>
              Off by default. While it is off, a project set to Dynamic Review
              gets a failed run with the code{" "}
              <code>dynamic_review_disabled</code>, never a Diff review. While
              it is on, those runs are queued and wait for a runner that can run
              it; one is cancelled with <code>no_capable_runner</code> once 30
              minutes pass without a runner running or finishing a Dynamic
              review, and in any case after 3 hours. Turning it off cancels the
              waiting runs and leaves the running ones to finish. Deploy a
              Dynamic-capable runner before turning it on; without one, those
              runs only wait and are then cancelled.
            </FieldDescription>
          </Field>
          {dynamicEnabled && !settings.dynamicReview.value ? (
            <Field>
              <span className="flex items-start gap-2">
                <Checkbox
                  id={`${ids}-rollout`}
                  checked={rolloutConfirmed}
                  onCheckedChange={(checked) =>
                    setRolloutConfirmed(checked === true)
                  }
                  aria-invalid={dynamicRefusal}
                />
                <Label htmlFor={`${ids}-rollout`} className="font-normal">
                  Every running copy of the app already runs the version that
                  supports Dynamic Review
                </Label>
              </span>
              <FieldDescription>
                A previous-release app on the same database could hand a Dynamic
                job to a runner as a Diff job. The order is in
                contracts/README.md, section &quot;Rolling out Dynamic
                Review&quot;.
              </FieldDescription>
              {dynamicRefusal ? (
                <span role="alert" className="text-sm text-destructive">
                  Confirm the rollout order before turning Dynamic Review on.
                </span>
              ) : null}
            </Field>
          ) : null}
          <LastChanged setting={settings.dynamicReview} />
          <SaveResult status={results.dynamic} />
        </CardContent>
      </Card>

      <Card role="group" aria-labelledby={planHeadingId}>
        <CardHeader>
          <CardTitle>
            <h2
              id={planHeadingId}
              className="text-lg font-semibold tracking-tight"
            >
              Plan management page
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${ids}-plan`}>Address of the page</FieldLabel>
            <Input
              id={`${ids}-plan`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://"
              value={planUrl}
              onChange={(event) => setPlanUrl(event.target.value)}
              aria-invalid={planIssue !== undefined}
              aria-describedby={`${ids}-plan-hint`}
            />
            <FieldDescription id={`${ids}-plan-hint`}>
              An operator-configured page where the Owners and Admins of a
              workspace manage its plan. While this is empty there is no
              &quot;Manage plan&quot; button. It has to be an absolute https
              address, without a user name, a password or a #fragment. The
              person who clicks the button arrives there with a token that is
              valid for five minutes and works once; the page redeems it through
              the operator API. Upgrade every running copy of the app before you
              set it.
            </FieldDescription>
            {planIssue ? (
              <FieldError>{describeAdminIssue(planIssue)}</FieldError>
            ) : null}
          </Field>
          <LastChanged setting={settings.planManagementUrl} />
          <SaveResult status={results.plan} />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} loadingLabel="Saving">
          Save settings
        </Button>
      </div>
    </form>
  );
}
