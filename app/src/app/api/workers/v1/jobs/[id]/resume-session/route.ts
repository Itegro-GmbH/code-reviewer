// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/workers/v1/jobs/:id/resume-session?part=n: the Worker of a follow-up turn of the Implementer reads one part of the session
// snapshot the earlier turns stored for its session (#840). The bytes of the part are the body, the description of the whole file is in
// the headers.
import { withWorkerApi } from "../../../../../../../runner-api/shared.ts";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withWorkerApi((api) => api.resumeSession(request, id));
}
