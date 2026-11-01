// SPDX-License-Identifier: LicenseRef-Proprietary

import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  SandboxServiceError,
  type SandboxCreateOptions,
  type SandboxFailureKind,
} from "./sandbox-service.ts";
import {
  createVercelSandboxService,
  type SandboxSdk,
  type SdkCommand,
  type SdkSandbox,
} from "./vercel-sandbox.ts";

const CREATE: SandboxCreateOptions = {
  name: "cr-diff-job-1-abcd1234",
  snapshotId: "snap_dummy_golden_0001",
  region: "fra1",
  vcpus: 2,
  timeoutMs: 1_320_000,
  tags: { app: "code-reviewer", kind: "diff", job: "job-1" },
  persistent: false,
};
const PLATFORM_TOKEN = "dummy-platform-token-for-tests-0000";

type Calls = {
  create: Record<string, unknown>[];
  get: Record<string, unknown>[];
  list: Record<string, unknown>[];
  run: Record<string, unknown>[];
  stop: number;
  /** The options of every `delete` call (the argument list, so a call without options is `[]`). */
  delete: unknown[][];
  command: { stdin: string[]; closed: number; waits: number };
};

function standIn(
  options: {
    exitCode?: number;
    output?: { stdout?: string; stderr?: string };
    createError?: unknown;
    getError?: unknown;
    stopError?: unknown;
    deleteError?: unknown;
    /** What `Sandbox.list` yields, one page of two at a time; the real paginator is an async iterable of sandboxes. */
    listed?: unknown[];
    listError?: unknown;
  } = {},
) {
  const calls: Calls = {
    create: [],
    get: [],
    list: [],
    run: [],
    stop: 0,
    delete: [],
    command: { stdin: [], closed: 0, waits: 0 },
  };
  const command: SdkCommand = {
    writeStdin: (data) => {
      calls.command.stdin.push(String(data));
      return Promise.resolve();
    },
    closeStdin: () => {
      calls.command.closed += 1;
      return Promise.resolve();
    },
    wait: () => {
      calls.command.waits += 1;
      return Promise.resolve({ exitCode: options.exitCode ?? 0 });
    },
  };
  const sandbox = {
    name: CREATE.name,
    runCommand(params: Record<string, unknown>) {
      calls.run.push(params);
      if (params.detached === true) return Promise.resolve(command);
      (params.stdout as Writable | undefined)?.write(
        options.output?.stdout ?? "",
      );
      (params.stderr as Writable | undefined)?.write(
        options.output?.stderr ?? "",
      );
      return Promise.resolve({ exitCode: options.exitCode ?? 0 });
    },
    stop() {
      calls.stop += 1;
      return options.stopError === undefined
        ? Promise.resolve({})
        : Promise.reject(options.stopError);
    },
    delete(...args: unknown[]) {
      calls.delete.push(args);
      return options.deleteError === undefined
        ? Promise.resolve()
        : Promise.reject(options.deleteError);
    },
  } as unknown as SdkSandbox;
  const sdk: SandboxSdk = {
    Sandbox: {
      create(params) {
        calls.create.push(params);
        return options.createError === undefined
          ? Promise.resolve(sandbox)
          : Promise.reject(options.createError);
      },
      get(params) {
        calls.get.push(params);
        return options.getError === undefined
          ? Promise.resolve(sandbox)
          : Promise.reject(options.getError);
      },
      list(params) {
        calls.list.push(params);
        if (options.listError !== undefined)
          return Promise.reject(options.listError);
        // The platform's own rule, seen on a real run: a name prefix filters by name, so it needs that sort.
        if (params.namePrefix !== undefined && params.sortBy !== "name")
          return Promise.reject(
            apiError(
              400,
              undefined,
              "Invalid request: `namePrefix` is only valid when `sortBy` is `name`",
            ),
          );
        // The platform's page limit is 50; above it the call is HTTP 400.
        if (typeof params.limit === "number" && params.limit > 50)
          return Promise.reject(
            apiError(400, undefined, "Invalid request: `limit` is at most 50"),
          );
        const prefix = params.namePrefix;
        const items = (options.listed ?? []).filter(
          (item) =>
            typeof prefix !== "string" ||
            String((item as { name: string }).name).startsWith(prefix),
        );
        return Promise.resolve(
          (async function* () {
            for (let at = 0; at < items.length; at += 2) {
              await Promise.resolve();
              yield* items.slice(at, at + 2) as never[];
            }
          })(),
        );
      },
    },
  };
  return { sdk, calls };
}

/** What the SDK throws for a failed API call: an `APIError` with the response and the parsed body. */
function apiError(
  status: number,
  code?: string,
  message = "request failed",
): Error {
  return Object.assign(new Error(message), {
    name: "APIError",
    response: { status },
    ...(code === undefined ? {} : { json: { error: { code } } }),
  });
}

describe("the Vercel adapter of the Sandbox port", () => {
  // #329-T03
  it("creates the VM from the snapshot with the options of the port and no failover region, no environment", async () => {
    const { sdk, calls } = standIn();
    const service = createVercelSandboxService(() => Promise.resolve(sdk));

    await service.create(CREATE);

    expect(calls.create).toStrictEqual([
      {
        name: CREATE.name,
        source: { type: "snapshot", snapshotId: CREATE.snapshotId },
        region: "fra1",
        resources: { vcpus: 2 },
        timeout: 1_320_000,
        tags: CREATE.tags,
        persistent: false,
      },
    ]);
    expect(Object.keys(calls.create[0] ?? {})).not.toContain("failoverRegions");
    expect(Object.keys(calls.create[0] ?? {})).not.toContain("env");
  });

  // #329 (additional): authentication
  it("uses the OIDC token of the environment unless credentials are given", async () => {
    const { sdk, calls } = standIn();

    await createVercelSandboxService(() => Promise.resolve(sdk)).create(CREATE);
    await createVercelSandboxService(() => Promise.resolve(sdk), {
      token: PLATFORM_TOKEN,
      teamId: "team_dummy",
      projectId: "prj_dummy",
    }).create(CREATE);

    expect(calls.create[0]).not.toHaveProperty("token");
    expect(calls.create[1]).toMatchObject({
      token: PLATFORM_TOKEN,
      teamId: "team_dummy",
      projectId: "prj_dummy",
    });
  });

  // #329 (additional): the SDK is loaded once, and only when it is needed
  it("loads the SDK on first use and once", async () => {
    const { sdk } = standIn();
    const load = vi.fn(() => Promise.resolve(sdk));
    const service = createVercelSandboxService(load);
    expect(load).not.toHaveBeenCalled();

    await service.create(CREATE);
    await service.stop(CREATE.name);

    expect(load).toHaveBeenCalledTimes(1);
  });

  // #329-T02
  it("runs a command as an argument vector with no shell and collects its output", async () => {
    const { sdk, calls } = standIn({
      output: { stdout: "sha256:abc\n", stderr: "warn" },
    });
    const vm = await createVercelSandboxService(() =>
      Promise.resolve(sdk),
    ).create(CREATE);

    const result = await vm.exec({
      label: "image-id",
      cmd: "docker",
      args: ["image", "inspect", "--format", "{{.Id}}", "ref"],
      sudo: true,
      timeoutMs: 30_000,
    });

    expect(result).toStrictEqual({
      exitCode: 0,
      stdout: "sha256:abc\n",
      stderr: "warn",
    });
    expect(calls.run[0]).toMatchObject({
      cmd: "docker",
      args: ["image", "inspect", "--format", "{{.Id}}", "ref"],
      sudo: true,
      timeoutMs: 30_000,
    });
    expect(calls.run[0]).not.toHaveProperty("env");
    expect(calls.run[0]).not.toHaveProperty("detached");
  });

  // #329-T02
  it("starts a process detached with a stdin pipe, and the start document travels only through the pipe", async () => {
    const document = '{"credential":"crj_dummy-credential"}\n';
    const { sdk, calls } = standIn({ exitCode: 3 });
    const vm = await createVercelSandboxService(() =>
      Promise.resolve(sdk),
    ).create(CREATE);

    const worker = await vm.start({
      label: "docker-run",
      cmd: "docker",
      args: ["run", "--interactive", "image"],
      sudo: true,
    });
    await worker.writeStdin(document);
    await worker.closeStdin();
    const ended = await worker.wait();

    expect(calls.run[0]).toMatchObject({
      cmd: "docker",
      args: ["run", "--interactive", "image"],
      sudo: true,
      detached: true,
      stdin: true,
    });
    expect(calls.run[0]).not.toHaveProperty("env");
    expect(JSON.stringify([calls.create, calls.get, calls.run])).not.toContain(
      "crj_dummy-credential",
    );
    expect(calls.command.stdin).toStrictEqual([document]);
    expect(calls.command.closed).toBe(1);
    expect(ended).toStrictEqual({ exitCode: 3 });
  });

  // #329-T08
  it("stops a VM by looking it up by name", async () => {
    const { sdk, calls } = standIn();
    const service = createVercelSandboxService(() => Promise.resolve(sdk), {
      token: PLATFORM_TOKEN,
      teamId: "team_dummy",
      projectId: "prj_dummy",
    });

    await service.stop(CREATE.name);

    expect(calls.get).toStrictEqual([
      {
        token: PLATFORM_TOKEN,
        teamId: "team_dummy",
        projectId: "prj_dummy",
        name: CREATE.name,
      },
    ]);
    expect(calls.stop).toBe(1);
  });

  // #802-T10
  it("deletes a VM by looking it up by name, without resuming it and without deleting the snapshots it owns", async () => {
    const { sdk, calls } = standIn();
    const service = createVercelSandboxService(() => Promise.resolve(sdk), {
      token: PLATFORM_TOKEN,
      teamId: "team_dummy",
      projectId: "prj_dummy",
    });

    await service.delete(CREATE.name);

    expect(calls.get).toStrictEqual([
      {
        token: PLATFORM_TOKEN,
        teamId: "team_dummy",
        projectId: "prj_dummy",
        name: CREATE.name,
      },
    ]);
    expect(calls.get[0]).not.toHaveProperty("resume");
    expect(calls.stop).toBe(0);
    // The golden snapshot must stay: the options say it in so many words, whatever the SDK's default is.
    expect(calls.delete).toStrictEqual([[{ deleteOrphanSnapshots: false }]]);
  });

  // #802-T10
  it.each([404, 410])(
    "treats a delete of a VM the platform no longer has (%s) as done",
    async (status) => {
      const { sdk, calls } = standIn({ getError: apiError(status) });

      await expect(
        createVercelSandboxService(() => Promise.resolve(sdk)).delete(
          CREATE.name,
        ),
      ).resolves.toBeUndefined();
      expect(calls.delete).toStrictEqual([]);
    },
  );

  // #802-T10
  it("treats a VM that is deleted between the lookup and the delete as done", async () => {
    const { sdk } = standIn({ deleteError: apiError(404) });

    await expect(
      createVercelSandboxService(() => Promise.resolve(sdk)).delete(
        CREATE.name,
      ),
    ).resolves.toBeUndefined();
  });

  // #802-T10
  it("maps a failed delete that is not a missing VM, without the platform's text", async () => {
    const { sdk } = standIn({
      deleteError: apiError(500, undefined, "secret platform text"),
    });

    const error = await createVercelSandboxService(() => Promise.resolve(sdk))
      .delete(CREATE.name)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SandboxServiceError);
    expect((error as SandboxServiceError).kind).toBe("unavailable");
    expect((error as Error).message).not.toContain("secret");
  });

  // #329-T08
  it.each([404, 410])(
    "treats a VM the platform no longer has (%s) as stopped",
    async (status) => {
      const { sdk } = standIn({ getError: apiError(status) });

      await expect(
        createVercelSandboxService(() => Promise.resolve(sdk)).stop(
          CREATE.name,
        ),
      ).resolves.toBeUndefined();
    },
  );

  // #329-T08
  it("treats a stop of a VM that has ended on its own as done", async () => {
    const { sdk } = standIn({ stopError: apiError(410, "sandbox_stopped") });

    await expect(
      createVercelSandboxService(() => Promise.resolve(sdk)).stop(CREATE.name),
    ).resolves.toBeUndefined();
  });

  // #329-T04
  it.each<[string, unknown, SandboxFailureKind]>([
    ["a rate limit", apiError(429), "rate_limited"],
    ["a quota", apiError(402, "quota_exceeded"), "quota_exceeded"],
    [
      "a limit named in a refusal",
      apiError(403, "concurrent_sandbox_limit_exceeded"),
      "quota_exceeded",
    ],
    [
      "a snapshot that does not exist",
      apiError(404, "snapshot_not_found"),
      "snapshot_missing",
    ],
    [
      "a snapshot in another region",
      apiError(400, "snapshot_not_available_in_region"),
      "region_mismatch",
    ],
    ["a snapshot not ready", apiError(409, "snapshot_not_ready"), "not_ready"],
    ["a platform error", apiError(503), "unavailable"],
    ["a bad gateway", apiError(502), "unavailable"],
    ["a refusal of the request", apiError(400, "invalid_request"), "rejected"],
    ["bad credentials", apiError(401), "auth_failed"],
    ["a forbidden request", apiError(403, "forbidden"), "auth_failed"],
    ["an expired token", apiError(401, "token_expired"), "auth_failed"],
    [
      "a refusal that only says limit and exceeds in its text",
      apiError(400, "invalid_timeout", "timeout exceeds the limit"),
      "rejected",
    ],
    [
      "a refusal that says quota in its text but has no code of one",
      apiError(400, "invalid_request", "quota of tags exceeded"),
      "rejected",
    ],
    [
      "no connection",
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET" },
      }),
      "network",
    ],
    [
      "a timeout",
      Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      "network",
    ],
  ])("maps %s to the failure kind %s", async (_what, thrown, kind) => {
    const { sdk } = standIn({ createError: thrown });

    const failed = await createVercelSandboxService(() => Promise.resolve(sdk))
      .create(CREATE)
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(SandboxServiceError);
    expect((failed as SandboxServiceError).kind).toBe(kind);
    // The platform's own text does not travel with it.
    expect((failed as SandboxServiceError).message).toBe(kind);
  });

  // #329-T04
  it("lets an abort through as it is, so the launcher can tell it from a failure", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const { sdk } = standIn({ createError: abort });

    await expect(
      createVercelSandboxService(() => Promise.resolve(sdk)).create(CREATE),
    ).rejects.toBe(abort);
  });

  // #329-T04
  it("maps a failed stop that is not a missing VM", async () => {
    const { sdk } = standIn({ stopError: apiError(500) });

    await expect(
      createVercelSandboxService(() => Promise.resolve(sdk)).stop(CREATE.name),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  // #364-T20
  it("lists the VMs of one tag by a name prefix, with the credentials, across every page, and maps what the reaper reads", async () => {
    const listed = [1, 2, 3].map((n) => ({
      name: `cr-diff-job-${n}-abcd1234`,
      createdAt: 1_700_000_000_000 + n,
      status: "running",
      timeout: 1_500_000,
      persistent: n === 3,
      tags: { app: "code-reviewer", kind: "diff", job: `job-${n}` },
      currentSessionId: "ignored",
      vcpus: 1,
    }));
    const { sdk, calls } = standIn({
      listed: [
        ...listed,
        { name: "other-1", createdAt: 9, status: "running", tags: {} },
      ],
    });
    const service = createVercelSandboxService(() => Promise.resolve(sdk), {
      token: PLATFORM_TOKEN,
      teamId: "team_dummy",
      projectId: "prj_dummy",
    });

    const vms = await service.list({
      namePrefix: "cr-",
      tags: { app: "code-reviewer" },
    });

    expect(calls.list).toStrictEqual([
      {
        token: PLATFORM_TOKEN,
        teamId: "team_dummy",
        projectId: "prj_dummy",
        namePrefix: "cr-",
        // The platform refuses a name prefix with any other sort (HTTP 400).
        sortBy: "name",
        tags: { app: "code-reviewer" },
        limit: 50,
      },
    ]);
    expect(vms).toStrictEqual(
      listed.map((vm) => ({
        name: vm.name,
        createdAtMs: vm.createdAt,
        status: "running",
        timeoutMs: 1_500_000,
        persistent: vm.persistent,
        tags: vm.tags,
      })),
    );
    expect(calls.create).toStrictEqual([]);
    expect(calls.get).toStrictEqual([]);
    expect(calls.stop).toBe(0);
  });

  // #364-T20
  it("asks the platform for the largest page it allows (50), so a fleet of stopped VMs is not listed in many round trips", async () => {
    const { sdk, calls } = standIn({ listed: [] });
    await createVercelSandboxService(() => Promise.resolve(sdk), {
      token: PLATFORM_TOKEN,
      teamId: "team_dummy",
      projectId: "prj_dummy",
    }).list({ namePrefix: "cr-", tags: { app: "code-reviewer" } });

    // The default page is small: 283 stopped VMs took 5.1 s to list and every claim ran into its 4 s limit.
    expect(calls.list).toHaveLength(1);
    const limit = (calls.list[0] as { limit?: unknown }).limit;
    expect(limit).toBe(50);
  });

  it("lists a VM without tags or a timeout with empty tags and no timeout", async () => {
    const { sdk } = standIn({
      listed: [{ name: "cr-x", createdAt: 5, status: "stopped" }],
    });

    const vms = await createVercelSandboxService(() =>
      Promise.resolve(sdk),
    ).list({ namePrefix: "cr-", tags: { app: "code-reviewer" } });

    expect(vms).toStrictEqual([
      { name: "cr-x", createdAtMs: 5, status: "stopped", tags: {} },
    ]);
  });

  // #364-T11
  it("maps a failed listing to a failure kind without the platform's text", async () => {
    const { sdk } = standIn({
      listError: apiError(500, undefined, `boom ${PLATFORM_TOKEN}`),
    });

    const failed = await createVercelSandboxService(() => Promise.resolve(sdk))
      .list({ namePrefix: "cr-", tags: { app: "code-reviewer" } })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(SandboxServiceError);
    expect((failed as SandboxServiceError).kind).toBe("unavailable");
    expect((failed as SandboxServiceError).message).toBe("unavailable");
  });

  // #364-T30
  it("is held to the platform's rule by its stand-in: a name prefix without the name sort is refused", async () => {
    const { sdk } = standIn();

    await expect(sdk.Sandbox.list({ namePrefix: "cr-" })).rejects.toThrow(
      "`namePrefix` is only valid when `sortBy` is `name`",
    );
    await expect(
      sdk.Sandbox.list({ namePrefix: "cr-", sortBy: "createdAt" }),
    ).rejects.toThrow("`namePrefix` is only valid");
    await expect(
      sdk.Sandbox.list({ namePrefix: "cr-", sortBy: "name" }),
    ).resolves.toBeDefined();
  });
});
