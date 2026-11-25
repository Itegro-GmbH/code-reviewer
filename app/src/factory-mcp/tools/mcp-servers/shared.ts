// SPDX-License-Identifier: LicenseRef-Proprietary

// What the MCP server tools share (#1147): the argument shapes.
import { z } from "zod";

export const serverIdArg = z
  .string()
  .min(1)
  .max(128)
  .describe("The id of the MCP server, as `list_mcp_servers` shows it.");

export const nameArg = z
  .string()
  .min(1)
  .max(64)
  .describe(
    "A name of letters, digits, spaces, `_`, `-` and `.`, up to 64 characters, free in the workspace (case ignored). Lane steps and the page show it.",
  );

export const transportArg = z
  .enum(["streamable-http", "sse"])
  .describe("`streamable-http` (the current MCP transport) or `sse`.");

export const urlArg = z
  .string()
  .min(1)
  .max(2048)
  .describe(
    "The https address of the remote MCP server. No user name, no query string, no private or local address.",
  );

/** How the server authenticates: nothing, headers (their values are sealed and never read back), or OAuth (connect it in the web app). */
export const authArg = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z
      .object({
        kind: z.literal("header"),
        headers: z
          .array(
            z
              .object({
                name: z.string().min(1).max(100),
                value: z
                  .string()
                  .min(1)
                  .max(4096)
                  .describe("Stored sealed; never returned by any tool."),
              })
              .strict(),
          )
          .min(1)
          .max(10),
      })
      .strict(),
    z.object({ kind: z.literal("oauth") }).strict(),
  ])
  .describe(
    'How the server is authenticated: `{ "kind": "none" }`, `{ "kind": "header", "headers": [{ "name", "value" }] }` (values are stored sealed and never shown again) or `{ "kind": "oauth" }` (a person still has to press Connect in the web app; a client registered by hand is set there too).',
  );
