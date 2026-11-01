// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the contracts of the hosted deployment (#316): the Worker API, the dispatch webhook, the
// hardened container spec and the additions to the runner API (#318). The files in contracts/ are the
// source; here the examples are valid, the closed objects are closed, the additive fields are ignored
// and the signing vectors give their verdicts. The runner checks the same files in
// runner/tests/contract/test_hosted_contracts.py; the Dispatcher project (#327) validates the same
// examples once it exists.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  signDispatch,
  verifyDispatch,
  type DispatchVerdict,
} from "../../../fakes/dispatcher-app/signing.ts";
import {
  CONTRACTS_DIRECTORY,
  createContractValidator,
  readContract,
  readExamples,
} from "../../src/test-support/runner-contract.ts";

const runner = createContractValidator("runner-api.v1.json");
const worker = createContractValidator("worker-api.v1.json");
const webhook = createContractValidator("dispatch-webhook.v1.json");
const container = createContractValidator("worker-container.v1.json");

function expectValid(
  validator: ReturnType<typeof createContractValidator>,
  definition: string,
  document: unknown,
) {
  const { valid, errors } = validator.check(definition, document);
  expect({ valid, errors }).toStrictEqual({ valid: true, errors: "" });
}

function expectInvalid(
  validator: ReturnType<typeof createContractValidator>,
  definition: string,
  document: unknown,
) {
  expect(validator.check(definition, document).valid).toBe(false);
}

function example(folder: string, definition: string): Record<string, unknown> {
  const found = readExamples(folder).find((e) => e.definition === definition);
  if (found === undefined)
    throw new Error(`No example ${folder}/${definition}`);
  return structuredClone(found.document) as Record<string, unknown>;
}

describe("the examples", () => {
  // #318-T01
  it.each(readExamples("examples"))(
    "runner API: $definition is valid",
    ({ definition, document }) => expectValid(runner, definition, document),
  );
  // #318-T01
  it.each(readExamples("examples/worker-api"))(
    "Worker API: $definition is valid",
    ({ definition, document }) => expectValid(worker, definition, document),
  );
  // #318-T01
  it.each(readExamples("examples/dispatch-webhook"))(
    "dispatch webhook: $definition is valid",
    ({ definition, document }) => expectValid(webhook, definition, document),
  );
  // #318-T01
  it.each(readExamples("examples/worker-container"))(
    "container spec: $definition is valid",
    ({ definition, document }) => expectValid(container, definition, document),
  );

  // #318-T01
  it("exist for every body of the new definitions", () => {
    const names = (folder: string) =>
      readExamples(folder)
        .map((e) => e.definition)
        .sort();

    expect(names("examples/worker-api")).toStrictEqual([
      "WorkerErrorResponse",
      "WorkerHeartbeatRequest",
      "WorkerHeartbeatResponse",
      "WorkerJobDetailsRequest",
      "WorkerJobDetailsResponse",
      "WorkerResultRequest",
      "WorkerResultResponse",
    ]);
    expect(names("examples/dispatch-webhook")).toStrictEqual([
      "DispatchAccepted",
      "DispatchIgnored",
      "DispatchStop",
      "DispatchStopAccepted",
      "DispatchStopIgnored",
      "DispatchWebhook",
    ]);
    expect(names("examples/worker-container")).toStrictEqual([
      "ImplementerContainerSpec",
      "WorkerContainerLauncherAdditions",
      "WorkerContainerOverrides",
      "WorkerContainerSpec",
    ]);
    expect(names("examples")).toStrictEqual(
      expect.arrayContaining([
        "JobStateResponse",
        "ReleaseRequest",
        "ReleaseResponse",
        "SplitClaimResponse",
        "VersionResponse",
        "VmStartRequest",
        "VmStartResponse",
      ]),
    );
  });

  // #318-T01
  it("keep the job credential out of the split claim's job input and out of the details body", () => {
    const claim = example("examples", "SplitClaimResponse");
    const details = example("examples/worker-api", "WorkerJobDetailsResponse");

    expect(JSON.stringify(claim)).not.toContain('"input"');
    expect(JSON.stringify(details)).not.toContain("leaseToken");
    expect(JSON.stringify(details)).not.toContain("crj_");
  });

  // #318-T01
  it("lists the new runner API names the way the schema does", () => {
    const defs = readContract("runner-api.v1.json").$defs;

    expect(defs.ApiErrorCode?.enum).toStrictEqual(
      expect.arrayContaining(["WORKER_CREDENTIAL_INVALID", "RUNNER_JOB_ENDED"]),
    );
    expect(defs.ClaimRequest).toMatchObject({
      properties: {
        jobId: { $ref: "#/$defs/JobId" },
        maxRunning: { type: "integer", minimum: 1, maximum: 1000 },
      },
    });
  });
});

describe("the dispatch webhook", () => {
  // #318-T03
  it.each([
    ["an unknown field", { extra: "value" }],
    ["a secret", { secret: "example-secret" }],
    ["a token", { token: "example-token" }],
    ["a credential", { credential: "crj_EXAMPLE" }],
    ["a signature", { signature: "v1=00" }],
    ["git data", { git: { token: "example" } }],
    ["a repository name", { repository: "acme/widgets" }],
  ])("is closed: refuses %s", (_name, addition) => {
    expectInvalid(webhook, "DispatchWebhook", {
      ...example("examples/dispatch-webhook", "DispatchWebhook"),
      ...addition,
    });
  });

  // #318-T03
  it.each([
    "version",
    "type",
    "jobId",
    "reviewKind",
    "attempt",
    "dispatchId",
    "sentAt",
  ])("requires %s", (field) => {
    const body = example("examples/dispatch-webhook", "DispatchWebhook");
    delete body[field];

    expectInvalid(webhook, "DispatchWebhook", body);
  });

  // #318-T03
  it("allows only the known type, version and review kinds", () => {
    const body = example("examples/dispatch-webhook", "DispatchWebhook");

    expectInvalid(webhook, "DispatchWebhook", { ...body, version: 2 });
    expectInvalid(webhook, "DispatchWebhook", { ...body, type: "job.other" });
    expectInvalid(webhook, "DispatchWebhook", { ...body, reviewKind: "x" });
    expectInvalid(webhook, "DispatchWebhook", { ...body, attempt: 0 });
  });

  // #318-T03
  it("stays under 1 KiB", () => {
    const body = example("examples/dispatch-webhook", "DispatchWebhook");

    expect(JSON.stringify(body).length).toBeLessThan(1024);
  });
});

describe("the stop call of the dispatch webhook", () => {
  // #487-T10
  it.each(["DispatchStop", "DispatchStopAccepted", "DispatchStopIgnored"])(
    "has a valid example of %s",
    (definition) => {
      expectValid(
        webhook,
        definition,
        example("examples/dispatch-webhook", definition),
      );
    },
  );

  // #487-T02
  it.each([
    ["an unknown field", { extra: "value" }],
    ["a secret", { secret: "example-secret" }],
    ["a credential", { credential: "crj_EXAMPLE" }],
    ["a review kind", { reviewKind: "dynamic" }],
    ["a repository name", { repository: "acme/widgets" }],
  ])("is closed: refuses %s", (_name, addition) => {
    expectInvalid(webhook, "DispatchStop", {
      ...example("examples/dispatch-webhook", "DispatchStop"),
      ...addition,
    });
  });

  // #487-T02
  it.each(["version", "type", "jobId", "stopId", "sentAt"])(
    "requires %s",
    (field) => {
      const body = example("examples/dispatch-webhook", "DispatchStop");
      delete body[field];

      expectInvalid(webhook, "DispatchStop", body);
    },
  );

  // #487-T02
  it("allows only the stop type and version, and ids of the form of a job id", () => {
    const body = example("examples/dispatch-webhook", "DispatchStop");

    expectInvalid(webhook, "DispatchStop", { ...body, version: 2 });
    expectInvalid(webhook, "DispatchStop", { ...body, type: "job.ready" });
    expectInvalid(webhook, "DispatchStop", { ...body, jobId: "../etc" });
    expectInvalid(webhook, "DispatchStop", { ...body, stopId: "x" });
  });

  // #487-T10
  it("stays under 1 KiB, and the wake-up call is unchanged by it", () => {
    expect(
      JSON.stringify(example("examples/dispatch-webhook", "DispatchStop"))
        .length,
    ).toBeLessThan(1024);
    expectValid(
      webhook,
      "DispatchWebhook",
      example("examples/dispatch-webhook", "DispatchWebhook"),
    );
  });

  // #487-T10
  it("is an addition that a Dispatcher of the previous release answers with 404, which the wake-up never sees", () => {
    // The wake-up call is `job.ready` and nothing else: a previous-release Dispatcher refuses any other type, so the
    // two calls cannot be mistaken for each other whichever side is older.
    expectInvalid(webhook, "DispatchWebhook", {
      ...example("examples/dispatch-webhook", "DispatchStop"),
      reviewKind: "diff",
      attempt: 1,
      dispatchId: "7c1e2d44-6b0a-4f5b-9a3e-5d8f2b6c1e07",
    });
  });
});

describe("a reader and an additive field", () => {
  const BODIES: Array<[string, string]> = [
    ["WorkerJobDetailsResponse", "job"],
    ["WorkerHeartbeatResponse", "job"],
    ["WorkerResultResponse", "job"],
    ["WorkerErrorResponse", "error"],
  ];

  // #318-T04
  it.each(BODIES)(
    "ignores an unknown field in %s, at the top and inside its object",
    (definition, inner) => {
      const body = example("examples/worker-api", definition);
      const nested = body[inner] as Record<string, unknown>;

      expectValid(worker, definition, { ...body, addedLater: 1 });
      expectValid(worker, definition, {
        ...body,
        [inner]: { ...nested, addedLater: { deep: true } },
      });
    },
  );

  // #318-T04
  it("ignores an unknown field in the split claim, release and version answers", () => {
    for (const definition of [
      "SplitClaimResponse",
      "ReleaseResponse",
      "VersionResponse",
      "JobStateResponse",
    ]) {
      const body = example("examples", definition);

      expectValid(runner, definition, { ...body, addedLater: 1 });
    }
  });

  // #318-T04
  it("still refuses an unknown field inside the job input, which stays closed", () => {
    const body = example("examples/worker-api", "WorkerJobDetailsResponse");
    const job = body.job as { input: Record<string, unknown> };

    expectInvalid(worker, "WorkerJobDetailsResponse", {
      ...body,
      job: { ...job, input: { ...job.input, addedLater: 1 } },
    });
  });
});

describe("the hardened container spec", () => {
  function spec(definition = "WorkerContainerSpec"): Record<string, unknown> {
    return example("examples/worker-container", definition);
  }

  // #318-T05, #760-T01: the same refusals for every profile
  describe.each(["WorkerContainerSpec", "ImplementerContainerSpec"])(
    "%s",
    (definition) => {
      it.each([
        ["privileged", { privileged: true }],
        [
          "a bind of the Docker socket",
          { binds: ["/var/run/docker.sock:/var/run/docker.sock"] },
        ],
        ["a volume", { volumes: ["/data:/data"] }],
        ["a device", { devices: ["/dev/kvm"] }],
        ["host network (key)", { networkMode: "host" }],
        ["host network (value)", { network: { mode: "host" } }],
        ["the host pid namespace", { pid: "host" }],
        ["the host ipc namespace", { ipc: "host" }],
        [
          "an unconfined seccomp profile",
          { securityOpt: ["no-new-privileges:true", "seccomp=unconfined"] },
        ],
        [
          "an unconfined apparmor profile",
          { securityOpt: ["no-new-privileges:true", "apparmor=unconfined"] },
        ],
        ["no no-new-privileges", { securityOpt: [] }],
        ["a writable root", { readOnly: false }],
        ["another user", { user: "10001:10001" }],
        ["not dropping all capabilities", { capDrop: ["NET_RAW"] }],
        [
          "a capability outside the list",
          { capAdd: [{ name: "SYS_ADMIN", startupOnly: false }] },
        ],
        [
          "a secret in the environment names",
          { allowedEnvironment: ["RUNNER_TOKEN"] },
        ],
        [
          "a credential environment name",
          { allowedEnvironment: ["WORKER_CREDENTIAL"] },
        ],
        ["an unknown key", { somethingNew: 1 }],
      ])("is refused with %s", (_name, change) => {
        expectInvalid(container, definition, {
          ...spec(definition),
          ...change,
        });
      });
    },
  );

  // #760-T01
  it("accepts the implementer profile, which differs from the default spec in the work volume, the memory, the pids limit and the environment names only", () => {
    const base = spec();
    const profile = spec("ImplementerContainerSpec");

    expectValid(container, "ImplementerContainerSpec", profile);
    // The default spec is not the profile and the profile is not the default spec.
    expectInvalid(container, "WorkerContainerSpec", profile);
    expectInvalid(container, "ImplementerContainerSpec", base);
    const differing = Object.keys({ ...base, ...profile }).filter(
      (key) => JSON.stringify(base[key]) !== JSON.stringify(profile[key]),
    );
    expect(differing.sort()).toStrictEqual([
      "allowedEnvironment",
      "memory",
      "pids",
      "workVolume",
    ]);
  });

  // #760-T01
  it.each([
    ["another path", { path: "/data" }],
    ["another path below /work", { path: "/work/x" }],
    ["no nosuid", { options: ["rw", "nodev"] }],
    ["no nodev", { options: ["rw", "nosuid"] }],
    ["a read-only volume", { options: ["ro", "nosuid", "nodev"] }],
    ["a suid option", { options: ["rw", "suid", "nodev"] }],
    ["a host path as the source", { source: "/var/lib/docker" }],
    ["a bind as the source", { source: "bind" }],
    ["an unknown key", { propagation: "shared" }],
  ])("refuses a work volume with %s", (_name, change) => {
    const profile = spec("ImplementerContainerSpec");
    const volume = profile.workVolume as Record<string, unknown>;

    expectInvalid(container, "ImplementerContainerSpec", {
      ...profile,
      workVolume: { ...volume, ...change },
    });
  });

  // #760-T01
  it.each([
    ["no work volume", "workVolume"],
    ["no pids limit", "pids"],
  ])("refuses a profile with %s", (_name, key) => {
    const profile = spec("ImplementerContainerSpec");
    delete profile[key];

    expectInvalid(container, "ImplementerContainerSpec", profile);
  });

  // #760-T01
  it("refuses a profile whose pids limit or environment is not the profile's", () => {
    const profile = spec("ImplementerContainerSpec");
    const names = profile.allowedEnvironment as string[];

    for (const limit of [512, 1024, 4096])
      expectInvalid(container, "ImplementerContainerSpec", {
        ...profile,
        pids: { limit },
      });
    for (const missing of [
      "RUNNER_IMPLEMENTER_WORK_DIR",
      "RUNNER_IMPLEMENTER_EGRESS_PORT",
      "RUNNER_IMPLEMENTER_NETWORK",
    ])
      expectInvalid(container, "ImplementerContainerSpec", {
        ...profile,
        allowedEnvironment: names.filter((name) => name !== missing),
      });
  });

  // #760-T01
  it("keeps the memory override per Worker kind to the memory keys for the profile too", () => {
    expectValid(container, "WorkerContainerOverrides", {
      memory: { limit: "3g", reservation: "2560m", swap: "3g" },
    });
    expectInvalid(container, "WorkerContainerOverrides", {
      workVolume: { path: "/data", options: ["rw"], source: "x" },
    });
  });

  // #318-T05
  it("refuses a tmpfs that can run a program, hold a device or honour a setuid bit", () => {
    const base = spec();
    const tmpfs = base.tmpfs as Array<Record<string, unknown>>;
    for (const option of ["noexec", "nosuid", "nodev"]) {
      const first = tmpfs[0] as { options: string[] };
      const weakened = tmpfs.map((entry, index) =>
        index === 0
          ? { ...entry, options: first.options.filter((o) => o !== option) }
          : entry,
      );

      expectInvalid(container, "WorkerContainerSpec", {
        ...base,
        tmpfs: weakened,
      });
    }
  });

  // #318-T05
  it("lets the memory limit be overridden per Worker kind, and nothing else", () => {
    expectValid(container, "WorkerContainerOverrides", {
      memory: { limit: "1536m", swap: "1536m" },
    });
    expectInvalid(container, "WorkerContainerOverrides", {
      user: "10001:10001",
    });
    expectInvalid(container, "WorkerContainerOverrides", { readOnly: false });
    expectInvalid(container, "WorkerContainerOverrides", { privileged: true });
    expectInvalid(container, "WorkerContainerOverrides", {
      pids: { limit: 100000 },
    });
  });

  // #325-T08
  it("has no sysctls of its own: they are a per-launcher addition", () => {
    expectInvalid(container, "WorkerContainerSpec", {
      ...spec(),
      sysctls: { "net.ipv6.conf.all.disable_ipv6": "1" },
    });
  });

  // #325-T08
  it("lets a launcher add the two IPv6 switches and nothing else", () => {
    const both = {
      "net.ipv6.conf.all.disable_ipv6": "1",
      "net.ipv6.conf.default.disable_ipv6": "1",
    };

    expectValid(container, "WorkerContainerLauncherAdditions", {
      sysctls: both,
    });
    expectValid(container, "WorkerContainerLauncherAdditions", {});
    for (const bad of [
      { sysctls: { "net.ipv6.conf.all.disable_ipv6": "1" } },
      { sysctls: { ...both, "net.ipv4.ip_forward": "1" } },
      { sysctls: { ...both, "net.ipv6.conf.all.disable_ipv6": "0" } },
      { sysctls: { ...both, "kernel.core_pattern": "|/bin/sh" } },
      { sysctls: both, privileged: true },
      { devices: ["/dev/kvm"] },
    ])
      expectInvalid(container, "WorkerContainerLauncherAdditions", bad);
  });

  // #318-T05
  it("marks the two capabilities that exist for the start of the container only", () => {
    const body = spec() as {
      capAdd: Array<{ name: string; startupOnly: boolean }>;
    };

    expect(
      body.capAdd.filter((c) => c.startupOnly).map((c) => c.name),
    ).toStrictEqual(["NET_ADMIN", "SETPCAP"]);
  });
});

describe("the signing vectors", () => {
  type Vector = {
    name: string;
    headers: Record<string, string>;
    body: string;
    now: number;
    expected: DispatchVerdict;
  };
  const vectors = JSON.parse(
    readFileSync(
      join(CONTRACTS_DIRECTORY, "dispatch-signing-vectors.json"),
      "utf8",
    ),
  ) as {
    toleranceSeconds: number;
    keys: Record<string, { kid: string; secret: string }>;
    vectors: Vector[];
  };

  // #318-T06
  it("are valid against their definition", () => {
    expectValid(webhook, "DispatchSigningVectors", vectors);
  });

  // #318-T06
  it("cover the valid, wrong key, old timestamp and tampered body cases", () => {
    expect(vectors.vectors.map((v) => v.expected)).toStrictEqual(
      expect.arrayContaining([
        "ok",
        "bad_signature",
        "unknown_key",
        "expired",
        "malformed",
      ]),
    );
    expect(vectors.vectors.map((v) => v.name)).toStrictEqual(
      expect.arrayContaining([
        "valid, current key",
        "valid, previous key (rotation)",
        "wrong key",
        "old timestamp",
        "tampered body",
      ]),
    );
  });

  // #318-T06
  it.each(readVectors())("gives the verdict of $name", (vector) => {
    const keys = Object.values(vectors.keys);

    expect(
      verifyDispatch({
        keys,
        headers: vector.headers,
        rawBody: vector.body,
        nowSeconds: vector.now,
        toleranceSeconds: vectors.toleranceSeconds,
      }),
    ).toBe(vector.expected);
  });

  // #318-T06
  it("sign the way the reference signer does", () => {
    const valid = vectors.vectors.find((v) => v.name === "valid, current key");
    const key = vectors.keys.current;
    if (valid === undefined || key === undefined)
      throw new Error("vector missing");

    expect(
      signDispatch({
        secret: key.secret,
        timestamp: valid.headers["x-dispatch-timestamp"] ?? "",
        dispatchId: valid.headers["x-dispatch-id"] ?? "",
        rawBody: valid.body,
      }),
    ).toBe(valid.headers["x-dispatch-signature"]);
  });

  function readVectors(): Vector[] {
    return (
      JSON.parse(
        readFileSync(
          join(CONTRACTS_DIRECTORY, "dispatch-signing-vectors.json"),
          "utf8",
        ),
      ) as { vectors: Vector[] }
    ).vectors;
  }
});
