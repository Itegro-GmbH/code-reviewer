// SPDX-License-Identifier: LicenseRef-Proprietary

// The read of `GET /api/w/:workspace/todos/count` for the badges (#925). The sidebar and the ToDos tab of a project both want the count at
// the same moment, so reads of one workspace that are on their way at the same time are one request. Nothing throws: a count that cannot
// be read is `null`, and a badge shows nothing.

/** The open ToDos of the person, and how many of them are in each project (the shape of the route). */
export type TodoCounts = { open: number; projects: Record<string, number> };

const reading = new Map<string, Promise<TodoCounts | null>>();

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

async function request(url: string): Promise<TodoCounts | null> {
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      open?: unknown;
      projects?: unknown;
    };
    if (!isCount(body.open)) return null;
    const projects: Record<string, number> = {};
    if (typeof body.projects === "object" && body.projects !== null)
      for (const [id, count] of Object.entries(body.projects))
        if (isCount(count)) projects[id] = count;
    return { open: body.open, projects };
  } catch {
    return null;
  }
}

/** `fresh` skips the server's short memory of the count: the read after a ToDo was dealt with. */
export function readTodoCounts(
  workspaceSlug: string,
  fresh: boolean,
): Promise<TodoCounts | null> {
  // The path is written out: this module imports nothing of the app, so every part that shows a badge can use it without a cycle.
  const url = `/api/w/${workspaceSlug}/todos/count${fresh ? "?fresh=1" : ""}`;
  const known = reading.get(url);
  if (known !== undefined) return known;
  const started = request(url).finally(() => reading.delete(url));
  reading.set(url, started);
  return started;
}
