# The factory MCP server (epic #1143, slice #1144)

One MCP server (`POST /api/mcp`, Streamable HTTP, stateless) lets an AI app control a workspace of the factory, behind an OAuth 2.1 authorization server of
its own. The guide for people is [`docs/factory-mcp.md`](../../../docs/factory-mcp.md); this is the guide for the code. Only in a deployment with the
capability `implementer`.

| Path                                                   | Role                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scopes.ts`                                            | `factory:read`, `factory:control`; control includes read. The vocabulary itself is `db/factory-oauth-types.ts` (the database layer imports nothing of this module).                                                                                                              |
| `oauth/service.ts`                                     | The decisions of the authorization server: client registration, the authorization request, consent, code and refresh exchange with rotation and reuse detection, revocation, and `authenticate` (token, expiry, revocation, audience, membership, role). Pure over a store port. |
| `oauth/store.ts`, `oauth/memory-store.ts`              | The store port (types in `db/factory-oauth-types.ts`) and an in-memory implementation for unit tests. The Kysely implementations are `db/repositories/factory-oauth-directory-repository.ts` (instance level) and `factory-oauth-repository.ts` (one workspace).                 |
| `oauth/http.ts`, `oauth/metadata.ts`, `oauth/paths.ts` | The HTTP shapes (RFC 9728 and 8414 documents, register, authorize, consent answer, token, revoke) and the addresses.                                                                                                                                                             |
| `oauth/tokens.ts`, `oauth/redirect-uri.ts`             | Secrets (256 random bits, prefixed `fmcp_at_`, `fmcp_rt_`, `fmcp_ac_`, stored as SHA-256), PKCE S256, and the redirect URI rules.                                                                                                                                                |
| `endpoint/handler.ts`                                  | `POST /api/mcp`: bearer check, the `WWW-Authenticate` challenge, the scope check of a `tools/call`, and the MCP SDK's low level server with its web standard transport.                                                                                                          |
| `tools/`                                               | The tool registry: `define.ts` (how a tool is written), `registry.ts` (the uniform call path), `errors.ts` (the uniform failure), `context.ts` (what a tool gets), `all.ts` (the list), `groups/` (one file per slice), `orientation/` (the three tools of this slice).          |
| `lane-schema/`                                         | What `get_lane_schema` answers. `guide.generated.json` is made from `docs/workflows.md` and the contracts by `pnpm lane-guide:generate`; a test fails when it is out of date.                                                                                                    |
| `apps/`                                                | The "Connected AI apps" list of the workspace settings: service (who sees and revokes what) and routes.                                                                                                                                                                          |
| `ui/`                                                  | The consent form and the list.                                                                                                                                                                                                                                                   |
| `shared.ts`                                            | The wiring on the running server.                                                                                                                                                                                                                                                |

## Better Auth's plugins: what was checked, and why this is not built on them

The app pins Better Auth 1.7.7. That version's core no longer has the `mcp` and `oidc-provider` plugins; they became the separate package
`@better-auth/oauth-provider` (1.7.7 exists and was read, not adopted). It implements a lot correctly (S256 only, resource indicators with a resource table,
rotating refresh tokens with a reuse interval, opt-in dynamic registration, an MCP preset), and it is a full OpenID provider besides: DPoP, pushed requests,
back-channel logout, pairwise subjects, client administration endpoints, a JWKS and the `jwt` plugin. For this app that means:

- seven more tables and the `jwt` plugin's key table, all mapped to this app's `snake_case` columns and ids, on a Better Auth instance that exposes only four of its
  endpoints on purpose (`src/auth/http.ts`); the plugin's endpoints, its consent and login redirects would have to be fitted into that;
- the consent screen has to be ours anyway (workspace and scope are chosen on it, the person's role must be read on every request), so the plugin's own consent,
  `referenceId` and token claims would be bypassed for the part that matters;
- a surface of OIDC and client-admin features that nobody here needs and that would have to be reviewed and kept switched off.

The authorization server here is the MCP profile only (about 600 lines of decisions, all unit tested with the cases of the specification, plus Postgres tests of
the repositories): opaque tokens stored as hashes, so revocation and the membership check are immediate and there is no key to rotate. Spec points and where each
is held: PKCE S256 only (`service.test.ts` T34), exact redirect URI comparison and refusing an untrusted client without a redirect (T33, `redirect-uri.test.ts`),
`iss` in every answer (T34, T42), resource indicators and audience binding (T34, T52, T73, handler T164), refresh rotation and reuse detection (T60 to T62), single
use code (T54), `invalid_target`, RFC 7009 revocation (T80), RFC 7591 registration limited to public clients (T30, T31), RFC 9728 and 8414 documents
(`http.test.ts` T100, T101), `WWW-Authenticate` with `resource_metadata` (handler T160) and `insufficient_scope` step-up (handler T175).

## How to add a tool (slices #1145 to #1147)

1. **One file per tool**, in the folder of its slice (`tools/projects/list-projects.ts`, `tools/lanes/validate-lane.ts`, `tools/runs/start-run.ts`, ...):

   ```ts
   import { z } from "zod";
   import { defineTool } from "../define.ts";
   import { ToolError } from "../errors.ts";

   export const listProjects = defineTool({
     name: "list_projects", // snake_case, unique
     title: "List projects",
     description:
       "One to three sentences, written for an AI: what it does and when to use it.",
     scope: "factory:read", // `factory:control` for anything that changes something
     action: "view", // the workspace action the ROLE must allow (permissions.ts); view when left out
     input: { limit: z.number().int().min(1).max(100).optional() },
     async handler(context, args) {
       // The SAME service the app's route uses, for the token's workspace and person (see "Services" below). Never SQL, never a workspace
       // from the arguments. A write passes `context.user.id` where the app stores a user, and `context.actor.label` where it stores a note.
       const projects = context.services.use(projectsService);
       return { projects: await projects.list() }; // a plain JSON object; or throw `new ToolError("not_found", "...", { details })`
     },
   });
   ```

2. **List it in your slice's group file only**, one line in the array: `groups/projects-lanes.ts` (#1145), `groups/runs-todos.ts` (#1146),
   `groups/runners-mcp-models.ts` (#1147). `tools/all.ts` already imports the groups and nobody edits it, so two slices never touch the same file.
3. **Map the service's own failure to a code** (`WorkflowError` to `invalid_input` with its `errors` in the details, a full workspace to `limit_reached`, a
   stale revision to `conflict`). Anything else that is thrown becomes `internal_error` with nothing shown and the details in the log.
4. **Test it** with `tools/test-context.ts` (a context for a role and scope) through `createToolRegistry(ALL_TOOLS).call(...)`, and add the cases the issue lists.
   `registry.test.ts` already holds every tool to a unique snake_case name, a description and a scope.

### Services: `context.services`

A tool reaches the app's own code through `context.services.use(factory)` (`tools/services.ts`), and never opens the database itself. A **factory** is a plain function from a
`ServiceScope` to a service, kept in your slice's folder, usually one line over the factory the app's routes already use:

```ts
// tools/projects/services.ts
export const projectsService: ServiceFactory<ProjectsService> = ({
  access,
  database,
}) =>
  createProjectsService(
    database(),
    access.workspace.id /* , ... whatever the route's wiring passes */,
  );
```

The scope is the token's, never the arguments': `access` is the same `WorkspaceAccess` a route gets from `withWorkspace` (the person, the workspace, the role the person has **now**), so you
can hand it to the handlers and services the routes already use; the person is a session user **without instance rank** (`isInstanceAdmin: false`), whoever they are, so an AI app
never acts as the instance admin. `actor` is the person and the AI app; `database()` opens the connection only when a factory calls it. `use` builds the service once per request. In a unit test,
`testContext({ database })` (`tools/test-context.ts`) hands the same scope with a database of your choice; without one a test that touches the database fails by name.

**Treat `actor.label` and `client.name` as untrusted text.** The app's name is what the app called itself at registration (control and direction characters are removed, nothing more). Store it
where the app stores a note, show it escaped, never as markdown or HTML, and never decide anything by it. Decide by `client.id` and `user.id`.

### The audit line

Every call writes one line on the server's log, from the registry, so a tool does nothing for it: `[factory-mcp] TOOL_CALL {"tool","scope","workspaceId","userId","clientId","outcome","durationMs"}`.
`outcome` is `ok` or the error code. A call the endpoint refused for its scope before the tool was looked at has its line too. **Arguments and results are never in it**, so a tool needs no care for secrets
here, and must not log them either. The sink is `createToolRegistry(tools, { audit })`; tests pass their own.

What the registry does for every call, so a tool cannot forget it: scope (`insufficient_scope`), role (`forbidden`), arguments (`invalid_input`, unknown fields
refused), the handler, the failure mapping. The endpoint additionally answers `403` with the `scope` needed, which is how a client asks the person for more.
