// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/runners/v1/jobs/:id/release: a Dispatcher gives a claimed job back (#322).
import { runAfterResponse } from "../../../../../../../dispatch/shared.ts";
import { startQueuedFollowUps } from "../../../../../../../implementer/follow-up-shared.ts";
import { withRunnerApi } from "../../../../../../../runner-api/shared.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const response = await withRunnerApi((api) => api.release(request, id));
  // #841: a turn that ended gives the instruction queued behind it its start, after this response. Cheap when nothing waits.
  if (response.ok) runAfterResponse(startQueuedFollowUps);
  return response;
}
