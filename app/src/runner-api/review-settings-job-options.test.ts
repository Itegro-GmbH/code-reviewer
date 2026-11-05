// SPDX-License-Identifier: LicenseRef-Proprietary

// #195 finding 2: the claim preparation must follow the **claimed job's pinned kind**, never the
// project's current kind. A settings save can run after the atomic claim but before `optionsFor`
// reads the settings; whichever way the kind moved, the job keeps the options of the kind it was
// queued for.
import { describe, expect, it } from "vitest";
import {
  resolveProjectDynamicSettings,
  resolveReviewSettings,
} from "../review-settings/effective.ts";
import {
  builtInProjectDynamicSettings,
  builtInReviewSettings,
} from "../review-settings/settings.ts";
import type { ProjectReviewKind } from "../job-kind/job-kind.ts";
import type { Job } from "../jobs/job-types.ts";
import { createReviewSettingsJobOptionsSource } from "./review-settings-job-options.ts";

const NO_LAYERS = {
  diff: { workspace: {}, project: {} },
  dynamic: { workspace: {}, project: {} },
};

function resolved(projectKind: ProjectReviewKind) {
  const builtInDynamic = {
    ...builtInProjectDynamicSettings(),
    dynamicModel: "dynamic-model",
  };
  return {
    ...resolveReviewSettings({ builtIn: builtInReviewSettings("diff-model") }),
    dynamic: resolveProjectDynamicSettings({
      builtIn: builtInDynamic,
      project: { reviewKind: projectKind },
      defaultSkill: "the shipped skill",
    }),
    modelLayers: NO_LAYERS,
  };
}

function sourceFor(projectKind: ProjectReviewKind) {
  const value = resolved(projectKind);
  return createReviewSettingsJobOptionsSource({
    settings: () => ({
      resolveForRepository: async () => value,
    }),
  });
}

function job(reviewKind: ProjectReviewKind): Job {
  return {
    id: "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11",
    workspaceId: "workspace-1",
    repositoryId: "repo-1",
    prNumber: 7,
    prUrl: "https://github.example/acme/widgets/pull/7",
    headSha: "a".repeat(40),
    reviewKind,
    command: "review",
    args: "",
    triggerKind: "webhook",
    actorLogin: "octocat",
    deliveryId: "delivery-1",
    status: "running",
    runAfter: "2026-10-10T12:00:00.000Z",
    attempts: 0,
    runnerId: "runner-1",
    claimedAt: "2026-10-10T12:00:00.000Z",
    heartbeatAt: "2026-10-10T12:00:30.000Z",
    leaseExpiresAt: "2026-10-10T12:02:30.000Z",
    result: null,
    errorCode: null,
    supersededBy: null,
    cancelRequestedAt: null,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    finishedAt: null,
  };
}

describe("the job options of a claimed job", () => {
  // #262-T02
  it("gives a Dynamic job of a project without a model override the OpenRouter id, in both model fields", async () => {
    const source = createReviewSettingsJobOptionsSource({
      settings: () => ({
        resolveForRepository: async () => ({
          ...resolveReviewSettings({
            builtIn: builtInReviewSettings("diff-model"),
          }),
          dynamic: resolveProjectDynamicSettings({
            builtIn: builtInProjectDynamicSettings(),
            project: { reviewKind: "dynamic" },
            defaultSkill: "the shipped skill",
          }),
          modelLayers: NO_LAYERS,
        }),
      }),
    });

    const options = await source.optionsFor(job("dynamic"));

    expect(options.dynamic).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
    });
    expect(options.llm?.model).toBe("deepseek/deepseek-v4.1-flash");
  });

  // #195 finding 2
  it("gives a claimed Dynamic job its Dynamic options even after the project turned Diff", async () => {
    const options = await sourceFor("diff").optionsFor(job("dynamic"));

    expect(options.dynamic).toMatchObject({ model: "dynamic-model" });
    expect(options.llm?.model).toBe("dynamic-model");
    // No PR-Agent option is promoted into the Dynamic job.
    expect(options.env).toStrictEqual({});
  });

  // #666-T01
  it.each(["diff", "dynamic"] as const)(
    "carries the effective cost limit of the project in a %s job",
    async (kind) => {
      const value = {
        ...resolved(kind),
        ...resolveReviewSettings({
          builtIn: builtInReviewSettings("diff-model"),
          global: { maxCostCents: 100 },
          project: { maxCostCents: 250 },
        }),
      };
      const source = createReviewSettingsJobOptionsSource({
        settings: () => ({ resolveForRepository: async () => value }),
      });

      const options = await source.optionsFor(job(kind));

      expect(options.llm?.maxCostCents).toBe(250);
    },
  );

  // #666-T02
  it.each(["diff", "dynamic"] as const)(
    "carries no cost limit in a %s job when none is set",
    async (kind) => {
      const options = await sourceFor("diff").optionsFor(job(kind));

      expect(options.llm?.maxCostCents ?? null).toBeNull();
    },
  );

  // #434-T03
  it("carries no model tier for either kind: the catalog entry is the only choice", async () => {
    const legacy = ["model", "Tier"].join("");
    for (const kind of ["diff", "dynamic"] as const)
      expect(
        Object.keys(await sourceFor(kind).optionsFor(job(kind))),
      ).not.toContain(legacy);
  });

  // #195 finding 2
  it("gives a claimed Diff job the PR-Agent options even after the project turned Dynamic", async () => {
    const options = await sourceFor("dynamic").optionsFor(job("diff"));

    expect(options.dynamic).toBeUndefined();
    expect(options.llm?.model).toBe("diff-model");
    expect(options.env).toHaveProperty("PR_REVIEWER__NUM_MAX_FINDINGS");
  });
  // #432-T01
  it("hands the claim the layers of the job's pinned kind and the entry the project selected for it", async () => {
    const source = (kind: ProjectReviewKind) =>
      createReviewSettingsJobOptionsSource({
        settings: () => ({
          resolveForRepository: async () => ({
            ...resolveReviewSettings({
              builtIn: builtInReviewSettings("diff-model"),
            }),
            dynamic: {
              ...resolveProjectDynamicSettings({
                builtIn: builtInProjectDynamicSettings(),
                project: { reviewKind: kind },
                defaultSkill: "the shipped skill",
              }),
              catalogEntryDiff: "mce_diff",
              catalogEntryDynamic: "mce_dynamic",
            },
            modelLayers: {
              diff: {
                workspace: { provider: "p", model: "workspace-model" },
                project: { model: "project-model" },
              },
              dynamic: {
                workspace: { provider: "p", model: "dynamic-workspace-model" },
                project: { model: "dynamic-project-model" },
              },
            },
          }),
        }),
      });

    // The project moved to Dynamic after the Diff job was claimed: the job keeps the selection of its own kind.
    expect((await source("dynamic").optionsFor(job("diff"))).selection).toEqual(
      {
        layers: {
          workspace: { provider: "p", model: "workspace-model" },
          project: { model: "project-model" },
        },
        entryId: "mce_diff",
      },
    );
    expect((await source("diff").optionsFor(job("dynamic"))).selection).toEqual(
      {
        // #676-T03: the workspace default of the Dynamic provider and model travels apart from the project's.
        layers: {
          workspace: { provider: "p", model: "dynamic-workspace-model" },
          project: { model: "dynamic-project-model" },
        },
        entryId: "mce_dynamic",
      },
    );
  });
});
