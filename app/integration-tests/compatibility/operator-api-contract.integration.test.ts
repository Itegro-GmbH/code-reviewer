// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that the app and contracts/operator-api.v1.json describe the same API: what the app really answers
// (through the real API) is valid against the file, what the app accepts as a body is what the file allows for
// the cases the file can express, and the lists the app keeps in TypeScript (error codes, limits, key modes)
// are the lists of the file. An external client is built against this file.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { planReturnPath } from "../../src/plan-handoff/return-path.ts";
import {
  checkPlanManagementUrl,
  MAX_PLAN_MANAGEMENT_URL_LENGTH,
  PLAN_MANAGEMENT_URL_ERROR_CODES,
} from "../../src/plan-handoff/url.ts";
import {
  createHandoffToken,
  hashHandoffToken,
} from "../../src/plan-handoff/token.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import {
  MAX_USAGE_CURSOR_LENGTH,
  TIER_NAME_PATTERN,
  OPERATOR_API_ERROR_CODES,
  OPERATOR_API_VERSION,
  OPERATOR_ID_PATTERN,
  OPERATOR_MAX_BODY_BYTES,
  USAGE_SAFETY_LAG_MS,
} from "../../src/operator-api/contract.ts";
import {
  startOperatorApiHarness,
  type CallOptions,
} from "../../src/test-support/operator-api-harness.ts";
import {
  createContractValidator,
  OPERATOR_CONTRACT_FILE,
  readContract,
  readExamples,
} from "../../src/test-support/runner-contract.ts";
import { JOB_KINDS } from "../../src/job-kind/job-kind.ts";
import { KEY_MODES, LIMIT_NAMES } from "../../src/workspaces/entitlements.ts";
import {
  CATALOG_ENTRY_ID_PATTERN,
  MODEL_ACCESS_MAX_ENTRIES,
} from "../../src/workspaces/entitlements-validation.ts";

const contract = createContractValidator(OPERATOR_CONTRACT_FILE);

function expectValid(definition: string, document: unknown) {
  const { valid, errors } = contract.check(definition, document);
  expect({ valid, errors }).toStrictEqual({ valid: true, errors: "" });
}

const ENTRY_ID = "mce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const WRITE = {
  planLabel: "team",
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 100,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: 5_000_000,
    ownKeyCostLimitMicroUsd: null,
  },
  periodStart: "2026-10-01T00:00:00.000Z",
  suspended: false,
  suspensionCode: null,
};

describe("the contract file", () => {
  // #275-T10
  it("is version 1 and the app speaks version 1", () => {
    expect(readContract(OPERATOR_CONTRACT_FILE).version).toBe(1);
    expect(OPERATOR_API_VERSION).toBe(1);
    expect(readContract(OPERATOR_CONTRACT_FILE).$defs.Version?.const).toBe(1);
  });

  // #275-T10
  it("lists the same error codes as the app's TypeScript list", () => {
    const listed = readContract(OPERATOR_CONTRACT_FILE).$defs.ApiErrorCode
      ?.enum;

    expect([...OPERATOR_API_ERROR_CODES].sort()).toStrictEqual(
      [...(listed ?? [])].sort(),
    );
  });

  // #275-T10
  it("names the same key modes, limits, id pattern and body size as the app", () => {
    const defs = readContract(OPERATOR_CONTRACT_FILE).$defs as unknown as {
      EntitlementsFields: { properties: { keyMode: { enum: string[] } } };
      EntitlementLimits: { required: string[] };
      WorkspaceId: { pattern: string };
      ApiErrorCode: { description: string };
    };

    expect(defs.EntitlementsFields.properties.keyMode.enum).toEqual([
      ...KEY_MODES,
    ]);
    expect([...defs.EntitlementLimits.required].sort()).toEqual(
      [...LIMIT_NAMES].sort(),
    );
    expect(defs.WorkspaceId.pattern).toBe(OPERATOR_ID_PATTERN.source);
    expect(
      readContract(OPERATOR_CONTRACT_FILE) as unknown as {
        description: string;
      },
    ).toMatchObject({
      description: expect.stringContaining(String(OPERATOR_MAX_BODY_BYTES)),
    });
  });

  // #428-T08
  it("names the code, the id shape and the most entries of the model access like the app", () => {
    const defs = readContract(OPERATOR_CONTRACT_FILE).$defs as unknown as {
      ApiErrorCode: { enum: string[] };
      ModelAccess: {
        required: string[];
        additionalProperties: boolean;
        properties: {
          catalogEntries: {
            type: string[];
            maxItems: number;
            items: { pattern: string };
          };
        };
      };
    };

    expect(defs.ApiErrorCode.enum).toContain("catalog_entry_invalid");
    expect(OPERATOR_API_ERROR_CODES).toContain("catalog_entry_invalid");
    expect(defs.ModelAccess.required).toEqual(["catalogEntries"]);
    expect(defs.ModelAccess.additionalProperties).toBe(false);
    expect(defs.ModelAccess.properties.catalogEntries.type).toEqual([
      "array",
      "null",
    ]);
    expect(defs.ModelAccess.properties.catalogEntries.maxItems).toBe(
      MODEL_ACCESS_MAX_ENTRIES,
    );
    expect(defs.ModelAccess.properties.catalogEntries.items.pattern).toBe(
      CATALOG_ENTRY_ID_PATTERN.source,
    );
  });

  // #275-T10
  it.each(readExamples("examples/operator-api"))(
    "has a valid example for $definition",
    ({ definition, document }) => {
      expectValid(definition, document);
    },
  );

  // #275-T10
  it("has an example for every body definition", () => {
    const named = readExamples("examples/operator-api").map(
      (example) => example.definition,
    );

    expect(named.sort()).toEqual(
      [
        "DefaultEntitlementsResponse",
        "EffectiveEntitlements",
        "EntitlementsFields",
        "EntitlementsWrite",
        "ErrorResponse",
        "HandoffRedeemRequest",
        "HandoffRedeemResponse",
        "PlanManagementResponse",
        "PlanManagementWrite",
        "StoredEntitlements",
        "UnknownCostCountsResponse",
        "UsageItem",
        "UsagePage",
        "UsageSummaryResponse",
        "WorkspaceEntitlementsResponse",
        "WorkspaceList",
        "WorkspaceSummary",
      ].sort(),
    );
  });
});

describe("the usage part of the contract file", () => {
  // #278-T09
  it("names the same cursor size, safety lag, key modes, review kinds and states as the app", () => {
    const defs = readContract(OPERATOR_CONTRACT_FILE).$defs as unknown as {
      UsageCursor: { maxLength: number };
      UsageItem: {
        properties: {
          modelTier: { pattern: string };
          keyMode: { enum: string[] };
          reviewKind: { enum: string[] };
        };
      };
      UsagePage: { description: string };
    };

    expect(defs.UsageCursor.maxLength).toBe(MAX_USAGE_CURSOR_LENGTH);
    expect(defs.UsageItem.properties.modelTier.pattern).toBe(
      TIER_NAME_PATTERN.source,
    );
    expect(defs.UsageItem.properties.keyMode.enum).toEqual([...KEY_MODES]);
    // #752: a record is of the kind of its job, and a turn of the Implementer has its own.
    expect(defs.UsageItem.properties.reviewKind.enum).toEqual([...JOB_KINDS]);
    expect(defs.UsagePage.description).toContain(
      `${USAGE_SAFETY_LAG_MS / 1000} seconds`,
    );
    expect(defs.UsagePage.description).toContain("idempotency key");
  });

  // #432-T14
  it("grows by the entry id and name as optional fields, so a strict reader of the previous release still validates", () => {
    const defs = readContract(OPERATOR_CONTRACT_FILE).$defs as unknown as {
      UsageItem: { required: string[] };
    };

    expect(defs.UsageItem.required).not.toContain("catalogEntryId");
    expect(defs.UsageItem.required).not.toContain("catalogEntryName");
    expect(defs.UsageItem.required).toContain("modelTier");
  });

  // #278-T09
  it("promises no field that could carry a repository, a pull request, a title, a user or a model name", () => {
    const defs = readContract(OPERATOR_CONTRACT_FILE).$defs as unknown as {
      UsageItem: {
        properties: Record<string, unknown>;
        additionalProperties?: unknown;
      };
    };

    expect(Object.keys(defs.UsageItem.properties).sort()).toEqual(
      [
        "catalogEntryId",
        "catalogEntryName",
        "completionTokens",
        "costMicroUsd",
        "id",
        "jobId",
        "keyMode",
        "modelTier",
        "promptTokens",
        "reason",
        "reviewKind",
        "settledAt",
        "workspaceId",
      ].sort(),
    );
  });
});

describe("the unknown cost part of the contract file", () => {
  // #385-T09
  it("promises a plain integer per workspace and key mode, and no figure, model, key or name", () => {
    const defs = readContract(OPERATOR_CONTRACT_FILE).$defs as unknown as {
      UnknownCostCount: {
        required: string[];
        properties: Record<string, { enum?: string[]; type?: string }>;
      };
      UnknownCostCountsResponse: { required: string[] };
    };

    expect(Object.keys(defs.UnknownCostCount.properties).sort()).toEqual([
      "keyMode",
      "unknownCostCount",
      "workspaceId",
    ]);
    expect([...defs.UnknownCostCount.required].sort()).toEqual([
      "keyMode",
      "unknownCostCount",
      "workspaceId",
    ]);
    expect(defs.UnknownCostCount.properties.keyMode?.enum).toEqual([
      ...KEY_MODES,
    ]);
    expect(defs.UnknownCostCount.properties.unknownCostCount?.type).toBe(
      "integer",
    );
    expect([...defs.UnknownCostCountsResponse.required].sort()).toEqual([
      "counts",
      "from",
      "nextAfter",
      "to",
      "version",
    ]);
  });

  // #385-T09
  it("only grows: every definition of the version before the count is still there", () => {
    const names = Object.keys(
      readContract(OPERATOR_CONTRACT_FILE).$defs as object,
    );

    for (const before of [
      "ErrorResponse",
      "WorkspaceList",
      "WorkspaceEntitlementsResponse",
      "UsageCursor",
      "UsageItem",
      "UsagePage",
      "UsageSummaryGroup",
      "UsageSummaryResponse",
      "PlanManagementWrite",
      "HandoffRedeemResponse",
    ])
      expect(names).toContain(before);
  });
});

describe("the plan handoff part of the contract file", () => {
  // #284-T11
  it("allows the addresses the app saves and the codes it refuses with", () => {
    const defs = readContract(OPERATOR_CONTRACT_FILE).$defs as unknown as {
      PlanManagementWrite: {
        properties: { url: { maxLength: number; pattern: string } };
      };
      ApiErrorCode: { enum: string[] };
    };

    expect(defs.PlanManagementWrite.properties.url.maxLength).toBe(
      MAX_PLAN_MANAGEMENT_URL_LENGTH,
    );
    expect(defs.PlanManagementWrite.properties.url.pattern).toBe("^https://");
    expect(defs.ApiErrorCode.enum).toEqual(
      expect.arrayContaining([
        ...PLAN_MANAGEMENT_URL_ERROR_CODES,
        "invalid_token",
      ]),
    );
    // What the file allows for `url` is a superset of what the app saves: whatever the app stores is valid.
    const stored = checkPlanManagementUrl("https://plans.example/a?b=c");
    expect(stored.ok).toBe(true);
    expectValid("PlanManagementResponse", {
      version: 1,
      planManagementUrl: stored.ok ? stored.url : null,
    });
  });

  // #284-P2
  it("names the return path the app has, from the one constant", () => {
    const defs = readContract(OPERATOR_CONTRACT_FILE).$defs as unknown as {
      HandoffRedeemResponse: { description: string };
    };

    expect(defs.HandoffRedeemResponse.description).toContain(
      planReturnPath("SLUG").replace("SLUG", "<workspaceSlug>"),
    );
  });

  // #284-T03
  it("promises exactly the fields the redemption answers, and no person data", () => {
    const defs = readContract(OPERATOR_CONTRACT_FILE).$defs as unknown as {
      HandoffRedeemResponse: {
        properties: Record<string, { enum?: string[] }>;
      };
    };

    expect(Object.keys(defs.HandoffRedeemResponse.properties).sort()).toEqual(
      ["role", "userId", "version", "workspaceId", "workspaceSlug"].sort(),
    );
    expect(defs.HandoffRedeemResponse.properties.role?.enum).toEqual([
      "owner",
      "admin",
    ]);
  });
});

describe("what the app answers", () => {
  const path = (id: string) => `/api/operator/v1/workspaces/${id}/entitlements`;

  async function answer(
    response: Response,
    definition: string,
  ): Promise<unknown> {
    const body: unknown = await response.json();
    expectValid(definition, body);
    return body;
  }

  // #275-T10
  it("answers the list, the entitlements, the default and removal with documents valid against the file", async () => {
    const h = await startOperatorApiHarness();
    await h.addWorkspace("second");

    await answer(
      await h.call("GET", "/api/operator/v1/workspaces?limit=1"),
      "WorkspaceList",
    );
    await answer(
      await h.call("GET", "/api/operator/v1/workspaces"),
      "WorkspaceList",
    );
    await answer(
      await h.call("GET", path(h.workspaceId)),
      "WorkspaceEntitlementsResponse",
    );
    await answer(
      await h.call("GET", "/api/operator/v1/entitlements/default"),
      "DefaultEntitlementsResponse",
    );
    await answer(
      await h.call("PUT", "/api/operator/v1/entitlements/default", {
        body: WRITE,
      }),
      "DefaultEntitlementsResponse",
    );
    await answer(
      await h.call("PUT", path(h.workspaceId), { body: WRITE }),
      "WorkspaceEntitlementsResponse",
    );
    await answer(
      await h.call("GET", path(h.workspaceId)),
      "WorkspaceEntitlementsResponse",
    );
    await answer(
      await h.call("DELETE", path(h.workspaceId)),
      "WorkspaceEntitlementsResponse",
    );
    // A row that cannot be read, and the default seen through a workspace without a row.
    await h.call("PUT", path(h.workspaceId), { body: WRITE });
    await h.db
      .updateTable("workspace_entitlements")
      .set({ limits: "x" })
      .execute();
    await answer(
      await h.call("GET", path(h.workspaceId)),
      "WorkspaceEntitlementsResponse",
    );
  });

  // #278-T09
  it("answers the usage feed, the usage of a workspace and its summary with documents valid against the file", async () => {
    const h = await startOperatorApiHarness();
    const seeded = {
      workspaceId: h.workspaceId,
      reservedAt: "2026-10-14T11:00:00.000Z",
      settledAt: "2026-10-14T11:00:01.000Z",
    };
    await h.usage.seed({
      ...seeded,
      keyMode: "managed",
      modelTier: "standard",
      costMicroUsd: 12346,
      promptTokens: 10,
      completionTokens: 5,
    });
    await h.usage.seed({ ...seeded, reviewKind: "dynamic" });
    const page = (await answer(
      await h.call("GET", "/api/operator/v1/usage?limit=1"),
      "UsagePage",
    )) as {
      nextCursor: string;
    };
    await answer(
      await h.call("GET", `/api/operator/v1/usage?after=${page.nextCursor}`),
      "UsagePage",
    );
    await answer(
      await h.call(
        "GET",
        "/api/operator/v1/usage?after=" + page.nextCursor + "&limit=200",
      ),
      "UsagePage",
    );
    await answer(
      await h.call("GET", `/api/operator/v1/workspaces/${h.workspaceId}/usage`),
      "UsagePage",
    );
    await answer(
      await h.call(
        "GET",
        `/api/operator/v1/workspaces/${h.workspaceId}/usage?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z`,
      ),
      "UsagePage",
    );
    await answer(
      await h.call(
        "GET",
        `/api/operator/v1/workspaces/${h.workspaceId}/usage/summary?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z`,
      ),
      "UsageSummaryResponse",
    );
    await answer(
      await h.call(
        "GET",
        `/api/operator/v1/workspaces/${h.workspaceId}/usage/summary?from=2020-10-01T00:00:00.000Z&to=2020-11-01T00:00:00.000Z`,
      ),
      "UsageSummaryResponse",
    );
    // #385: the count of unknown costs, with a page, with the last page and with nothing to count.
    const period = "from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z";
    const counted = (await answer(
      await h.call(
        "GET",
        `/api/operator/v1/usage/unknown-cost?${period}&limit=1`,
      ),
      "UnknownCostCountsResponse",
    )) as { counts: unknown[]; nextAfter: string | null };
    expect(counted.counts).not.toHaveLength(0);
    await answer(
      await h.call("GET", `/api/operator/v1/usage/unknown-cost?${period}`),
      "UnknownCostCountsResponse",
    );
    await answer(
      await h.call(
        "GET",
        "/api/operator/v1/usage/unknown-cost?from=2020-10-01T00:00:00.000Z&to=2020-11-01T00:00:00.000Z",
      ),
      "UnknownCostCountsResponse",
    );
    // An empty feed has no position yet.
    const empty = await startOperatorApiHarness();
    await answer(
      await empty.call("GET", "/api/operator/v1/usage"),
      "UsagePage",
    );
  });

  // #278-T09
  it("answers every usage error with a document valid against the file", async () => {
    const h = await startOperatorApiHarness();
    const id = h.workspaceId;
    const cases: Array<[string, string, CallOptions]> = [
      ["GET", "/api/operator/v1/usage?after=%20", {}],
      ["GET", "/api/operator/v1/usage?limit=0", {}],
      ["GET", `/api/operator/v1/workspaces/${id}/usage?from=x`, {}],
      ["GET", `/api/operator/v1/workspaces/${id}/usage/summary`, {}],
      ["GET", "/api/operator/v1/usage/unknown-cost", {}],
      ["GET", "/api/operator/v1/usage/unknown-cost?limit=0&from=a", {}],
      ["POST", "/api/operator/v1/usage/unknown-cost", {}],
      ["GET", "/api/operator/v1/workspaces/nope/usage", {}],
      ["GET", "/api/operator/v1/usage", { token: null }],
      ["POST", "/api/operator/v1/usage", {}],
    ];
    for (const [method, target, options] of cases) {
      const response = await h.call(method, target, options);
      expect(response.status).toBeGreaterThanOrEqual(400);
      await answer(response, "ErrorResponse");
    }
  });

  // #428-T01
  it("answers a row with a model access, one without it and the default with documents valid against the file", async () => {
    const h = await startOperatorApiHarness();

    for (const modelAccess of [
      undefined,
      { catalogEntries: [ENTRY_ID] },
      { catalogEntries: [] },
      { catalogEntries: null },
    ]) {
      await answer(
        await h.call("PUT", "/api/operator/v1/entitlements/default", {
          body: {
            ...WRITE,
            ...(modelAccess === undefined ? {} : { modelAccess }),
          },
        }),
        "DefaultEntitlementsResponse",
      );
      await answer(
        await h.call("PUT", path(h.workspaceId), {
          body: {
            ...WRITE,
            ...(modelAccess === undefined ? {} : { modelAccess }),
          },
        }),
        "WorkspaceEntitlementsResponse",
      );
    }
    // A row of before the field existed.
    await h.db
      .updateTable("workspace_entitlements")
      .set({ model_access: null })
      .execute();
    await answer(
      await h.call("GET", path(h.workspaceId)),
      "WorkspaceEntitlementsResponse",
    );
    // The refusal.
    const refused = await h.call("PUT", path(h.workspaceId), {
      body: { ...WRITE, modelAccess: { catalogEntries: "all" } },
    });
    expect(refused.status).toBe(422);
    await answer(refused, "ErrorResponse");
  });

  // #428-T01
  it("accepts the answers of an instance that is not yet upgraded: a response without modelAccess is valid, a write without it too", () => {
    const fields = {
      planLabel: "team",
      keyMode: "managed",
      limits: Object.fromEntries(LIMIT_NAMES.map((name) => [name, null])),
      periodStart: "2026-10-01T00:00:00.000Z",
      suspended: false,
      suspensionCode: null,
    };

    expectValid("EntitlementsFields", fields);
    expectValid("StoredEntitlements", {
      ...fields,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expectValid("DefaultEntitlementsResponse", {
      version: 1,
      default: fields,
    });
    expect(
      contract.check("EntitlementsFields", { ...fields, modelAccess: null })
        .valid,
    ).toBe(false);
  });

  // #275-T10
  it("answers every kind of error with a document valid against the file", async () => {
    const h = await startOperatorApiHarness();
    const huge = JSON.stringify({ ...WRITE, planLabel: "x".repeat(20_000) });
    const cases: Array<[string, string, CallOptions]> = [
      ["GET", "/api/operator/v1/workspaces", { token: null }],
      ["GET", "/api/operator/v1/nothing", {}],
      ["GET", path("nope"), {}],
      ["POST", "/api/operator/v1/workspaces", {}],
      ["GET", "/api/operator/v1/workspaces", { rawBody: "{}" }],
      ["GET", "/api/operator/v1/workspaces?limit=0", {}],
      ["PUT", path(h.workspaceId), { rawBody: "{" }],
      ["PUT", path(h.workspaceId), { rawBody: huge }],
      [
        "PUT",
        path(h.workspaceId),
        { rawBody: "{}", contentType: "text/plain" },
      ],
      ["PUT", path(h.workspaceId), { body: { ...WRITE, keyMode: "x" } }],
      [
        "PUT",
        path(h.workspaceId),
        {
          body: {
            ...WRITE,
            limits: { ...WRITE.limits, diffRunsPerPeriod: -1 },
          },
        },
      ],
    ];
    for (const [method, target, options] of cases) {
      const response = await h.call(method, target, options);
      expect(response.status).toBeGreaterThanOrEqual(400);
      await answer(response, "ErrorResponse");
    }
    await h.call("PUT", path(h.workspaceId), { body: WRITE });
    const backwards = await h.call("PUT", path(h.workspaceId), {
      body: { ...WRITE, periodStart: "2026-09-01T00:00:00.000Z" },
    });
    await answer(backwards, "ErrorResponse");
  });
});

describe("what the app accepts", () => {
  const { periodStart: _periodStart, ...WITHOUT_START } = WRITE;
  void _periodStart;

  const GOOD: unknown[] = [
    WRITE,
    WITHOUT_START,
    // #277: the own key takes no cost limit (cost_limit_requires_managed_key), so it is sent without one.
    {
      ...WRITE,
      keyMode: "own",
      limits: { ...WRITE.limits, managedCostLimitMicroUsd: null },
    },
    // #361: the own key takes the cost limit of its own, and the operator's key may carry one too (a workspace
    // can be switched between the two).
    {
      ...WRITE,
      keyMode: "own",
      limits: {
        ...WRITE.limits,
        managedCostLimitMicroUsd: null,
        ownKeyCostLimitMicroUsd: 2_000_000,
      },
    },
    {
      ...WRITE,
      limits: { ...WRITE.limits, ownKeyCostLimitMicroUsd: 0 },
    },
    { ...WRITE, limits: { ...WRITE.limits, diffRunsPerPeriod: 0 } },
    {
      ...WRITE,
      limits: {
        diffRunsPerPeriod: null,
        dynamicRunsPerPeriod: null,
        managedCostLimitMicroUsd: null,
        ownKeyCostLimitMicroUsd: null,
      },
    },
    { ...WRITE, suspended: true, suspensionCode: "unpaid" },
    { ...WRITE, periodStart: "2026-10-01T00:00:00Z".replace("Z", ".000Z") },
    // #428: the model access is optional (an older writer leaves it out and keeps the stored one), null is every
    // released entry, [] none; ids that no entry has are accepted; it is kept next to the own key.
    { ...WRITE, modelAccess: { catalogEntries: null } },
    { ...WRITE, modelAccess: { catalogEntries: [] } },
    { ...WRITE, modelAccess: { catalogEntries: [ENTRY_ID] } },
    {
      ...WRITE,
      modelAccess: {
        catalogEntries: Array.from(
          { length: 100 },
          (_unused, index) => `mce_${String(index)}`,
        ),
      },
    },
    {
      ...WRITE,
      keyMode: "own",
      limits: { ...WRITE.limits, managedCostLimitMicroUsd: null },
      modelAccess: { catalogEntries: [ENTRY_ID] },
    },
  ];
  const BAD: unknown[] = [
    null,
    [],
    "text",
    {},
    { ...WRITE, keyMode: "shared" },
    // #277: a cost limit, even 0, next to the own key.
    { ...WRITE, keyMode: "own" },
    {
      ...WRITE,
      keyMode: "own",
      limits: { ...WRITE.limits, managedCostLimitMicroUsd: 0 },
    },
    { ...WRITE, planLabel: "" },
    { ...WRITE, planLabel: "x".repeat(65) },
    { ...WRITE, suspended: "no" },
    { ...WRITE, suspensionCode: "Not A Code" },
    { ...WRITE, periodStart: "yesterday" },
    { ...WRITE, extra: 1 },
    { ...WRITE, limits: { diffRunsPerPeriod: 1 } },
    // #361: a write states every limit, the own-key one too; and it is a count or null.
    {
      ...WRITE,
      limits: {
        diffRunsPerPeriod: 1,
        dynamicRunsPerPeriod: null,
        managedCostLimitMicroUsd: null,
      },
    },
    { ...WRITE, limits: { ...WRITE.limits, ownKeyCostLimitMicroUsd: -1 } },
    { ...WRITE, limits: { ...WRITE.limits, ownKeyCostLimitMicroUsd: 1.5 } },
    { ...WRITE, limits: { ...WRITE.limits, ownKeyCostLimitMicroUsd: "5" } },
    { ...WRITE, limits: { ...WRITE.limits, diffRunsPerPeriod: -1 } },
    { ...WRITE, limits: { ...WRITE.limits, diffRunsPerPeriod: 1.5 } },
    { ...WRITE, limits: { ...WRITE.limits, diffRunsPerPeriod: "5" } },
    { ...WRITE, limits: { ...WRITE.limits, diffRunPerPeriod: 5 } },
    // #428: the shape of the model access.
    { ...WRITE, modelAccess: null },
    { ...WRITE, modelAccess: "all" },
    { ...WRITE, modelAccess: [ENTRY_ID] },
    { ...WRITE, modelAccess: {} },
    { ...WRITE, modelAccess: { catalogEntries: ENTRY_ID } },
    { ...WRITE, modelAccess: { catalogEntries: [1] } },
    { ...WRITE, modelAccess: { catalogEntries: ["gpt-5"] } },
    { ...WRITE, modelAccess: { catalogEntries: [`${ENTRY_ID} `] } },
    { ...WRITE, modelAccess: { catalogEntries: null, extra: 1 } },
    {
      ...WRITE,
      modelAccess: {
        catalogEntries: Array.from(
          { length: 101 },
          (_unused, index) => `mce_${String(index)}`,
        ),
      },
    },
  ];

  async function accepted(body: unknown): Promise<boolean> {
    const h = await startOperatorApiHarness();
    const response = await h.call(
      "PUT",
      `/api/operator/v1/workspaces/${h.workspaceId}/entitlements`,
      { body },
    );
    return response.status === 200;
  }

  // #275-T10
  it.each(GOOD.map((body, index) => [index, body] as const))(
    "gives the verdict of the file for good body %s",
    async (_index, body) => {
      expectValid("EntitlementsWrite", body);
      expect(await accepted(body)).toBe(true);
    },
  );

  // #275-T10
  it.each(BAD.map((body, index) => [index, body] as const))(
    "gives the verdict of the file for bad body %s",
    async (_index, body) => {
      expect(contract.check("EntitlementsWrite", body).valid).toBe(false);
      expect(await accepted(body)).toBe(false);
    },
  );
});

describe("what the app answers for the plan handoff", () => {
  // #284-T03
  it("answers the setting and the redemption with documents valid against the file", async () => {
    const h = await startOperatorApiHarness();
    await signedInMember(h.db, {
      id: "owner-1",
      workspaceId: h.workspaceId,
      role: "owner",
    });
    const token = createHandoffToken();
    await h.handoffTokens(h.workspaceId).issue({
      tokenHash: hashHandoffToken(token),
      userId: "owner-1",
      role: "owner",
      ttlMs: 60_000,
    });
    await createInstanceSettingsRepository(h.db).remove("plan_management_url");

    const expectBody = async (response: Response, definition: string) => {
      const body: unknown = await response.json();
      expectValid(definition, body);
    };
    await expectBody(
      await h.call("GET", "/api/operator/v1/plan-management"),
      "PlanManagementResponse",
    );
    await expectBody(
      await h.call("PUT", "/api/operator/v1/plan-management", {
        body: { url: "https://plans.example/manage" },
      }),
      "PlanManagementResponse",
    );
    await expectBody(
      await h.call("DELETE", "/api/operator/v1/plan-management"),
      "PlanManagementResponse",
    );
    // The request the app accepts is what the file describes, and so are both of its answers.
    expectValid("PlanManagementWrite", { url: "https://plans.example/manage" });
    expectValid("HandoffRedeemRequest", { token });
    await expectBody(
      await h.call("POST", "/api/operator/v1/handoff/redeem", {
        body: { token },
      }),
      "HandoffRedeemResponse",
    );
    for (const response of [
      await h.call("POST", "/api/operator/v1/handoff/redeem", {
        body: { token },
      }),
      await h.call("PUT", "/api/operator/v1/plan-management", {
        body: { url: "http://plans.example/" },
      }),
      await h.call("POST", "/api/operator/v1/handoff/redeem", {
        rawBody: "[]",
      }),
      await h.call("GET", "/api/operator/v1/handoff/redeem"),
    ])
      await expectBody(response, "ErrorResponse");
  });
});

describe("the removed model tiers part of the contract file (#434)", () => {
  // #434-T09
  it("has no definition, no error code and no path of the tier configuration any more", () => {
    const contractText = JSON.stringify(readContract(OPERATOR_CONTRACT_FILE));
    const defs = readContract(OPERATOR_CONTRACT_FILE).$defs as unknown as {
      ApiErrorCode: { enum: string[] };
    };

    for (const name of [
      "ModelTiersWrite",
      "ModelTiersResponse",
      "ModelTierAnswer",
      "ModelTierModels",
      "ModelId",
    ])
      expect(Object.keys(defs)).not.toContain(name);
    for (const code of [
      "model_id_invalid",
      "MODEL_UNKNOWN",
      "DYNAMIC_MODEL_TOOLS_UNSUPPORTED",
      "DYNAMIC_MODEL_UNKNOWN",
      "DYNAMIC_MODEL_UNVERIFIED",
    ])
      expect(defs.ApiErrorCode.enum).not.toContain(code);
    expect(contractText).not.toContain("/model-tiers");
  });

  // #434-T09
  it("answers a call of the removed path with the ErrorResponse of any missing path", async () => {
    const h = await startOperatorApiHarness();
    for (const response of [
      await h.call("GET", "/api/operator/v1/model-tiers"),
      await h.call("PUT", "/api/operator/v1/model-tiers", {
        body: { tiers: { low: { diff: "vendor/low-diff" } } },
      }),
    ]) {
      expect(response.status).toBe(404);
      expectValid("ErrorResponse", await response.json());
    }
  });
});
