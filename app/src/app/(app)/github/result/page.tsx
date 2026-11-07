// SPDX-License-Identifier: LicenseRef-Proprietary

import { getProductIdentity } from "@/product-identity/current";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { getCapabilities } from "@/capabilities/shared";
import { currentLookup } from "@/auth/session";
import { loginPath } from "@/auth/session-user";
import { Button } from "@/components/button";
import { PageHeader } from "@/components/page-header";
import { isBindingResultCode } from "@/installation-binding/errors";
import { describeResultCode } from "@/installation-binding/ui/messages";
import { ResultBanner } from "@/installation-binding/ui/result-banner";
import { loadAccountView } from "@/workspaces/account-view";
import { connectionsPlace, workspacePath } from "@/workspaces/paths";

export const metadata: Metadata = { title: "Connections" };

// Where a flow of "Connect GitHub" ends when no workspace the person administers can be named (a state that
// has expired, a person who is not an Owner or Admin any more): the reason in words, and the way back to the
// Connections page. The code in the query is one of our own list; anything else says nothing.
export default async function GithubResultPage({
  searchParams,
}: PageProps<"/github/result">) {
  const { github } = await searchParams;
  const result =
    typeof github === "string" && isBindingResultCode(github)
      ? describeResultCode(getProductIdentity(), github)
      : null;
  const connectionsHref = await connectionsPath();
  return (
    <>
      <PageHeader
        title="Connections"
        actions={
          <Button asChild>
            <Link href={connectionsHref}>Back to Connections</Link>
          </Button>
        }
      />
      <ResultBanner result={result} />
    </>
  );
}

/**
 * The Connections page of the first workspace of the person, or the page that says what to do when they have
 * none. The flow that landed here was started in a workspace, but the request no longer names one.
 */
async function connectionsPath(): Promise<string> {
  await connection();
  const lookup = await currentLookup();
  if (lookup.kind !== "user" && lookup.kind !== "no_workspace")
    return loginPath(lookup);
  const view = await loadAccountView(lookup.user.id);
  const [first] = view.memberships;
  return first === undefined
    ? "/no-access"
    : `${workspacePath(first.workspace.slug)}${connectionsPlace(getCapabilities())}`;
}
