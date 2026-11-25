// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { readConfig } from "./config.ts";
import { handle, type HandlerDeps, type VmClient } from "./handler.ts";
import { RegistryController } from "./registry-controller.ts";
import {
  FakeContainer,
  FakeRegistryStorage,
  FakeVmStorage,
  RecordingLogger,
} from "./test-fakes.ts";
import { VmController } from "./vm-controller.ts";

const TOKEN = "s".repeat(40);
const NOW = 2_000_000;

function setup(env: Record<string, string> = {}) {
  const registryStorage = new FakeRegistryStorage();
  const vms = new Map<
    string,
    { controller: VmController; container: FakeContainer }
  >();
  // eslint-style note: the explicit types break the loop between the registry, the VM controllers and their callbacks.
  const vmFor = (
    name: string,
  ): { controller: VmController; container: FakeContainer } => {
    let found = vms.get(name);
    if (!found) {
      const container = new FakeContainer();
      const controller = new VmController({
        container,
        storage: new FakeVmStorage(),
        registry: {
          remove: async (n: string): Promise<void> => registry.remove(n),
        },
        logger: new RecordingLogger(),
        now: () => NOW,
        newId: () => `${vms.size}`,
      });
      found = { controller, container };
      vms.set(name, found);
    }
    return found;
  };
  const registry: RegistryController = new RegistryController(
    registryStorage,
    {
      destroy: async (n: string): Promise<void> =>
        vmFor(n).controller.destroy(),
    },
    () => NOW,
  );
  const deps: HandlerDeps = {
    config: readConfig({
      IMAGE_VERSION: "abc123",
      WORKER_FEATURES: "implementer_multi_repo",
      ...env,
    }),
    token: TOKEN,
    registry,
    vm: (name) => vmFor(name).controller as VmClient,
    now: () => NOW,
  };
  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
  ) =>
    handle(
      new Request(`https://cr-sandbox.example${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      deps,
    );
  return { call, vmFor, registry };
}

const CREATE = {
  name: "job-1",
  instanceType: "standard-4",
  timeoutMs: 3_600_000,
  tags: { cr: "job" },
};

describe("authentication", () => {
  // #1159-T21
  it("answers /health without a credential", async () => {
    const { call } = setup();
    const response = await call("GET", "/health", undefined, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      imageVersion: "abc123",
      workerFeatures: ["implementer_multi_repo"],
      instanceTypes: ["standard-4"],
    });
  });

  // #1159-T21
  it("adds the ids of the inner images to /health when the build gave them", async () => {
    const worker = `sha256:${"1".repeat(64)}`;
    const agent = `sha256:${"2".repeat(64)}`;
    const { call } = setup({ WORKER_IMAGE_ID: worker, AGENT_IMAGE_ID: agent });
    expect(
      await (await call("GET", "/health", undefined, {})).json(),
    ).toMatchObject({ workerImageId: worker, agentImageId: agent });
  });

  // #1159-T21
  it("answers 401 with the kind alone for a missing or wrong credential, on every other route, before it looks at anything else", async () => {
    const { call } = setup();
    for (const [method, path] of [
      ["GET", "/v1/vms"],
      ["POST", "/v1/vms"],
      ["DELETE", "/v1/vms/a"],
      ["GET", "/nothing"],
      ["POST", "/v1/vms/a/exec"],
    ] as const) {
      for (const headers of [
        {} as Record<string, string>,
        { authorization: "Bearer wrong" },
      ]) {
        const response = await call(method, path, undefined, headers);
        expect(response.status, `${method} ${path}`).toBe(401);
        expect(await response.json()).toEqual({ error: "auth_failed" });
      }
    }
  });

  // #1159-T21
  it("answers 404 for a route it does not have, once authenticated", async () => {
    const { call } = setup();
    expect((await call("GET", "/v1/nothing")).status).toBe(404);
  });
});

describe("create, list and delete", () => {
  // #1159-T22
  it("creates a VM, lists it as running with its tags, and deletes it", async () => {
    const { call, vmFor } = setup();
    const created = await call("POST", "/v1/vms", CREATE);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      name: "job-1",
      instanceType: "standard-4",
    });
    expect(vmFor("job-1").container.running).toBe(true);

    const listed = await (
      await call("GET", "/v1/vms?namePrefix=job-&tag=cr:job")
    ).json();
    expect(listed).toEqual({
      vms: [
        {
          name: "job-1",
          createdAtMs: NOW,
          status: "running",
          timeoutMs: 3_600_000,
          tags: { cr: "job" },
        },
      ],
    });
    expect(await (await call("GET", "/v1/vms?tag=cr:other")).json()).toEqual({
      vms: [],
    });

    expect((await call("DELETE", "/v1/vms/job-1")).status).toBe(204);
    expect(vmFor("job-1").container.running).toBe(false);
    expect(await (await call("GET", "/v1/vms")).json()).toEqual({ vms: [] });
  });

  // #1159-T22
  it("treats a delete of a VM that never existed as done", async () => {
    const { call } = setup();
    expect((await call("DELETE", "/v1/vms/never-was")).status).toBe(204);
  });

  // #1159-T23
  it("refuses a body that is not valid, an unknown instance type and a name that exists, with 400", async () => {
    const { call } = setup();
    for (const body of [
      { ...CREATE, name: "BAD" },
      { ...CREATE, instanceType: "standard-9" },
      { ...CREATE, timeoutMs: 1 },
    ]) {
      const response = await call("POST", "/v1/vms", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "rejected" });
    }
    expect((await call("POST", "/v1/vms")).status).toBe(400);
    expect((await call("POST", "/v1/vms", CREATE)).status).toBe(201);
    expect((await call("POST", "/v1/vms", CREATE)).status).toBe(400);
  });

  // #1159-T23
  it("answers 429 beyond the cap of VMs", async () => {
    const { call } = setup({ MAX_VMS: "1" });
    expect((await call("POST", "/v1/vms", CREATE)).status).toBe(201);
    const response = await call("POST", "/v1/vms", {
      ...CREATE,
      name: "job-2",
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });

  // #1159-T24
  it("gives the place back and answers 503 when the VM does not boot", async () => {
    const { call, vmFor, registry } = setup();
    const created = await call("POST", "/v1/vms", {
      ...CREATE,
      name: "bad-boot",
    });
    expect(created.status).toBe(201);
    await call("DELETE", "/v1/vms/bad-boot");
    const container = vmFor("job-2").container;
    container.scripts.set("/usr/local/sbin/cr-sandbox-boot.sh", { exit: 1 });
    const response = await call("POST", "/v1/vms", {
      ...CREATE,
      name: "job-2",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(await registry.list({ namePrefix: "", tag: null })).toEqual([]);
  });
});

describe("exec, processes and the network", () => {
  async function running() {
    const s = setup();
    await s.call("POST", "/v1/vms", CREATE);
    return s;
  }

  // #1159-T25
  it("runs a command and answers 404 for a VM that does not exist", async () => {
    const { call, vmFor } = await running();
    vmFor("job-1").container.scripts.set("docker", {
      exit: 0,
      stdout: "sha256:abc\n",
    });
    const response = await call("POST", "/v1/vms/job-1/exec", {
      label: "image-id",
      cmd: "docker",
      args: ["image", "inspect"],
      sudo: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      exitCode: 0,
      stdout: "sha256:abc\n",
      stderr: "",
      truncated: false,
    });
    const missing = await call("POST", "/v1/vms/nobody/exec", {
      label: "x",
      cmd: "true",
      args: [],
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_ready" });
    expect(
      (await call("POST", "/v1/vms/job-1/exec", { label: "x" })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/v1/vms/BAD/exec", {
          label: "x",
          cmd: "true",
          args: [],
        })
      ).status,
    ).toBe(400);
  });

  // #1159-T26
  it("starts a process, takes stdin, closes it and reports the exit", async () => {
    const { call, vmFor } = await running();
    vmFor("job-1").container.scripts.set("docker", {});
    const started = await call("POST", "/v1/vms/job-1/processes", {
      label: "docker-run",
      cmd: "docker",
      args: ["run"],
    });
    expect(started.status).toBe(201);
    const { processId } = (await started.json()) as { processId: string };
    expect(
      await (await call("GET", `/v1/vms/job-1/processes/${processId}`)).json(),
    ).toEqual({ running: true });
    expect(
      (
        await call("POST", `/v1/vms/job-1/processes/${processId}/stdin`, {
          data: "hello",
        })
      ).status,
    ).toBe(204);
    expect(
      (await call("POST", `/v1/vms/job-1/processes/${processId}/stdin/close`))
        .status,
    ).toBe(204);
    vmFor("job-1").container.execs.at(-1)?.finish(7);
    expect(
      await (
        await call("GET", `/v1/vms/job-1/processes/${processId}?waitMs=100`)
      ).json(),
    ).toEqual({ running: false, exitCode: 7 });
    expect(
      (await call("GET", `/v1/vms/job-1/processes/${processId}?waitMs=25001`))
        .status,
    ).toBe(400);
    expect(
      (await call("GET", "/v1/vms/job-1/processes/p-unknown")).status,
    ).toBe(404);
    expect(
      (
        await call("POST", "/v1/vms/job-1/processes/BAD_ID/stdin", {
          data: "x",
        })
      ).status,
    ).toBe(400);
  });

  // #1159-T27
  it("sets the network policy, effective for the next read, and refuses a policy that is not one", async () => {
    const { call, vmFor } = await running();
    const policy = { allow: ["github.com", "*.pythonhosted.org"] };
    expect(
      (await call("PUT", "/v1/vms/job-1/network", { policy })).status,
    ).toBe(204);
    expect(await vmFor("job-1").controller.getPolicy()).toEqual(policy);
    expect(
      (await call("PUT", "/v1/vms/job-1/network", { policy: "deny-all" }))
        .status,
    ).toBe(204);
    expect(await vmFor("job-1").controller.getPolicy()).toBe("deny-all");
    expect(
      (
        await call("PUT", "/v1/vms/job-1/network", {
          policy: { allow: ["10.0.0.1"] },
        })
      ).status,
    ).toBe(400);
    expect((await call("PUT", "/v1/vms/job-1/network", {})).status).toBe(400);
    expect(
      (await call("PUT", "/v1/vms/nobody/network", { policy: "deny-all" }))
        .status,
    ).toBe(404);
  });

  // #1159-T28
  it("answers 503 with the kind alone when the platform throws, never its text", async () => {
    const s = setup();
    const response = await handle(
      new Request("https://cr-sandbox.example/v1/vms", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      {
        ...({} as HandlerDeps),
        config: readConfig({}),
        token: TOKEN,
        now: () => NOW,
        vm: () => {
          throw new Error("SECRET platform text");
        },
        registry: {
          ...s.registry,
          list: async () => {
            throw new Error("SECRET platform text");
          },
        } as unknown as HandlerDeps["registry"],
      },
    );
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toBe('{"error":"unavailable"}');
  });
});
