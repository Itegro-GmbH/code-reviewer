// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { currentLookup } from "@/auth/session";
import { loginPath } from "@/auth/session-user";
import { AuthCard } from "@/components/auth-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConsentForm } from "@/factory-mcp/ui/consent-form";
import { consentErrorCopy } from "@/factory-mcp/ui/messages";
import { getOAuthService } from "@/factory-mcp/shared";
import { requireImplementerCapability } from "@/implementer/shared";
import { getProductIdentity } from "@/product-identity/current";

export const metadata: Metadata = {
  title: "Connect an AI app",
  // The address carries a request id: it must not leak as a referrer.
  referrer: "no-referrer",
};

// The consent page of an AI app that wants to connect to the factory MCP (epic #1143, #1144). Behind the sign in like every page (the
// proxy sends a visitor to the login page; `/oauth/authorize` carries the request through it). The request id in the address is the only
// input; what is shown is read from the server's own record of the request, and the answer posts to /api/oauth/consent.
export default function ConsentPage({
  searchParams,
}: PageProps<"/oauth/consent">) {
  return (
    <Suspense
      fallback={
        <AuthCard product={getProductIdentity()} title="Connect an AI app" />
      }
    >
      <ConsentBoundary searchParams={searchParams} />
    </Suspense>
  );
}

async function ConsentBoundary({
  searchParams,
}: Pick<PageProps<"/oauth/consent">, "searchParams">) {
  // Reads the session and the database at request time (not when the page is built).
  await connection();
  requireImplementerCapability();
  const lookup = await currentLookup();
  if (lookup.kind !== "user") redirect(loginPath(lookup));
  const product = getProductIdentity();
  const { request, error } = await searchParams;
  const view =
    typeof request === "string"
      ? await getOAuthService().describeRequest(request, lookup.user.id)
      : null;
  const errorCopy = consentErrorCopy(typeof error === "string" ? error : null);
  if (view === null)
    return (
      <AuthCard product={product} title="Connect an AI app">
        <Alert variant="destructive">
          <AlertDescription>
            {consentErrorCopy("request_not_found")}
          </AlertDescription>
        </Alert>
      </AuthCard>
    );
  return (
    <AuthCard product={product} title={`Connect ${view.client.name}`}>
      {errorCopy === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{errorCopy}</AlertDescription>
        </Alert>
      )}
      <ConsentForm view={view} productName={product.name} />
    </AuthCard>
  );
}
