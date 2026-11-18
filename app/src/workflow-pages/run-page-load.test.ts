// SPDX-License-Identifier: LicenseRef-Proprietary

// Which lane document the run page draws (#1079): the one of the version the run uses, read through the workflow service, whatever has
// been saved since; the page of a run is not hidden when that version cannot be read.
import { describe, expect, it, vi } from "vitest";
import { WorkflowError } from "../workflows/errors.ts";
import type { WorkflowService, WorkflowView } from "../workflows/service.ts";
import type { WorkflowRunService } from "../workflow-runs/service.ts";
import { loadRunPage } from "./pages.tsx";
import { run } from "./test-fixtures.ts";

const view = (version: number, document: unknown): WorkflowView =>
  ({
    id: "wf-1",
    name: "Issue to PR",
    version: 3,
    documentVersion: version,
    document,
    versions: [],
  }) as unknown as WorkflowView;

function services(
  options: { runVersion: number; older?: () => Promise<WorkflowView> } = {
    runVersion: 3,
  },
) {
  const get = vi.fn(async (_id: string, version?: number) =>
    version === undefined
      ? view(3, { current: true })
      : (options.older ?? (async () => view(version, { version })))(),
  );
  return {
    get,
    deps: {
      workflows: { get } as unknown as Pick<WorkflowService, "get">,
      runs: {
        get: async () => run({ workflowVersion: options.runVersion }),
      } as unknown as Pick<WorkflowRunService, "get">,
    },
  };
}

describe("the lane of a run", () => {
  // #1079-T30
  it("is the current document when the run uses the current version, without asking again", async () => {
    const { deps, get } = services({ runVersion: 3 });
    const page = await loadRunPage("wf-1", "run-1", deps);
    expect(page).toMatchObject({ kind: "ready", document: { current: true } });
    expect(get).toHaveBeenCalledTimes(1);
  });

  // #1079-T30
  it("is the document of the version the run uses when the lane was saved again since", async () => {
    const { deps, get } = services({ runVersion: 1 });
    const page = await loadRunPage("wf-1", "run-1", deps);
    expect(page).toMatchObject({ kind: "ready", document: { version: 1 } });
    expect(get).toHaveBeenLastCalledWith("wf-1", 1);
  });

  // #1079-T30
  it("is none when that version cannot be read, and the run is shown all the same", async () => {
    const { deps } = services({
      runVersion: 1,
      older: async () => {
        throw new WorkflowError(
          "WORKFLOW_VERSION_NOT_FOUND",
          "The workflow has no such version.",
        );
      },
    });
    expect(await loadRunPage("wf-1", "run-1", deps)).toMatchObject({
      kind: "ready",
      document: null,
    });
  });

  // #1079-T30
  it("does not hide any other failure", async () => {
    const { deps } = services({
      runVersion: 1,
      older: async () => {
        throw new Error("the database is gone");
      },
    });
    await expect(loadRunPage("wf-1", "run-1", deps)).rejects.toThrow(
      "the database is gone",
    );
  });
});
