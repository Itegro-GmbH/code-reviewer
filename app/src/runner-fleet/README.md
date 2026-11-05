# Runner fleet: the runners on customers' own machines (#854, R1a of epic #852)

A workspace can register Linux machines of its own that take its jobs, like a self-hosted runner of GitHub Actions. This folder is the **app side of
the registration**: the registration token, the exchange for a credential, the list of runners with a revoke, and the question every call of such a
runner begins with (who is this, and is it new enough). The routing of jobs to them is the next part (R1a part 2, same issue); the runner itself, its
image and its service, is R1b. The plan is the owner's `plans/customer-runner.md`; what is built and why is in [`docs/runner.md`](../../../docs/runner.md)
("Registration and routing").

Three places hold the parts, split so that none of them joins the import cycle of the app (`src/ci/import-cycles/`):

| File                                               | Role                                                                                                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner-identity/announcement.ts`                  | What a runner says about itself (labels, version of the base, manifest, limits): the check and the stored forms. Pure, a leaf module.                                                                       |
| `runner-identity/versions.ts`                      | `meetsMinimum`: the version of the base against the minimum. Pure.                                                                                                                                          |
| `runner-identity/tokens.ts`                        | The registration token (`crt_...`) and the runner credential (`crc_...`): 256 random bits each, kept as a SHA-256 hash.                                                                                     |
| `runner-identity/config.ts`                        | `RUNNER_MIN_BASE_VERSION`, the length of "online".                                                                                                                                                          |
| `runner-api/registration.ts`                       | The runner side: `POST /api/runners/v1/register`, `PUT /api/runners/v1/self`, `POST /api/runners/v1/credential`, and `authenticate`, which the claim uses. Format: `contracts/runner-registration.v1.json`. |
| `runner-fleet/service.ts`, `http.ts`, `shared.ts`  | The member side: `GET /api/w/:workspace/runners`, `POST .../runners/tokens`, `POST .../runners/:id/revoke`. Every member lists; Owners and Admins (`manage_runners`) register and revoke.                   |
| `runner-fleet/ui/`                                 | The page `/w/:workspace/runners`.                                                                                                                                                                           |
| `db/repositories/runners-repository.ts`            | Scoped to one workspace: the list, making a token (at most 20 unused ones), revoking.                                                                                                                       |
| `db/repositories/runner-credentials-repository.ts` | Instance level (the caller holds only a secret): the exchange, the lookup by credential, the announcement, the renewal.                                                                                     |

## The rules

- **A token** is made by an Owner or Admin (`manage_runners`), valid for one hour, usable once (one conditional `UPDATE ... WHERE used_at IS NULL AND expires_at > now`,
  so two runners racing for it cannot both win), shown once in the answer. The database keeps the hash. A token that is unknown, used or expired is one
  answer (`401 RUNNER_REGISTRATION_TOKEN_INVALID`).
- **A credential** is the runner's own. It is shown once (the answer of the exchange or of a renewal). A renewal keeps the previous credential valid until
  the new one is used once, so an answer lost on the way does not lock the runner out. **A revoked runner is refused at once**: the lookup joins on
  `revoked_at is null`, so the very next call is `401 RUNNER_UNAUTHORIZED`, the same answer as for a credential nobody knows.
- **Last seen** is set by the lookup, so every authenticated call is a heartbeat. A runner is _online_ when it was heard from within two minutes,
  _update needed_ when it is online but older than `RUNNER_MIN_BASE_VERSION`, _offline_ otherwise.
- **The minimum version.** A claim by a runner below `RUNNER_MIN_BASE_VERSION` (unset: no minimum) is `426 RUNNER_UPDATE_NEEDED` with `minBaseVersion`; the
  runner shows "update needed" and gets no job. The app never updates a runner (decision 9 of the plan): the runner updates itself or is updated on the machine.
- **What the runner says about itself** (labels, base version, manifest, limits) lives on the machine (decision 8). It sends it at the exchange and with
  `PUT /api/runners/v1/self` whenever it changes; the app keeps the last word it got. A field the format does not know is dropped, a known field that is
  wrong is refused with its name and never its value.
- **The two doors stay apart.** The shared `RUNNER_TOKEN` (the Dispatcher's and the poll mode's) and a runner credential are different secrets with
  different prefixes; a claim that carries `crc_...` takes this path and never the other. In this part a runner credential opens `claim` (which answers
  204 until the routing exists), `self` and `credential` and nothing else.
- **Capability.** Every route and the page exist only in a deployment with the capability `implementer` (the 404 of a path that does not exist elsewhere).
