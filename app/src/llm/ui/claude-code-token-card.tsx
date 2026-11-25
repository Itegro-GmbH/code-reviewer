// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The card "Claude Code OAuth token" next to the provider keys on the LLM keys page (#1150): set, replace, test and remove the token of the
// workspace that runs of the harness `claude-code` use. Write-only like the keys: the page shows whether one is saved (and its last four
// characters), an empty field keeps it, and the saved value never reaches the page. "Test token" checks the shape and says that it does
// not ask Anthropic. Anyone who manages the LLM keys of the workspace (an Admin or an Owner) can do all of it; a Member sees whether
// one is saved.
import { useProductIdentity } from "../../product-identity/context.tsx";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
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
import { Input } from "../../components/ui/input.tsx";
import { UNREADABLE_SECRET_CAUSE } from "../../secrets/messages.ts";
import type { ClaudeCodeTokenStatus } from "../claude-code-token.ts";
import {
  browserClaudeCodeTokenApi,
  type ClaudeCodeTokenApi,
} from "./claude-code-token-api.ts";
import {
  describeClaudeCodeTokenFailure,
  describeClaudeCodeTokenIssue,
} from "./claude-code-token-messages.ts";

export const CLAUDE_CODE_TOKEN_HOW_STORED =
  "Runs of the harness claude-code use this token as CLAUDE_CODE_OAUTH_TOKEN (make one with `claude setup-token`); Anthropic bills it to your Claude subscription, not to this factory. The token is stored encrypted on this server and is never shown again. It is handed to the run that needs it and to nobody else, but inside that run the agent can read it: Claude Code needs it there. On a self-hosted runner that has a Claude login of its own, the runner's login is used and this token is not sent. Everyone who may start a run of this workspace on the harness claude-code spends this subscription.";

type Outcome =
  | { kind: "saved"; changed: boolean }
  | { kind: "removed" }
  | { kind: "tested"; format: "known" | "unknown" }
  | { kind: "failed"; text: string; issues: Array<{ field: string; code: string }> }
  | null;

export function ClaudeCodeTokenCard({
  workspaceSlug,
  canManage,
  status,
  api = browserClaudeCodeTokenApi(workspaceSlug),
}: {
  workspaceSlug: string;
  /** An Admin or an Owner of the workspace (`manage_llm_key`). */
  canManage: boolean;
  status: ClaudeCodeTokenStatus;
  /** Only tests pass this. */
  api?: ClaudeCodeTokenApi;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const ids = useId();
  const [token, setToken] = useState("");
  const [pending, setPending] = useState<"save" | "test" | "remove" | null>(
    null,
  );
  const [outcome, setOutcome] = useState<Outcome>(null);
  const issue =
    outcome?.kind === "failed"
      ? outcome.issues.find((candidate) => candidate.field === "token")
      : undefined;

  async function save(event: FormEvent) {
    event.preventDefault();
    setOutcome(null);
    setPending("save");
    const result = await api.save(token);
    setPending(null);
    if (!result.ok) {
      setOutcome({
        kind: "failed",
        text: describeClaudeCodeTokenFailure(product, result.code),
        issues: result.issues,
      });
      return;
    }
    setToken("");
    setOutcome({ kind: "saved", changed: result.data.changed });
    router.refresh();
  }

  async function test() {
    setOutcome(null);
    setPending("test");
    const result = await api.test(token);
    setPending(null);
    if (!result.ok) {
      setOutcome({
        kind: "failed",
        text:
          result.code === "invalid_input" && result.issues[0] !== undefined
            ? describeClaudeCodeTokenIssue(result.issues[0].code)
            : describeClaudeCodeTokenFailure(product, result.code),
        issues: result.issues,
      });
      return;
    }
    setOutcome({ kind: "tested", format: result.data.format });
  }

  async function remove() {
    setOutcome(null);
    setPending("remove");
    const result = await api.remove();
    setPending(null);
    if (!result.ok) {
      setOutcome({
        kind: "failed",
        text: describeClaudeCodeTokenFailure(product, result.code),
        issues: [],
      });
      return;
    }
    setOutcome({ kind: "removed" });
    router.refresh();
  }

  const hint =
    status.state === "not_configured"
      ? "No token is saved."
      : status.state === "unreadable"
        ? "The saved token cannot be read; enter it again."
        : `A token is saved${status.lastFour === null ? "" : ` (ends in ${status.lastFour})`}.`;

  return (
    <Card role="region" aria-labelledby="claude-code-token-heading">
      <CardHeader>
        <CardTitle>
          <h2
            id="claude-code-token-heading"
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            Claude Code OAuth token
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <HelpDisclosure label="How the token is stored and used">
          {CLAUDE_CODE_TOKEN_HOW_STORED}
        </HelpDisclosure>
        {canManage ? (
          <form
            onSubmit={(event) => void save(event)}
            aria-label="Claude Code OAuth token"
            noValidate
            className="flex flex-col gap-4"
          >
            {status.state === "unreadable" ? (
              <Alert variant="destructive" role="status">
                <AlertDescription>
                  <strong>The saved token cannot be read.</strong>{" "}
                  {UNREADABLE_SECRET_CAUSE} Enter the token again and save.
                  Until then runs on the harness claude-code cannot use it.
                </AlertDescription>
              </Alert>
            ) : null}
            <Field data-invalid={issue !== undefined || undefined}>
              <FieldLabel htmlFor={`${ids}-token`}>Token</FieldLabel>
              <Input
                id={`${ids}-token`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder="sk-ant-oat01-…"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                aria-invalid={issue !== undefined}
                aria-describedby={`${ids}-token-hint${issue ? ` ${ids}-token-error` : ""}`}
              />
              <FieldDescription id={`${ids}-token-hint`}>
                {hint}
              </FieldDescription>
              {issue ? (
                <FieldError id={`${ids}-token-error`}>
                  {describeClaudeCodeTokenIssue(issue.code)}
                </FieldError>
              ) : null}
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                loading={pending === "save"}
                loadingLabel="Saving"
              >
                Save token
              </Button>
              <Button
                variant="secondary"
                loading={pending === "test"}
                loadingLabel="Testing"
                disabled={
                  pending !== null ||
                  (token.trim() === "" && status.state === "not_configured")
                }
                onClick={() => void test()}
              >
                Test token
              </Button>
              {status.state !== "not_configured" ? (
                <Button
                  variant="secondary"
                  loading={pending === "remove"}
                  loadingLabel="Removing"
                  disabled={pending !== null}
                  onClick={() => void remove()}
                >
                  Remove token
                </Button>
              ) : null}
            </div>
            <div role="status" aria-live="polite" aria-atomic="true">
              {outcome?.kind === "saved" ? (
                <p className="text-sm text-success">
                  {outcome.changed
                    ? "The token is saved."
                    : "The saved token is kept."}
                </p>
              ) : null}
              {outcome?.kind === "removed" ? (
                <p className="text-sm text-success">The token is removed.</p>
              ) : null}
              {outcome?.kind === "tested" ? (
                <p className="text-sm text-muted-foreground">
                  {outcome.format === "known"
                    ? "The token has the shape that `claude setup-token` prints."
                    : "The token is usable text, but not the shape that `claude setup-token` prints (sk-ant-oat01-…)."}{" "}
                  Only the shape was checked: nothing is sent to Anthropic.
                  Whether Anthropic accepts the token shows with the first run.
                </p>
              ) : null}
            </div>
            {outcome?.kind === "failed" ? (
              <Alert variant="destructive">
                <AlertDescription>{outcome.text}</AlertDescription>
              </Alert>
            ) : null}
          </form>
        ) : (
          <p>
            {status.state === "configured"
              ? "A Claude Code OAuth token is saved for this workspace."
              : status.state === "unreadable"
                ? "The saved Claude Code OAuth token cannot be read."
                : "No Claude Code OAuth token is saved."}{" "}
            Only an Admin or an Owner of the workspace can change it.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
