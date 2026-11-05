// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/runners/v1/jobs/:id/release: a Dispatcher gives a claimed job back (#322).
import { withRunnerApi } from "../../../../../../../runner-api/shared.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withRunnerApi((api) => api.release(request, id));
}
