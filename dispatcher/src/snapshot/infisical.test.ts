// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { persistPair, type InfisicalTarget } from "./infisical.ts";
import { type SnapshotPair } from "./pair.ts";

const TARGET: InfisicalTarget = {
  domain: "https://infisical.example.com",
  clientId: "client-id-not-real",
  clientSecret: "client-secret-not-a-real-one-0123456789",
  projectSlug: "example-project",
};
const PAIR: SnapshotPair = {
  snapshotId: "snap_example01",
  imageDigest: `sha256:${"a".repeat(64)}`,
  commit: "1".repeat(40),
  sysbox: "proven",
};
const TOKEN = "access-token-not-real";

type Seen = {
  method: string;
  url: URL;
  headers: Headers;
  body: Record<string, unknown> | undefined;
  redirect: string;
};

function infisical(
  handler: (seen: Seen) => Response | undefined = () => undefined,
  existing: readonly string[] = [],
) {
  const seen: Seen[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    const entry: Seen = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body:
        text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>),
      redirect: request.redirect,
    };
    seen.push(entry);
    const custom = handler(entry);
    if (custom) return custom;
    const path = entry.url.pathname;
    if (path === "/api/v1/auth/universal-auth/login")
      return Response.json({
        accessToken: TOKEN,
        expiresIn: 60,
        accessTokenMaxTTL: 60,
        tokenType: "Bearer",
      });
    if (path === "/api/v1/projects/slug/example-project")
      return Response.json({ id: "project-id-example" });
    const name = path.split("/").pop() ?? "";
    if (entry.method === "PATCH")
      return existing.includes(name)
        ? Response.json({ secret: { secretKey: name } })
        : Response.json({ message: "not found" }, { status: 404 });
    return Response.json({ secret: { secretKey: name } });
  };
  return { fetch: fetchImplementation, seen };
}

describe("writing the snapshot pair to Infisical", () => {
  const ALL = [
    "SANDBOX_SNAPSHOT_ID",
    "SANDBOX_IMAGE_DIGEST",
    "SANDBOX_SNAPSHOT_COMMIT",
    "SANDBOX_SYSBOX_PROOF",
  ];

  // #403-T15
  it("signs in with the machine identity, finds the project by its slug and updates the four secrets of /dispatcher in prod", async () => {
    const { fetch, seen } = infisical(undefined, ALL);

    expect(await persistPair(TARGET, PAIR, fetch)).toEqual({ ok: true });

    const login = seen[0] as Seen;
    expect(login.method).toBe("POST");
    expect(login.url.href).toBe(
      "https://infisical.example.com/api/v1/auth/universal-auth/login",
    );
    expect(login.body).toEqual({
      clientId: TARGET.clientId,
      clientSecret: TARGET.clientSecret,
    });
    const lookup = seen[1] as Seen;
    expect(lookup.url.pathname).toBe("/api/v1/projects/slug/example-project");
    expect(lookup.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    const writes = seen.filter((entry) => entry.method === "PATCH");
    expect(writes.map((entry) => entry.url.pathname.split("/").pop())).toEqual([
      "SANDBOX_SYSBOX_PROOF",
      "SANDBOX_SNAPSHOT_ID",
      "SANDBOX_IMAGE_DIGEST",
      "SANDBOX_SNAPSHOT_COMMIT",
      "SANDBOX_SYSBOX_PROOF",
    ]);
    for (const write of writes) {
      expect(write.url.pathname).toMatch(/^\/api\/v4\/secrets\/SANDBOX_/);
      expect(write.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(write.body).toMatchObject({
        projectId: "project-id-example",
        environment: "prod",
        secretPath: "/dispatcher",
        type: "shared",
      });
    }
    // #745-T02: the verdict is cleared first and set last, so that a write that fails in between leaves a pair that is not
    // proven, never the `proven` of an older snapshot next to a newer snapshot id.
    expect(writes.map((entry) => entry.body?.secretValue)).toEqual([
      "unproven",
      PAIR.snapshotId,
      PAIR.imageDigest,
      PAIR.commit,
      "proven",
    ]);
    // Nothing is read, and every call is made without following a redirect.
    expect(
      seen.some(
        (entry) =>
          entry.method === "GET" && entry.url.pathname.includes("/secrets"),
      ),
    ).toBe(false);
    expect(seen.every((entry) => entry.redirect === "manual")).toBe(true);
  });

  // #403-T15
  it("creates a secret that does not exist yet (the first deployment)", async () => {
    const { fetch, seen } = infisical(undefined, ["SANDBOX_SNAPSHOT_ID"]);

    expect(await persistPair(TARGET, PAIR, fetch)).toEqual({ ok: true });

    const created = seen.filter(
      (entry) =>
        entry.method === "POST" &&
        entry.url.pathname.startsWith("/api/v4/secrets/"),
    );
    expect(created.map((entry) => entry.url.pathname.split("/").pop())).toEqual(
      [
        "SANDBOX_SYSBOX_PROOF",
        "SANDBOX_IMAGE_DIGEST",
        "SANDBOX_SNAPSHOT_COMMIT",
        "SANDBOX_SYSBOX_PROOF",
      ],
    );
    expect(created[0]?.body).toMatchObject({
      environment: "prod",
      secretPath: "/dispatcher",
      type: "shared",
    });
  });

  // #745-T02
  it("writes an unproven pair with the verdict cleared once and no `proven` at any point", async () => {
    const { fetch, seen } = infisical(undefined, ALL);

    await persistPair(TARGET, { ...PAIR, sysbox: "unproven" }, fetch);

    const verdicts = seen
      .filter((entry) => entry.url.pathname.endsWith("/SANDBOX_SYSBOX_PROOF"))
      .map((entry) => entry.body?.secretValue);
    expect(verdicts).toEqual(["unproven"]);
  });

  // #745-T02
  it("leaves the verdict cleared when a write fails before the last one", async () => {
    const { fetch, seen } = infisical(
      (entry) =>
        entry.method === "PATCH" &&
        entry.url.pathname.endsWith("/SANDBOX_SNAPSHOT_COMMIT")
          ? Response.json({ message: "no" }, { status: 500 })
          : undefined,
      ALL,
    );

    expect(await persistPair(TARGET, PAIR, fetch)).toEqual({
      ok: false,
      code: "infisical_write_failed",
    });

    const verdicts = seen
      .filter((entry) => entry.url.pathname.endsWith("/SANDBOX_SYSBOX_PROOF"))
      .map((entry) => entry.body?.secretValue);
    expect(verdicts).toEqual(["unproven"]);
  });

  // #403-T15
  it("writes only the four names, whatever the pair holds", async () => {
    const { fetch, seen } = infisical(undefined, ALL);

    await persistPair(TARGET, PAIR, fetch);

    const names = seen
      .filter((entry) => entry.url.pathname.startsWith("/api/v4/secrets/"))
      .map((entry) => entry.url.pathname.split("/").pop());
    expect(new Set(names)).toEqual(new Set(ALL));
  });

  // #403-T15
  it.each([
    ["http", "http://infisical.example.com"],
    ["a path", "https://infisical.example.com/api"],
    ["credentials", "https://user:pw@infisical.example.com"],
    ["no domain", ""],
  ])(
    "refuses a domain with %s before it sends the client secret anywhere",
    async (_name, domain) => {
      const { fetch, seen } = infisical();

      const result = await persistPair({ ...TARGET, domain }, PAIR, fetch);

      expect(result).toEqual({ ok: false, code: "infisical_domain_invalid" });
      expect(seen).toEqual([]);
    },
  );

  // #403-T15
  it.each([
    [
      "the sign-in is refused",
      (s: Seen) =>
        s.url.pathname.includes("login")
          ? Response.json({}, { status: 401 })
          : undefined,
      "infisical_sign_in_failed",
    ],
    [
      "the project is unknown",
      (s: Seen) =>
        s.url.pathname.includes("/projects/slug/")
          ? Response.json({}, { status: 404 })
          : undefined,
      "infisical_project_unavailable",
    ],
    [
      "a write is refused",
      (s: Seen) =>
        s.method === "PATCH" ? Response.json({}, { status: 403 }) : undefined,
      "infisical_write_failed",
    ],
    [
      "a write needs an approval",
      (s: Seen) =>
        s.method === "PATCH"
          ? Response.json({ approval: { id: "x" } })
          : undefined,
      "infisical_write_failed",
    ],
  ])(
    "stops with a stable code and no text when %s",
    async (_name, handler, code) => {
      const { fetch } = infisical(handler, ALL);

      const result = await persistPair(TARGET, PAIR, fetch);

      expect(result).toEqual({ ok: false, code });
    },
  );

  // #403-T15
  it("stops with a code when Infisical cannot be reached, and never repeats the error text", async () => {
    const failing = (() => {
      throw new Error(`connect ECONNREFUSED ${TARGET.clientSecret}`);
    }) as unknown as typeof fetch;

    const result = await persistPair(TARGET, PAIR, failing);

    expect(result).toEqual({ ok: false, code: "infisical_unreachable" });
    expect(JSON.stringify(result)).not.toContain(TARGET.clientSecret);
  });
});
