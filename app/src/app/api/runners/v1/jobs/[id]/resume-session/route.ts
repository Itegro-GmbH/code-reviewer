// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/runners/v1/jobs/:id/resume-session?part=n: the runner on a customer's machine reads one part of the session snapshot the
// earlier turns stored for the session of the follow-up turn it holds (#879). The runner credential is in Authorization and the lease
// token in `X-Lease-Token`; the bytes of the part are the body and the description of the whole file is in the headers, as on the
// Worker API's call of the same name.
import { withRunnerApi } from "../../../../../../../runner-api/shared.ts";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withRunnerApi((api) => api.resumeSession(request, id));
}
