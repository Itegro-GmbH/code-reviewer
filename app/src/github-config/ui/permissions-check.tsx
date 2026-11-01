// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// What an App that was imported or made by hand may lack: the repository permission "Checks" (the check run of
// a review, #405), the account permission "Email addresses" (the verified primary email of a GitHub sign in) and
// the organization permission "Members" (a person's role when an installation is bound to a workspace), and, in a deployment
// with the Implementer, Contents as read and write (#749). The list is always shown; the button asks GitHub which of
// them this App really lacks. It sits behind the "Permissions GitHub granted" disclosure of the page.
import { useState } from "react";
import { useCapabilities } from "../../capabilities/context.tsx";
import { Button } from "../../components/button.tsx";
import { ProductName } from "../../components/brand.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { browserGithubApi, type GithubApi } from "./api.ts";
import { describeGithubFailure, permissionLabels } from "./messages.ts";
import type { ProductIdentity } from "@/product-identity/identity.ts";

type Outcome =
  | { kind: "missing"; missing: string[] }
  | { kind: "failed"; text: string }
  | null;

export function PermissionsCheck({
  product,
  api = browserGithubApi,
}: {
  /** The product the App is for: the sentence names it. */
  product: ProductIdentity;
  /** Only tests pass this. */
  api?: GithubApi;
}) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const capabilities = useCapabilities();
  const labels = permissionLabels(capabilities);
  // Only a deployment with the Implementer asks for Contents as write (#749): code-review.com lists nothing of it.
  const listed = [
    ...(capabilities.has("implementer") ? ["contents"] : []),
    "checks",
    "emails",
    "members",
  ];

  async function check() {
    setPending(true);
    setOutcome(null);
    const result = await api.check();
    setPending(false);
    setOutcome(
      result.ok
        ? { kind: "missing", missing: result.data.missing }
        : { kind: "failed", text: describeGithubFailure(product, result.code) },
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-2">
      <p className="text-sm text-muted-foreground">
        An App that was imported or made by hand may lack permissions that the
        one-click flow asks for. Without Checks, reviews run as before but the
        pull request shows no check run
        {capabilities.has("implementer")
          ? ", and without write access to Contents the Implementer cannot push a branch"
          : ""}
        . Add them in the App&apos;s settings on GitHub (Permissions &amp;
        events), then accept the changed permissions on each installation when
        GitHub asks:
      </p>
      <ul className="list-disc pl-5 text-sm text-muted-foreground">
        {listed.map((name) => (
          <li key={name}>{labels[name]}</li>
        ))}
      </ul>
      <div>
        <Button
          loading={pending}
          loadingLabel="Asking GitHub"
          onClick={() => void check()}
        >
          Check the permissions
        </Button>
      </div>
      <div role="status" aria-live="polite">
        {outcome?.kind === "missing" && outcome.missing.length === 0 ? (
          <Alert variant="success" role="status">
            <AlertDescription>
              The App has every permission <ProductName product={product} />{" "}
              asks for.
            </AlertDescription>
          </Alert>
        ) : null}
        {outcome?.kind === "missing" && outcome.missing.length > 0 ? (
          <Alert variant="warning" role="status">
            <AlertDescription>
              <p>The App lacks:</p>
              <ul className="list-disc pl-5">
                {outcome.missing.map((name) => (
                  <li key={name}>{labels[name] ?? name}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {outcome?.kind === "failed" ? (
          <Alert variant="destructive" role="status">
            <AlertDescription>{outcome.text}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
