// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { bearerAllowed } from "./auth.ts";
import { drain, TailBuffer } from "./bounded-tail.ts";
import { instanceOption, parseFeatures, readConfig } from "./config.ts";
import { errorResponse, FAILURE_KINDS, statusOf } from "./errors.ts";
import {
  matchesFilter,
  overdueEntries,
  planAlarm,
  PENDING_MAX_MS,
  OVERDUE_GRACE_MS,
  type VmEntry,
} from "./lifecycle.ts";
import { routeOf } from "./router.ts";
import {
  checkCreate,
  checkExec,
  checkListFilter,
  checkNetwork,
  checkStdin,
  checkWaitMs,
} from "./validate.ts";

const TOKEN = "t".repeat(32);

describe("bearerAllowed", () => {
  // #1159-T04
  it("accepts the secret and nothing else", async () => {
    expect(await bearerAllowed(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(await bearerAllowed(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    for (const header of [
      null,
      "",
      "Bearer",
      "Bearer ",
      `Bearer ${TOKEN}x`,
      `Bearer x${TOKEN}`,
      `Basic ${TOKEN}`,
      TOKEN,
      `Bearer ${TOKEN} extra`,
    ]) {
      expect(await bearerAllowed(header, TOKEN), String(header)).toBe(false);
    }
  });

  // #1159-T04
  it("refuses everything when the Worker has no secret or one shorter than 32 characters", async () => {
    expect(await bearerAllowed(`Bearer ${TOKEN}`, undefined)).toBe(false);
    expect(await bearerAllowed("Bearer short", "short")).toBe(false);
    expect(
      await bearerAllowed(`Bearer ${TOKEN.slice(1)}`, TOKEN.slice(1)),
    ).toBe(false);
  });
});

describe("TailBuffer", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  // #1159-T05
  it("keeps everything below the cap and says nothing was cut", () => {
    const tail = new TailBuffer(100);
    tail.push(bytes("hello "));
    tail.push(bytes("world"));
    expect(tail.text()).toBe("hello world");
    expect(tail.truncated).toBe(false);
  });

  // #1159-T05
  it("keeps the last bytes above the cap, however it is pushed, and says so", () => {
    const tail = new TailBuffer(10);
    for (let i = 0; i < 1000; i++) tail.push(bytes(`line ${i}\n`));
    expect(tail.truncated).toBe(true);
    expect(tail.text().length).toBeLessThanOrEqual(10);
    expect(tail.text().endsWith("line 999\n")).toBe(true);
    const one = new TailBuffer(10);
    one.push(bytes("0123456789ABCDEF"));
    expect(one.text()).toBe("6789ABCDEF");
    expect(one.truncated).toBe(true);
  });

  // #1159-T05
  it("drains a stream to its end and survives a stream that breaks", async () => {
    const good = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes("a"));
        c.enqueue(bytes("b"));
        c.close();
      },
    });
    const tail = new TailBuffer(10);
    await drain(good, tail);
    expect(tail.text()).toBe("ab");
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes("x"));
        c.error(new Error("gone"));
      },
    });
    const kept = new TailBuffer(10);
    await expect(drain(broken, kept)).resolves.toBeUndefined();
    await expect(drain(null, kept)).resolves.toBeUndefined();
  });
});

describe("errors", () => {
  // #1159-T06
  it("gives each kind the status of the contract and a body of the kind alone", async () => {
    expect(FAILURE_KINDS).toContain("not_ready");
    expect([
      statusOf("rejected"),
      statusOf("auth_failed"),
      statusOf("not_ready"),
      statusOf("rate_limited"),
      statusOf("unavailable"),
    ]).toEqual([400, 401, 404, 429, 503]);
    const response = errorResponse("not_ready");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_ready" });
  });
});

describe("lifecycle", () => {
  const entry = (over: Partial<VmEntry>): VmEntry => ({
    name: "job-1",
    instanceType: "standard-4",
    createdAtMs: 0,
    status: "running",
    timeoutMs: 1000,
    tags: { cr: "job" },
    ...over,
  });

  // #1159-T07
  it("plans the alarm every interval, never past the deadline, and the destroy at the deadline", () => {
    expect(planAlarm(0, 1_000_000)).toEqual({ action: "keep", atMs: 45_000 });
    expect(planAlarm(990_000, 1_000_000)).toEqual({
      action: "keep",
      atMs: 1_000_000,
    });
    expect(planAlarm(1_000_000, 1_000_000)).toEqual({ action: "destroy" });
    expect(planAlarm(2_000_000, 1_000_000)).toEqual({ action: "destroy" });
  });

  // #1159-T08
  it("lists by name prefix and by one tag", () => {
    const a = entry({ name: "job-1" });
    const b = entry({ name: "canary-1", tags: { cr: "canary" } });
    expect(matchesFilter(a, { namePrefix: "job-", tag: null })).toBe(true);
    expect(matchesFilter(b, { namePrefix: "job-", tag: null })).toBe(false);
    expect(
      matchesFilter(b, { namePrefix: "", tag: { key: "cr", value: "canary" } }),
    ).toBe(true);
    expect(
      matchesFilter(a, { namePrefix: "", tag: { key: "cr", value: "canary" } }),
    ).toBe(false);
    expect(
      matchesFilter(a, { namePrefix: "", tag: { key: "missing", value: "" } }),
    ).toBe(false);
  });

  // #1159-T07
  it("finds what is overdue: past the deadline by the grace, or pending for too long", () => {
    const now = 10_000_000;
    const running = entry({
      name: "a",
      createdAtMs: now - 1000 - OVERDUE_GRACE_MS - 1,
      timeoutMs: 1000,
    });
    const fresh = entry({
      name: "b",
      createdAtMs: now - 5000,
      timeoutMs: 1_000_000,
    });
    const stuck = entry({
      name: "c",
      status: "pending",
      createdAtMs: now - PENDING_MAX_MS - 1,
      timeoutMs: 21_600_000,
    });
    const booting = entry({
      name: "d",
      status: "pending",
      createdAtMs: now - 60_000,
      timeoutMs: 21_600_000,
    });
    expect(
      overdueEntries([running, fresh, stuck, booting], now).map((e) => e.name),
    ).toEqual(["a", "c"]);
  });
});

describe("router", () => {
  // #1159-T09
  it("maps every route of the contract and refuses the rest", () => {
    expect(routeOf("GET", "/health")).toEqual({ kind: "health" });
    expect(routeOf("POST", "/v1/vms")).toEqual({ kind: "create" });
    expect(routeOf("GET", "/v1/vms")).toEqual({ kind: "list" });
    expect(routeOf("DELETE", "/v1/vms/a")).toEqual({
      kind: "delete",
      name: "a",
    });
    expect(routeOf("POST", "/v1/vms/a/exec")).toEqual({
      kind: "exec",
      name: "a",
    });
    expect(routeOf("PUT", "/v1/vms/a/network")).toEqual({
      kind: "network",
      name: "a",
    });
    expect(routeOf("POST", "/v1/vms/a/processes")).toEqual({
      kind: "startProcess",
      name: "a",
    });
    expect(routeOf("GET", "/v1/vms/a/processes/p")).toEqual({
      kind: "processStatus",
      name: "a",
      id: "p",
    });
    expect(routeOf("POST", "/v1/vms/a/processes/p/stdin")).toEqual({
      kind: "stdin",
      name: "a",
      id: "p",
    });
    expect(routeOf("POST", "/v1/vms/a/processes/p/stdin/close")).toEqual({
      kind: "stdinClose",
      name: "a",
      id: "p",
    });
    for (const [method, path] of [
      ["GET", "/"],
      ["POST", "/health"],
      ["GET", "/v1"],
      ["PATCH", "/v1/vms"],
      ["GET", "/v1/vms/a"],
      ["GET", "/v1/vms/a/exec"],
      ["POST", "/v1/vms/a/exec/x"],
      ["POST", "/v1/vms/a/processes/p/stdin/close/x"],
      ["POST", "/v1/vms/a/processes/p/stdin/other"],
      ["GET", "/v2/vms"],
    ] as const) {
      expect(routeOf(method, path), `${method} ${path}`).toBeNull();
    }
  });
});

describe("validation", () => {
  const create = {
    name: "job-1",
    instanceType: "standard-4",
    timeoutMs: 3_600_000,
    tags: { cr: "job" },
  };

  // #1159-T10
  it("accepts a create request of the contract and refuses names, types, timeouts and tags outside it", () => {
    expect(checkCreate(create, ["standard-4"])).toEqual({
      ok: true,
      value: create,
    });
    for (const bad of [
      { ...create, name: "Job" },
      { ...create, name: "a".repeat(64) },
      { ...create, name: "" },
      { ...create, instanceType: "standard-3" },
      { ...create, timeoutMs: 59_999 },
      { ...create, timeoutMs: 21_600_001 },
      { ...create, timeoutMs: 1.5 },
      { ...create, tags: { "bad key": "x" } },
      { ...create, tags: { a: 1 } },
      {
        ...create,
        tags: Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]),
        ),
      },
      { ...create, tags: undefined },
      null,
      "x",
    ]) {
      expect(checkCreate(bad, ["standard-4"]).ok, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  // #1159-T10
  it("reads an exec request with its default and limits for the timeout", () => {
    expect(checkExec({ label: "vm-prepare", cmd: "x", args: [] })).toEqual({
      ok: true,
      value: { label: "vm-prepare", cmd: "x", args: [], timeoutMs: 120_000 },
    });
    expect(
      checkExec({
        label: "a",
        cmd: "x",
        args: ["y"],
        sudo: true,
        timeoutMs: 600_000,
      }).ok,
    ).toBe(true);
    for (const bad of [
      { label: "A", cmd: "x", args: [] },
      { label: "a", cmd: "", args: [] },
      { label: "a", cmd: "x" },
      { label: "a", cmd: "x", args: [1] },
      { label: "a", cmd: "x", args: [], timeoutMs: 999 },
      { label: "a", cmd: "x", args: [], timeoutMs: 600_001 },
      { label: "a", cmd: "x", args: [], sudo: "yes" },
    ]) {
      expect(checkExec(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  // #1159-T10
  it("reads stdin, a network request, waitMs and the listing filter", () => {
    expect(checkStdin({ data: "x" })).toEqual({ ok: true, value: "x" });
    expect(checkStdin({ data: "x".repeat(1_048_577) }).ok).toBe(false);
    expect(checkStdin({}).ok).toBe(false);
    expect(checkNetwork({ policy: "deny-all" })).toEqual({
      ok: true,
      value: "deny-all",
    });
    expect(checkNetwork({ policy: "open" }).ok).toBe(false);
    expect(checkWaitMs(null)).toEqual({ ok: true, value: 0 });
    expect(checkWaitMs("25000")).toEqual({ ok: true, value: 25000 });
    expect(checkWaitMs("25001").ok).toBe(false);
    expect(checkWaitMs("-1").ok).toBe(false);
    expect(checkWaitMs("abc").ok).toBe(false);
    expect(
      checkListFilter(new URLSearchParams("namePrefix=job-&tag=cr:job")),
    ).toEqual({
      ok: true,
      value: { namePrefix: "job-", tag: { key: "cr", value: "job" } },
    });
    expect(checkListFilter(new URLSearchParams(""))).toEqual({
      ok: true,
      value: { namePrefix: "", tag: null },
    });
    expect(checkListFilter(new URLSearchParams("namePrefix=Job")).ok).toBe(
      false,
    );
    expect(checkListFilter(new URLSearchParams("tag=bad key:v")).ok).toBe(
      false,
    );
  });
});

describe("config", () => {
  // #1159-T11
  it("starts with standard-4, 8 VMs and no features, and reads what it is given", () => {
    const defaults = readConfig({});
    expect(defaults).toMatchObject({
      instanceTypes: ["standard-4"],
      maxVms: 8,
      imageVersion: "unknown",
      workerFeatures: [],
      workerImageId: null,
    });
    const id = `sha256:${"a".repeat(64)}`;
    const given = readConfig({
      INSTANCE_TYPES: "standard-4, custom-8",
      CUSTOM_INSTANCE_TYPES:
        '{"custom-8":{"vcpu":8,"memoryMib":32768,"diskMb":100000}}',
      MAX_VMS: "3",
      IMAGE_VERSION: "abc123",
      WORKER_FEATURES: "b,a",
      WORKER_IMAGE_ID: id,
      AGENT_IMAGE_ID: "nope",
    });
    expect(given).toMatchObject({
      instanceTypes: ["standard-4", "custom-8"],
      maxVms: 3,
      imageVersion: "abc123",
      workerFeatures: ["a", "b"],
      workerImageId: id,
      agentImageId: null,
    });
    expect(instanceOption(given, "standard-4")).toBe("standard-4");
    expect(instanceOption(given, "custom-8")).toEqual({
      vcpu: 8,
      memoryMib: 32768,
      diskMb: 100000,
    });
  });

  // #1159-T11
  it("falls back on malformed values and reads features like the Dispatcher does", () => {
    expect(
      readConfig({
        INSTANCE_TYPES: "Bad Type",
        MAX_VMS: "0",
        CUSTOM_INSTANCE_TYPES: "{",
      }),
    ).toMatchObject({
      instanceTypes: ["standard-4"],
      maxVms: 8,
      customInstanceTypes: {},
    });
    expect(parseFeatures("none")).toEqual([]);
    expect(parseFeatures("")).toEqual([]);
    expect(parseFeatures(undefined)).toEqual([]);
    expect(parseFeatures("implementer_multi_repo,pool_cap")).toEqual([
      "implementer_multi_repo",
      "pool_cap",
    ]);
    expect(parseFeatures("good,Bad Name")).toEqual([]);
  });
});
