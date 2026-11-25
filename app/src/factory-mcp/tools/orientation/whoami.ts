// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";

export const whoami = defineTool({
  name: "whoami",
  title: "Who am I",
  description:
    "Says who this connection acts for: the person, the workspace it is limited to, the person's role there, the approved scope and the AI app. Call it first to know what you may do.",
  scope: "factory:read",
  input: {},
  async handler(context) {
    return {
      user: {
        id: context.user.id,
        name: context.user.name,
        email: context.user.email,
      },
      workspace: {
        slug: context.workspace.slug,
        name: context.workspace.name,
      },
      role: context.role,
      scope: [...context.scopes],
      client: { id: context.client.id, name: context.client.name },
      connectedAt: context.connectedAt,
      accessTokenExpiresAt: context.accessTokenExpiresAt,
      note: "Every tool acts in this one workspace. What a tool may do is the smaller of the approved scope and the role the person has now.",
    };
  },
});
