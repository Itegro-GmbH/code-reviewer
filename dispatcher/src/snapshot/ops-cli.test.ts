// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { runOps, type OpsDeps } from "./ops-cli.ts";
import { pairToMeta, type SnapshotPair } from "./pair.ts";
import type { BuilderInfo, SnapshotService } from "./service.ts";

const OLD_COMMIT = "1".repeat(40);
const SHA = "2".repeat(40);
const PAIR: SnapshotPair = {
  snapshotId: "snap_old01",
  imageDigest: `sha256:${"a".repeat(64)}`,
  commit: OLD_COMMIT,
  sysbox: "proven",
};
const NEW: SnapshotPair = {
  snapshotId: "snap_new01",
  imageDigest: `sha256:${"b".repeat(64)}`,
  commit: SHA,
  sysbox: "proven",
};
const VERCEL = {
  VERCEL_TOKEN: "vercel-token-not-a-real-one-0123456789",
  VERCEL_TEAM_ID: "team_example01",
  VERCEL_PROJECT_ID: "prj_example01",
};
const INFISICAL = {
  INFISICAL_DOMAIN: "https://infisical.example.com",
  INFISICAL_CLIENT_ID: "client-id-not-real",
  INFISICAL_CLIENT_SECRET: "client-secret-not-a-real-one-0123456789",
  INFISICAL_PROJECT_SLUG: "example-project",
};

function envFile(pair: SnapshotPair | undefined): string {
  return pair === undefined
    ? 'OTHER="x"\n'
    : `SANDBOX_SNAPSHOT_ID="${pair.snapshotId}"\nSANDBOX_IMAGE_DIGEST="${pair.imageDigest}"\nSANDBOX_SNAPSHOT_COMMIT="${pair.commit}"\nSANDBOX_SYSBOX_PROOF="${pair.sysbox}"\n`;
}

type Harness = ReturnType<typeof harness>;

function harness(
  options: {
    env?: Record<string, string>;
    file?: string;
    live?: SnapshotPair | "none" | "unavailable";
    changed?: boolean;
    known?: boolean;
    builders?: BuilderInfo[];
    listFails?: boolean;
    deleteFails?: string;
    persistStatus?: number;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const requests: Array<{ method: string; url: URL; body?: unknown }> = [];
  const deleted: string[] = [];
  const builders = options.builders ?? [
    {
      name: "code-reviewer-golden-builder-0",
      createdAt: 0,
      snapshotId: PAIR.snapshotId,
    },
  ];
  const service: SnapshotService = {
    createVm: () => Promise.reject(new Error("not used")),
    listBuilders: () =>
      options.listFails
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(builders),
    deleteBuilder: (name) => {
      if (name === options.deleteFails) return Promise.reject(new Error("x"));
      deleted.push(name);
      return Promise.resolve();
    },
  };
  const live = options.live ?? "none";
  const deps: OpsDeps = {
    env: { ...VERCEL, ...INFISICAL, ...options.env },
    stdout: (text) => out.push(text),
    stderr: (line) => err.push(line),
    readText: (path) => {
      if (path === ".vercel/.env.production.local")
        return options.file ?? envFile(PAIR);
      throw new Error("missing");
    },
    appendText: (path, text) => files.set(path, (files.get(path) ?? "") + text),
    commitKnown: () => Promise.resolve(options.known ?? true),
    pathsChanged: () => Promise.resolve(options.changed ?? false),
    createService: () => service,
    now: () => 1_000_000_000,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = await request.text();
      requests.push({
        method: request.method,
        url,
        ...(text === "" ? {} : { body: JSON.parse(text) as unknown }),
      });
      if (url.hostname === "api.vercel.com") {
        if (live === "unavailable") return new Response("{}", { status: 500 });
        if (url.pathname.startsWith("/v9/projects/"))
          return Response.json({ targets: { production: { id: "dpl_live" } } });
        return Response.json({
          projectId: VERCEL.VERCEL_PROJECT_ID,
          ownerId: VERCEL.VERCEL_TEAM_ID,
          meta: live === "none" ? {} : pairToMeta(live),
        });
      }
      if (url.pathname.includes("login"))
        return Response.json({ accessToken: "t" });
      if (url.pathname.includes("/projects/slug/"))
        return Response.json({ id: "pid" });
      return Response.json({}, { status: options.persistStatus ?? 200 });
    },
  };
  return { deps, out, err, files, requests, deleted };
}

const builder = (n: number, snapshotId: string): BuilderInfo => ({
  name: `code-reviewer-golden-builder-${String(n)}`,
  createdAt: n,
  snapshotId,
});

const text = (h: Harness): string => [...h.out, ...h.err].join("\n");

describe("snapshot:ops decide", () => {
  const args = (extra: string[] = []) => [
    "decide",
    "--sha",
    SHA,
    "--env-file",
    ".vercel/.env.production.local",
    "--github-output",
    "OUT",
    ...extra,
  ];

  // #403-T13
  it("writes a reuse decision with the pair as step outputs and masks the ids", async () => {
    const h = harness();

    expect(await runOps(args(), h.deps)).toBe(0);

    const output = h.files.get("OUT") ?? "";
    expect(output).toContain("rebuild=false\n");
    expect(output).toContain("reason=inputs_unchanged\n");
    expect(output).toContain(`snapshot-id=${PAIR.snapshotId}\n`);
    expect(output).toContain(`image-digest=${PAIR.imageDigest}\n`);
    expect(output).toContain(`commit=${PAIR.commit}\n`);
    expect(output).toContain(`sysbox=${PAIR.sysbox}\n`);
    expect(output).toContain("repair=false\n");
    // The ids go to the outputs file only (they are not secrets, and GitHub drops an output that holds a masked value).
    expect(text(h)).not.toContain(PAIR.snapshotId);
    expect(text(h)).not.toContain(PAIR.imageDigest);
  });

  // #403-T13
  it("writes a rebuild decision without a pair when the inputs changed", async () => {
    const h = harness({ changed: true });

    expect(await runOps(args(), h.deps)).toBe(0);

    const output = h.files.get("OUT") ?? "";
    expect(output).toContain("rebuild=true\n");
    expect(output).toContain("reason=inputs_changed\n");
    expect(output).not.toMatch(/^snapshot-id=/m);
    // What production runs now, to be kept next to the new snapshot.
    expect(output).toContain(`previous-snapshot-id=${PAIR.snapshotId}\n`);
  });

  // #403-T13
  it("rebuilds on the first deployment, when the pulled file holds no pair", async () => {
    const h = harness({ file: envFile(undefined) });

    await runOps(args(), h.deps);

    expect(h.files.get("OUT")).toContain("reason=pair_missing\n");
  });

  // #403-T13
  it("rebuilds when told to, and takes the live pair over a stale variable", async () => {
    const forced = harness();
    await runOps(args(["--force"]), forced.deps);
    expect(forced.files.get("OUT")).toContain("reason=forced\n");

    const repaired = harness({
      live: NEW,
      file: envFile(PAIR),
      builders: [builder(1, NEW.snapshotId)],
    });
    await runOps(args(), repaired.deps);
    const output = repaired.files.get("OUT") ?? "";
    expect(output).toContain(`snapshot-id=${NEW.snapshotId}\n`);
    expect(output).toContain("repair=true\n");
  });

  // #403-T13
  it("stops, and writes nothing, when the live deployment cannot be read: stale variables must not decide", async () => {
    const h = harness({ live: "unavailable" });

    expect(await runOps(args(), h.deps)).toBe(1);

    expect(h.files.size).toBe(0);
    expect(text(h)).toContain("live_pair_unavailable");
  });

  // #403-T21
  it("rebuilds when the snapshot of the pair is gone, and says why", async () => {
    const h = harness({ builders: [builder(1, "snap_other99")] });

    expect(await runOps(args(), h.deps)).toBe(0);

    expect(h.files.get("OUT")).toContain("rebuild=true\n");
    expect(h.files.get("OUT")).toContain("reason=snapshot_missing\n");
  });

  // #403-T21
  it("stops the run when the snapshots cannot be listed", async () => {
    const h = harness({ listFails: true });

    expect(await runOps(args(), h.deps)).toBe(1);

    expect(text(h)).toContain("snapshot_lookup_failed");
    expect(h.files.size).toBe(0);
  });

  // #403-T21
  it("keeps the snapshot of a pair set up by hand, with no commit, as the previous one", async () => {
    const h = harness({
      file: 'SANDBOX_SNAPSHOT_ID="snap_by_hand01"\nSANDBOX_IMAGE_DIGEST="sha256:abc"\n',
    });

    expect(await runOps(args(), h.deps)).toBe(0);

    expect(h.files.get("OUT")).toContain("reason=pair_missing\n");
    expect(h.files.get("OUT")).toContain(
      "previous-snapshot-id=snap_by_hand01\n",
    );
  });

  // #403-T13
  it.each([
    ["no sha", ["decide", "--env-file", "x", "--github-output", "OUT"]],
    [
      "a sha that is not one",
      ["decide", "--sha", "main", "--env-file", "x", "--github-output", "OUT"],
    ],
    [
      "an unknown option",
      [
        "decide",
        "--sha",
        SHA,
        "--env-file",
        "x",
        "--github-output",
        "OUT",
        "--nope",
      ],
    ],
    ["no command", []],
    ["an unknown command", ["frobnicate"]],
  ])("refuses %s with exit 2 and nothing written", async (_name, argv) => {
    const h = harness();

    expect(await runOps(argv, h.deps)).toBe(2);

    expect(h.files.size).toBe(0);
  });
});

describe("snapshot:ops persist", () => {
  const PAIR_ENV = {
    PAIR_SNAPSHOT_ID: NEW.snapshotId,
    PAIR_IMAGE_DIGEST: NEW.imageDigest,
    PAIR_COMMIT: NEW.commit,
    PAIR_SYSBOX: NEW.sysbox,
  };

  // #403-T15
  it("writes the pair of the environment to Infisical and prints nothing of it", async () => {
    const h = harness({ env: PAIR_ENV });

    expect(await runOps(["persist"], h.deps)).toBe(0);

    const writes = h.requests.filter((r) =>
      r.url.pathname.startsWith("/api/v4/secrets/"),
    );
    expect(
      writes.map((r) => (r.body as { secretValue: string }).secretValue),
    ).toEqual([
      "unproven",
      NEW.snapshotId,
      NEW.imageDigest,
      NEW.commit,
      NEW.sysbox,
    ]);
    // Every line the command prints is a code.
    expect(text(h)).not.toContain(NEW.snapshotId);
    expect(text(h)).not.toContain(NEW.imageDigest);
    expect(text(h)).not.toContain(INFISICAL.INFISICAL_CLIENT_SECRET);
  });

  // #403-T15
  it("restores the pair of an earlier deployment for a rollback, read from that deployment's meta", async () => {
    const h = harness({ live: PAIR });

    expect(
      await runOps(
        ["persist", "--from-deployment", "dpl_oldexample01"],
        h.deps,
      ),
    ).toBe(0);

    const lookup = h.requests.find(
      (r) => r.url.pathname === "/v13/deployments/dpl_oldexample01",
    );
    expect(lookup).toBeDefined();
    const writes = h.requests.filter((r) =>
      r.url.pathname.startsWith("/api/v4/secrets/"),
    );
    expect(
      writes.map((r) => (r.body as { secretValue: string }).secretValue),
    ).toEqual([
      "unproven",
      PAIR.snapshotId,
      PAIR.imageDigest,
      PAIR.commit,
      PAIR.sysbox,
    ]);
  });

  // #745-T02
  it("writes a verdict of unproven for a deployment that carries none, so that no proven stays behind", async () => {
    const h = harness({ live: PAIR });
    // The deployment predates the fourth member: its meta has the snapshot, the image and the commit only.
    const fetchWithOldMeta = h.deps.fetch;
    const deps: typeof h.deps = {
      ...h.deps,
      fetch: async (input, init) => {
        const answer = await fetchWithOldMeta(input, init);
        const url = new URL(new Request(input, init).url);
        if (url.pathname !== "/v13/deployments/dpl_oldexample01") return answer;
        const body = (await answer.json()) as { meta: Record<string, string> };
        delete body.meta.sandboxSysboxProof;
        return Response.json(body);
      },
    };

    expect(
      await runOps(["persist", "--from-deployment", "dpl_oldexample01"], deps),
    ).toBe(0);

    const writes = h.requests.filter((r) =>
      r.url.pathname.startsWith("/api/v4/secrets/"),
    );
    expect(
      writes.map((r) => (r.body as { secretValue: string }).secretValue),
    ).toEqual(["unproven", PAIR.snapshotId, PAIR.imageDigest, PAIR.commit]);
  });

  // #403-T15
  it("takes the deployment as an address with its scheme too, as the CLI and the dashboard print it", async () => {
    const h = harness({ live: PAIR });

    expect(
      await runOps(
        ["persist", "--from-deployment", "https://example-abc.vercel.app"],
        h.deps,
      ),
    ).toBe(0);

    expect(
      h.requests.some(
        (r) => r.url.pathname === "/v13/deployments/example-abc.vercel.app",
      ),
    ).toBe(true);
  });

  // #403-T15
  it.each([
    "--evil",
    "https://example.com",
    "dpl_x y",
    "https://example.vercel.app/x",
  ])(
    "refuses %j as the deployment to restore from, with exit 2 and no request",
    async (value) => {
      const h = harness({ live: PAIR });

      expect(
        await runOps(["persist", "--from-deployment", value], h.deps),
      ).toBe(2);

      expect(h.requests).toEqual([]);
    },
  );

  // #403-T15
  it("does nothing, and says so, for a deployment that carries no pair", async () => {
    const h = harness({ live: "none" });

    expect(
      await runOps(
        ["persist", "--from-deployment", "dpl_oldexample01"],
        h.deps,
      ),
    ).toBe(0);

    expect(
      h.requests.some((r) => r.url.pathname.startsWith("/api/v4/secrets/")),
    ).toBe(false);
    expect(text(h)).toContain("deployment_without_pair");
  });

  // #403-T15
  it("fails loudly with the code when a write is refused", async () => {
    const h = harness({ env: PAIR_ENV, persistStatus: 403 });

    expect(await runOps(["persist"], h.deps)).toBe(1);

    expect(text(h)).toContain("infisical_write_failed");
  });

  // #403-T15
  it.each([
    ["no pair in the environment", {}],
    [
      "a pair of the wrong shape",
      {
        PAIR_SNAPSHOT_ID: "x y",
        PAIR_IMAGE_DIGEST: "latest",
        PAIR_COMMIT: "abc",
      },
    ],
  ])("refuses %s with exit 2", async (_name, env) => {
    const h = harness({ env });

    expect(await runOps(["persist"], h.deps)).toBe(2);

    expect(h.requests).toEqual([]);
  });

  // #403-T15
  it.each([
    "INFISICAL_DOMAIN",
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_PROJECT_SLUG",
  ])("refuses to start without %s, naming it", async (name) => {
    const h = harness({ env: { ...PAIR_ENV, [name]: "" } });

    expect(await runOps(["persist"], h.deps)).toBe(2);

    expect(text(h)).toContain(name);
    expect(h.requests).toEqual([]);
  });
});

describe("snapshot:ops cleanup", () => {
  const four = [
    builder(1, "snap_a"),
    builder(2, "snap_b"),
    builder(3, PAIR.snapshotId),
    builder(4, NEW.snapshotId),
  ];
  const KEEP = { KEEP_SNAPSHOT_IDS: `${NEW.snapshotId} ${PAIR.snapshotId}` };

  // #403-T16
  it("removes the older builders, keeps the new and the previous snapshot, and protects the live one too", async () => {
    const h = harness({ builders: four, env: KEEP, live: NEW });

    expect(await runOps(["cleanup"], h.deps)).toBe(0);

    expect(h.deleted).toEqual([builder(1, "").name, builder(2, "").name]);
  });

  // #403-T16
  it("also keeps what the live deployment uses when the caller did not name it", async () => {
    const h = harness({
      builders: four,
      env: { KEEP_SNAPSHOT_IDS: NEW.snapshotId },
      live: PAIR,
    });

    await runOps(["cleanup"], h.deps);

    expect(h.deleted).not.toContain(builder(3, "").name);
    expect(h.deleted).not.toContain(builder(4, "").name);
  });

  // #403-T16
  it("removes nothing, and fails, when the live deployment cannot be read: it could be the one to delete", async () => {
    const h = harness({ builders: four, env: KEEP, live: "unavailable" });

    expect(await runOps(["cleanup"], h.deps)).toBe(1);

    expect(h.deleted).toEqual([]);
    expect(text(h)).toContain("cleanup_refused");
  });

  // #403-T16
  it("removes nothing when the kept snapshots are not among the builders", async () => {
    const h = harness({
      builders: four,
      env: { KEEP_SNAPSHOT_IDS: "snap_unknown" },
    });

    expect(await runOps(["cleanup"], h.deps)).toBe(1);

    expect(h.deleted).toEqual([]);
  });

  // #403-T16
  it("goes on after a builder that cannot be deleted, reports it, and fails at the end", async () => {
    const h = harness({
      builders: four,
      env: KEEP,
      live: NEW,
      deleteFails: builder(1, "").name,
    });

    expect(await runOps(["cleanup"], h.deps)).toBe(1);

    expect(h.deleted).toEqual([builder(2, "").name]);
    expect(text(h)).toContain("cleanup_incomplete");
  });

  // #403-T16
  it("discards the snapshot of a run that did not reach production, unless the live deployment uses it", async () => {
    const discard = harness({
      builders: four,
      env: {
        KEEP_SNAPSHOT_IDS: PAIR.snapshotId,
        DISCARD_SNAPSHOT_ID: NEW.snapshotId,
      },
      live: PAIR,
    });
    expect(await runOps(["cleanup"], discard.deps)).toBe(0);
    expect(discard.deleted).toEqual([builder(4, "").name]);

    // A promotion that timed out but went through: the live deployment already uses it.
    const live = harness({
      builders: four,
      env: {
        KEEP_SNAPSHOT_IDS: PAIR.snapshotId,
        DISCARD_SNAPSHOT_ID: NEW.snapshotId,
      },
      live: NEW,
    });
    expect(await runOps(["cleanup"], live.deps)).toBe(0);
    expect(live.deleted).toEqual([]);
  });

  // #403-T16
  it("prints the names of no snapshot", async () => {
    const h = harness({ builders: four, env: KEEP, live: NEW });

    await runOps(["cleanup"], h.deps);

    for (const id of ["snap_a", PAIR.snapshotId, NEW.snapshotId])
      expect(text(h)).not.toContain(id);
  });
});

describe("snapshot:ops verify", () => {
  const deployment = (overrides: Record<string, unknown> = {}) => ({
    id: "dpl_oldexample01",
    projectId: VERCEL.VERCEL_PROJECT_ID,
    ownerId: VERCEL.VERCEL_TEAM_ID,
    target: "production",
    readyState: "READY",
    ...overrides,
  });

  function verifying(body: Record<string, unknown>, status = 200) {
    const h = harness();
    const inner = h.deps.fetch;
    h.deps.fetch = (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/v13/deployments/dpl_oldexample01")
        return Promise.resolve(Response.json(body, { status }));
      return inner(input, init);
    };
    return h;
  }

  // #403-T18
  it("passes for a ready production deployment of the project", async () => {
    const h = verifying(deployment());

    expect(
      await runOps(["verify", "--deployment", "dpl_oldexample01"], h.deps),
    ).toBe(0);
  });

  // #403-T18
  it.each([
    ["another project", { projectId: "prj_other" }],
    ["a preview", { target: null }],
  ])("refuses %s with a code and exit 1", async (_name, overrides) => {
    const h = verifying(deployment(overrides));

    expect(
      await runOps(["verify", "--deployment", "dpl_oldexample01"], h.deps),
    ).toBe(1);
    expect(text(h)).toContain("deployment_not_production");
  });

  // #403-T18
  it("fails, with another code, when the platform cannot be asked", async () => {
    const h = verifying({}, 500);

    expect(
      await runOps(["verify", "--deployment", "dpl_oldexample01"], h.deps),
    ).toBe(1);
    expect(text(h)).toContain("deployment_lookup_failed");
  });

  // #403-T18
  it.each([
    ["no deployment", ["verify"]],
    [
      "a deployment that is neither an id nor an address",
      ["verify", "--deployment", "--evil"],
    ],
    ["a path", ["verify", "--deployment", "https://example.vercel.app/x"]],
  ])("refuses %s with exit 2", async (_name, argv) => {
    const h = harness();

    expect(await runOps(argv, h.deps)).toBe(2);
    expect(h.requests).toEqual([]);
  });

  // #403-T18
  it("takes a deployment address with its scheme, as the CLI prints it", async () => {
    const h = verifying(deployment());
    const inner = h.deps.fetch;
    h.deps.fetch = (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/v13/deployments/example-abc.vercel.app")
        return Promise.resolve(Response.json(deployment()));
      return inner(input, init);
    };

    expect(
      await runOps(
        ["verify", "--deployment", "https://example-abc.vercel.app"],
        h.deps,
      ),
    ).toBe(0);
  });
});

describe("snapshot:ops exists", () => {
  // #403-T21
  it("passes for a snapshot that is there", async () => {
    const h = harness({ env: { PAIR_SNAPSHOT_ID: PAIR.snapshotId } });

    expect(await runOps(["exists"], h.deps)).toBe(0);
  });

  // #403-T21
  it("fails with a stable code for a snapshot that is gone, and another when the platform cannot say", async () => {
    const gone = harness({ env: { PAIR_SNAPSHOT_ID: "snap_gone99" } });
    expect(await runOps(["exists"], gone.deps)).toBe(1);
    expect(text(gone)).toContain("snapshot_missing");

    const offline = harness({
      env: { PAIR_SNAPSHOT_ID: PAIR.snapshotId },
      listFails: true,
    });
    expect(await runOps(["exists"], offline.deps)).toBe(1);
    expect(text(offline)).toContain("snapshot_lookup_failed");
  });

  // #403-T21
  it("refuses a value that is not a snapshot id, with exit 2 and no request", async () => {
    const h = harness({ env: { PAIR_SNAPSHOT_ID: "snap x" } });

    expect(await runOps(["exists"], h.deps)).toBe(2);
    expect(h.requests).toEqual([]);
  });
});

describe("snapshot:ops verify --check-snapshot", () => {
  const dpl = "dpl_oldexample01";
  function rolling(snapshotId: string | undefined, builders: BuilderInfo[]) {
    const h = harness({ builders });
    const inner = h.deps.fetch;
    h.deps.fetch = (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === `/v13/deployments/${dpl}`)
        return Promise.resolve(
          Response.json({
            id: dpl,
            projectId: VERCEL.VERCEL_PROJECT_ID,
            ownerId: VERCEL.VERCEL_TEAM_ID,
            target: "production",
            readyState: "READY",
            meta:
              snapshotId === undefined
                ? {}
                : pairToMeta({ ...PAIR, snapshotId }),
          }),
        );
      return inner(input, init);
    };
    return h;
  }
  const argv = ["verify", "--deployment", dpl, "--check-snapshot"];

  // #403-T21
  it("passes when the snapshot of the deployment's pair is still there", async () => {
    expect(
      await runOps(
        argv,
        rolling(PAIR.snapshotId, [builder(1, PAIR.snapshotId)]).deps,
      ),
    ).toBe(0);
  });

  // #403-T21
  it("refuses the rollback with a stable code when that snapshot is gone: it would put production on a Dispatcher that cannot start a job", async () => {
    const h = rolling(PAIR.snapshotId, [builder(1, "snap_other99")]);

    expect(await runOps(argv, h.deps)).toBe(1);

    expect(text(h)).toContain("rollback_snapshot_missing");
  });

  // #403-T21
  it("lets a deployment without a pair through (made by hand: nothing to check), and stops when the platform cannot say", async () => {
    expect(await runOps(argv, rolling(undefined, []).deps)).toBe(0);

    const offline = rolling(PAIR.snapshotId, []);
    offline.deps.createService = () => ({
      createVm: () => Promise.reject(new Error("x")),
      listBuilders: () => Promise.reject(new Error("offline")),
      deleteBuilder: () => Promise.resolve(),
    });
    expect(await runOps(argv, offline.deps)).toBe(1);
    expect(text(offline)).toContain("snapshot_lookup_failed");
  });

  // #403-T21
  it("does not look at snapshots without the flag (the App has none)", async () => {
    const h = rolling(PAIR.snapshotId, [builder(1, "snap_other99")]);

    expect(await runOps(["verify", "--deployment", dpl], h.deps)).toBe(0);
  });
});

describe("snapshot:ops cleanup, leftovers", () => {
  // #403-T22
  it("leaves a young snapshot that is not kept alone, and clears a builder that never got a snapshot", async () => {
    const h = harness({
      env: { KEEP_SNAPSHOT_IDS: NEW.snapshotId },
      live: NEW,
      builders: [
        builder(1, "snap_old"),
        {
          name: "code-reviewer-golden-builder-young",
          createdAt: 1_000_000_000 - 60_000,
          snapshotId: "snap_young",
        },
        {
          name: "code-reviewer-golden-builder-killed",
          createdAt: 1_000_000_000 - 4 * 3_600_000,
        },
        builder(4, NEW.snapshotId),
      ],
    });

    expect(await runOps(["cleanup"], h.deps)).toBe(0);

    expect(h.deleted.sort()).toEqual([
      "code-reviewer-golden-builder-1",
      "code-reviewer-golden-builder-killed",
    ]);
  });
});
