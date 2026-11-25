// SPDX-License-Identifier: LicenseRef-Proprietary

// The Cloudflare placement's client of the cf-sandbox API (#1158): the Dispatcher's port over HTTP, against the double in `fakes/cf-sandbox/` and held to
// `contracts/cf-sandbox.v1.json` (the bodies it sends and reads are valid under the schema, the failure kinds are the port's, the routes are the contract's).
import { Ajv2020 } from "ajv/dist/2020.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeCfSandbox } from "../../../fakes/cf-sandbox/service.ts";
import { createCfSandboxService } from "./cf-sandbox.ts";
import {
  SANDBOX_FAILURE_KINDS,
  SandboxServiceError,
  type SandboxCreateOptions,
} from "./sandbox-service.ts";

const CONTRACTS = join(import.meta.dirname, "..", "..", "..", "contracts");
const contract = JSON.parse(
  readFileSync(join(CONTRACTS, "cf-sandbox.v1.json"), "utf8"),
) as { $id: string; $defs: Record<string, unknown> };
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(contract);

function valid(definition: string, value: unknown): boolean {
  const check = ajv.getSchema(`${contract.$id}#/$defs/${definition}`);
  if (check === undefined) throw new Error(`no definition ${definition}`);
  const ok = check(value) as boolean;
  if (!ok) throw new Error(`${definition}: ${JSON.stringify(check.errors)}`);
  return ok;
}

const TOKEN = "t".repeat(40);
const JOB = "0f8fad5b-d9cb-469f-a165-70867728950e";
const NAME = `cr-implementer-${JOB}-cf-1a2b3c4d`;
const SECRET = "crj_EXAMPLEexampleEXAMPLEexampleEXAMPLE-0123456";

function create(
  overrides: Partial<SandboxCreateOptions> = {},
): SandboxCreateOptions {
  return {
    name: NAME,
    placement: "cloudflare",
    snapshotId: "cloudflare-image",
    region: "cloudflare",
    vcpus: 4,
    timeoutMs: 4_200_000,
    tags: {
      app: "code-reviewer",
      kind: "implementer",
      job: JOB,
      tenant: "reviewer",
    },
    persistent: false,
    ...overrides,
  };
}

function setup(
  options: { timeouts?: { create?: number; call?: number } } = {},
) {
  const fake = new FakeCfSandbox({ token: TOKEN });
  const service = createCfSandboxService({
    baseUrl: "https://cr-sandbox.example.workers.dev/",
    token: TOKEN,
    instanceTypes: new Map([[4, "standard-4"]]),
    fetch: fake.fetch,
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
  });
  return { fake, service };
}

async function kindOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SandboxServiceError) return error.kind;
    throw error;
  }
  return "no error";
}

describe("the contract of the cf-sandbox API", () => {
  // #1158-C01
  it("has valid examples, and nothing else is in the directory", () => {
    const names = readdirSync(join(CONTRACTS, "examples", "cf-sandbox")).sort();
    for (const file of names) {
      const definition = file.replace(/\.json$/, "");
      const example = JSON.parse(
        readFileSync(join(CONTRACTS, "examples", "cf-sandbox", file), "utf8"),
      ) as unknown;
      expect(valid(definition, example)).toBe(true);
    }
    expect(names).toContain("CreateRequest.json");
    expect(names).toContain("HealthResponse.json");
  });

  // #1158-C02
  it("names the failure kinds of the Dispatcher's port, the same ones", () => {
    const kinds = (
      contract.$defs.ErrorResponse as {
        properties: { error: { enum: string[] } };
      }
    ).properties.error.enum;
    expect([...kinds].sort()).toEqual([...SANDBOX_FAILURE_KINDS].sort());
  });
});

describe("the Cloudflare SandboxService", () => {
  // #1158-C10
  it("creates a VM with the instance type of its size, its tags and its lifetime, with the bearer token, and returns a VM of that name", async () => {
    const { fake, service } = setup();

    const vm = await service.create(create());

    expect(vm.name).toBe(NAME);
    const [request] = fake.requests;
    expect(request).toMatchObject({
      method: "POST",
      path: "/v1/vms",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(request?.body).toEqual({
      name: NAME,
      instanceType: "standard-4",
      timeoutMs: 4_200_000,
      tags: {
        app: "code-reviewer",
        kind: "implementer",
        job: JOB,
        tenant: "reviewer",
      },
    });
    expect(valid("CreateRequest", request?.body)).toBe(true);
  });

  // #1158-C11
  it("keeps the lifetime inside what the Worker accepts", async () => {
    const { fake, service } = setup();
    await service.create(create({ timeoutMs: 1000 }));
    await service.create(
      create({
        name: `cr-implementer-${JOB}-cf-ffffffff`,
        timeoutMs: 99_999_999_999,
      }),
    );
    expect(
      fake.requests.map((r) => (r.body as { timeoutMs: number }).timeoutMs),
    ).toEqual([60_000, 21_600_000]);
  });

  // #1158-C12
  it("refuses a size no instance type was configured for, without a call", async () => {
    const { fake, service } = setup();
    expect(await kindOf(service.create(create({ vcpus: 8 })))).toBe("rejected");
    expect(fake.requests).toEqual([]);
  });

  // #1158-C13
  it("maps what the Worker says to the failure kinds of the port, the body's own kind first, then the status", async () => {
    const { fake, service } = setup();
    const cases: [number, unknown, string][] = [
      [400, { error: "rejected" }, "rejected"],
      [401, { error: "auth_failed" }, "auth_failed"],
      [404, { error: "not_ready" }, "not_ready"],
      [429, { error: "rate_limited" }, "rate_limited"],
      [503, { error: "unavailable" }, "unavailable"],
      [503, { error: "quota_exceeded" }, "quota_exceeded"],
      [500, "<html>", "unavailable"],
      [502, null, "unavailable"],
      [429, "nope", "rate_limited"],
      [400, undefined, "rejected"],
    ];
    for (const [status, body, kind] of cases) {
      fake.failNext(status, body);
      expect(
        await kindOf(
          service.create(create({ name: `${NAME}-${String(status)}` })),
        ),
      ).toBe(kind);
    }
  });

  // #1158-C14
  it("takes a wrong token as auth_failed and carries neither token nor body in the error", async () => {
    const fake = new FakeCfSandbox({ token: TOKEN });
    const service = createCfSandboxService({
      baseUrl: "https://cr-sandbox.example",
      token: "x".repeat(40),
      instanceTypes: new Map([[4, "standard-4"]]),
      fetch: fake.fetch,
    });

    const error = await service.create(create()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxServiceError);
    expect((error as Error).message).toBe("auth_failed");
    expect(JSON.stringify(error)).not.toContain("x".repeat(40));
  });

  // #1158-C15
  it("is a network failure when nothing answers, and unavailable when the call runs out of time", async () => {
    const down = createCfSandboxService({
      baseUrl: "https://cr-sandbox.example",
      token: TOKEN,
      instanceTypes: new Map([[4, "standard-4"]]),
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(await kindOf(down.create(create()))).toBe("network");

    const slow = createCfSandboxService({
      baseUrl: "https://cr-sandbox.example",
      token: TOKEN,
      instanceTypes: new Map([[4, "standard-4"]]),
      timeouts: { create: 20 },
      fetch: (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          ),
        ),
    });
    expect(await kindOf(slow.create(create()))).toBe("unavailable");
  });

  // #1158-C16
  it("lets the caller's abort through as an AbortError, so the launcher can tell it from a failure", async () => {
    const { fake, service } = setup();
    const release = fake.holdNextCreate();
    const controller = new AbortController();

    const pending = service.create(create(), controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    release();
  });

  // #1158-C17
  it("answers a body of another shape as unavailable and reads nothing of it", async () => {
    const { fake, service } = setup();
    fake.failNext(201, { unexpected: SECRET });
    const error = await service.create(create()).catch((e: unknown) => e);
    expect((error as SandboxServiceError).kind).toBe("unavailable");
    expect(String(error)).not.toContain(SECRET);
  });
});

describe("a Cloudflare VM", () => {
  async function started() {
    const s = setup();
    const vm = await s.service.create(create());
    return { ...s, vm };
  }

  // #1158-C20
  it("runs a command to its end with the label, the vector, sudo and a timeout, and returns exit code and output", async () => {
    const { fake, vm } = await started();
    fake.onExec("image-id", {
      exitCode: 0,
      stdout: "sha256:abc\n",
      stderr: "warn",
    });

    const done = await vm.exec({
      label: "image-id",
      cmd: "docker",
      args: ["image", "inspect", "x"],
      sudo: true,
      timeoutMs: 30_000,
    });

    expect(done).toEqual({
      exitCode: 0,
      stdout: "sha256:abc\n",
      stderr: "warn",
    });
    const sent = fake.requests.at(-1);
    expect(sent?.path).toBe(`/v1/vms/${NAME}/exec`);
    expect(sent?.body).toEqual({
      label: "image-id",
      cmd: "docker",
      args: ["image", "inspect", "x"],
      sudo: true,
      timeoutMs: 30_000,
    });
    expect(valid("ExecRequest", sent?.body)).toBe(true);
  });

  // #1158-C21
  it("holds the timeout of an exec to what the Worker accepts, 1 s to 10 min, 2 min without one", async () => {
    const { fake, vm } = await started();
    const exec = (timeoutMs?: number) =>
      vm.exec({
        label: "step",
        cmd: "true",
        args: [],
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    await exec(5);
    await exec(99_999_999);
    await exec();
    expect(
      fake.requests
        .filter((r) => r.path.endsWith("/exec"))
        .map((r) => (r.body as { timeoutMs: number }).timeoutMs),
    ).toEqual([1000, 600_000, 120_000]);
  });

  // #1158-C22
  it("starts a process with its stdin open, writes to it, closes it and waits for the exit code in polls", async () => {
    const { fake, vm } = await started();
    const worker = await vm.start({
      label: "docker-run",
      cmd: "docker",
      args: ["run"],
      sudo: true,
    });
    await worker.writeStdin(`{"credential":"${SECRET}"}\n`);
    await worker.closeStdin();

    const waiting = worker.wait();
    // A first poll answers `running`; the process ends before the next one.
    fake.exitProcess(NAME, 3);

    expect(await waiting).toEqual({ exitCode: 3 });
    expect(fake.stdinOf(NAME)).toContain(SECRET);
    const polls = fake.requests.filter(
      (r) => r.method === "GET" && r.path.includes("/processes/"),
    );
    expect(polls[0]?.query).toEqual({ waitMs: "25000" });
  });

  // #1158-C23
  it("keeps the per-job credential out of everything but the stdin call", async () => {
    const { fake, vm } = await started();
    const worker = await vm.start({
      label: "docker-run",
      cmd: "docker",
      args: ["run", "--interactive"],
      sudo: true,
    });
    await worker.writeStdin(`{"credential":"${SECRET}"}\n`);
    await worker.closeStdin();

    expect(fake.requestText()).not.toContain(SECRET);
    expect(fake.stdinOf(NAME)).toContain(SECRET);
    for (const request of fake.requests.filter((r) =>
      r.path.endsWith("/stdin"),
    ))
      expect(valid("StdinRequest", request.body)).toBe(true);
  });

  // #1158-C24
  it("stops waiting with an AbortError when the caller's signal aborts, and asks again while the process runs", async () => {
    const { vm } = await started();
    const worker = await vm.start({
      label: "docker-run",
      cmd: "docker",
      args: [],
      sudo: true,
    });
    const controller = new AbortController();

    const waiting = worker.wait(controller.signal);
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  // #1158-C25
  it("is not_ready for a VM the Worker does not have, and that is a failure of the call, not of the port", async () => {
    const { vm, fake } = await started();
    fake.vms.delete(NAME);
    expect(await kindOf(vm.exec({ label: "x", cmd: "true", args: [] }))).toBe(
      "not_ready",
    );
  });
});

describe("the Cloudflare SandboxFleet", () => {
  // #1158-C30
  it("stops a VM by deleting it, and a VM that is gone is no error", async () => {
    const { fake, service } = setup();
    await service.create(create());
    await service.stop(NAME);
    expect(fake.vms.size).toBe(0);
    await service.stop(NAME);
    expect(fake.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/v1/vms/${NAME}`,
    });
  });

  // #1158-C31
  it("treats a 404 on delete as gone, and any other failure as one", async () => {
    const { fake, service } = setup();
    fake.failNext(404, { error: "not_ready" });
    await service.stop(NAME);
    fake.failNext(503, { error: "unavailable" });
    expect(await kindOf(service.stop(NAME))).toBe("unavailable");
  });

  // #1158-C32
  it("lists by name prefix and one tag, and returns what the reaper reads", async () => {
    const { fake, service } = setup();
    await service.create(create());
    fake.seedVm({
      name: "cr-canary-1234abcd",
      tags: { app: "other" },
      status: "pending",
    });

    const listed = await service.list({
      namePrefix: "cr-implementer-",
      tags: { app: "code-reviewer" },
    });

    expect(listed).toEqual([
      expect.objectContaining({
        name: NAME,
        status: "running",
        timeoutMs: 4_200_000,
        tags: expect.objectContaining({ job: JOB }),
      }),
    ]);
    expect(fake.requests.at(-1)?.query).toEqual({
      namePrefix: "cr-implementer-",
      tag: "app:code-reviewer",
    });
    expect(valid("ListResponse", { vms: listed })).toBe(true);
  });

  // #1158-C33
  it("deletes a VM that the Worker no longer lists, and keeps one that is listed as running", async () => {
    const { fake, service } = setup();
    await service.create(create());

    expect(await service.delete(NAME)).toBe("kept");
    expect(fake.vms.has(NAME)).toBe(true);
    expect(await service.delete("cr-implementer-gone")).toBe("deleted");
  });

  // #1158-C34
  it("sets the network policy of a VM, and says not_ready for one that is not running", async () => {
    const { fake, service } = setup();
    await service.create(create());

    await service.setNetworkPolicy(NAME, {
      allow: ["github.com", "*.example.com"],
    });
    await service.setNetworkPolicy(NAME, "deny-all");

    const puts = fake.requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => r.body)).toEqual([
      { policy: { allow: ["github.com", "*.example.com"] } },
      { policy: "deny-all" },
    ]);
    for (const put of puts)
      expect(valid("NetworkRequest", put.body)).toBe(true);
    expect(
      await kindOf(
        service.setNetworkPolicy("cr-implementer-nowhere", "allow-all"),
      ),
    ).toBe("not_ready");
  });
});

describe("the health of the Worker", () => {
  // #1158-C40
  it("is read without the token and carries what the claim features and the image check need", async () => {
    const fake = new FakeCfSandbox({
      token: TOKEN,
      workerFeatures: ["implementer_workspace_token"],
      imageVersion: "abc123",
    });
    const service = createCfSandboxService({
      baseUrl: "https://cr-sandbox.example",
      token: TOKEN,
      instanceTypes: new Map([[4, "standard-4"]]),
      fetch: fake.fetch,
    });

    const health = await service.health();

    expect(health).toMatchObject({
      imageVersion: "abc123",
      workerFeatures: ["implementer_workspace_token"],
      instanceTypes: ["standard-4"],
      workerImageId: `sha256:${"a".repeat(64)}`,
    });
    expect(fake.requests[0]?.authorization).toBeNull();
    expect(valid("HealthResponse", health)).toBe(true);
  });

  // #1158-C41
  it("fails with unavailable when the Worker does not answer, and with unavailable for an answer of another shape", async () => {
    const { fake, service } = setup();
    fake.healthDown();
    expect(await kindOf(service.health())).toBe("unavailable");
    fake.healthDown(false);
    const odd = createCfSandboxService({
      baseUrl: "https://cr-sandbox.example",
      token: TOKEN,
      instanceTypes: new Map(),
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: false }), { status: 200 }),
        ),
    });
    expect(await kindOf(odd.health())).toBe("unavailable");
  });
});
