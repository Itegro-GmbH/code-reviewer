// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/runners/v1/jobs/:id/complete: the runner reports the result of the job it holds.
import { withRunnerApi } from "../../../../../../../runner-api/shared.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withRunnerApi((api) => api.complete(request, id));
}
