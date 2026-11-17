// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the MCP page makes to the routes of #1050 (`../http.ts`). The workspace is the one of the page that makes the call. Browser
// side; a header value passes here only on its way from the form to the route and is kept nowhere.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import type { McpServerView } from "../service.ts";

/** The form as the routes read it (`../input.ts`). */
export type McpServerForm = {
  name: string;
  transport: string;
  url: string;
  auth:
    | { kind: "none" }
    | {
        kind: "header";
        headers: (
          { name: string; value: string } | { name: string; keep: true }
        )[];
      };
  /** On a change: the revision the form was made from. */
  revision?: number;
};

export type McpApi = {
  list(): Promise<RequestResult<{ servers: McpServerView[] }>>;
  create(
    form: McpServerForm,
  ): Promise<RequestResult<{ server: McpServerView }>>;
  update(
    id: string,
    form: McpServerForm,
  ): Promise<RequestResult<{ server: McpServerView }>>;
  remove(id: string): Promise<RequestResult<{ removed: true }>>;
  test(id: string): Promise<RequestResult<{ server: McpServerView }>>;
};

export function createMcpApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): McpApi {
  const base = workspaceApiPath(workspaceSlug, "/mcp/servers");
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    list: () => requestJson(fetchImpl, "GET", base),
    create: (form) => requestJson(fetchImpl, "POST", base, form),
    update: (id, form) => requestJson(fetchImpl, "PUT", one(id), form),
    remove: (id) => requestJson(fetchImpl, "DELETE", one(id)),
    test: (id) => requestJson(fetchImpl, "POST", `${one(id)}/test`),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserMcpApi(workspaceSlug: string): McpApi {
  return createMcpApi((url, init) => fetch(url, init), workspaceSlug);
}
