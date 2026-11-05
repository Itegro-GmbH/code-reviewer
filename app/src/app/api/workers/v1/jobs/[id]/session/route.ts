// SPDX-License-Identifier: LicenseRef-Proprietary

// PUT /api/workers/v1/jobs/:id/session: the Worker puts one part of the session snapshot of the turn of the Implementer it holds
// (follow-up turns, #839). The bytes of the part are the body, the description of the whole file is in the query.
import { withWorkerApi } from "../../../../../../../runner-api/shared.ts";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withWorkerApi((api) => api.session(request, id));
}
