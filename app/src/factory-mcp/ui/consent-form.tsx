// SPDX-License-Identifier: LicenseRef-Proprietary

// The consent page of an AI app that wants to connect (#1144): which app, where its code goes, and two choices that are the person's:
// the workspace (one) and what the app may do (read, or read and control). Approve and Deny are two submit buttons of one form that posts
// to `/api/oauth/consent`; it needs no script. The words come from `messages.ts`; the page shows no text that an answer carried.
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { ROLE_LABEL } from "@/workspaces/ui/role-copy";
import type { ConsentView } from "../oauth/service.ts";
import { OAUTH_PATHS } from "../oauth/paths.ts";
import { SCOPE_DESCRIPTIONS, SCOPE_LABEL } from "./messages.ts";

const OPTION_CLASS =
  "flex items-start gap-3 rounded-md border border-border p-3 has-[:checked]:bg-muted";

export function ConsentForm({
  view,
  productName,
}: {
  view: ConsentView;
  productName: string;
}) {
  const defaultScope = view.allowedScopes.includes("factory:read")
    ? "factory:read"
    : view.allowedScopes[0];
  return (
    <form
      method="post"
      action={OAUTH_PATHS.consentSubmit}
      aria-label="Connect an AI app"
      className="flex flex-col gap-6"
    >
      <input type="hidden" name="request" value={view.requestId} />
      <p>
        <strong>{view.client.name}</strong> asks to work in {productName} for
        you. If you approve, it is sent back to{" "}
        <strong>{view.redirectTarget}</strong>.
      </p>
      <Alert>
        <AlertDescription>
          Approve only if you started this from that app. You can end the
          connection later in the workspace settings.
        </AlertDescription>
      </Alert>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Workspace</legend>
        {view.workspaces.map((workspace, index) => (
          <label key={workspace.id} className={OPTION_CLASS}>
            <input
              type="radio"
              name="workspace"
              value={workspace.id}
              defaultChecked={index === 0}
              required
            />
            <span className="flex flex-col">
              <span>{workspace.name}</span>
              <span className="text-sm text-muted-foreground">
                Your role: {ROLE_LABEL[workspace.role]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">What it may do</legend>
        {view.allowedScopes.map((scope) => (
          <label key={scope} className={OPTION_CLASS}>
            <input
              type="radio"
              name="scope"
              value={scope}
              defaultChecked={scope === defaultScope}
              required
            />
            <span className="flex flex-col">
              <span>{SCOPE_LABEL[scope]}</span>
              <span className="text-sm text-muted-foreground">
                {SCOPE_DESCRIPTIONS[scope]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <Field orientation="horizontal">
        <FieldLabel className="sr-only">Answer</FieldLabel>
        <Button type="submit" name="decision" value="approve">
          Approve
        </Button>
        <Button
          type="submit"
          name="decision"
          value="deny"
          variant="secondary"
          formNoValidate
        >
          Deny
        </Button>
      </Field>
    </form>
  );
}
