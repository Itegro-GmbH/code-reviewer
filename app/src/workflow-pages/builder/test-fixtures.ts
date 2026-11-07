// SPDX-License-Identifier: LicenseRef-Proprietary

// Fixtures for the tests of the lane builder (#926): the shipped lane "Issue to PR" (the contract's example, as the builder opens it)
// and a stand-in for the builder's calls that asks the real validator, so what a test sees is what the validate route would answer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { FAKE_RESOLVER } from "../../workflows/test-fixtures.ts";
import { reachAt, type ReachSamples } from "../../workflows/reach.ts";
import { validateWorkflow } from "../../workflows/validate.ts";
import { TARGET_ROOTS, type TargetRoot } from "../../workflows/connectors.ts";
import type {
  BuilderApi,
  ReachLookup,
  SavedWorkflow,
  ValidateAnswer,
} from "./api.ts";

export function shippedLane(): Record<string, unknown> {
  const file = join(
    import.meta.dirname,
    "../../../../contracts/examples/workflow/Workflow.json",
  );
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function answerOf(document: unknown): ValidateAnswer {
  const result = validateWorkflow(document, FAKE_RESOLVER);
  return {
    valid: result.valid,
    errors: result.errors,
    truncated: result.truncated,
    steps: result.steps,
    ...(result.budgetUsd === undefined ? {} : { budgetUsd: result.budgetUsd }),
  };
}

/** A lookup that asks the real scope rules about a document, like the scope route would. */
export function reachLookupFor(
  document: unknown,
  samples?: ReachSamples,
): ReachLookup {
  return (request) => {
    const roots = (request.targetRoots ?? []).filter(
      (root): root is TargetRoot =>
        (TARGET_ROOTS as readonly string[]).includes(root),
    );
    const reach = reachAt(document, FAKE_RESOLVER, request.at, {
      ...(request.targetRoots === undefined
        ? {}
        : { target: { input: "this field", roots } }),
      ...(request.wants === undefined ? {} : { wants: request.wants }),
      ...(samples === undefined ? {} : { samples }),
    });
    return Promise.resolve(
      reach === undefined
        ? {
            ok: false as const,
            status: 400,
            code: "WORKFLOW_REQUEST_INVALID",
            issues: [],
          }
        : {
            ok: true as const,
            data: { ...reach, sampled: samples !== undefined },
          },
    );
  };
}

/** A builder API whose validate is the real validator and whose save keeps what it was given. */
export function fakeBuilderApi(version = 1): {
  api: BuilderApi;
  saved: unknown[];
  validate: ReturnType<typeof vi.fn>;
  scope: ReturnType<typeof vi.fn>;
} {
  const saved: unknown[] = [];
  const validate = vi.fn((document: unknown) =>
    Promise.resolve({ ok: true as const, data: answerOf(document) }),
  );
  const scope = vi.fn(
    (document: unknown, request: Parameters<ReachLookup>[0]) =>
      reachLookupFor(document)(request),
  );
  const api: BuilderApi = {
    validate,
    scope,
    save: (workflowId, document, expectedVersion) => {
      saved.push(document);
      const workflow: SavedWorkflow = {
        id: workflowId,
        name: "Issue to PR",
        version: expectedVersion + 1,
        documentVersion: expectedVersion + 1,
        document,
        versions: [
          { version: expectedVersion + 1, savedAt: "2026-11-07T10:00:00.000Z" },
          { version: version, savedAt: "2026-11-06T10:00:00.000Z" },
        ],
      };
      return Promise.resolve({ ok: true as const, data: { workflow } });
    },
  };
  return { api, saved, validate, scope };
}
