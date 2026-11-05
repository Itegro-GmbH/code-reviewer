// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route files behind a customer's runner (#854) with the wiring the running server uses: a member makes a
// registration token, the runner exchanges it for a credential, takes part with it (the claim counts as its heartbeat), renews it,
// and a revoked runner is refused at once. Only the session lookup and `connection()` are replaced (they need Next.js's request
// scope). The pieces' own behaviour is in src/runner-fleet and src/db/repositories; this file proves they are connected: the
// right of the matrix, the workspace in the address, the shared token and the runner credential staying two different doors, and a
// deployment without the capability having no such path.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import type { WorkspaceRole } from "../../src/db/workspace-roles.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../src/test-support/workspaces.ts";
import {
  createContractValidator,
  readExamples,
} from "../../src/test-support/runner-contract.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const DEPLOYMENTS = {
  withCapability: {
    PRODUCT_ID: "factory",
    PRODUCT_CAPABILITIES: "review,dynamic-review,implementer",
  },
  factoryToday: {
    PRODUCT_ID: "factory",
    PRODUCT_CAPABILITIES: "review,dynamic-review",
  },
  codeReviewCom: { PRODUCT_ID: "code-review-com" },
} as const;

const SHARED_TOKEN = "s".repeat(40);
const ANNOUNCEMENT = {
  labels: ["Linux", "gpu"],
  baseVersion: "1.2.0",
  manifest: {
    harnesses: { opencode: { version: "1.19.0", ready: true } },
    capabilities: ["agent-docker"],
  },
  limits: { cpus: 8 },
};

const contract = createContractValidator("runner-registration.v1.json");
const runnerApi = createContractValidator();
const examples = readExamples("examples/runner-registration");

async function startRoutes(
  options: { role?: WorkspaceRole; deployment?: keyof typeof DEPLOYMENTS } = {},
) {
  for (const [name, value] of Object.entries(
    DEPLOYMENTS[options.deployment ?? "withCapability"],
  ))
    vi.stubEnv(name, value);
  vi.stubEnv("RUNNER_TOKEN", SHARED_TOKEN);
  await openRouteTestDatabase();
  const db = getDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const otherId = await addWorkspace(db, "other");
  const asRole = async (role: WorkspaceRole) =>
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, {
        // One account for each role: a membership already made keeps its role.
        id: `user-${role}`,
        workspaceId,
        role,
        githubLogin: `octocat-${role}`,
      }),
    );
  await asRole(options.role ?? "admin");

  const listRoute =
    await import("../../src/app/api/w/[workspace]/runners/route.ts");
  const tokensRoute =
    await import("../../src/app/api/w/[workspace]/runners/tokens/route.ts");
  const revokeRoute =
    await import("../../src/app/api/w/[workspace]/runners/[runnerId]/revoke/route.ts");
  const registerRoute =
    await import("../../src/app/api/runners/v1/register/route.ts");
  const selfRoute = await import("../../src/app/api/runners/v1/self/route.ts");
  const credentialRoute =
    await import("../../src/app/api/runners/v1/credential/route.ts");
  const claimRoute =
    await import("../../src/app/api/runners/v1/claim/route.ts");
  const heartbeatRoute =
    await import("../../src/app/api/runners/v1/jobs/[id]/heartbeat/route.ts");

  const base = (workspace: string) =>
    `https://app.test/api/w/${workspace}/runners`;
  const list = (workspace = "default") =>
    listRoute.GET(new Request(base(workspace)), {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof listRoute.GET>[1]);
  const makeToken = (workspace = "default") =>
    tokensRoute.POST(
      new Request(`${base(workspace)}/tokens`, { method: "POST" }),
      {
        params: Promise.resolve({ workspace }),
      } as Parameters<typeof tokensRoute.POST>[1],
    );
  const revoke = (runnerId: string, workspace = "default") =>
    revokeRoute.POST(
      new Request(`${base(workspace)}/${runnerId}/revoke`, { method: "POST" }),
      { params: Promise.resolve({ workspace, runnerId }) } as Parameters<
        typeof revokeRoute.POST
      >[1],
    );
  const json = (
    method: string,
    path: string,
    body?: unknown,
    credential?: string,
  ) =>
    new Request(`https://app.test${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(credential === undefined
          ? {}
          : { authorization: `Bearer ${credential}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const register = (body: unknown) =>
    registerRoute.POST(json("POST", "/api/runners/v1/register", body));
  const announce = (credential: string | undefined, body: unknown) =>
    selfRoute.PUT(json("PUT", "/api/runners/v1/self", body, credential));
  const renew = (credential: string | undefined) =>
    credentialRoute.POST(
      json("POST", "/api/runners/v1/credential", undefined, credential),
    );
  const claim = (credential: string | undefined) =>
    claimRoute.POST(
      json("POST", "/api/runners/v1/claim", undefined, credential),
    );
  const heartbeat = (credential: string) =>
    heartbeatRoute.POST(
      json(
        "POST",
        "/api/runners/v1/jobs/00000000-0000-4000-8000-000000000001/heartbeat",
        { leaseToken: "x".repeat(20) },
        credential,
      ),
      {
        params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }),
      } as Parameters<typeof heartbeatRoute.POST>[1],
    );

  /** A token made through the route and exchanged through the route: the runner's id and credential. */
  async function registerRunner(name = "build-box-1", workspace = "default") {
    const made = (await (await makeToken(workspace)).json()) as {
      token: string;
    };
    const response = await register({
      token: made.token,
      name,
      ...ANNOUNCEMENT,
    });
    const body = (await response.json()) as {
      runnerId: string;
      credential: string;
    };
    return { ...body, token: made.token, status: response.status };
  }
  return {
    db,
    workspaceId,
    otherId,
    asRole,
    list,
    makeToken,
    revoke,
    register,
    announce,
    renew,
    claim,
    heartbeat,
    registerRunner,
    routes: {
      listRoute,
      tokensRoute,
      revokeRoute,
      registerRoute,
      selfRoute,
      credentialRoute,
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("registering a runner through the route files", () => {
  // #854-T120
  it("lets an Admin make a token, shown once and kept as a hash, that a runner exchanges for a credential", async () => {
    const { makeToken, register, db, list } = await startRoutes();

    const made = await makeToken();
    const { token, expiresAt } = (await made.clone().json()) as {
      token: string;
      expiresAt: string;
    };
    const registered = await register({
      token,
      name: "build-box-1",
      ...ANNOUNCEMENT,
    });
    const body = await registered.clone().json();

    expect(made.status).toBe(201);
    expect(made.headers.get("cache-control")).toBe("no-store");
    expect(token).toMatch(/^crt_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(
      60 * 60 * 1000,
    );
    expect(registered.status).toBe(201);
    expect(registered.headers.get("cache-control")).toBe("no-store");
    expect(contract.check("RegisterResponse", body)).toEqual({
      valid: true,
      errors: "",
    });
    expect(body).toMatchObject({ version: 1, minBaseVersion: null });
    // The database holds hashes, never the token or the credential.
    const stored = JSON.stringify([
      await db.selectFrom("runner_registration_tokens").selectAll().execute(),
      await db.selectFrom("runners").selectAll().execute(),
    ]);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain((body as { credential: string }).credential);
    // The list shows it with the labels as stored.
    const listed = (await (await list()).json()) as {
      runners: Array<Record<string, unknown>>;
    };
    expect(listed.runners).toEqual([
      expect.objectContaining({
        name: "build-box-1",
        labels: ["gpu", "linux"],
        baseVersion: "1.2.0",
        status: "online",
        manifest: ANNOUNCEMENT.manifest,
      }),
    ]);
  });

  // #854-T121
  it("accepts a token once: the second exchange, an expired token and an unknown one are the same 401", async () => {
    const { registerRunner, register, makeToken, db } = await startRoutes();
    const first = await registerRunner();
    const again = await register({
      token: first.token,
      name: "second",
      ...ANNOUNCEMENT,
    });
    const { token: stale } = (await (await makeToken()).json()) as {
      token: string;
    };
    await db
      .updateTable("runner_registration_tokens")
      .set({ expires_at: "2020-01-01T00:00:00.000Z" })
      .where("used_at", "is", null)
      .execute();
    const expired = await register({
      token: stale,
      name: "late",
      ...ANNOUNCEMENT,
    });
    const unknown = await register({
      token: `crt_${"A".repeat(43)}`,
      name: "nobody",
      ...ANNOUNCEMENT,
    });

    expect(first.status).toBe(201);
    for (const refused of [again, expired, unknown]) {
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({
        error: { code: "RUNNER_REGISTRATION_TOKEN_INVALID" },
      });
    }
    expect(await db.selectFrom("runners").select("name").execute()).toEqual([
      { name: "build-box-1" },
    ]);
  });

  // #854-T122
  it("refuses a body that does not fit with the fields it got wrong, and uses no token for it", async () => {
    const { register, makeToken, db } = await startRoutes();
    const { token } = (await (await makeToken()).json()) as { token: string };

    const bad = await register({
      token,
      name: "",
      labels: ["two words"],
      baseVersion: "one",
    });
    const noObject = await register(["token"]);
    const notJson = await (
      await import("../../src/app/api/runners/v1/register/route.ts")
    ).POST(
      new Request("https://app.test/api/runners/v1/register", {
        method: "POST",
        body: "{",
      }),
    );

    expect(bad.status).toBe(400);
    const body = (await bad.json()) as {
      error: { code: string; fields: Array<{ field: string }> };
    };
    expect(body.error.code).toBe("RUNNER_REQUEST_INVALID");
    expect(body.error.fields.map((field) => field.field).sort()).toEqual([
      "baseVersion",
      "labels[0]",
      "name",
    ]);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(noObject.status).toBe(400);
    expect(notJson.status).toBe(400);
    expect(
      await db
        .selectFrom("runner_registration_tokens")
        .select("used_at")
        .execute(),
    ).toEqual([{ used_at: null }]);
  });

  // #854-T123
  it("answers the examples of the contract in the form of the contract", async () => {
    const { registerRunner, announce, renew } = await startRoutes();
    const { credential } = await registerRunner();

    const announced = await announce(credential, ANNOUNCEMENT);
    const renewed = await renew(credential);

    expect(contract.check("AnnounceResponse", await announced.json())).toEqual({
      valid: true,
      errors: "",
    });
    expect(contract.check("CredentialResponse", await renewed.json())).toEqual({
      valid: true,
      errors: "",
    });
    for (const example of examples.filter((entry) =>
      entry.definition.endsWith("Request"),
    ))
      expect(contract.check(example.definition, example.document).valid).toBe(
        true,
      );
  });
});

describe("a registered runner's calls", () => {
  // #854-T124
  it("take no job yet, answer 204, and count as its heartbeat (last seen)", async () => {
    const { registerRunner, claim, db } = await startRoutes();
    const { credential, runnerId } = await registerRunner();
    await db
      .updateTable("runners")
      .set({ last_seen_at: "2026-01-01T00:00:00.000Z" })
      .where("id", "=", runnerId)
      .execute();

    const answer = await claim(credential);

    expect(answer.status).toBe(204);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const { last_seen_at } = await db
      .selectFrom("runners")
      .select("last_seen_at")
      .where("id", "=", runnerId)
      .executeTakeFirstOrThrow();
    expect(Date.parse(last_seen_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  // #854-T125
  it("are refused with 401 the moment a member revokes the runner, on every route, and the list no longer shows it", async () => {
    const { registerRunner, revoke, claim, announce, renew, list } =
      await startRoutes();
    const { credential, runnerId } = await registerRunner();
    expect((await claim(credential)).status).toBe(204);

    const revoked = await revoke(runnerId);

    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    for (const call of [
      () => claim(credential),
      () => announce(credential, ANNOUNCEMENT),
      () => renew(credential),
    ]) {
      const refused = await call();
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({
        error: { code: "RUNNER_UNAUTHORIZED" },
      });
    }
    expect(
      ((await (await list()).json()) as { runners: unknown[] }).runners,
    ).toEqual([]);
    // A runner that is revoked is gone: revoking it again is a missing one.
    expect((await revoke(runnerId)).status).toBe(404);
  });

  // #854-T126
  it("do not reach into another workspace: a runner of another one is not listed or revoked, and its workspace's page is not open", async () => {
    const { registerRunner, revoke, db, otherId, list, claim } =
      await startRoutes();
    const { credential, runnerId } = await registerRunner();
    await db
      .insertInto("runners")
      .values({
        id: "foreign-runner",
        workspace_id: otherId,
        name: "not ours",
        labels: "linux",
        base_version: "1.0.0",
        manifest: "{}",
        limits: "{}",
        credential_hash: "foreign-hash",
        previous_credential_hash: null,
        created_at: "2026-11-05T08:00:00.000Z",
        last_seen_at: "2026-11-05T08:00:00.000Z",
        revoked_at: null,
      })
      .execute();

    const listed = (await (await list()).json()) as {
      runners: Array<{ id: string }>;
    };
    const crossRevoke = await revoke("foreign-runner");
    const crossList = await list("other").catch((error: unknown) => error);

    expect(listed.runners.map((runner) => runner.id)).toEqual([runnerId]);
    expect(crossRevoke.status).toBe(404);
    expect(await crossRevoke.json()).toEqual({
      error: "RUNNER_FLEET_NOT_FOUND",
    });
    expect(
      await db
        .selectFrom("runners")
        .select("revoked_at")
        .where("id", "=", "foreign-runner")
        .executeTakeFirstOrThrow(),
    ).toEqual({ revoked_at: null });
    // The signed in account is no member of the other workspace.
    expect(
      crossList instanceof Response
        ? crossList.status
        : (crossList as { digest?: string }).digest,
    ).toSatisfy((status: unknown) =>
      [403, 404, "NEXT_HTTP_ERROR_FALLBACK;404"].includes(status as never),
    );
    expect((await claim(credential)).status).toBe(204);
  });

  // #854-T127
  it("stay below the minimum version: no job and the reason 'update needed', until the runner says it is updated", async () => {
    vi.stubEnv("RUNNER_MIN_BASE_VERSION", "2.0.0");
    const { registerRunner, claim, announce, list } = await startRoutes();
    const { credential, runnerId } = await registerRunner();

    const old = await claim(credential);

    expect(old.status).toBe(426);
    const body = await old.json();
    expect(body).toMatchObject({
      error: { code: "RUNNER_UPDATE_NEEDED", minBaseVersion: "2.0.0" },
    });
    expect(runnerApi.check("ErrorResponse", body).valid).toBe(true);
    const shown = (await (await list()).json()) as {
      minBaseVersion: string;
      runners: Array<{ id: string; status: string }>;
    };
    expect(shown.minBaseVersion).toBe("2.0.0");
    expect(shown.runners).toEqual([
      expect.objectContaining({ id: runnerId, status: "update_needed" }),
    ]);

    const updated = await announce(credential, {
      ...ANNOUNCEMENT,
      baseVersion: "2.0.0",
    });

    expect(await updated.json()).toMatchObject({
      updateNeeded: false,
      minBaseVersion: "2.0.0",
    });
    expect((await claim(credential)).status).toBe(204);
  });

  // #854-T128
  it("renew the credential: the old one works until the new one is used, and a lost answer locks nobody out", async () => {
    const { registerRunner, renew, claim } = await startRoutes();
    const { credential } = await registerRunner();

    const renewed = await renew(credential);
    const { credential: next } = (await renewed.json()) as {
      credential: string;
    };

    expect(next).not.toBe(credential);
    expect((await claim(credential)).status).toBe(204);
    expect((await claim(next)).status).toBe(204);
    expect((await claim(credential)).status).toBe(401);
    expect((await claim(next)).status).toBe(204);
  });

  // #854-T129
  it("keep the two doors apart: the shared token is no runner credential, a runner credential is no shared token for the Dispatcher's calls", async () => {
    const { registerRunner, claim, announce, heartbeat } = await startRoutes();
    const { credential } = await registerRunner();

    // The shared token still opens the claim as before (no job: 204).
    expect((await claim(SHARED_TOKEN)).status).toBe(204);
    // It is no runner credential.
    expect((await announce(SHARED_TOKEN, ANNOUNCEMENT)).status).toBe(401);
    // The runner credential does not open the job calls (they come with the routing of the next part).
    expect((await heartbeat(credential)).status).toBe(401);
    // And nothing opens the claim without a credential.
    expect((await claim(undefined)).status).toBe(401);
    expect((await claim(`crc_${"B".repeat(43)}`)).status).toBe(401);
  });
});

describe("the right to register and revoke", () => {
  // #854-T130
  it("is the Owner's and the Admin's: a Member may list the runners and nothing else", async () => {
    const { asRole, list, makeToken, revoke, registerRunner } =
      await startRoutes();
    const { runnerId } = await registerRunner();
    await asRole("member");

    const listed = await list();
    const refused = await Promise.all([
      makeToken().catch((error: unknown) => error),
      revoke(runnerId).catch((error: unknown) => error),
    ]);

    expect(listed.status).toBe(200);
    for (const answer of refused)
      expect([403, 404]).toContain((answer as Response).status);
    await asRole("owner");
    expect((await makeToken()).status).toBe(201);
    expect((await revoke(runnerId)).status).toBe(200);
  });

  // #854-T131
  it("makes at most 20 unused tokens", async () => {
    const { makeToken } = await startRoutes();
    for (let index = 0; index < 20; index += 1)
      expect((await makeToken()).status).toBe(201);

    const refused = await makeToken();

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "RUNNER_FLEET_TOKEN_LIMIT_REACHED",
      maximum: 20,
    });
  });
});

describe("a deployment without the capability", () => {
  // #854-T132
  it.each(["factoryToday", "codeReviewCom"] as const)(
    "has none of these paths (%s): the 404 of a path that does not exist, before the session or the database is asked, and nothing is written",
    async (deployment) => {
      const { list, makeToken, revoke, register, announce, renew, db } =
        await startRoutes({ deployment });
      session.currentLookup.mockClear();
      session.currentLookup.mockResolvedValue({ kind: "none" });

      for (const call of [
        () => list(),
        () => makeToken(),
        () => revoke("x"),
        () => register({}),
        () => announce(`crc_${"A".repeat(43)}`, ANNOUNCEMENT),
        () => renew(`crc_${"A".repeat(43)}`),
      ])
        await expect(call()).rejects.toMatchObject({
          digest: "NEXT_HTTP_ERROR_FALLBACK;404",
        });
      expect(session.currentLookup).not.toHaveBeenCalled();
      expect(
        await db.selectFrom("runner_registration_tokens").selectAll().execute(),
      ).toEqual([]);
    },
  );

  // #854-T133
  it("export only the methods each route serves", async () => {
    const { routes } = await startRoutes();

    expect(Object.keys(routes.listRoute).sort()).toEqual(["GET"]);
    expect(Object.keys(routes.tokensRoute).sort()).toEqual(["POST"]);
    expect(Object.keys(routes.revokeRoute).sort()).toEqual(["POST"]);
    expect(Object.keys(routes.registerRoute).sort()).toEqual(["POST"]);
    expect(Object.keys(routes.selfRoute).sort()).toEqual(["PUT"]);
    expect(Object.keys(routes.credentialRoute).sort()).toEqual(["POST"]);
  });
});
