// SPDX-License-Identifier: LicenseRef-Proprietary

// #1105 (ADR 0007): the start of a task for a lane step that carries its settings itself. The engine hands the Implementer the profile copy it
// built from the step (`inline`), the body names a model and no profile; the turn is written with that copy, the hosted environment keeps its
// size and takes the script and the network rule of the step, and a repeated request is told from another by the same copy.
import { describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import type { TurnProfile } from "../db/repositories/implementer-repository.ts";
import { ImplementerError } from "./errors.ts";
import {
  createImplementerService,
  type ImplementerServiceDependencies,
  type StartTaskOptions,
} from "./service.ts";

const USER = { id: "user-1", githubLogin: "octocat" };
const OWN: ModelChoice = { provider: "anthropic", model: "claude-sonnet-5-5" };

const PROFILE: TurnProfile = {
  id: "workflow:wf-1",
  name: "Issue to PR",
  version: 4,
  instructions: "Standing text.",
  canPush: true,
  harness: "opencode",
};

const HOSTED = {
  id: "env-vm",
  kind: "hosted" as const,
  name: "vm",
  vcpus: 4,
  setupScript: "echo environment",
  network: { mode: "open" as const, hosts: [] },
  labels: [],
};

function build(options: { found?: unknown; write?: boolean } = {}) {
  const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
    status: "created" as const,
    job: { id: "job-1" },
    session: { id: "session-1", repos: input.repos },
    turn: {},
  }));
  const check = vi.fn(async () => null);
  const profilesFind = vi.fn(async () => undefined);
  const deps = {
    repositories: {
      get: async () => ({
        id: "repo-app",
        active: true,
        integrationId: "int-1",
        externalId: "1",
        fullName: "Acme/App",
        url: "https://github.test/Acme/App",
      }),
    },
    integrations: {
      get: async () => ({ id: "int-1", type: "github_app", status: "active" }),
    },
    registry: {
      resolve: () => ({
        installationPermissions: async () => ({
          contentsWrite: options.write ?? true,
        }),
        getRepositoryFacts: async () => ({ defaultBranch: "main" }),
        listBranches: async () => ({ names: ["main"] }),
        getBranch: async (_i: unknown, _r: unknown, name: string) =>
          name === "main" ? { name, sha: "a".repeat(40) } : null,
      }),
    },
    profiles: { findByName: profilesFind },
    models: { options: async () => ({ keyMode: "unreadable" }), check },
    environments: { get: async () => HOSTED },
    queue: {
      findImplementerTurn: async () => options.found,
      enqueueImplementerTurn: enqueue,
    },
    operatorCostLimitCents: async () => 500,
    log: () => {},
  } as unknown as ImplementerServiceDependencies;
  return {
    service: createImplementerService(deps),
    enqueue,
    check,
    profilesFind,
  };
}

const TASK = {
  repositoryId: "repo-app",
  baseBranch: "main",
  branch: "workflow/run-1/implement",
  instruction: "Do it.",
  model: OWN,
  environmentId: "env-vm",
  clientRequestId: "wf-run-1-0",
};

const OPTIONS: StartTaskOptions = {
  workflowStep: true,
  costCapCents: 300,
  inline: { profile: PROFILE },
};

describe("a task of a step with settings of its own (#1105)", () => {
  // #1105-T40
  it("writes the turn with the profile copy of the step, reads no profile, and checks the model like any model", async () => {
    const { service, enqueue, check, profilesFind } = build();

    await service.startTask(USER, TASK, OPTIONS);

    const call = enqueue.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      profile: PROFILE,
      modelChoice: OWN,
      // The cap of the lane's budget is the only limit of the turn.
      costLimitCents: 300,
    });
    expect(check).toHaveBeenCalledWith(OWN);
    expect(profilesFind).not.toHaveBeenCalled();
  });

  // #1105-T41
  it("keeps the size of the hosted environment and takes the script and the network rule of the step, none given is none", async () => {
    const { service, enqueue } = build();

    await service.startTask(USER, TASK, {
      ...OPTIONS,
      inline: {
        profile: PROFILE,
        setupScript: "npm ci",
        network: { mode: "list", hosts: ["registry.npmjs.org"] },
      },
    });
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      environment: {
        id: "env-vm",
        vcpus: 4,
        setupScript: "npm ci",
        network: { mode: "list", hosts: ["registry.npmjs.org"] },
      },
    });

    await service.startTask(
      USER,
      { ...TASK, clientRequestId: "wf-run-1-1" },
      OPTIONS,
    );
    expect(enqueue.mock.calls[1]?.[0]).toMatchObject({
      environment: {
        vcpus: 4,
        setupScript: "",
        network: { mode: "off", hosts: [] },
      },
    });
  });

  // #1105-T42
  it("leaves a task without inline settings as it was: the environment keeps its own script and rule", async () => {
    const { service, enqueue } = build();

    await service.startTask(USER, TASK, { workflowStep: true });

    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      profile: null,
      environment: {
        setupScript: "echo environment",
        network: { mode: "open", hosts: [] },
      },
    });
  });

  // #1105-T43
  it("never takes inline settings from a request body: the option is the engine's", async () => {
    const { service } = build();
    // A body cannot carry `inline`; a body with a profile and a model is refused as before.
    await expect(
      service.startTask(USER, {
        ...TASK,
        clientRequestId: "request-1",
        profile: "worker",
      }),
    ).rejects.toBeInstanceOf(ImplementerError);
  });

  // #1105-T44
  it("hands back the first task for a repeated request, and refuses another copy or model for the same id", async () => {
    const found = {
      status: "existing",
      job: { id: "job-1" },
      session: {
        id: "session-1",
        repositoryId: "repo-app",
        baseBranch: "main",
        branch: "workflow/run-1/implement",
        repos: null,
      },
      turn: {
        instruction: "Do it.",
        modelChoice: OWN,
        // The cap of the first request: the budget has moved since, so it is not compared.
        costLimitCents: 450,
        profile: PROFILE,
        environment: { id: "env-vm" },
        resultSchema: null,
      },
    };
    const { service, enqueue } = build({ found });

    expect(await service.startTask(USER, TASK, OPTIONS)).toEqual({
      runId: "job-1",
      sessionId: "session-1",
      created: false,
    });
    for (const changed of [
      { ...OPTIONS, inline: { profile: { ...PROFILE, canPush: false } } },
      {
        ...OPTIONS,
        inline: { profile: { ...PROFILE, instructions: "other" } },
      },
      { ...OPTIONS, inline: { profile: { ...PROFILE, version: 5 } } },
    ])
      await expect(
        service.startTask(USER, TASK, changed),
      ).rejects.toMatchObject({ code: "IMPLEMENTER_REQUEST_REUSED" });
    await expect(
      service.startTask(
        USER,
        { ...TASK, model: { provider: "anthropic", model: "other" } },
        OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "IMPLEMENTER_REQUEST_REUSED" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  // #1105-T45
  it("asks for write access to the repositories when the step may push, and not when it may not", async () => {
    const readOnly = {
      ...OPTIONS,
      inline: { profile: { ...PROFILE, canPush: false } },
    };
    const repos = [{ repositoryId: "repo-app" }];
    const denied = build({ write: false });
    await expect(
      denied.service.startTask(USER, { ...TASK, repos }, OPTIONS),
    ).rejects.toMatchObject({ code: "IMPLEMENTER_WRITE_NOT_GRANTED" });
    expect(denied.enqueue).not.toHaveBeenCalled();
    await denied.service.startTask(USER, { ...TASK, repos }, readOnly);
    expect(denied.enqueue).toHaveBeenCalledTimes(1);
  });
});
