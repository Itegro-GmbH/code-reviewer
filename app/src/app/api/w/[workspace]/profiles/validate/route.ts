// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/profiles/validate (#843): checks a profile (the body) against the format, the models the workspace
// can run and the operator's maximum cost, and answers `{ valid, errors, truncated }`; nothing is stored. A profile with problems is
// a normal answer (200, `valid: false`, every problem with path, code and message). Every member may ask.
// Only in a deployment with the capability `implementer`. The logic is in src/profiles/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createProfileRouteHandlers } from "@/profiles/http";
import { profileServiceFor } from "@/profiles/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/profiles/validate">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createProfileRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: profileServiceFor(access.workspace.id),
    }).validate(request),
  );
}
