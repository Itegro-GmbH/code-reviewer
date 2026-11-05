// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/workers/v1/jobs/:id/result: the Worker delivers the result of the job it holds.
import { withWorkerApi } from "../../../../../../../runner-api/shared.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withWorkerApi((api) => api.result(request, id));
}
