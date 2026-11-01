# code-review.com

Automatic code reviews for GitHub pull requests, with a small web UI to configure and inspect them.
code-review.com is a hosted service run by Itegro GmbH: you sign up on the website, connect your
GitHub repositories and get reviews on your pull requests. It is built on
[PR-Agent](https://github.com/qodo-ai/pr-agent) and a tool-using review engine (Dynamic Review).

**This repository is source-visible, not open source.** The code is public for transparency (and so
that the team's CI runs on GitHub-hosted runners). It is proprietary: no license is granted to use,
copy, modify, distribute, host or self-host it. Read [`LICENSE`](LICENSE). code-review.com cannot be
self-hosted, and external contributions are not accepted ([`CONTRIBUTING.md`](CONTRIBUTING.md)).

The rest of this file is for the team that develops the service.

## Repository layout

| Path | Content |
|---|---|
| `app/` | Web app and API: Next.js 16, TypeScript, pnpm |
| `runner/` | Worker that runs PR-Agent and the Dynamic Review engine: Python, uv |
| `dispatcher/` | The Dispatcher of the hosted deployment (TypeScript on Hono) and the golden snapshot pipeline, see [`dispatcher/README.md`](dispatcher/README.md) |
| `contracts/` | JSON schemas of the interfaces between the app, the runner and the dispatcher |
| `docs/` | Internal guides: [`docs/deployment-vercel.md`](docs/deployment-vercel.md) (the hosted deployment on Vercel), [`docs/dispatcher.md`](docs/dispatcher.md) (the Dispatcher and Worker vocabulary and interfaces), [`docs/github-app.md`](docs/github-app.md) (creating and installing the GitHub App), [`docs/billing.md`](docs/billing.md) (billing with Stripe), [`docs/billing-terms-checklist.md`](docs/billing-terms-checklist.md) (the points for the terms), [`docs/dynamic-review.md`](docs/dynamic-review.md) (Dynamic Review), [`docs/implementer.md`](docs/implementer.md) (the Implementer of the factory deployment, with its [smoke test](docs/implementer-smoke-test.md)) |
| `docs/decisions/` | Architecture decision records, see [`docs/decisions/README.md`](docs/decisions/README.md) |
| `docker/` | The smoke test of the Worker image (`docker/smoke/`) and the VM preparation script of the golden snapshot (`docker/sandbox/`) |
| `fakes/` | Fake servers and fixtures used by the tests |
| `website/` | The code-review.com landing page: Astro, its own pnpm project, hosted on Cloudflare, see [`website/README.md`](website/README.md) |
| `TESTING.md` | Testing strategy |
| `AGENTS.md` | Rules for agents and the team |

## Prerequisites

- Node.js 24 or newer (`.nvmrc`) with [pnpm](https://pnpm.io) 10 (`corepack enable` is enough)
- [uv](https://docs.astral.sh/uv/) 0.5 or newer. It downloads the Python version pinned in
  `runner/.python-version` if needed.
- `make`
- Docker: for the image smoke test, and to run a throwaway Postgres for the integration and browser tests (see below)
- A Postgres server (version 18 is what CI uses) for the integration and end-to-end tests, for example
  `docker run -d --name cr-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:18`. The tests make a database of
  their own on it and drop it again (`TEST_DATABASE_URL`, `E2E_DATABASE_URL`; the default is the URL of that container)

## Setup

```sh
make install
```

This runs `pnpm install --frozen-lockfile` (one pnpm workspace with one `pnpm-lock.yaml` for the app and the Dispatcher; `website/` is its own pnpm project) and `uv --directory runner sync --locked`.

## Run the app locally

```sh
cd app
pnpm dev          # http://localhost:3000, needs the sign in settings below
```

Agents and parallel worktrees must not use ports 3000 or 3100 (see `AGENTS.md`); start the dev
server on your own port instead: `pnpm dev --port 3417`.

Production build:

```sh
cd app
pnpm build
pnpm start
```

The app needs a Postgres database (`DATABASE_URL`, and `DATABASE_URL_MIGRATE` for the migration command). The schema is
not migrated by the app: run `pnpm migrate` against the database first (a deployment does the same as a step of its own).
Copy `app/.env.example` to `app/.env.local` and fill in the values. Settings and the database layer are described in
`app/.env.example` and `app/src/db/README.md`.

### First start and sign in

Every page except the login page needs a session. The server refuses to start until two settings in
`app/.env.example` are set: a random `APP_SECRET` (the master key, at least 32 characters,
`openssl rand -base64 32`) and the address of the app in `BETTER_AUTH_URL`. No GitHub setting is
needed to start.

A new database is set up in the browser. The operator makes a 6-digit **setup code** with `pnpm setup-code` (against
the same database; it prints the code in the terminal and nowhere else) until then, everything but `/api/health` waits
for the setup. Open the app, enter the code and create the admin account. You land in `/admin`, signed in.
How it works: `app/src/setup/README.md`.

The admin portal at `/admin` (admin only; everybody else gets a 404) holds the settings of the
service. Credentials (the GitHub App, the mail server password) are stored encrypted with a key derived
from `APP_SECRET`. Details: `app/src/admin/README.md`. Sign up and sign in: `app/src/signup/README.md`
and `app/src/auth/README.md`. Billing is off unless it is switched on in the admin portal; how it works
is in [docs/billing.md](docs/billing.md).

### GitHub App

Reading pull requests, posting reviews and signing people in needs one GitHub App.
[`docs/github-app.md`](docs/github-app.md) describes creating it (one click in the admin portal, or by
hand), the permissions and events, and how to install it on repositories.

### LLM access

Reviews call a language model with a key: a key the workspace brings (bring your own key, entered under
**Settings, LLM** of the workspace and stored encrypted) or a managed key of the service. How it works:
`app/src/llm/README.md`.

## Supported browsers

The web UI is built for Tailwind CSS v4's browsers: Chrome and Edge 111 or newer, Firefox 128 or
newer and Safari 16.4 or newer. The color tokens are plain custom properties per mode in
`theme.css` (no `light-dark()`), and the stylesheets use `color-mix()` and `:has()` without a
fallback, so an older browser shows the page without its colors; there is no polyfill on purpose. The
navigation menu on narrow screens and the user menu need JavaScript; the sign in, the sign out and
the three places themselves are plain links and forms.

## Run the runner locally

```sh
cd runner
uv run code-reviewer-runner --version
```

### Run one PR-Agent job

`code-reviewer-run-job` runs one PR-Agent command (`review`) for one
pull request. The job is JSON on stdin (`runner/src/code_reviewer_runner/job.py` documents the
shape: pull request URL, command, installation token and bot login, LLM model and key). The result
is exactly one line of JSON on stdout (`ok`, `durationMs`, `commentUrl`, `errorCode`, `logTail`,
`logTruncated`, `usage`), and the exit code is 0 for `ok` and 1 otherwise. PR-Agent is pinned to one version
(`runner/pyproject.toml`); the runner patches the identity lookup of that exact version, so a
PR-Agent upgrade needs a conscious change of both (see `runner/src/code_reviewer_runner/identity_patch.py`).

```sh
echo '{}' | uv run code-reviewer-run-job     # an invalid job: {"ok":false,"errorCode":"invalid_job",...}
```

A real run against the sandbox repository (posts a real comment, costs a few cents; needs the App
credentials and an OpenRouter key in the environment, see the docstring of the script):

```sh
cd runner
uv run python scripts/manual_review.py
```

## Container image

One image is built from the repository: the Worker image, the `sandbox` target of `runner/Dockerfile` (the build context
is the repository root, so the Dockerfile is named with `--file`):

```sh
docker build -f runner/Dockerfile --target sandbox -t code-reviewer-runner-sandbox .
```

It holds both engines (PR-Agent, pinned, and the pinned OpenCode for Dynamic Review) and runs as uid 10001. The golden
snapshot of the hosted deployment builds this file inside a Vercel Sandbox VM, and every review job runs the image there.
`make test-images` builds it and runs its smoke test (`docker/smoke/runner.sh`); CI does the same for pull requests that
touch the runner. No image is published to a registry. The app is not an image: Vercel builds it.

## Deploy on Vercel (hosted)

[`docs/deployment-vercel.md`](docs/deployment-vercel.md) is the guide for the hosted deployment: the App as a
serverless Vercel project, a Dispatcher (`dispatcher/`) as a second one, and every review job run by a short-lived
Worker in a fresh Vercel Sandbox VM. It covers the architecture and the vocabulary ([`docs/dispatcher.md`](docs/dispatcher.md)),
the prerequisites (an external Postgres with two roles, the GitHub environments), every environment variable of both
projects and which must match, the ordered first deployment (migrate, App, setup code, golden snapshot, Dispatcher,
canary, webhook mode, smoke test), operations (rebuilding the snapshot, rotating secrets, reading the error codes,
rollback) and the known limits. Merging to `main` deploys to production
(`.github/workflows/deploy-production.yml`).

## Lint, typecheck, test

One command per task from the repository root, covering both parts:

```sh
make lint              # app: eslint and prettier --check; runner: ruff check and ruff format --check
make typecheck         # app: next typegen and tsc --noEmit (strict); runner: pyright (strict)
make test-unit         # app: vitest unit project; runner: pytest -m unit
make test-integration  # integration tests (they need a Postgres server)
make verify            # all of the above, run before every pull request
```

Or per part:

|             | App (`cd app`)                                            | Runner (`cd runner`)                                                       |
| ----------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| Lint        | `pnpm lint` and `pnpm format:check` (`pnpm format` fixes) | `uv run ruff check . ../fakes` and `uv run ruff format --check . ../fakes` |
| Typecheck   | `pnpm typecheck`                                          | `uv run pyright`                                                           |
| Unit tests  | `pnpm test`                                               | `uv run pytest -m unit`                                                    |
| Integration | `pnpm test:int`                                           | `uv run pytest -m "integration or contract"`                               |

End-to-end tests run against a production build on port 3417 (`E2E_PORT`), next to a fake GitHub on
a random port (`fakes/github`):

```sh
make test-e2e                              # needs a Playwright browser:
                                           #   cd app && pnpm exec playwright install chromium
make test-e2e PLAYWRIGHT_CHANNEL=chrome   # or use an installed Google Chrome
```

The journey with the real runner and PR-Agent (`app/e2e/jobs`) also needs the runner installed
(`make install`) and the tiktoken encoding cached once per machine
(`uv --directory runner run python scripts/prime_tiktoken_cache.py`, needs the internet); it fails
at the start and says so when one is missing.

All automated tests are hermetic: a network guard blocks every host except loopback. See
[TESTING.md](TESTING.md) for the test levels, naming rules and fakes.

### Troubleshooting

- `pyenv: version '3.13' is not installed` when running `uv`: a pyenv shim named `uv` is found
  first and trips over `runner/.python-version`. Put the real uv (for example `~/.local/bin`) before
  `~/.pyenv/shims` in your `PATH`, or install the Python version with pyenv.

## Working on the code

[CONTRIBUTING.md](CONTRIBUTING.md) is the team's workflow (branch names, commit messages, pull
requests, which checks to run). External contributions are not accepted. Report security problems
privately as described in [SECURITY.md](SECURITY.md).

## Branching

- `main` and `development` are permanent branches. `development` is the default branch.
- Every change starts from a GitHub issue `#<n>`. Its branch is named `<n>-<slug>` and branches off
  `development`, e.g. `123-fix-webhook-retry`.
- A pull request goes into `development`, its description contains `Closes #<n>`, and it is squash
  merged once the review is done and CI is green.
- `development` -> PR into `main` for releases.

Direct pushes to `main` and `development` are not allowed; all changes go through pull requests.
[CONTRIBUTING.md](CONTRIBUTING.md) has the full workflow.

## License

Copyright (c) 2026 Itegro GmbH. All rights reserved. The source is published for transparency only;
see [`LICENSE`](LICENSE) for what is and is not permitted. [`NOTICE`](NOTICE) and
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) carry the attribution for third party software,
which keeps its own licenses (for example the MIT licensed PR-Agent).
