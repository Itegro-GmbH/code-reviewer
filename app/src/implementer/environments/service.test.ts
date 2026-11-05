// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import type {
  CreateOutcome,
  ImplementerEnvironmentsRepository,
  StoredEnvironment,
  UpdateOutcome,
} from "../../db/repositories/implementer-environments-repository.ts";
import { EnvironmentError } from "./errors.ts";
import { ENVIRONMENTS_PER_WORKSPACE_MAX } from "./limits.ts";
import { createEnvironmentService } from "./service.ts";

const STORED: StoredEnvironment = {
  id: "env-1",
  workspaceId: "w-1",
  name: "Node 22",
  kind: "hosted",
  vcpus: 4,
  setupScript: "npm ci\n",
  labels: [],
  network: { mode: "off", hosts: [] },
  createdBy: "u-1",
  createdAt: "2026-11-02T08:00:00.000Z",
  updatedAt: "2026-11-02T09:00:00.000Z",
};

function fakeRepository(
  overrides: Partial<ImplementerEnvironmentsRepository> = {},
): ImplementerEnvironmentsRepository & { maximums: number[] } {
  const maximums: number[] = [];
  return {
    maximums,
    list: async () => [STORED],
    listSummaries: async () => [
      {
        id: STORED.id,
        name: STORED.name,
        kind: "hosted",
        labels: [],
        vcpus: STORED.vcpus,
        hasScript: true,
        networkMode: "off",
      },
    ],
    get: async (id) => (id === STORED.id ? STORED : undefined),
    create: async (_environment, maximum): Promise<CreateOutcome> => {
      maximums.push(maximum);
      return { ok: true, environment: STORED };
    },
    update: async (): Promise<UpdateOutcome> => ({
      ok: true,
      environment: STORED,
    }),
    remove: async (id) => id === STORED.id,
    ...overrides,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<EnvironmentError> {
  const reason = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(reason instanceof EnvironmentError))
    throw new Error("expected an EnvironmentError");
  return reason;
}

const BODY = { name: "Node 22", vcpus: 4, setupScript: "npm ci\n" };

describe("the environment service", () => {
  // #818-T07
  it("lists environments as the page needs them: the memory of the size, the script, no user id", async () => {
    const service = createEnvironmentService({
      environments: fakeRepository(),
    });

    expect(await service.list()).toEqual({
      environments: [
        {
          id: "env-1",
          name: "Node 22",
          kind: "hosted",
          labels: [],
          vcpus: 4,
          memoryGb: 5.7,
          sizeSupported: true,
          setupScript: "npm ci\n",
          network: { mode: "off", hosts: [] },
          createdAt: "2026-11-02T08:00:00.000Z",
          updatedAt: "2026-11-02T09:00:00.000Z",
        },
      ],
      maximum: ENVIRONMENTS_PER_WORKSPACE_MAX,
    });
  });

  // #818-T46
  it("lists the picker's view without the script: the repository is asked for summaries, not for the scripts", async () => {
    const service = createEnvironmentService({
      environments: fakeRepository({
        list: () => {
          throw new Error("the scripts must not be read for the picker");
        },
      }),
    });

    const listed = await service.listForPicker();

    expect(listed).toEqual({
      environments: [
        {
          id: "env-1",
          name: "Node 22",
          kind: "hosted",
          labels: [],
          vcpus: 4,
          memoryGb: 5.7,
          sizeSupported: true,
          hasScript: true,
          networkMode: "off",
        },
      ],
      maximum: ENVIRONMENTS_PER_WORKSPACE_MAX,
    });
    expect(JSON.stringify(listed)).not.toContain("npm ci");
  });

  // #818-T07
  it("creates with the checked body, the creator and the workspace bound", async () => {
    const repository = fakeRepository();
    const service = createEnvironmentService({ environments: repository });

    const created = await service.create({ id: "u-1" }, BODY);

    expect(created).toMatchObject({ id: "env-1", vcpus: 4, memoryGb: 5.7 });
    expect(repository.maximums).toEqual([ENVIRONMENTS_PER_WORKSPACE_MAX]);
  });

  // #818-T07
  it("refuses a bad body before the database is asked, naming the fields", async () => {
    const repository = fakeRepository({
      create: () => {
        throw new Error("the database must not be asked");
      },
    });
    const service = createEnvironmentService({ environments: repository });

    const error = await failureOf(
      service.create({ id: "u-1" }, { name: "", vcpus: 3 }),
    );

    expect(error.code).toBe("ENVIRONMENT_REQUEST_INVALID");
    expect(error.issues).toEqual([
      { field: "name", code: "required" },
      { field: "vcpus", code: "invalid" },
    ]);
  });

  // #818-T07
  it("turns a taken name and a full workspace into their codes", async () => {
    const taken = createEnvironmentService({
      environments: fakeRepository({
        create: async () => ({ ok: false, reason: "name_taken" }),
      }),
    });
    const full = createEnvironmentService({
      environments: fakeRepository({
        create: async () => ({ ok: false, reason: "limit_reached" }),
      }),
    });

    expect((await failureOf(taken.create({ id: "u-1" }, BODY))).code).toBe(
      "ENVIRONMENT_NAME_TAKEN",
    );
    const limit = await failureOf(full.create({ id: "u-1" }, BODY));
    expect(limit.code).toBe("ENVIRONMENT_LIMIT_REACHED");
    expect(limit.maximum).toBe(ENVIRONMENTS_PER_WORKSPACE_MAX);
  });

  // #818-T07
  it("updates, and answers a missing id and a taken name with their codes", async () => {
    const service = createEnvironmentService({
      environments: fakeRepository(),
    });
    expect(await service.update("env-1", BODY)).toMatchObject({ id: "env-1" });

    const missing = createEnvironmentService({
      environments: fakeRepository({
        update: async () => ({ ok: false, reason: "not_found" }),
      }),
    });
    expect((await failureOf(missing.update("nope", BODY))).code).toBe(
      "ENVIRONMENT_NOT_FOUND",
    );
    const taken = createEnvironmentService({
      environments: fakeRepository({
        update: async () => ({ ok: false, reason: "name_taken" }),
      }),
    });
    expect((await failureOf(taken.update("env-1", BODY))).code).toBe(
      "ENVIRONMENT_NAME_TAKEN",
    );
  });

  // #818-T07
  it("reads one environment, and a missing one is the same code as an update of it", async () => {
    const service = createEnvironmentService({
      environments: fakeRepository(),
    });

    expect(await service.get("env-1")).toMatchObject({ name: "Node 22" });
    expect((await failureOf(service.get("nope"))).code).toBe(
      "ENVIRONMENT_NOT_FOUND",
    );
  });

  // #818-T07
  it("deletes, and a missing id is ENVIRONMENT_NOT_FOUND", async () => {
    const service = createEnvironmentService({
      environments: fakeRepository(),
    });

    await service.remove("env-1");
    expect((await failureOf(service.remove("nope"))).code).toBe(
      "ENVIRONMENT_NOT_FOUND",
    );
  });

  // #818-T07
  it("does not look at an id that is not text of a sane length: it is a missing environment", async () => {
    const repository = fakeRepository({
      get: () => {
        throw new Error("the database must not be asked");
      },
    });
    const service = createEnvironmentService({ environments: repository });

    expect((await failureOf(service.get("a\u0000b"))).code).toBe(
      "ENVIRONMENT_NOT_FOUND",
    );
    expect((await failureOf(service.get("x".repeat(500)))).code).toBe(
      "ENVIRONMENT_NOT_FOUND",
    );
  });
});

describe("the service for an environment that runs on a runner (#854)", () => {
  const RUNNER: StoredEnvironment = {
    ...STORED,
    id: "env-box",
    name: "GPU box",
    kind: "runner",
    vcpus: null,
    setupScript: "",
    labels: ["gpu", "linux"],
  };

  // #854-T199
  it("shows its labels, no size and no memory, and a size that cannot be unsupported", async () => {
    const service = createEnvironmentService({
      environments: fakeRepository({
        list: async () => [RUNNER],
        listSummaries: async () => [
          {
            id: RUNNER.id,
            name: RUNNER.name,
            kind: "runner",
            labels: RUNNER.labels,
            vcpus: null,
            hasScript: false,
            networkMode: "off",
          },
        ],
      }),
    });

    const list = await service.list();
    const picker = await service.listForPicker();

    expect(list.environments).toEqual([
      expect.objectContaining({
        kind: "runner",
        labels: ["gpu", "linux"],
        vcpus: null,
        memoryGb: null,
        sizeSupported: true,
        setupScript: "",
      }),
    ]);
    expect(picker.environments).toEqual([
      expect.objectContaining({
        kind: "runner",
        labels: ["gpu", "linux"],
        vcpus: null,
        memoryGb: null,
        sizeSupported: true,
      }),
    ]);
  });

  // #854-T200
  it("creates it with the checked labels", async () => {
    const created: unknown[] = [];
    const service = createEnvironmentService({
      environments: fakeRepository({
        create: async (environment) => {
          created.push(environment);
          return { ok: true, environment: RUNNER };
        },
      }),
    });

    await service.create(
      { id: "u-1" },
      { kind: "runner", name: "GPU box", labels: ["Linux", "gpu"] },
    );

    expect(created).toEqual([
      {
        kind: "runner",
        name: "GPU box",
        labels: ["gpu", "linux"],
        createdBy: "u-1",
      },
    ]);
  });
});
