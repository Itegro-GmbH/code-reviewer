// SPDX-License-Identifier: LicenseRef-Proprietary

// The admin portal assembled for integration tests: an instance set up through the real first-run setup
// (so the instance admin is made by the same code as in production), the real Better Auth, the setup
// gate and the access proxy in front, the real admin data routes behind them, and the real settings
// service and secret store over a real Postgres database. Requests are real `Request` objects with cookies, the
// way a browser sends them; nothing listens on a port.
import { createCapabilitySet } from "../capabilities/capability.ts";
import { PRODUCTS } from "../capabilities/products.ts";
import { SECRET_NAMES } from "../admin/secret-names.ts";
import { STRIPE_SECRET_NAMES } from "../secret-names/names.ts";
import { WORKSPACE_LLM_KEY_NAMES } from "../llm/secret-names.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { NextRequest } from "next/server";
import { adminAccessOf } from "../admin/access.ts";
import {
  MISSING_PATH,
  PORTAL_DENIED_HEADER,
  isAdminPath,
  portalRewriteTarget,
} from "../admin/paths.ts";
import { PORTAL_REWRITE_HEADER } from "../auth/access-proxy.ts";
import { createAdminRouteHandlers } from "../admin/http.ts";
import { createApprovalRouteHandlers } from "../installation-binding/approvals-http.ts";
import { createAdminService } from "../admin/service.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createSmtpConfigStore } from "../mail/smtp-config.ts";
import type { SmtpTimeouts } from "../mail/smtp-delivery.ts";
import { createTestMailService } from "../mail/test-mail.ts";
import { createOperatorKeyTestService } from "../llm/operator-key-test.ts";
import { createSecretStore } from "../secrets/store.ts";
import type { FakeGithub } from "../../../fakes/github/server.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createModelCapabilityChecker } from "../llm/model-capabilities.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { createCatalogAdminService } from "../model-catalog/admin-service.ts";
import { createCatalogRouteHandlers } from "../model-catalog/admin-http.ts";
import { createModelPriceRouteHandlers } from "../model-prices/admin-http.ts";
import { createModelsDevRouteHandlers } from "../models-dev/admin-http.ts";
import { createModelsDevAdminService } from "../models-dev/admin-service.ts";
import type { RefreshOptions, RefreshOutcome } from "../models-dev/service.ts";
import { createModelPriceService } from "../model-prices/service.ts";
import { createCatalogService } from "../model-catalog/service.ts";
import { createBillingCreditService } from "../billing/admin-credit-service.ts";
import { createBillingRouteHandlers } from "../billing/admin-http.ts";
import { createBillingAdminService } from "../billing/admin-service.ts";
import {
  createBillingReviewService,
  type ReviewCheck,
} from "../billing/admin-review-service.ts";
import { createStripeClient } from "../billing/stripe-client.ts";
import type { StripeFake } from "../../../fakes/stripe/server.ts";
import { createGithubCredentialStore } from "../github-config/credentials.ts";
import { createGithubRouteHandlers } from "../github-config/http.ts";
import { createGithubConfigService } from "../github-config/service.ts";
import { createSignedStates } from "../signed-state/state.ts";
import { TEST_APP_SLUG } from "./github-app.ts";
import { startTestGithub } from "./github-fake.ts";
import { lookupSession } from "../auth/session-user.ts";
import { cookieHeader, remember, type CookieJar } from "./auth-harness.ts";
import {
  createSetupHarness,
  SETUP_TEST_ADMIN,
  SETUP_TEST_CODE,
  SETUP_TEST_BASE_URL,
  SETUP_TEST_SECRET,
  WIZARD_BODY,
} from "./setup-harness.ts";
import { getProductIdentity } from "../product-identity/current.ts";

export const ADMIN_TEST_BASE_URL = SETUP_TEST_BASE_URL;
export { SETUP_TEST_ADMIN as ADMIN_TEST_CREDENTIALS };

/** What `notFound()` of Next.js throws: the handlers call it for a person who is not an admin. */
export class NotFoundSignal extends Error {
  readonly digest = "NEXT_HTTP_ERROR_FALLBACK;404";
  constructor() {
    super("NEXT_HTTP_ERROR_FALLBACK;404");
  }
}

/** Marks the answer of a path that is no route of the app (the stand-in for Next.js's own 404). */
export const MISSING_ANSWER_MARKER = "x-answer-of-a-missing-path";

export type AdminHarnessOptions = {
  githubConfigured?: boolean;
  mailConfigured?: boolean;
  /** The fake GitHub the GitHub routes talk to. Default: one is started the first time a GitHub route is used. */
  github?: FakeGithub;
  /** The fake LLM the Test button of the operator's keys talks to. Default: an address where nothing answers. */
  llm?: { baseUrl: string };
  /** The fake Stripe the billing page talks to (#504). Default: an address where nothing answers. */
  stripe?: StripeFake;
  /** The public address of the app, where Stripe is told to post its events (`BETTER_AUTH_URL`). Default: a public https one. */
  billingPublicUrl?: string;
  /** The key sent to Stripe is kept off a fake that expects another: the client of the fake is made over this fetch. */
  stripeFetch?: typeof fetch;
  /** What "Check payment" of a billing review row asks (#603). Default: no adapter that can look a payment up. */
  reviewCheck?: ReviewCheck | undefined;
};

/** Short waits, so a test of a mail server that never answers does not take half a minute. */
export const ADMIN_TEST_SMTP_TIMEOUTS: SmtpTimeouts = {
  connectionMs: 1_500,
  greetingMs: 400,
  socketMs: 1_500,
  totalMs: 3_000,
};

export async function createAdminHarness(options: AdminHarnessOptions = {}) {
  const setup = await createSetupHarness();
  const { db, auth } = setup;

  // The instance is set up the way an operator does it: the code, then the wizard.
  await setup.start();
  const { cookies: setupCookies } = await setup.submitCode(SETUP_TEST_CODE);
  const completed = await setup.complete(setupCookies, WIZARD_BODY);
  if (completed.status !== 200)
    throw new Error(`The setup did not complete: ${completed.status}`);

  setup.gateState.mail = options.mailConfigured ?? false;
  const flags = {
    github: options.githubConfigured ?? false,
    /** Whether the instance can send mail; the access gates in front of the app read the same flag. */
    get mail(): boolean {
      return setup.gateState.mail;
    },
    set mail(value: boolean) {
      setup.gateState.mail = value;
    },
  };
  const secrets = createSecretStore({
    db,
    names: SECRET_NAMES,
    appSecret: SETUP_TEST_SECRET,
  });
  // The GitHub credentials as the portal saves and reads them. The addresses of GitHub are the fake's, which
  // is started when the first GitHub route is used; the store itself reads them from this object.
  const githubEnv: Record<string, string | undefined> = {
    ALLOW_TEST_GITHUB_ENDPOINTS: "true",
  };
  const credentials = createGithubCredentialStore({
    db,
    appSecret: SETUP_TEST_SECRET,
    env: githubEnv,
  });
  const smtp = createSmtpConfigStore({ db, appSecret: SETUP_TEST_SECRET });
  // The model catalog (#429): the real service over the real database, its capability checks answered by the fake LLM
  // (an address where nothing answers when a test brings none), and the audit lines of a change of model kept in a list.
  const catalogLog: string[] = [];
  const catalog = createCatalogService({
    catalog: createCatalogRepository(db),
    settings: createInstanceSettingsRepository(db),
    modelCapabilities: createModelCapabilityChecker({
      baseUrl: () => options.llm?.baseUrl ?? "http://127.0.0.1:1/api/v1",
      log: () => undefined,
      timeoutMs: 1_000,
    }),
    logger: { info: (line) => catalogLog.push(line) },
  });
  const service = createAdminService({
    db,
    secrets,
    smtp,
    catalogSummary: () => catalog.summary(),
    testMail: createTestMailService({
      product: getProductIdentity(),
      config: smtp,
      rateLimits: createRateLimitsRepository(db),
      baseUrl: ADMIN_TEST_BASE_URL,
      timeouts: ADMIN_TEST_SMTP_TIMEOUTS,
    }),
    operatorKeyTest: createOperatorKeyTestService({
      rateLimits: createRateLimitsRepository(db),
      baseUrlOf: () => options.llm?.baseUrl ?? "http://127.0.0.1:1",
      log: () => undefined,
    }),
    // A test switches the flag; a user authorization saved through the portal counts as well.
    githubConfigured: async () =>
      flags.github ||
      (await credentials.load()).userAuthorization.state === "configured",
    // A test switches the flag; a mail server saved through the portal counts as well.
    mailConfigured: () => Promise.resolve(flags.mail),
  });

  // The headers of the request being served, as the page code reads them with `headers()`.
  const current = { headers: new Headers() };

  // The routes of the GitHub integration, built on first use over the fake GitHub.
  let githubPart:
    | Promise<{
        fake: FakeGithub;
        routes: ReturnType<typeof createGithubRouteHandlers>;
      }>
    | undefined;
  function github() {
    githubPart ??= (async () => {
      const fake =
        options.github ?? (await startTestGithub({ appSlug: TEST_APP_SLUG }));
      githubEnv.GITHUB_API_BASE_URL = fake.baseUrl;
      const signedStates = createSignedStates({
        db,
        appSecret: SETUP_TEST_SECRET,
      });
      const rateLimits = createRateLimitsRepository(db);
      const service = createGithubConfigService({
        product: getProductIdentity(),
        capabilities: createCapabilitySet(PRODUCTS["code-review-com"].default),
        credentials,
        signedStates,
        rateLimits,
        publicUrl: ADMIN_TEST_BASE_URL,
        tenancy: async () =>
          (await createInstanceSettingsRepository(db).get("tenancy")) ??
          "single",
        webBaseUrl: fake.baseUrl,
        apiBaseUrl: fake.baseUrl,
        log: () => undefined,
      });
      const routes = createGithubRouteHandlers({
        access: async () =>
          adminAccessOf(
            await lookupSession(auth, current.headers, setup.gates),
          ),
        sessionId: async () =>
          (await auth.api.getSession({ headers: current.headers }))?.session
            .id ?? null,
        notFound: () => {
          throw new NotFoundSignal();
        },
        service,
      });
      return { fake, routes };
    })();
    return githubPart;
  }
  // The routes of the model catalog (#429).
  const catalogRoutes = createCatalogRouteHandlers({
    access: async () =>
      adminAccessOf(await lookupSession(auth, current.headers, setup.gates)),
    notFound: () => {
      throw new NotFoundSignal();
    },
    service: createCatalogAdminService({
      catalog,
      providers: () =>
        llmProviderDescriptors.ids.map((id) => ({
          id,
          label: llmProviderDescriptors.labelOf(id),
        })),
    }),
  });
  // The routes of the catalog prices and the enablement of catalog models (#549), the audit lines of a write kept in a list.
  const modelPriceLog: string[] = [];
  const modelPrices = createModelPriceService({
    db,
    log: { info: (line) => modelPriceLog.push(line) },
  });
  const modelPriceRoutes = createModelPriceRouteHandlers({
    access: async () =>
      adminAccessOf(await lookupSession(auth, current.headers, setup.gates)),
    notFound: () => {
      throw new NotFoundSignal();
    },
    service: modelPrices,
  });
  // The routes of the models.dev catalog (#554): the providers, the confirmation of an address and "fetch now". The fetch
  // itself is a double the test scripts, and the audit lines are kept in a list.
  const modelsDevLog: string[] = [];
  const modelsDevFetch: {
    calls: RefreshOptions[];
    outcome: RefreshOutcome;
  } = {
    calls: [],
    outcome: { status: "skipped", reason: "fetch_off" },
  };
  const modelsDevAdmin = createModelsDevAdminService({
    db,
    models: {
      refresh: async (options = {}) => {
        modelsDevFetch.calls.push(options);
        return modelsDevFetch.outcome;
      },
    },
    rateLimits: createRateLimitsRepository(db),
    settings: () => ({
      enabled: true,
      url: "http://127.0.0.1:1/api.json",
      warnings: [],
    }),
    log: { info: (line) => modelsDevLog.push(line) },
  });
  const modelsDevRoutes = createModelsDevRouteHandlers({
    access: async () =>
      adminAccessOf(await lookupSession(auth, current.headers, setup.gates)),
    notFound: () => {
      throw new NotFoundSignal();
    },
    service: modelsDevAdmin,
  });
  // The billing page (#504): the real service over the real database and secret store, its Stripe client pointed at the fake
  // Stripe (an address where nothing answers when a test brings none), the audit lines kept in a list.
  const billingLog: string[] = [];
  const billingService = createBillingAdminService({
    product: getProductIdentity(),
    db,
    secretsOn: (executor) =>
      createSecretStore({
        db: executor,
        names: STRIPE_SECRET_NAMES,
        appSecret: SETUP_TEST_SECRET,
      }),
    ownKeySecretNames: WORKSPACE_LLM_KEY_NAMES,
    publicUrl: options.billingPublicUrl ?? "https://reviews.example.test",
    clientFor: (apiKey, environment, clientOptions) =>
      createStripeClient({
        apiKey,
        baseUrl: options.stripe?.baseUrl ?? "http://127.0.0.1:1",
        environment,
        ...(clientOptions?.managedPayments === undefined
          ? {}
          : { managedPayments: clientOptions.managedPayments }),
        maxRetries: 0,
        sleep: () => Promise.resolve(),
        ...(options.stripeFetch === undefined
          ? {}
          : { fetch: options.stripeFetch }),
      }),
    log: (line) => billingLog.push(line),
  });
  const billingCreditLog: string[] = [];
  const billingCredit = createBillingCreditService({
    db,
    logger: { info: (line) => billingCreditLog.push(line) },
  });
  const billingRoutes = createBillingRouteHandlers({
    access: async () =>
      adminAccessOf(await lookupSession(auth, current.headers, setup.gates)),
    notFound: () => {
      throw new NotFoundSignal();
    },
    service: billingService,
    credit: billingCredit,
    reviews: createBillingReviewService({
      db,
      credit: billingCredit,
      check: options.reviewCheck,
      log: (line) => billingCreditLog.push(line),
    }),
  });
  // The synchronization with GitHub is a double that counts how often it was asked: what these tests need to
  // know is whether a request got as far as the synchronization.
  const syncCalls = { count: 0 };
  const handlers = createAdminRouteHandlers({
    access: async () => {
      const lookup = await lookupSession(auth, current.headers, setup.gates);
      return adminAccessOf(lookup);
    },
    notFound: () => {
      throw new NotFoundSignal();
    },
    service,
    sync: () => ({
      syncAll: () => {
        syncCalls.count += 1;
        return Promise.resolve({
          integrations: { created: 0, updated: 0, enabled: 0, disabled: 0 },
          repositories: {
            added: 3,
            reactivated: 0,
            updated: 0,
            deactivated: 0,
            unchanged: 0,
          },
          errors: [],
        });
      },
    }),
  });

  // The decisions on requests to link an installation are a double that counts how often it was asked to
  // decide: what these tests need to know is whether a request got as far as the decision.
  const approvalCalls = { count: 0 };
  const approvalRoutes = createApprovalRouteHandlers({
    access: async () =>
      adminAccessOf(await lookupSession(auth, current.headers, setup.gates)),
    notFound: () => {
      throw new NotFoundSignal();
    },
    approvals: {
      list: async () => ({ pending: [], decided: [] }),
      approve: async () => {
        approvalCalls.count += 1;
        return { ok: true };
      },
      deny: async () => {
        approvalCalls.count += 1;
        return { ok: true };
      },
    },
  });

  /** Makes a user with a password (and, if asked, the instance admin flag). */
  async function createUser(user: {
    id: string;
    email: string;
    password: string;
    isInstanceAdmin?: boolean;
    emailVerified?: boolean;
    /**
     * Whether the user is a Member of the instance's workspace. Default: yes, so a test about the portal's
     * guard meets the person who is not an admin and has access to the app. Pass `false` for an account
     * that has none, like a new sign-up.
     */
    member?: boolean;
  }): Promise<void> {
    const context = await auth.$context;
    const hash = await context.password.hash(user.password);
    const at = "2026-10-11T08:00:00.000Z";
    await db
      .insertInto("users")
      .values({
        id: user.id,
        name: user.email.split("@")[0] ?? user.email,
        email: user.email,
        email_verified: user.emailVerified === true ? 1 : 0,
        image: null,
        github_login: null,
        imported_at: null,
        is_instance_admin: user.isInstanceAdmin === true ? 1 : 0,
        org_checked_at: null,
        org_checked_for: null,
        created_at: at,
        updated_at: at,
      })
      .execute();
    await db
      .insertInto("accounts")
      .values({
        id: `account-${user.id}`,
        account_id: user.id,
        provider_id: "credential",
        user_id: user.id,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: hash,
        created_at: at,
        updated_at: at,
      })
      .execute();
    if (user.member !== false && user.isInstanceAdmin !== true) {
      const workspace = await createWorkspacesRepository(db).findDefault();
      if (workspace === undefined)
        throw new Error("The set-up instance has no workspace to join.");
      await createWorkspacesRepository(db).addMember(
        workspace.id,
        user.id,
        "member",
      );
    }
  }

  /** Signs in with email and password the way the login form does; returns the cookies. */
  async function signIn(email: string, password: string): Promise<CookieJar> {
    const response = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    if (!response.ok) throw new Error(`Sign in failed: ${response.status}`);
    const cookies: CookieJar = new Map();
    remember(cookies, response);
    return cookies;
  }

  /**
   * A request through the setup gate and the access proxy; what passes both reaches "the route": the
   * admin data route runs its real handler, everything else answers 200 `reached`. A rewrite (the 404
   * for a person who is not an admin) is returned as the proxy made it.
   */
  async function visit(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      cookies?: CookieJar;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    if (init.cookies && init.cookies.size > 0)
      headers.set("cookie", cookieHeader(init.cookies));
    if (init.body !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    const bodyText =
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body);
    const build = () =>
      new NextRequest(`${ADMIN_TEST_BASE_URL}${path}`, {
        method,
        headers,
        ...(bodyText === undefined ? {} : { body: bodyText }),
      });
    const gated = await setup.gate(build());
    const outcome = gated ?? (await setup.access(build()));
    // A request the proxy marked as one for the files of the portal by their own address is rewritten to
    // a missing path by next.config.ts, before it reaches any route.
    if (
      outcome.headers.get(`x-middleware-request-${PORTAL_DENIED_HEADER}`) !==
      null
    )
      return missingAnswer();
    if (outcome.headers.get("x-middleware-next") !== "1") return outcome;
    // The instance admin's request for the portal goes on marked, and next.config.ts serves it from the
    // files of the portal (`/admin/setup` is `/instance-portal/setup`). The files are all there is:
    // `/admin` itself is no route. The proxy builds no address for it, and Next.js does not run it a
    // second time.
    const marked =
      outcome.headers.get(`x-middleware-request-${PORTAL_REWRITE_HEADER}`) !==
      null;
    if (marked) {
      const requested = new URL(build().url);
      const target = portalRewriteTarget(requested.pathname);
      if (target === null) return missingAnswer();
      return reach(
        new Request(`${ADMIN_TEST_BASE_URL}${target}${requested.search}`, {
          method,
          headers,
          ...(bodyText === undefined ? {} : { body: bodyText }),
        }),
        headers,
      );
    }
    return reach(build(), headers);
  }

  /** The answer of a path that is no route of the app. */
  function missingAnswer(): Response {
    return new Response("not found", {
      status: 404,
      headers: { [MISSING_ANSWER_MARKER]: "1" },
    });
  }

  /** The request as the route sees it, after the proxy let it through (or without a proxy at all). */
  async function reach(request: Request, headers: Headers): Promise<Response> {
    current.headers = headers;
    const { pathname } = new URL(request.url);
    // What is no route of the app is a missing path: 404, as the app answers it.
    if (pathname === MISSING_PATH || isAdminPath(pathname))
      return missingAnswer();
    try {
      if (
        pathname === "/api/instance-portal/settings" &&
        request.method === "GET"
      )
        return await handlers.getSettings(request);
      if (
        pathname === "/api/instance-portal/settings" &&
        request.method === "PUT"
      )
        return await handlers.putSettings(request);
      if (
        pathname === "/api/instance-portal/mail/test" &&
        request.method === "POST"
      )
        return await handlers.testMail(request);
      const llmKeyTest =
        /^\/api\/instance-portal\/llm-keys\/([^/]+)\/test$/.exec(pathname);
      if (llmKeyTest !== null && request.method === "POST")
        return await handlers.testLlmKey(
          request,
          decodeURIComponent(llmKeyTest[1] ?? ""),
        );
      const catalogPath =
        /^\/api\/instance-portal\/model-catalog(?:\/([^/]+)(?:\/(release|retire))?)?$/.exec(
          pathname,
        );
      if (catalogPath !== null) {
        const [, segment, action] = catalogPath;
        const id = decodeURIComponent(segment ?? "");
        const method = request.method;
        if (segment === undefined) {
          if (method === "GET") return await catalogRoutes.get(request);
          if (method === "POST") return await catalogRoutes.create(request);
        } else if (action === undefined && segment === "check") {
          if (method === "POST") return await catalogRoutes.check(request);
        } else if (action === undefined && segment === "order") {
          if (method === "PUT") return await catalogRoutes.reorder(request);
        } else if (action === undefined && segment === "defaults") {
          if (method === "PUT") return await catalogRoutes.setDefaults(request);
        } else if (action === undefined) {
          if (method === "PUT") return await catalogRoutes.update(request, id);
          if (method === "DELETE")
            return await catalogRoutes.remove(request, id);
        } else if (method === "POST") {
          return action === "release"
            ? await catalogRoutes.release(request, id)
            : await catalogRoutes.retire(request, id);
        }
      }
      if (pathname === "/api/instance-portal/catalog-models") {
        if (request.method === "GET")
          return await modelPriceRoutes.list(request);
      }
      if (request.method === "POST") {
        if (pathname === "/api/instance-portal/catalog-models/enablement")
          return await modelPriceRoutes.setEnabled(request);
        if (pathname === "/api/instance-portal/catalog-models/enablement/reset")
          return await modelPriceRoutes.resetDecision(request);
        if (pathname === "/api/instance-portal/catalog-models/price/confirm")
          return await modelPriceRoutes.confirmPrice(request);
        if (pathname === "/api/instance-portal/catalog-models/price/correct")
          return await modelPriceRoutes.correctPrice(request);
      }
      if (
        pathname === "/api/instance-portal/catalog-providers/url/confirm" &&
        request.method === "POST"
      )
        return await modelsDevRoutes.confirmUrl(request);
      if (
        pathname === "/api/instance-portal/catalog-fetch" &&
        request.method === "POST"
      )
        return await modelsDevRoutes.fetchNow(request);
      if (pathname.startsWith("/api/instance-portal/billing")) {
        const rest = pathname.slice("/api/instance-portal/billing".length);
        const method = request.method;
        if (rest === "" && method === "GET")
          return await billingRoutes.get(request);
        if (rest === "" && method === "PUT")
          return await billingRoutes.put(request);
        if (rest === "/check" && method === "POST")
          return await billingRoutes.check(request);
        if (rest === "/webhook-endpoint" && method === "POST")
          return await billingRoutes.webhookEndpoint(request);
        if (rest === "/workspaces" && method === "GET")
          return await billingRoutes.searchWorkspaces(request);
        if (rest === "/reviews" && method === "GET")
          return await billingRoutes.reviews(request);
        if (rest === "/reviews/resolve" && method === "POST")
          return await billingRoutes.resolveReview(request);
        if (rest === "/reviews/check" && method === "POST")
          return await billingRoutes.checkReview(request);
        const workspace = /^\/workspaces\/([^/]+)(\/credit)?$/.exec(rest);
        if (workspace !== null) {
          const id = decodeURIComponent(workspace[1] ?? "");
          if (workspace[2] === undefined && method === "GET")
            return await billingRoutes.workspace(request, id);
          if (workspace[2] !== undefined && method === "POST")
            return await billingRoutes.credit(request, id);
        }
      }
      if (pathname.startsWith("/api/instance-portal/github")) {
        const { routes } = await github();
        if (
          pathname === "/api/instance-portal/github" &&
          request.method === "GET"
        )
          return await routes.get(request);
        if (
          pathname === "/api/instance-portal/github" &&
          request.method === "PUT"
        )
          return await routes.put(request);
        if (
          pathname === "/api/instance-portal/github/manifest" &&
          request.method === "POST"
        )
          return await routes.startManifest(request);
        if (
          pathname === "/api/instance-portal/github/manifest/callback" &&
          request.method === "GET"
        )
          return await routes.manifestCallback(request);
        if (
          pathname === "/api/instance-portal/github/check" &&
          request.method === "POST"
        )
          return await routes.check(request);
      }
      if (
        pathname === "/api/instance-portal/integrations/sync" &&
        request.method === "POST"
      )
        return await handlers.syncIntegrations(request);
      const approval = /^\/api\/instance-portal\/approvals\/([^/]+)$/.exec(
        pathname,
      );
      if (approval !== null && request.method === "POST")
        return await approvalRoutes.decide(
          request,
          decodeURIComponent(approval[1] ?? ""),
        );
    } catch (error) {
      if (error instanceof NotFoundSignal)
        return new Response("not found", { status: 404 });
      throw error;
    }
    return new Response("reached", { status: 200 });
  }

  /** What the access proxy itself answers, before any route (for comparing two paths). */
  async function askProxy(
    path: string,
    init: { method?: string; cookies?: CookieJar } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (init.cookies && init.cookies.size > 0)
      headers.set("cookie", cookieHeader(init.cookies));
    return setup.access(
      new NextRequest(`${ADMIN_TEST_BASE_URL}${path}`, {
        method: init.method ?? "GET",
        headers,
      }),
    );
  }

  /** Calls the data route's handler directly, as if the proxy had not been there. */
  function callRoute(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      cookies?: CookieJar;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.cookies && init.cookies.size > 0)
      headers.set("cookie", cookieHeader(init.cookies));
    if (init.body !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    return reach(
      new Request(`${ADMIN_TEST_BASE_URL}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
      headers,
    );
  }

  const adminCookies = await signIn(
    SETUP_TEST_ADMIN.email,
    SETUP_TEST_ADMIN.password,
  );
  const adminRow = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", SETUP_TEST_ADMIN.email)
    .executeTakeFirstOrThrow();

  return {
    ...setup,
    adminId: adminRow.id,
    adminCookies,
    secrets,
    smtp,
    service,
    /** The model catalog service the catalog routes use (#429) and the audit lines it wrote. */
    catalog,
    catalogLog,
    /** The catalog price service the price routes use (#549) and the audit lines it wrote. */
    modelPrices,
    modelPriceLog,
    /** The admin side of the models.dev catalog (#554), its audit lines, and the fetch it calls (a double the test scripts). */
    modelsDevAdmin,
    modelsDevLog,
    modelsDevFetch,
    credentials,
    /** The billing service the billing routes use (#504) and the lines it and the manual credit logged. */
    billingService,
    billingLog,
    billingCreditLog,
    /** The fake GitHub behind the GitHub routes (started on first use). */
    fakeGithub: async () => (await github()).fake,
    flags,
    /** How many times a request got as far as the synchronization with GitHub. */
    syncCalls,
    /** How many times a request got as far as the decision on a request to link an installation. */
    approvalCalls,
    createUser,
    signIn,
    visit,
    askProxy,
    callRoute,
  };
}

export type AdminHarness = Awaited<ReturnType<typeof createAdminHarness>>;
