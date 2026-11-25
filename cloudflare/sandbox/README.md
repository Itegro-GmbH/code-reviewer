# cr-sandbox: the Cloudflare Worker of the Cloudflare placement

The Worker, the Durable Objects and the Container image of **#1159** (epic #1157): one Durable Object and one Cloudflare Container (a microVM) per VM, the `cf-sandbox` API of
[`contracts/cf-sandbox.v1.json`](../../contracts/cf-sandbox.v1.json) that the Dispatcher's Cloudflare `SandboxService`/`SandboxFleet` (#1158) call. How it works, the decisions of the
epic, what layout P1 means for isolation and how a larger size becomes active: [`docs/runner.md`, "Cloudflare placement"](../../docs/runner.md#cloudflare-placement-the-worker-and-the-image-1159).
The measurements it is built from: the spike, [`spikes/cloudflare/`](../../spikes/cloudflare/README.md).

A pnpm project of its own, like [`website/`](../../website/README.md): **not** a member of the root workspace (`pnpm-workspace.yaml` here makes this directory its own root, its lockfile is
`pnpm-lock.yaml` here), so the installs of the app and the Dispatcher never pull wrangler and workerd. It imports nothing from the other projects; it reads `contracts/` in its tests.

| Path                                                                                                                | What                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/handler.ts`                                                                                                    | the HTTP API: bearer check, routes, validation, the calls to the two Durable Objects (clients passed in, so a test passes fakes)                                                                   |
| `src/vm-controller.ts`, `src/vm-do.ts`                                                                              | one VM: start (handlers, Container, boot), `exec`, processes with stdin, policy, alarm, destroy. The controller holds the logic; the Durable Object class adapts `ctx.container` and `ctx.storage` |
| `src/registry-controller.ts`, `src/registry-do.ts`                                                                  | the registry: the cap, the listing for the reaper, the sweep of overdue VMs                                                                                                                        |
| `src/door.ts`                                                                                                       | the outbound handler (the outer wall): terminates TLS, reads the VM's policy per request, refuses or fetches                                                                                       |
| `src/policy.ts`, `lifecycle.ts`, `validate.ts`, `router.ts`, `auth.ts`, `config.ts`, `bounded-tail.ts`, `errors.ts` | the pure parts                                                                                                                                                                                     |
| `image/`                                                                                                            | the Container image: `Dockerfile`, `files/` (the Sysbox patch, the boot script), `prepare-context.sh`, `build-inner.sh`, `self-check.sh` (CI only)                                                 |
| `wrangler.jsonc`                                                                                                    | the Worker `cr-sandbox`, its classes, the `durable_object` scheduling policy, the variables                                                                                                        |

## Commands

Needs Node 24 and pnpm (see the repository's `.nvmrc` and `package.json`).

```sh
cd cloudflare/sandbox
pnpm install --frozen-lockfile
pnpm verify        # tsc --noEmit, vitest run, prettier --check
```

**Never build the image or run `wrangler deploy --dry-run` on a developer machine**: wrangler builds the Container image with the local Docker even for a dry run (about 3 GB of images),
and the development server has 9 GB of disk. The image is built in CI only (`.github/workflows/cloudflare-sandbox.yml`, for a pull request that touches this directory and on a push to
main). `pnpm test` needs no Cloudflare account and makes no call to one.

## Deployment, secrets, account guard

By the workflow, never by hand: a push to `main` (part of the release) or a run by hand on `main`. It needs the repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and
`CF_SANDBOX_TOKEN` (at least 32 characters) and fails in its first step, naming the missing ones. Everything it creates is named `cr-sandbox*`; it never touches the spike's `cr-spike-*`, the
other apps of the account, billing or plans (`app/src/ci/cloudflare-sandbox-workflow.test.ts` holds that).

## Configuration (`wrangler.jsonc` `vars`, the build's `--var`s, the secret)

| Variable                                                                | Meaning                                                                                                                                 |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `INSTANCE_TYPES`                                                        | the instance types a `create` may name (`standard-4`); published in `GET /health`                                                       |
| `CUSTOM_INSTANCE_TYPES`                                                 | JSON, optional: resources of a type that is not one of Cloudflare's own names (`{"name":{"vcpu":8,"memoryMib":32768,"diskMb":100000}}`) |
| `MAX_VMS`                                                               | the cap of live VMs (429 `rate_limited` above it), 8                                                                                    |
| `IMAGE_VERSION`, `WORKER_FEATURES`, `WORKER_IMAGE_ID`, `AGENT_IMAGE_ID` | given by the workflow: the git SHA and what the build read from the images                                                              |
| `CF_SANDBOX_TOKEN` (secret)                                             | the bearer token of the API; without it, or shorter than 32 characters, every route but `/health` answers 401                           |
