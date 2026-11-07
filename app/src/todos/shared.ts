// SPDX-License-Identifier: LicenseRef-Proprietary

// What waits for a person in a workspace (#925). The ToDos themselves (a question of an agent, a review that is asked for, red checks)
// come with the ticket source and the answer flow (#923, #924); until they land nothing waits, so the count the sidebar badge shows is
// 0 and the ToDos page is empty. The one function the badge and the page read, so they change in one place when the data arrives.
import "server-only";

/** How many ToDos of the workspace are open. */
export async function openTodoCountFor(workspaceId: string): Promise<number> {
  void workspaceId;
  return 0;
}
