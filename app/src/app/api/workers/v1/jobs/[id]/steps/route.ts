// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/workers/v1/jobs/:id/steps: the Worker sends the steps of the turn of the Implementer it holds (the live view, #745).
import { withWorkerApi } from "../../../../../../../runner-api/shared.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withWorkerApi((api) => api.steps(request, id));
}
