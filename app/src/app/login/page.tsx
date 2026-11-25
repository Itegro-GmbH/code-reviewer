// SPDX-License-Identifier: LicenseRef-Proprietary

// The sign-in page: the action is the h1, the ways to sign in each get their own named form, and a
// sign-in error sits directly above the fields of the form it concerns (#170). What is on (the ways to
// sign in, the sign-up rule, whether mail can be sent) is the state of the instance, read at request
// time behind a boundary. The invitation link the person came from is carried through the forms.
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { signInWithGithub, signInWithPassword } from "@/auth/actions";
import { invitationTokenOf, pathCarrying } from "@/auth/invitation-return";
import { oauthRequestIdOf } from "@/auth/oauth-return";
import { loginErrorMessage } from "@/auth/login-errors";
import { passwordResetAvailable } from "@/auth/password-reset-request";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { signUpAvailability } from "@/signup/availability";
import { getSignUpFacts } from "@/signup/shared";
import { getProductIdentity } from "@/product-identity/current";

/** What the login page draws, gathered from the state of the instance and the `?error=` code. */
export type LoginPageData = {
  /** The invitation link the person came from, or null. */
  invitation: string | null;
  /** The pending authorization request of an AI app (the factory MCP, #1144) the person came from, or null. */
  oauth: string | null;
  /** Whether email and password sign-in is on. */
  emailPassword: boolean;
  /** Whether the sign-in with GitHub is on. */
  github: boolean;
  /** Whether the sign-up is open (offer the link to it). */
  signUpOpen: boolean;
  /** Whether a password reset by mail is offered (offer the link to it). */
  canReset: boolean;
  /** The sentence of a failed sign in, or null. */
  error: string | null;
};

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <Suspense
      fallback={<AuthCard product={getProductIdentity()} title="Sign in" />}
    >
      <LoginBoundary searchParams={searchParams} />
    </Suspense>
  );
}

async function LoginBoundary({
  searchParams,
}: Pick<PageProps<"/login">, "searchParams">) {
  // Reads the database and the environment at request time (not when the page is built).
  await connection();
  return <LoginPageContent data={await loadLoginPage(searchParams)} />;
}

/** The state of the page, read at request time. */
export async function loadLoginPage(
  searchParams: PageProps<"/login">["searchParams"],
): Promise<LoginPageData> {
  const {
    invitation: rawInvitation,
    oauth: rawOauth,
    error: rawError,
  } = await searchParams;
  const invitation = invitationTokenOf(rawInvitation);
  const oauth = oauthRequestIdOf(rawOauth);
  // The state of the instance, read once: the ways to sign in that are on, the sign-up rule, whether mail
  // can be sent.
  const facts = await getSignUpFacts();
  const methods = facts.signInMethods;
  // The link to the sign-up is offered while the sign-up is open; the link to the reset while mail can be
  // sent and email with password sign-in is on.
  const signUp = methods.emailPassword
    ? signUpAvailability(facts)
    : { open: false as const };
  return {
    invitation,
    oauth,
    emailPassword: methods.emailPassword,
    github: methods.github,
    signUpOpen: signUp.open,
    canReset: passwordResetAvailable(facts),
    error: loginErrorMessage(
      getProductIdentity(),
      typeof rawError === "string" ? rawError : undefined,
    ),
  };
}

export function LoginPageContent({ data }: { data: LoginPageData }) {
  // The id ties the error to the fields it concerns through `aria-describedby`.
  const errorId = "login-error";
  const errorAlert =
    data.error === null ? null : (
      <Alert id={errorId} variant="destructive">
        <AlertDescription>{data.error}</AlertDescription>
      </Alert>
    );
  return (
    <AuthCard product={getProductIdentity()} title="Sign in">
      {data.emailPassword ? (
        <form
          action={signInWithPassword}
          aria-label="Sign in with email"
          className="flex flex-col gap-4"
        >
          {errorAlert}
          <Field>
            <FieldLabel htmlFor="login-email">Email address</FieldLabel>
            <Input
              id="login-email"
              name="email"
              type="email"
              autoComplete="username"
              required
              aria-describedby={data.error === null ? undefined : errorId}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="login-password">Password</FieldLabel>
            <Input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              aria-describedby={data.error === null ? undefined : errorId}
            />
          </Field>
          {data.invitation === null ? null : (
            <input type="hidden" name="invitation" value={data.invitation} />
          )}
          {data.oauth === null ? null : (
            <input type="hidden" name="oauth" value={data.oauth} />
          )}
          <Button type="submit">Sign in</Button>
          {data.canReset ? (
            <p className="text-sm text-muted-foreground">
              <Link
                className="underline underline-offset-4"
                href="/forgot-password"
              >
                Forgot your password?
              </Link>
            </p>
          ) : null}
        </form>
      ) : null}
      {/* Without the email form (GitHub only, an unusual instance) the error has no fields to sit above. */}
      {data.emailPassword ? null : errorAlert}
      {data.emailPassword && data.github ? (
        <FieldSeparator>or</FieldSeparator>
      ) : null}
      {data.github ? (
        <form
          action={signInWithGithub}
          aria-label="Sign in with GitHub"
          className="flex flex-col gap-4"
        >
          {data.invitation === null ? null : (
            <input type="hidden" name="invitation" value={data.invitation} />
          )}
          {data.oauth === null ? null : (
            <input type="hidden" name="oauth" value={data.oauth} />
          )}
          <Button type="submit" variant="secondary">
            Sign in with GitHub
          </Button>
        </form>
      ) : null}
      {/* The sign-up link is not a way to sign in: it follows the two methods, after the "or" that joins them. */}
      {data.signUpOpen ? (
        <p className="text-sm text-muted-foreground">
          No account yet?{" "}
          <Link
            className="underline underline-offset-4"
            href={pathCarrying("/sign-up", data.invitation)}
          >
            Create one
          </Link>
          .
        </p>
      ) : null}
    </AuthCard>
  );
}
