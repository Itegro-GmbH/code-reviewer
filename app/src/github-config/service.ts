// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub integration of the admin portal (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.4): what the portal shows, and the three ways to change it.
//
// - The manifest flow: `startManifest` builds the manifest from the configured public URL and a signed,
//   single-use state bound to the admin's session; `completeManifest` takes what GitHub sends back (the
//   one-time code and the state), uses the state up first, trades the code for the App's credentials
//   exactly once and stores them in one transaction.
// - The manual form: `saveApp` validates the six values before anything is saved (the key parses, a call
//   to GitHub with the App JWT names the entered id and slug, the client credentials are accepted) and
//   keeps a stored secret only while the App id (and, for the client secret, the client id) is unchanged.
// - The prompt of an imported App: `saveUserAuthorization` adds the client id and secret that enable the
//   sign in with GitHub, and `setPrivateApp` records the "private app" flag.
//
// Every call that makes the server talk to GitHub is limited per admin and for the instance, in the shared
// `rate_limits` table. Nothing here logs a secret, a code or a response body, and no answer contains one.
import type { CapabilitySet } from "../capabilities/capability.ts";
import type { ProductIdentity } from "../product-identity/identity.ts";
import { secondsLeft } from "../auth/sign-in-limit.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import {
  buildAppManifest,
  checkClientCredentials,
  convertManifestCode,
  githubAppInstallUrlFor,
  GITHUB_APP_PATHS,
  isUsableRsaKey,
  missingPermissions,
  normalizePemKey,
  suggestedAppName,
  verifyGithubApp,
  type ManifestConversionErrorCode,
} from "../integrations/registry.ts";
import type { SignedStates } from "../signed-state/state.ts";
import type { SetupIssue } from "../setup/errors.ts";
import type { GithubCredentialStore, GithubSnapshot } from "./credentials.ts";
import {
  parseManualInput,
  parseUserAuthorizationInput,
  type StoredGithubApp,
} from "./settings.ts";

export const GITHUB_ADMIN_WINDOW_MS = 10 * 60 * 1000;
/** Calls that make the server talk to GitHub, per admin and for the whole instance. */
export const GITHUB_ADMIN_MAX = 20;
export const GITHUB_GLOBAL_MAX = 60;
export const MANIFEST_START_MAX = 10;

export function githubAdminKey(adminId: string): string {
  return `github-admin:admin:${adminId}`;
}
export const GITHUB_GLOBAL_KEY = "github-admin:all";
export function manifestStartKey(adminId: string): string {
  return `github-manifest-start:admin:${adminId}`;
}

type Tenancy = "single" | "multi";

/** What the portal shows about one secret: never the value. */
export type SecretView = "none" | "configured" | "unreadable";

export type GithubConfigView = {
  /** `not_configured`: nothing. `configured`: the App works. `problem`: something is saved or set, and unusable. */
  status: "not_configured" | "configured" | "problem";
  source: "database" | "none";
  app: {
    appId: string | null;
    slug: string | null;
    privateApp: boolean | null;
    origin: StoredGithubApp["origin"];
    /** Where a person installs the App; null while the slug is not known. */
    installUrl: string | null;
  } | null;
  /** What is wrong, as field or variable names; null when nothing is. */
  problem: { kind: "missing" | "invalid"; fields: string[] } | null;
  secrets: {
    privateKey: SecretView;
    webhookSecret: SecretView;
    clientSecret: SecretView;
  };
  userAuthorization: {
    /** The sign in with GitHub can work: a client id and a secret that can be read. */
    configured: boolean;
    clientId: string | null;
  };
  /** The addresses the admin enters in the App's settings, all made from the configured public URL. */
  urls: {
    homepage: string;
    webhook: string;
    callback: string;
    setup: string;
  };
  /** True while the "private app" flag is not known (an imported App): the portal asks. */
  privateAppUnknown: boolean;
  /** An App made by hand or imported may lack permissions; the portal says what to add. */
  mayLackPermissions: boolean;
  updatedAt: string | null;
};

export type SaveResult =
  | { ok: true }
  | { ok: false; error: "invalid_input"; issues: SetupIssue[] }
  | { ok: false; error: "app_not_in_database" }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number };

export type StartManifestResult =
  | {
      ok: true;
      /** Where the browser posts the manifest (GitHub's creation page, with the state in the address). */
      postUrl: string;
      /** The manifest as JSON text, the value of the `manifest` field of the form. */
      manifest: string;
    }
  | { ok: false; error: "already_configured" }
  | { ok: false; error: "invalid_input"; issues: SetupIssue[] }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number };

export const COMPLETE_MANIFEST_ERROR_CODES = [
  /** The state is forged, expired, used, or belongs to another person or session. Nothing was exchanged. */
  "state_invalid",
  "manifest_code_invalid",
  "github_unreachable",
  "conversion_response_invalid",
  "rate_limited",
  /** The credentials were received and could not be saved; nothing was stored. */
  "storing_failed",
] as const;
export type CompleteManifestErrorCode =
  (typeof COMPLETE_MANIFEST_ERROR_CODES)[number];

export type CompleteManifestResult =
  { ok: true; slug: string } | { ok: false; error: CompleteManifestErrorCode };

export type CheckPermissionsResult =
  | { ok: true; missing: string[] }
  | {
      ok: false;
      error: "not_configured" | "app_auth_failed" | "github_unreachable";
    }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number };

export type GithubActor = { id: string; sessionId: string };

export type GithubConfigService = {
  view(): Promise<GithubConfigView>;
  /** `raw` is the request's `app` object, as received. */
  saveApp(actorId: string, raw: unknown): Promise<SaveResult>;
  /** `raw` is the request's `userAuthorization` object, as received. */
  saveUserAuthorization(actorId: string, raw: unknown): Promise<SaveResult>;
  /** `raw` is the request's `privateApp` value, as received. */
  setPrivateApp(actorId: string, raw: unknown): Promise<SaveResult>;
  /** `raw` is the request body, as received: `{ name?, organization?, replace? }`. */
  startManifest(actor: GithubActor, raw: unknown): Promise<StartManifestResult>;
  completeManifest(
    actor: GithubActor,
    query: { code: unknown; state: unknown },
  ): Promise<CompleteManifestResult>;
  checkPermissions(actorId: string): Promise<CheckPermissionsResult>;
};

export type GithubConfigServiceOptions = {
  /** Who the App is for: its suggested name and its description on GitHub. */
  product: ProductIdentity;
  /** What the deployment offers: the permissions the manifest asks for, and the check of an App, follow it (#749). */
  capabilities: CapabilitySet;
  credentials: GithubCredentialStore;
  signedStates: SignedStates;
  rateLimits: RateLimitsRepository;
  /** The configured public address of the app (`BETTER_AUTH_URL`): every address in the manifest is made from it. */
  publicUrl: string;
  /** The tenancy decides whether the App is created public or private. */
  tenancy: () => Promise<Tenancy>;
  /** GitHub's web address (the creation page); the fake GitHub's in the test stack. */
  webBaseUrl: string;
  /** GitHub's API address. */
  apiBaseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
};

const ORGANIZATION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const APP_NAME_MAX_LENGTH = 34;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretView(state: { state: string }): SecretView {
  return state.state === "configured"
    ? "configured"
    : state.state === "undecryptable"
      ? "unreadable"
      : "none";
}

export function createGithubConfigService({
  product,
  capabilities,
  credentials,
  signedStates,
  rateLimits,
  publicUrl,
  tenancy,
  webBaseUrl,
  apiBaseUrl,
  fetch: fetchImpl,
  timeoutMs,
  now = () => new Date(),
  log = console.error,
}: GithubConfigServiceOptions): GithubConfigService {
  const origin = publicUrl.replace(/\/+$/, "");
  const urls = {
    homepage: origin,
    webhook: `${origin}${GITHUB_APP_PATHS.webhook}`,
    callback: `${origin}${GITHUB_APP_PATHS.signInCallback}`,
    setup: `${origin}${GITHUB_APP_PATHS.installationSetup}`,
  };
  const request = {
    apiBaseUrl,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };

  // The instance counter first: an admin who is over their own allowance must not use up the budget of the
  // instance (their attempt is taken back from it), and an instance out of budget counts against no admin.
  async function limited(
    adminId: string,
  ): Promise<{ retryAfterSeconds: number } | null> {
    const instance = await rateLimits.hit(
      GITHUB_GLOBAL_KEY,
      GITHUB_ADMIN_WINDOW_MS,
    );
    if (instance.count > GITHUB_GLOBAL_MAX)
      return {
        retryAfterSeconds: secondsLeft(
          instance.windowStartedAt,
          GITHUB_ADMIN_WINDOW_MS,
          now(),
        ),
      };
    const own = await rateLimits.hit(
      githubAdminKey(adminId),
      GITHUB_ADMIN_WINDOW_MS,
    );
    if (own.count > GITHUB_ADMIN_MAX) {
      await rateLimits.refund(GITHUB_GLOBAL_KEY);
      return {
        retryAfterSeconds: secondsLeft(
          own.windowStartedAt,
          GITHUB_ADMIN_WINDOW_MS,
          now(),
        ),
      };
    }
    return null;
  }

  const invalid = (issues: SetupIssue[]) =>
    ({ ok: false, error: "invalid_input", issues }) as const;

  function statusOf(snapshot: GithubSnapshot): GithubConfigView["status"] {
    if (snapshot.source === "none") return "not_configured";
    return snapshot.app.ok ? "configured" : "problem";
  }

  return {
    async view() {
      const [snapshot, states] = await Promise.all([
        credentials.load(),
        credentials.secretStates(),
      ]);
      const stored = snapshot.stored;
      const configured = snapshot.userAuthorization.state === "configured";
      return {
        status: statusOf(snapshot),
        source: snapshot.source,
        app:
          snapshot.source === "none"
            ? null
            : {
                appId:
                  stored?.appId ??
                  (snapshot.app.ok ? snapshot.app.config.appId : null),
                slug: snapshot.slug,
                privateApp: stored?.privateApp ?? null,
                origin: stored?.origin ?? "manual",
                installUrl:
                  snapshot.slug === null
                    ? null
                    : githubAppInstallUrlFor(snapshot.slug),
              },
        problem: snapshot.app.ok
          ? null
          : snapshot.source === "none"
            ? null
            : { kind: snapshot.app.kind, fields: snapshot.app.fields },
        secrets: {
          privateKey: secretView(states.privateKey),
          webhookSecret: secretView(states.webhookSecret),
          clientSecret: secretView(states.clientSecret),
        },
        userAuthorization: {
          configured,
          clientId: stored?.clientId ?? null,
        },
        urls,
        privateAppUnknown:
          snapshot.source !== "none" && stored?.privateApp == null,
        // The manifest asks for everything; any other origin may lack the account and organization permissions.
        mayLackPermissions:
          snapshot.source !== "none" && stored?.origin !== "manifest",
        updatedAt: snapshot.updatedAt,
      };
    },

    async saveApp(actorId, raw) {
      const parsed = parseManualInput(raw);
      if (!parsed.ok) return invalid(parsed.issues);
      const input = parsed.value;
      const snapshot = await credentials.load();
      const current = snapshot.source === "database" ? snapshot.stored : null;
      // A stored secret is kept only for the App it was entered for: pointing the form at another App id
      // never carries the old key or secrets over.
      const sameApp = current !== null && current.appId === input.appId;
      const issues: SetupIssue[] = [];

      let privateKey: string | null = null;
      let keyForCheck = "";
      if (input.privateKey.kind === "set") {
        privateKey = normalizePemKey(input.privateKey.value);
        if (!isUsableRsaKey(privateKey))
          issues.push({ field: "privateKey", code: "private_key_invalid" });
        keyForCheck = privateKey;
      } else if (sameApp && snapshot.app.ok) {
        keyForCheck = snapshot.app.config.privateKey;
      } else {
        issues.push({ field: "privateKey", code: "private_key_required" });
      }

      let webhookSecret: string | null = null;
      if (input.webhookSecret.kind === "set")
        webhookSecret = input.webhookSecret.value;
      else if (!(sameApp && snapshot.app.ok))
        issues.push({
          field: "webhookSecret",
          code: "webhook_secret_required",
        });

      // The client secret belongs to a client id: it is kept only while both the App and the client id are
      // unchanged and the stored one can be read.
      let clientSecret: "keep" | "remove" | { set: string } = "remove";
      if (input.clientId !== null) {
        if (input.clientSecret.kind === "set")
          clientSecret = { set: input.clientSecret.value };
        else if (
          sameApp &&
          current.clientId === input.clientId &&
          snapshot.userAuthorization.state === "configured"
        )
          clientSecret = "keep";
        else
          issues.push({
            field: "clientSecret",
            code: "client_secret_required",
          });
      }
      if (issues.length > 0) return invalid(issues);

      const wait = await limited(actorId);
      if (wait !== null) return { ok: false, error: "rate_limited", ...wait };

      // GitHub has the last word on whether the values belong together; nothing is saved before it agrees.
      const verified = await verifyGithubApp({
        ...request,
        appId: input.appId,
        slug: input.slug,
        privateKey: keyForCheck,
      });
      if (!verified.ok) {
        if (verified.error !== "github_unreachable")
          log(`[github-config] APP_CHECK_FAILED: ${verified.error}`);
        return invalid([
          verified.error === "app_auth_failed"
            ? { field: "privateKey", code: "app_auth_failed" }
            : verified.error === "slug_mismatch"
              ? { field: "slug", code: "slug_mismatch" }
              : { field: "", code: "github_unreachable" },
        ]);
      }
      if (
        input.clientId !== null &&
        typeof clientSecret === "object" &&
        input.clientSecret.kind === "set"
      ) {
        const checked = await checkClientCredentials({
          ...request,
          clientId: input.clientId,
          clientSecret: input.clientSecret.value,
        });
        if (checked !== "valid")
          return invalid([
            checked === "invalid"
              ? { field: "clientSecret", code: "client_credentials_invalid" }
              : { field: "", code: "github_unreachable" },
          ]);
      }

      await credentials.persistApp({
        actorId,
        stored: {
          appId: input.appId,
          slug: input.slug,
          clientId: input.clientId,
          privateApp: input.privateApp,
          origin: "manual",
        },
        privateKey,
        webhookSecret,
        clientSecret:
          clientSecret === "keep"
            ? { kind: "keep" }
            : clientSecret === "remove"
              ? { kind: "remove" }
              : { kind: "set", value: clientSecret.set },
      });
      return { ok: true };
    },

    async saveUserAuthorization(actorId, raw) {
      const parsed = parseUserAuthorizationInput(raw);
      if (!parsed.ok) return invalid(parsed.issues);
      const { clientId, clientSecret } = parsed.value;
      const snapshot = await credentials.load();
      // The client id and secret are added to an App that is stored in the database. An App that is still
      // in the environment is entered in the form (or imported) first.
      if (snapshot.source !== "database" || snapshot.stored === null)
        return { ok: false, error: "app_not_in_database" };
      const keepable =
        snapshot.stored.clientId === clientId &&
        snapshot.userAuthorization.state === "configured";
      if (clientSecret.kind === "keep" && !keepable)
        return invalid([
          { field: "clientSecret", code: "client_secret_required" },
        ]);

      if (clientSecret.kind === "set") {
        const wait = await limited(actorId);
        if (wait !== null) return { ok: false, error: "rate_limited", ...wait };
        const checked = await checkClientCredentials({
          ...request,
          clientId,
          clientSecret: clientSecret.value,
        });
        if (checked !== "valid")
          return invalid([
            checked === "invalid"
              ? { field: "clientSecret", code: "client_credentials_invalid" }
              : { field: "", code: "github_unreachable" },
          ]);
      }
      await credentials.persistUserAuthorization({
        actorId,
        clientId,
        clientSecret: clientSecret.kind === "set" ? clientSecret.value : null,
      });
      return { ok: true };
    },

    async setPrivateApp(actorId, raw) {
      if (typeof raw !== "boolean")
        return invalid([{ field: "privateApp", code: "private_app_invalid" }]);
      const saved = await credentials.setPrivateApp(actorId, raw);
      return saved ? { ok: true } : { ok: false, error: "app_not_in_database" };
    },

    async startManifest(actor, raw) {
      const body = raw === undefined || raw === null ? {} : raw;
      if (!isObject(body))
        return invalid([{ field: "", code: "github_invalid" }]);
      const issues: SetupIssue[] = [];

      let name = suggestedAppName(product, publicUrl);
      if (body.name !== undefined && body.name !== null && body.name !== "") {
        if (
          typeof body.name !== "string" ||
          body.name.trim() === "" ||
          body.name.trim().length > APP_NAME_MAX_LENGTH ||
          CONTROL_CHARACTERS.test(body.name)
        )
          issues.push({ field: "name", code: "name_invalid" });
        else name = body.name.trim();
      }
      let organization: string | null = null;
      if (
        body.organization !== undefined &&
        body.organization !== null &&
        body.organization !== ""
      ) {
        if (
          typeof body.organization !== "string" ||
          !ORGANIZATION_PATTERN.test(body.organization.trim())
        )
          issues.push({ field: "organization", code: "organization_invalid" });
        else organization = body.organization.trim();
      }
      if (body.replace !== undefined && typeof body.replace !== "boolean")
        issues.push({ field: "replace", code: "replace_invalid" });
      if (issues.length > 0) return invalid(issues);

      // Replacing an App that works leaves its installations behind: only on purpose.
      const snapshot = await credentials.load();
      if (snapshot.source !== "none" && body.replace !== true)
        return { ok: false, error: "already_configured" };

      const hit = await rateLimits.hit(
        manifestStartKey(actor.id),
        GITHUB_ADMIN_WINDOW_MS,
      );
      if (hit.count > MANIFEST_START_MAX)
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: secondsLeft(
            hit.windowStartedAt,
            GITHUB_ADMIN_WINDOW_MS,
            now(),
          ),
        };

      const currentTenancy = await tenancy();
      const manifest = buildAppManifest({
        product,
        capabilities,
        publicUrl,
        tenancy: currentTenancy,
        name,
      });
      // What the manifest asked for is recorded with the state, so the "private app" flag says what the App
      // was created as even if the tenancy is changed before GitHub sends the person back.
      const state = await signedStates.issue({
        purpose: "github-manifest",
        userId: actor.id,
        sessionId: actor.sessionId,
        data: { privateApp: !manifest.public },
      });
      const web = webBaseUrl.replace(/\/+$/, "");
      const path =
        organization === null
          ? "/settings/apps/new"
          : `/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
      return {
        ok: true,
        postUrl: `${web}${path}?state=${encodeURIComponent(state)}`,
        manifest: JSON.stringify(manifest),
      };
    },

    async completeManifest(actor, query) {
      const { code, state } = query;
      if (typeof state !== "string" || state === "" || state.length > 2048)
        return fail("state_invalid");
      // The state first, and used up before anything else happens: a forged, expired, replayed or foreign
      // state exchanges nothing and stores nothing.
      const consumed = await signedStates.consume({
        purpose: "github-manifest",
        value: state,
        userId: actor.id,
        sessionId: actor.sessionId,
      });
      if (!consumed.ok) return fail("state_invalid");
      // Only a request that carried a state of this admin and this session is counted: a callback with a
      // forged, expired or foreign state costs nothing, so junk cannot lock the admin out of the check or
      // the manual save, which share the counter. A state is single use and a start is limited on its own.
      const hit = await rateLimits.hit(
        githubAdminKey(actor.id),
        GITHUB_ADMIN_WINDOW_MS,
      );
      if (hit.count > GITHUB_ADMIN_MAX) return fail("rate_limited");
      if (typeof code !== "string" || code === "" || code.length > 512)
        return fail("manifest_code_invalid");

      const converted = await convertManifestCode({ ...request, code });
      if (!converted.ok) return fail(converted.error);
      const { app } = converted;
      const privateApp =
        isObject(consumed.data) && typeof consumed.data.privateApp === "boolean"
          ? consumed.data.privateApp
          : null;
      try {
        await credentials.persistApp({
          actorId: actor.id,
          stored: {
            appId: app.appId,
            slug: app.slug,
            clientId: app.clientId,
            privateApp,
            origin: "manifest",
          },
          privateKey: app.privateKey,
          webhookSecret: app.webhookSecret,
          clientSecret: { kind: "set", value: app.clientSecret },
        });
      } catch {
        return fail("storing_failed");
      }
      return { ok: true, slug: app.slug };

      function fail(
        error: CompleteManifestErrorCode | ManifestConversionErrorCode,
      ): CompleteManifestResult {
        log(`[github-config] MANIFEST_FAILED: ${error}`);
        return { ok: false, error: error as CompleteManifestErrorCode };
      }
    },

    async checkPermissions(actorId) {
      const snapshot = await credentials.load();
      if (!snapshot.app.ok) return { ok: false, error: "not_configured" };
      const wait = await limited(actorId);
      if (wait !== null) return { ok: false, error: "rate_limited", ...wait };
      const verified = await verifyGithubApp({
        ...request,
        appId: snapshot.app.config.appId,
        slug: snapshot.app.config.slug,
        privateKey: snapshot.app.config.privateKey,
      });
      if (!verified.ok)
        return {
          ok: false,
          error:
            verified.error === "github_unreachable"
              ? "github_unreachable"
              : "app_auth_failed",
        };
      return {
        ok: true,
        missing: missingPermissions(verified.permissions, capabilities),
      };
    },
  };
}
