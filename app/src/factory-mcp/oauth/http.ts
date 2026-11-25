// SPDX-License-Identifier: LicenseRef-Proprietary

// The HTTP shapes of the OAuth server of the factory MCP: discovery documents, dynamic client registration, the authorization request, the
// consent answer, the token endpoint and revocation. The decisions are in `service.ts`; this module reads the request (size, content
// type, parameters), calls it and writes the answer the RFCs prescribe. Collaborators are passed in so the route files wire the real ones
// and tests wire fakes.
//
// - Discovery, registration, token and revocation are public and called by programs from anywhere, so they answer CORS for any origin
//   without credentials (no cookie is ever read there).
// - The authorization request is a browser navigation: an invalid client or redirect URI is an error page (never a redirect), anything else
//   goes back to the client, and a valid request goes on to the consent page, through the sign in when the person has no session.
// - The consent answer is a form post of the signed in person: same origin only, and the request id in it is the one the page was made for.
import type { SessionUser } from "../../auth/access-policy.ts";
import { isCrossSite, isJsonRequest } from "../../http/request-checks.ts";
import { readLimitedBody } from "../../webhooks/limited-body.ts";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "./metadata.ts";
import { OAUTH_PATHS, OAUTH_RETURN_PARAM, consentPath } from "./paths.ts";
import type { OAuthService } from "./service.ts";

export const BODY_MAX_BYTES = 16 * 1024;

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

export type OAuthHttpDependencies = {
  service: OAuthService;
  baseUrl: string;
  /** Whether one more registration is allowed now (a counter shared by the whole instance); false answers 429. */
  allowRegistration: () => Promise<boolean>;
  /** Whether the request comes with a session that may use the app; `null` sends the person to the sign in. */
  currentUser: () => Promise<SessionUser | null>;
};

export type OAuthHandlers = ReturnType<typeof createOAuthHandlers>;

function json(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { ...NO_STORE, ...CORS, ...extra },
  });
}

function oauthError(
  status: number,
  error: string,
  description: string,
  extra: Record<string, string> = {},
): Response {
  return json({ error, error_description: description }, status, extra);
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The page of an authorization request that cannot be answered to the client: it says what is wrong, and goes nowhere. */
function errorPage(title: string, message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  return new Response(html, {
    status: 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) return null;
  const body = await readLimitedBody(request, BODY_MAX_BYTES);
  return body.ok ? new URLSearchParams(body.text) : null;
}

export function createOAuthHandlers({
  service,
  baseUrl,
  allowRegistration,
  currentUser,
}: OAuthHttpDependencies) {
  return {
    /** OPTIONS for the public endpoints. */
    preflight(): Response {
      return new Response(null, { status: 204, headers: CORS });
    },

    protectedResource(): Response {
      return json(protectedResourceMetadata(baseUrl), 200, {
        "cache-control": "public, max-age=300",
      });
    },

    authorizationServer(): Response {
      return json(authorizationServerMetadata(baseUrl), 200, {
        "cache-control": "public, max-age=300",
      });
    },

    /** POST /api/oauth/register (RFC 7591). */
    async register(request: Request): Promise<Response> {
      if (!isJsonRequest(request))
        return oauthError(
          400,
          "invalid_client_metadata",
          "The body must be application/json.",
        );
      const body = await readLimitedBody(request, BODY_MAX_BYTES);
      if (!body.ok)
        return oauthError(
          400,
          "invalid_client_metadata",
          "The body is too large.",
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        return oauthError(
          400,
          "invalid_client_metadata",
          "The body is not valid JSON.",
        );
      }
      if (!(await allowRegistration()))
        return oauthError(
          429,
          "temporarily_unavailable",
          "Too many registrations; try again later.",
          { "retry-after": "600" },
        );
      const outcome = await service.registerClient(parsed);
      if (outcome.kind === "ok") return json(outcome.response, 201);
      return oauthError(
        outcome.error === "temporarily_unavailable" ? 503 : 400,
        outcome.error,
        outcome.description,
      );
    },

    /** GET /oauth/authorize: a browser navigation. */
    async authorize(request: Request): Promise<Response> {
      const outcome = await service.beginAuthorization(
        new URL(request.url).searchParams,
      );
      if (outcome.kind === "page_error")
        return errorPage("Cannot connect this app", outcome.description);
      if (outcome.kind === "redirect_error")
        return redirect(outcome.redirectTo);
      const user = await currentUser();
      const target =
        user === null
          ? `/login?${OAUTH_RETURN_PARAM}=${encodeURIComponent(outcome.requestId)}`
          : consentPath(outcome.requestId);
      return redirect(target);
    },

    /** POST /api/oauth/consent: the person's answer. */
    async consent(request: Request, user: SessionUser): Promise<Response> {
      if (isCrossSite(request))
        return new Response("The request does not come from this site.", {
          status: 403,
          headers: { "cache-control": "no-store" },
        });
      const form = await readForm(request);
      if (form === null)
        return new Response("Bad request.", {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      const requestId = form.get("request") ?? "";
      const decision = form.get("decision");
      if (decision !== "approve" && decision !== "deny")
        return new Response("Bad request.", {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      const outcome = await service.decide({
        requestId,
        userId: user.id,
        decision,
        workspaceId: form.get("workspace") ?? undefined,
        scope: form.get("scope") ?? undefined,
      });
      if (outcome.kind === "redirect") return redirect(outcome.redirectTo);
      // Back to the page with a code it can explain; a request that is gone has nothing to come back to.
      return redirect(
        outcome.code === "request_not_found"
          ? `${OAUTH_PATHS.consent}?error=request_not_found`
          : `${consentPath(requestId)}&error=${outcome.code}`,
      );
    },

    /** POST /api/oauth/token. */
    async token(request: Request): Promise<Response> {
      const form = await readForm(request);
      if (form === null)
        return oauthError(
          400,
          "invalid_request",
          "The body must be application/x-www-form-urlencoded and small.",
        );
      const outcome = await service.exchange(form);
      if (outcome.kind === "ok") return json(outcome.body);
      return oauthError(400, outcome.error, outcome.description);
    },

    /** POST /api/oauth/revoke (RFC 7009). */
    async revoke(request: Request): Promise<Response> {
      const form = await readForm(request);
      if (form === null)
        return oauthError(
          400,
          "invalid_request",
          "The body must be application/x-www-form-urlencoded and small.",
        );
      const token = form.get("token");
      if (token === null || token === "")
        return oauthError(400, "invalid_request", "token is required.");
      await service.revoke(token);
      return json({}, 200);
    },
  };
}

/** A redirect that keeps the address as given (it may be an app's own scheme, which `Response.redirect` refuses). */
function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
