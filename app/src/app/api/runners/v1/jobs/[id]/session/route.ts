// SPDX-License-Identifier: LicenseRef-Proprietary

// PUT /api/runners/v1/jobs/:id/session: the runner on a customer's machine puts one part of the session snapshot of the turn of the
// Implementer it holds (follow-up turns, #879). The runner credential is in Authorization and the lease token in `X-Lease-Token`; the
// bytes of the part are the body and the description of the whole file is in the query, as on the Worker API's call of the same name.
import { withRunnerApi } from "../../../../../../../runner-api/shared.ts";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withRunnerApi((api) => api.session(request, id));
}
