// SPDX-License-Identifier: LicenseRef-Proprietary

// What a route that creates or switches on a project starts after its response (#923, #1038): the first full sync of the GitHub issues of
// the repository. A project whose tickets are a Jira project's has none (its tickets are not those issues), and a sync that fails is
// logged without the details of the error.
import { describe, expect, it, vi } from "vitest";
import { firstSyncAfterActivation } from "./first-sync.ts";

function setup(sync: () => Promise<unknown> = async () => undefined) {
  const scheduled: (() => Promise<void>)[] = [];
  const syncFn = vi.fn<
    (repositoryId: string, options: { deadline: number }) => Promise<unknown>
  >(() => sync());
  const log = vi.fn<(line: string) => void>();
  const hook = firstSyncAfterActivation({
    sync: (repositoryId, options) => syncFn(repositoryId, options),
    schedule: (work) => void scheduled.push(work),
    now: () => 1_000,
    budgetMs: 20_000,
    log,
  });
  return { hook, scheduled, syncFn, log };
}

describe("the first sync after a project was created or switched on", () => {
  // #1038 (finding of the review of #1044)
  it("starts the first sync of the repository's GitHub issues, with its deadline", async () => {
    const { hook, scheduled, syncFn } = setup();

    await hook({
      projectId: "p1",
      repositoryId: "r1",
      ticketProvider: "github",
    });
    expect(syncFn).not.toHaveBeenCalled();
    await scheduled[0]?.();

    expect(scheduled).toHaveLength(1);
    expect(syncFn).toHaveBeenCalledExactlyOnceWith("r1", { deadline: 21_000 });
  });

  // #1038 (finding of the review of #1044)
  it("starts none for a project whose tickets are a Jira project's, so that no sync fails for them", async () => {
    const { hook, scheduled, syncFn, log } = setup();

    await hook({ projectId: "p1", repositoryId: "r1", ticketProvider: "jira" });

    expect(scheduled).toEqual([]);
    expect(syncFn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  // #1038 (finding of the review of #1044)
  it("logs a sync that does not finish by the name of its error only", async () => {
    const { hook, scheduled, log } = setup(async () => {
      throw new TypeError("secret detail");
    });

    await hook({
      projectId: "p1",
      repositoryId: "r1",
      ticketProvider: "github",
    });
    await scheduled[0]?.();

    expect(log).toHaveBeenCalledExactlyOnceWith(
      "[tracker] the first sync of repository=r1 did not finish (TypeError)",
    );
  });
});
