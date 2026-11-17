// SPDX-License-Identifier: LicenseRef-Proprietary

// #1058: the statuses of a Jira project for the webhook, kept for a short while.
import { describe, expect, it, vi } from "vitest";
import { createJiraStatusDirectory } from "./status-directory.ts";

const source = { connectionId: "c1", projectKey: "PROJ" };

describe("the statuses of a Jira project for the webhook", () => {
  // #1058
  it("reads the project once for a burst of deliveries and again when the minute is over", async () => {
    let time = 0;
    const listStatuses = vi.fn(async () => ({
      ok: true as const,
      statuses: [
        {
          id: "1",
          name: "Zu erledigen",
          untranslatedName: "To Do",
          category: "new" as const,
        },
      ],
    }));
    const directory = createJiraStatusDirectory({
      reader: { listStatuses },
      now: () => time,
    });

    expect(await directory.statusesOf(source)).toEqual([
      { id: "1", name: "Zu erledigen", untranslatedName: "To Do" },
    ]);
    await directory.statusesOf(source);
    time = 59_000;
    await directory.statusesOf(source);
    expect(listStatuses).toHaveBeenCalledTimes(1);
    time = 61_000;
    await directory.statusesOf(source);
    expect(listStatuses).toHaveBeenCalledTimes(2);
    await directory.statusesOf({ ...source, projectKey: "OTHER" });
    expect(listStatuses).toHaveBeenCalledTimes(3);
  });

  // #1058
  it("answers undefined, and keeps nothing, when Jira cannot be asked", async () => {
    const listStatuses = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "jira_unavailable" })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        ok: true,
        statuses: [{ id: "1", name: "Done", category: "done" }],
      });
    const directory = createJiraStatusDirectory({
      reader: { listStatuses },
    });
    expect(await directory.statusesOf(source)).toBeUndefined();
    expect(await directory.statusesOf(source)).toBeUndefined();
    expect(await directory.statusesOf(source)).toEqual([
      { id: "1", name: "Done" },
    ]);
  });
});
