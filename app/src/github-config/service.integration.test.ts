// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub integration of the admin portal against the fake GitHub: the manifest flow (the state, the one
// exchange of the code, the secrets at rest), the manual form (what is checked before anything is saved),
// the private-app flag, the prompt of an imported App, the credentials as every instance reads them, and
// that no secret is in any answer or log line.
import { createCapabilitySet } from "../capabilities/capability.ts";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { webhookDelivery } from "../../../fakes/github/webhooks.ts";
import { createDefaultIntegrationRegistry } from "../integrations/registry.ts";
import {
  TEST_APP_ID,
  TEST_APP_SLUG,
  testAppKeys,
  testGithubAppEnv,
} from "../test-support/github-app.ts";
import {
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
} from "../test-support/github-fake.ts";
import { createGithubConfigHarness } from "../test-support/github-config-harness.ts";

async function issues(
  result: Promise<{ ok: boolean; issues?: unknown }>,
): Promise<unknown> {
  const outcome = await result;
  return outcome.ok ? "ok" : outcome.issues;
}

describe("the manifest flow", () => {
  // #102-GH-03
  it("exchanges the code once, stores the six values encrypted and shows the integration as configured", async () => {
    const h = await createGithubConfigHarness();

    const { result } = await h.createAppThroughManifest();

    expect(result).toMatchObject({ ok: true });
    expect(h.github.conversionCodes()).toHaveLength(1);
    const view = await h.service.view();
    expect(view.status).toBe("configured");
    expect(view.source).toBe("database");
    expect(view.secrets).toEqual({
      privateKey: "configured",
      webhookSecret: "configured",
      clientSecret: "configured",
    });
    expect(view.userAuthorization.configured).toBe(true);
    // The values are in the database as ciphertext only.
    const rows = await h.db.selectFrom("secrets").selectAll().execute();
    const created = h.github
      .registeredApps()
      .find((app) => app.createdFromManifest);
    expect(rows.map((row) => row.name).sort()).toEqual([
      "github_app_client_secret",
      "github_app_private_key",
      "github_app_webhook_secret",
    ]);
    for (const row of rows) {
      expect(row.ciphertext).not.toContain("BEGIN");
      expect(row.ciphertext).not.toContain(created?.clientSecret ?? "?");
      expect(row.ciphertext).not.toContain(created?.webhookSecret ?? "?");
    }
    const stored = await h.settings.get("github_app");
    expect(stored).toMatchObject({
      appId: created?.id,
      slug: created?.slug,
      clientId: created?.clientId,
      origin: "manifest",
    });
  });

  // #102-GH-03
  it("refuses the same code again with manifest_code_invalid and changes nothing", async () => {
    const h = await createGithubConfigHarness();
    const first = await h.createAppThroughManifest();
    const code = first.back.searchParams.get("code");
    const before = await h.credentials.load();
    const again = await h.service.startManifest(h.admin, { replace: true });
    if (!again.ok) throw new Error("did not start");

    const result = await h.service.completeManifest(h.admin, {
      code,
      state: new URL(again.postUrl).searchParams.get("state"),
    });

    expect(result).toEqual({ ok: false, error: "manifest_code_invalid" });
    const after = await h.credentials.load();
    expect(after.stored).toEqual(before.stored);
  });

  // #102-GH-02
  it("refuses a tampered, expired or foreign state with state_invalid and exchanges nothing", async () => {
    const h = await createGithubConfigHarness();
    const start = async () => {
      const started = await h.service.startManifest(h.admin, {});
      if (!started.ok) throw new Error("did not start");
      const back = await h.github.confirmManifest(
        started.postUrl,
        started.manifest,
      );
      return {
        code: back.searchParams.get("code"),
        state: back.searchParams.get("state") ?? "",
      };
    };
    const tampered = await start();
    const expired = await start();
    const foreignAdmin = await start();
    const foreignSession = await start();
    // Eleven minutes later: the first four are expired, the next one is fresh.
    h.clock.at = new Date(h.clock.at.getTime() + 11 * 60 * 1000);

    const outcomes = [
      await h.service.completeManifest(h.admin, {
        ...tampered,
        state: `${tampered.state}x`,
      }),
      await h.service.completeManifest(h.admin, expired),
      await h.service.completeManifest(
        { id: "admin-2", sessionId: h.admin.sessionId },
        foreignAdmin,
      ),
      await h.service.completeManifest(
        { id: h.admin.id, sessionId: "session-other" },
        foreignSession,
      ),
      await h.service.completeManifest(h.admin, { code: "x", state: "" }),
      await h.service.completeManifest(h.admin, { code: "x", state: null }),
    ];

    expect(outcomes).toEqual(
      Array(6).fill({ ok: false, error: "state_invalid" }),
    );
    expect(h.github.conversionCodes()).toEqual([]);
    expect((await h.credentials.load()).source).toBe("none");
  });

  // #102-GH-02
  it("refuses a state that was used already, and keeps what the first use stored", async () => {
    const h = await createGithubConfigHarness();
    const started = await h.service.startManifest(h.admin, {});
    if (!started.ok) throw new Error("did not start");
    const back = await h.github.confirmManifest(
      started.postUrl,
      started.manifest,
    );
    const callback = {
      code: back.searchParams.get("code"),
      state: back.searchParams.get("state"),
    };

    const first = await h.service.completeManifest(h.admin, callback);
    const stored = await h.settings.get("github_app");
    const second = await h.service.completeManifest(h.admin, callback);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: "state_invalid" });
    expect(h.github.conversionCodes()).toHaveLength(1);
    expect(await h.settings.get("github_app")).toEqual(stored);
  });

  // #102-GH-02
  it("refuses a state made for another purpose", async () => {
    const h = await createGithubConfigHarness();
    const state = await h.signedStates.issue({
      purpose: "github-link",
      userId: h.admin.id,
      sessionId: h.admin.sessionId,
    });

    const result = await h.service.completeManifest(h.admin, {
      code: "x",
      state,
    });

    expect(result).toEqual({ ok: false, error: "state_invalid" });
  });

  // #102-GH-04
  it.each([
    [404, "manifest_code_invalid"],
    [422, "manifest_code_invalid"],
    [503, "github_unreachable"],
  ] as const)(
    "stores no partial credentials when the conversion answers %i",
    async (status, code) => {
      const h = await createGithubConfigHarness();
      h.github.fail({ pathIncludes: "/app-manifests/", status });

      const { result } = await h.createAppThroughManifest();

      expect(result).toEqual({ ok: false, error: code });
      expect((await h.credentials.load()).source).toBe("none");
      expect(await h.db.selectFrom("secrets").selectAll().execute()).toEqual(
        [],
      );
    },
  );

  // #102-GH-04
  it("stores nothing when the conversion times out", async () => {
    const h = await createGithubConfigHarness({ requestTimeoutMs: 150 });
    h.github.fail({ pathIncludes: "/app-manifests/", delayMs: 600 });

    const { result } = await h.createAppThroughManifest();

    expect(result).toEqual({ ok: false, error: "github_unreachable" });
    expect((await h.credentials.load()).source).toBe("none");
  });

  // #102-GH-04
  it("stores nothing when GitHub answers with something that is not an App's credentials", async () => {
    const h = await createGithubConfigHarness();
    h.github.fail({ pathIncludes: "/app-manifests/", status: 200 });

    const { result } = await h.createAppThroughManifest();

    expect(result).toEqual({ ok: false, error: "conversion_response_invalid" });
    expect((await h.credentials.load()).source).toBe("none");
  });

  // #102-GH-20
  it("records the App as private on a single-tenant instance and as public on a multi-tenant one", async () => {
    const single = await createGithubConfigHarness({ tenancy: "single" });
    const multi = await createGithubConfigHarness({ tenancy: "multi" });

    await single.createAppThroughManifest();
    await multi.createAppThroughManifest();

    expect((await single.settings.get("github_app"))?.privateApp).toBe(true);
    expect((await multi.settings.get("github_app"))?.privateApp).toBe(false);
    expect(single.github.postedManifests()[0]?.public).toBe(false);
    expect(multi.github.postedManifests()[0]?.public).toBe(true);
  });

  // #102-GH-20
  it("records what the manifest asked for even if the tenancy changes before GitHub sends the person back", async () => {
    const h = await createGithubConfigHarness({ tenancy: "single" });
    const started = await h.service.startManifest(h.admin, {});
    if (!started.ok) throw new Error("did not start");
    const back = await h.github.confirmManifest(
      started.postUrl,
      started.manifest,
    );
    h.tenancy.value = "multi";

    await h.service.completeManifest(h.admin, {
      code: back.searchParams.get("code"),
      state: back.searchParams.get("state"),
    });

    expect((await h.settings.get("github_app"))?.privateApp).toBe(true);
  });

  it("registers the callback URL of the sign in at GitHub, so the sign in with GitHub works for the new App", async () => {
    const h = await createGithubConfigHarness();

    await h.createAppThroughManifest();

    const created = h.github
      .registeredApps()
      .find((app) => app.createdFromManifest);
    expect(created?.callbackUrls).toEqual([
      "https://reviews.example.test/api/auth/callback/github",
    ]);
    expect(created?.accountPermissions).toEqual({
      emails: "read",
      members: "read",
    });
  });

  it("asks for confirmation before it replaces an App that is configured", async () => {
    const h = await createGithubConfigHarness();
    await h.createAppThroughManifest();

    const refused = await h.service.startManifest(h.admin, {});
    const allowed = await h.service.startManifest(h.admin, { replace: true });

    expect(refused).toEqual({ ok: false, error: "already_configured" });
    expect(allowed.ok).toBe(true);
  });

  it("builds the address of an organization's creation page and refuses a name that is not one", async () => {
    const h = await createGithubConfigHarness();

    const org = await h.service.startManifest(h.admin, {
      organization: "acme",
    });
    const bad = await h.service.startManifest(h.admin, {
      organization: "../evil",
    });

    expect(org.ok && new URL(org.postUrl).pathname).toBe(
      "/organizations/acme/settings/apps/new",
    );
    expect(bad).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("limits how often a flow can be started", async () => {
    const h = await createGithubConfigHarness();

    const results = [];
    for (let i = 0; i < 12; i += 1)
      results.push(await h.service.startManifest(h.admin, {}));

    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results[11]).toMatchObject({ ok: false, error: "rate_limited" });
  });
});

describe("the manual form", () => {
  // #102-GH-05
  it("normalises a key with escaped line breaks, checks it against GitHub and saves", async () => {
    const h = await createGithubConfigHarness();
    const escaped = testAppKeys().privateKey.trim().replace(/\n/g, "\\n");

    const result = await h.service.saveApp(
      "admin-1",
      h.validManualInput({ privateKey: escaped }),
    );

    expect(result).toEqual({ ok: true });
    expect(h.github.requests().map((r) => r.path)).toContain("/app");
    const loaded = await h.credentials.load();
    expect(loaded.app.ok && loaded.app.config.appId).toBe(TEST_APP_ID);
    // The stored key is a real PEM, whatever shape it was typed in.
    expect(
      loaded.app.ok &&
        createPrivateKey(loaded.app.config.privateKey).asymmetricKeyType,
    ).toBe("rsa");
  });

  // #102-GH-06
  it("refuses an invalid key, a key of another App and a slug GitHub does not know, each at its own field, and saves nothing", async () => {
    const h = await createGithubConfigHarness();
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    const results = await Promise.all([
      issues(
        h.service.saveApp(
          "admin-1",
          h.validManualInput({ privateKey: "not a key" }),
        ),
      ),
      issues(
        h.service.saveApp(
          "admin-1",
          h.validManualInput({ privateKey: other.privateKey }),
        ),
      ),
      issues(
        h.service.saveApp(
          "admin-1",
          h.validManualInput({ slug: "another-slug" }),
        ),
      ),
    ]);

    expect(results).toEqual([
      [{ field: "privateKey", code: "private_key_invalid" }],
      [{ field: "privateKey", code: "app_auth_failed" }],
      [{ field: "slug", code: "slug_mismatch" }],
    ]);
    expect((await h.credentials.load()).source).toBe("none");
    expect(await h.db.selectFrom("secrets").selectAll().execute()).toEqual([]);
  });

  it("refuses an input that is not an App id, a slug or the right kind of value, naming the field", async () => {
    const h = await createGithubConfigHarness();

    const result = await issues(
      h.service.saveApp(
        "admin-1",
        h.validManualInput({
          appId: "12 3",
          slug: "bad slug",
          webhookSecret: "has\nbreak",
          clientId: "x",
          privateApp: "yes",
        }),
      ),
    );

    expect(result).toEqual([
      { field: "appId", code: "app_id_invalid" },
      { field: "slug", code: "slug_invalid" },
      { field: "webhookSecret", code: "webhook_secret_invalid" },
      { field: "clientId", code: "client_id_invalid" },
      { field: "privateApp", code: "private_app_invalid" },
    ]);
  });

  it("saves nothing when GitHub cannot be reached", async () => {
    const h = await createGithubConfigHarness();
    h.github.fail({ pathIncludes: "/app", status: 503 });

    const result = await issues(
      h.service.saveApp("admin-1", h.validManualInput()),
    );

    expect(result).toEqual([{ field: "", code: "github_unreachable" }]);
    expect((await h.credentials.load()).source).toBe("none");
  });

  it("refuses client credentials GitHub does not accept", async () => {
    const h = await createGithubConfigHarness();

    const result = await issues(
      h.service.saveApp(
        "admin-1",
        h.validManualInput({ clientSecret: "wrong-secret-value" }),
      ),
    );

    expect(result).toEqual([
      { field: "clientSecret", code: "client_credentials_invalid" },
    ]);
    expect((await h.credentials.load()).source).toBe("none");
  });

  // #102-GH-20
  it("stores the private flag as the checkbox says", async () => {
    const h = await createGithubConfigHarness();

    await h.service.saveApp(
      "admin-1",
      h.validManualInput({ privateApp: true }),
    );
    const checked = (await h.settings.get("github_app"))?.privateApp;
    await h.service.saveApp(
      "admin-1",
      h.validManualInput({ privateApp: false }),
    );
    const unchecked = (await h.settings.get("github_app"))?.privateApp;

    expect([checked, unchecked]).toEqual([true, false]);
  });

  it("keeps the stored secrets for an empty field only while the App id is unchanged", async () => {
    const h = await createGithubConfigHarness();
    await h.service.saveApp("admin-1", h.validManualInput());
    const keep = {
      privateKey: "",
      webhookSecret: "",
      clientSecret: "",
    };

    const unchanged = await h.service.saveApp(
      "admin-1",
      h.validManualInput({ ...keep, privateApp: false }),
    );
    // The App id changes: nothing is carried over to it.
    const changed = await issues(
      h.service.saveApp(
        "admin-1",
        h.validManualInput({ ...keep, appId: "999" }),
      ),
    );

    expect(unchanged).toEqual({ ok: true });
    expect(changed).toEqual([
      { field: "privateKey", code: "private_key_required" },
      { field: "webhookSecret", code: "webhook_secret_required" },
      { field: "clientSecret", code: "client_secret_required" },
    ]);
    expect((await h.settings.get("github_app"))?.appId).toBe(TEST_APP_ID);
    expect((await h.settings.get("github_app"))?.privateApp).toBe(false);
  });

  it("asks for the client secret again when the client id changes, and removes it with the client id", async () => {
    const h = await createGithubConfigHarness();
    await h.service.saveApp("admin-1", h.validManualInput());

    const newId = await issues(
      h.service.saveApp(
        "admin-1",
        h.validManualInput({
          privateKey: "",
          webhookSecret: "",
          clientSecret: "",
          clientId: "Iv1.0000000000000000",
        }),
      ),
    );
    const removed = await h.service.saveApp(
      "admin-1",
      h.validManualInput({
        privateKey: "",
        webhookSecret: "",
        clientSecret: "",
        clientId: "",
      }),
    );

    expect(newId).toEqual([
      { field: "clientSecret", code: "client_secret_required" },
    ]);
    expect(removed).toEqual({ ok: true });
    expect((await h.service.view()).userAuthorization.configured).toBe(false);
    expect((await h.service.view()).secrets.clientSecret).toBe("none");
  });

  it("limits how often the values are checked against GitHub", async () => {
    const h = await createGithubConfigHarness();

    const results = [];
    for (let i = 0; i < 22; i += 1)
      results.push(
        await h.service.saveApp(
          "admin-1",
          h.validManualInput({ slug: "another-slug" }),
        ),
      );

    expect(results.at(-1)).toMatchObject({ ok: false, error: "rate_limited" });
  });

  // #102-GH-02
  it("is not locked out of the check or the manual save by callbacks that carry no valid state", async () => {
    const h = await createGithubConfigHarness();

    const junk = [];
    for (let i = 0; i < 21; i += 1)
      junk.push(
        await h.service.completeManifest(h.admin, {
          code: "some-code",
          state: i % 2 === 0 ? `forged-${String(i)}` : null,
        }),
      );
    const check = await h.service.checkPermissions("admin-1");
    const save = await h.service.saveApp("admin-1", h.validManualInput());

    expect(junk.every((r) => !r.ok && r.error === "state_invalid")).toBe(true);
    expect(check).not.toMatchObject({ error: "rate_limited" });
    expect(save).toEqual({ ok: true });
  });
});

describe("what the portal shows", () => {
  // #102-GH-07
  it("shows the app id, the slug and the client id, and never a secret, in the view or in a log line", async () => {
    const h = await createGithubConfigHarness();
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => {
        lines.push(args.map(String).join(" "));
      }),
    );
    await h.service.saveApp("admin-1", h.validManualInput());
    await h.service.saveApp("admin-1", h.validManualInput({ slug: "wrong" })); // a failure to log
    await h.createAppThroughManifest(h.admin, { replace: true });

    const view = JSON.stringify(await h.service.view());

    const created = h.github
      .registeredApps()
      .find((app) => app.createdFromManifest);
    expect(view).toContain(created?.slug ?? "?");
    expect(view).toContain(created?.clientId ?? "?");
    const secretsEverywhere = [
      testAppKeys().privateKey,
      "a-webhook-secret-of-the-test",
      TEST_CLIENT_SECRET,
      created?.clientSecret ?? "?",
      created?.webhookSecret ?? "?",
    ];
    for (const secret of secretsEverywhere) {
      expect(view).not.toContain(secret);
      expect(JSON.stringify(h.logs)).not.toContain(secret);
      for (const line of lines) expect(line).not.toContain(secret);
    }
    expect(view).not.toContain("PRIVATE KEY");
    for (const spy of spies) spy.mockRestore();
  });

  it("is not configured when nothing is saved and no variable is set", async () => {
    const h = await createGithubConfigHarness();

    const view = await h.service.view();

    expect(view).toMatchObject({
      status: "not_configured",
      source: "none",
      app: null,
    });
    expect(view.urls).toEqual({
      homepage: "https://reviews.example.test",
      webhook: "https://reviews.example.test/api/webhooks/github-app",
      callback: "https://reviews.example.test/api/auth/callback/github",
      setup: "https://reviews.example.test/github/connected",
    });
  });

  it("reports a stored App whose secret cannot be read as a problem naming the secret", async () => {
    const h = await createGithubConfigHarness();
    await h.service.saveApp("admin-1", h.validManualInput());
    await h.db
      .updateTable("secrets")
      .set({ ciphertext: "AAAA" })
      .where("name", "=", "github_app_private_key")
      .execute();

    const view = await h.service.view();

    expect(view.status).toBe("problem");
    expect(view.problem).toEqual({
      kind: "invalid",
      fields: ["github_app_private_key"],
    });
    expect(view.secrets.privateKey).toBe("unreadable");
  });

  it("says what an App made by hand may lack, and that the manifest App does not", async () => {
    const manual = await createGithubConfigHarness();
    await manual.service.saveApp("admin-1", manual.validManualInput());
    const manifest = await createGithubConfigHarness();
    await manifest.createAppThroughManifest();

    expect((await manual.service.view()).mayLackPermissions).toBe(true);
    expect((await manifest.service.view()).mayLackPermissions).toBe(false);
  });

  it("lists the permissions a hand-made App lacks when asked, and none for the manifest App", async () => {
    const manual = await createGithubConfigHarness();
    await manual.service.saveApp("admin-1", manual.validManualInput());
    manual.github.setAppAccountPermissions({});
    // An App made before the check run: the four permissions of a job and nothing else.
    manual.github.setAppPermissions({
      metadata: "read",
      contents: "read",
      pull_requests: "write",
      issues: "write",
    });
    const manifest = await createGithubConfigHarness();
    await manifest.createAppThroughManifest();

    const lacking = await manual.service.checkPermissions("admin-1");
    const complete = await manifest.service.checkPermissions("admin-1");

    // #405-T14
    expect(lacking).toEqual({
      ok: true,
      missing: ["checks", "emails", "members"],
    });
    expect(complete).toEqual({ ok: true, missing: [] });
  });
});

describe("the prompt of an imported App", () => {
  async function importedApp() {
    const h = await createGithubConfigHarness();
    // As the import of an existing installation leaves it: the App and its secrets, no client id, flag unknown.
    await h.credentials.persistApp({
      actorId: null,
      stored: {
        appId: TEST_APP_ID,
        slug: TEST_APP_SLUG,
        clientId: null,
        privateApp: null,
        origin: "import",
      },
      privateKey: testAppKeys().privateKey,
      webhookSecret: "imported-webhook-secret",
      clientSecret: { kind: "remove" },
    });
    return h;
  }

  // #102-GH-21
  it("shows the callback URL and takes the client id and secret, validated and encrypted, and sign in becomes available", async () => {
    const h = await importedApp();
    const before = await h.service.view();

    const saved = await h.service.saveUserAuthorization("admin-1", {
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_CLIENT_SECRET,
    });

    const after = await h.service.view();
    expect(before.userAuthorization.configured).toBe(false);
    expect(before.urls.callback).toBe(
      "https://reviews.example.test/api/auth/callback/github",
    );
    expect(before.privateAppUnknown).toBe(true);
    expect(saved).toEqual({ ok: true });
    expect(after.userAuthorization).toEqual({
      configured: true,
      clientId: TEST_CLIENT_ID,
    });
    const row = await h.db
      .selectFrom("secrets")
      .select("ciphertext")
      .where("name", "=", "github_app_client_secret")
      .executeTakeFirstOrThrow();
    expect(row.ciphertext).not.toContain(TEST_CLIENT_SECRET);
  });

  // #102-GH-21
  it("refuses a client secret GitHub does not accept and keeps the sign in unavailable", async () => {
    const h = await importedApp();

    const result = await issues(
      h.service.saveUserAuthorization("admin-1", {
        clientId: TEST_CLIENT_ID,
        clientSecret: "not-the-secret-at-all",
      }),
    );

    expect(result).toEqual([
      { field: "clientSecret", code: "client_credentials_invalid" },
    ]);
    expect((await h.service.view()).userAuthorization.configured).toBe(false);
  });

  // #102-GH-20
  it("records the answer to whether the App can only be installed on its own account", async () => {
    const h = await importedApp();

    const saved = await h.service.setPrivateApp("admin-1", true);

    expect(saved).toEqual({ ok: true });
    expect((await h.service.view()).privateAppUnknown).toBe(false);
    expect((await h.settings.get("github_app"))?.privateApp).toBe(true);
    expect(await h.service.setPrivateApp("admin-1", "maybe")).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });

  it("cannot be used for an App that is only in the environment: it is entered in the form first", async () => {
    const h = await createGithubConfigHarness({ env: testGithubAppEnv() });

    const result = await h.service.saveUserAuthorization("admin-1", {
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_CLIENT_SECRET,
    });

    expect(result).toEqual({ ok: false, error: "app_not_in_database" });
  });
});

describe("the credentials as the instances read them", () => {
  // #106-IM-01
  it("never reads the GitHub App variables: the App is the one in the database, or none", async () => {
    const h = await createGithubConfigHarness({ env: testGithubAppEnv() });

    const without = await h.credentials.load();
    await h.service.saveApp(
      "admin-1",
      h.validManualInput({ webhookSecret: "database-webhook-secret" }),
    );
    const afterwards = await h.credentials.load();

    expect(without.source).toBe("none");
    expect(without.app.ok).toBe(false);
    expect(afterwards.source).toBe("database");
    expect(afterwards.app.ok && afterwards.app.config.webhookSecret).toBe(
      "database-webhook-secret",
    );
  });

  // #102-GH-16
  it("never reads the OAuth app variables", async () => {
    const h = await createGithubConfigHarness({
      env: { GITHUB_OAUTH_CLIENT_ID: "x", GITHUB_OAUTH_CLIENT_SECRET: "y" },
    });

    const loaded = await h.credentials.load();

    expect(loaded.source).toBe("none");
    expect(loaded.userAuthorization).toEqual({ state: "none" });
  });

  // #102-GH-09
  it("refuses a delivery signed with the replaced webhook secret at once, on this instance and on a second one", async () => {
    const h = await createGithubConfigHarness();
    await h.service.saveApp(
      "admin-1",
      h.validManualInput({ webhookSecret: "old-webhook-secret" }),
    );
    const here = createDefaultIntegrationRegistry({
      loadConfig: async () => {
        const loaded = await h.credentials.load();
        if (!loaded.app.ok) throw new Error("not configured");
        return loaded.app.config;
      },
    }).resolve("github_app");
    const second = h.secondInstance();
    const there = createDefaultIntegrationRegistry({
      loadConfig: async () => {
        const loaded = await second.load();
        if (!loaded.app.ok) throw new Error("not configured");
        return loaded.app.config;
      },
    }).resolve("github_app");
    const delivery = (secret: string) =>
      webhookDelivery({ event: "ping", payload: { zen: "x" }, secret });
    expect(await here.verifyWebhook(null, delivery("old-webhook-secret"))).toBe(
      true,
    );
    expect(
      await there.verifyWebhook(null, delivery("old-webhook-secret")),
    ).toBe(true);

    await h.service.saveApp(
      "admin-1",
      h.validManualInput({ webhookSecret: "new-webhook-secret" }),
    );

    expect(await here.verifyWebhook(null, delivery("old-webhook-secret"))).toBe(
      false,
    );
    expect(
      await there.verifyWebhook(null, delivery("old-webhook-secret")),
    ).toBe(false);
    expect(
      await there.verifyWebhook(null, delivery("new-webhook-secret")),
    ).toBe(true);
  });

  it("refuses every delivery while nothing is configured", async () => {
    const h = await createGithubConfigHarness();
    const provider = createDefaultIntegrationRegistry({
      loadConfig: async () => {
        const loaded = await h.credentials.load();
        if (!loaded.app.ok) throw new Error("not configured");
        return loaded.app.config;
      },
    }).resolve("github_app");

    await expect(
      provider.verifyWebhook(
        null,
        webhookDelivery({ event: "ping", payload: {}, secret: "any" }),
      ),
    ).rejects.toThrow();
  });
});

describe("the permissions in a deployment with the Implementer", () => {
  const implementer = createCapabilitySet([
    "review",
    "dynamic-review",
    "implementer",
  ]);
  const permissionsOf = (started: { manifest: string }) =>
    (JSON.parse(started.manifest) as { default_permissions: unknown })
      .default_permissions;

  // #749-T02
  it("asks GitHub for contents write in the manifest, and for contents read in a deployment without the Implementer", async () => {
    const withImplementer = await createGithubConfigHarness({
      capabilities: implementer,
    });
    const without = await createGithubConfigHarness();

    const asked = await withImplementer.service.startManifest(
      withImplementer.admin,
      {},
    );
    const plain = await without.service.startManifest(without.admin, {});

    if (!asked.ok || !plain.ok) throw new Error("did not start");
    expect(permissionsOf(asked)).toMatchObject({ contents: "write" });
    expect(permissionsOf(plain)).toMatchObject({ contents: "read" });
  });

  // #749-T03
  it("lists Contents for a hand-made App that holds it read-only, and not in a deployment without the Implementer", async () => {
    const factory = await createGithubConfigHarness({
      capabilities: implementer,
    });
    await factory.service.saveApp("admin-1", factory.validManualInput());
    const reviewOnly = await createGithubConfigHarness();
    await reviewOnly.service.saveApp("admin-1", reviewOnly.validManualInput());

    expect(await factory.service.checkPermissions("admin-1")).toEqual({
      ok: true,
      missing: ["contents"],
    });
    expect(await reviewOnly.service.checkPermissions("admin-1")).toEqual({
      ok: true,
      missing: [],
    });
  });

  // #749-T03
  it("lists nothing for an App created from the manifest of the deployment", async () => {
    const factory = await createGithubConfigHarness({
      capabilities: implementer,
    });
    await factory.createAppThroughManifest();

    expect(await factory.service.checkPermissions("admin-1")).toEqual({
      ok: true,
      missing: [],
    });
  });
});
