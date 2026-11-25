// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy of the consent page and of the list of connected apps. The server answers with codes; the page turns them into these sentences,
// never the other way round.
import { SCOPE_DESCRIPTIONS } from "../scopes.ts";

export const CONSENT_ERROR_COPY = {
  request_not_found:
    "This connection request has expired or was already answered. Start the connection again from your AI app.",
  workspace_invalid: "Choose one of your workspaces.",
  scope_invalid: "Choose what the app may do.",
} as const;
export type ConsentErrorCode = keyof typeof CONSENT_ERROR_COPY;

export function consentErrorCopy(code: unknown): string | null {
  return typeof code === "string" && code in CONSENT_ERROR_COPY
    ? CONSENT_ERROR_COPY[code as ConsentErrorCode]
    : null;
}

export const SCOPE_LABEL = {
  "factory:read": "Read only",
  "factory:control": "Read and control",
} as const;

export { SCOPE_DESCRIPTIONS };

export const AI_APPS_COPY = {
  description:
    "The AI apps (Claude, Cursor and others) that are connected to this workspace through the factory's MCP server. Revoking a connection ends it at once; the app has to ask you again.",
  empty: "No AI app is connected to this workspace.",
  howTo:
    "Connect an app with the address of the MCP server; see the guide “Connect an AI app” in docs/factory-mcp.md.",
} as const;
