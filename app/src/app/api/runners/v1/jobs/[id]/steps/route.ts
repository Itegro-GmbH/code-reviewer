// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/runners/v1/jobs/:id/steps: the runner sends the steps of the turn of the Implementer it holds (the live view, #745).
import { withRunnerApi } from "../../../../../../../runner-api/shared.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withRunnerApi((api) => api.steps(request, id));
}
