# Implementer environments (#818)

An environment is a start configuration for an Implementer task: a name, a size (2, 4, 6 or 8 vCPU; 1 vCPU leaves the agent no memory and is not offered) and a setup script, kept per
workspace. This folder is the server side of the page `/w/<slug>/environments` and of the picker of the task form. It exists only in
a deployment with the capability `implementer`; every route and the page are classified `implementer` in `src/capabilities/routes.ts`
and ask again in the route file (`requireImplementerCapability()`).

| File         | Role                                                                                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limits.ts`  | The sizes an environment may name, the memory the agent gets at each, the 64 KB of the script, its 15 minutes, the name length and the 50 per workspace. A typed copy of `contracts/environment-sizes.v1.json`, held to it by `limits.test.ts`; the Dispatcher keeps `SANDBOX_VCPUS` and `agentMemoryMb` under the same test |
| `input.ts`   | `validateEnvironmentInput`: the body, field by field. The script is kept exactly as written; only what cannot be stored as text is refused                                                                                                    |
| `service.ts` | `createEnvironmentService`: list, get, create, update, remove for one workspace. Every rule about the data is here                                                                                                                            |
| `http.ts`    | The four handlers: user first, then origin, content type and size, then the service                                                                                                                                                           |
| `errors.ts`  | `EnvironmentError`, the stable codes and their statuses                                                                                                                                                                                       |
| `shared.ts`  | The wiring of the running server                                                                                                                                                                                                              |
| `ui/`        | The panel (list, form, delete confirmation), the calls and the copy                                                                                                                                                                           |

The rows are `implementer_environments` (`src/db/repositories/implementer-environments-repository.ts`, scoped to a workspace). The
migration only adds the table. `vcpus` is checked for `>= 1` in the database because the list of sizes belongs to the platform and changes with it;
the app holds the list. A row with a size that is no longer offered (1 vCPU) is read and shown as it is (`sizeSupported: false`) and a task started with it
is refused (`IMPLEMENTER_ENVIRONMENT_SIZE_UNSUPPORTED`); `validateEnvironmentInput` refuses to save one. Nothing references a row: a task copies size and script when it starts, so changing or deleting an
environment touches no task.

Who may do what (`src/workspaces/permissions.ts`): `start_implementer_task` (any member) lists; `manage_implementer_environments`
(Admin and up) creates, changes and deletes. The script is shown to every member who can list.
