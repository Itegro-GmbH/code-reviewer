# Spike #1149: Cloudflare Containers as a hosted sandbox

Throwaway code that **measured** whether a Cloudflare Container can host the sandbox of a job (Docker, Sysbox, the doors, the
network rule). The findings, the verdict and the design sketch are in `docs/runner.md`, section "Spike: Cloudflare Containers
(#1149)". **Nothing here is product code and nothing is wired into production**: no workflow, no Dispatcher, no app route reads it,
and it is not part of the pnpm workspace.

| Path | What |
|---|---|
| `wrangler.jsonc` | one Worker `cr-spike-cf`, one Durable Object class `CrSpikeBox` with a container (`scheduling_policy: durable_object`), `workers_dev` only (no route, no custom domain) |
| `src/index.ts` | the Worker (every request needs the header `x-spike-secret`), the Durable Object that owns the container (`begin`, `run`, `policy`, `snapshot`, `keepalive`, `pipe`, `kill`), and the two outbound handlers: `Door` (a rule that can change while the container runs) and `ModelDoor` (a host name that exists only in the Worker; the "key" is added there) |
| `image/Dockerfile`, `probes/boot.sh` | the probe image (Ubuntu 24.04, Docker 29.1.3 static bundle and Sysbox 0.7.1, both pinned by sha256 as in the golden snapshot) and the boot steps: the door's CA, the hosted cgroup fix, Sysbox, dockerd, each with a timing line |
| `measure/` | every probe that produced a number in the report (`q*.sh` by question), the driver `cf.sh`, the instance sizes and the allow list used |
| `results/` | the raw answers of those probes, with the account id and the workers.dev name replaced by placeholders |

## Safety rails (the issue's hard limits)

- Every resource is named `cr-spike-*` (Worker `cr-spike-cf`, the class, the image repository `cr-spike-cf-crspikebox-base`).
- The Worker answers `404` without the header `x-spike-secret` (a Worker secret). The secret, the fake model key and the URL live in files of
  mode 0600 outside the repository; `.gitignore` here keeps `.dev.vars` and `*.secret` out as well.
- Only the box names `a` and `b` exist, so at most **two instances** can run at once; every start sets an inactivity timeout of 45 s to 10 min
  (the long runs use a 2 min timeout and a keep-alive alarm).
- All traffic of a container goes through the outbound handler (`enableInternet: false`) except in the one test of `enableInternet: true`.
- At the end the Worker, the Durable Object namespace, the container application and every image tag were deleted (listed in the report).

## Run it again

```sh
cd spikes/cloudflare
export PATH=$HOME/.local/tools/node24/bin:$PATH
npx -y wrangler@latest deploy                     # builds image/Dockerfile (needs a Docker daemon) and pushes it to Cloudflare's registry
printf %s "$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')" | npx -y wrangler@latest secret put SPIKE_SECRET
printf %s "FAKE-MODEL-KEY-$(date +%s)"                         | npx -y wrangler@latest secret put MODEL_KEY
# put CF_URL and CF_SECRET into a 0600 file, then:
export CF_SPIKE_ENV=$HOME/secrets/cr-spike-1149-env
measure/cf.sh a begin measure/begin-standard-3.json
measure/cf.sh a policy measure/policy-allow-list.json
echo 'bash /opt/probes/boot.sh' > /tmp/boot.cmd && measure/cf.sh a run /tmp/boot.cmd
measure/cf.sh a run measure/q3a-egress-false.sh "?timeout=200000"
measure/cf.sh a kill
```

Delete everything when done: `wrangler delete --name cr-spike-cf` (removes the Worker, its Durable Object namespace and the container
application) and `wrangler containers images delete cr-spike-cf-crspikebox-base:<tag>` for each tag of `wrangler containers images list`.
