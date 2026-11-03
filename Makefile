# SPDX-License-Identifier: LicenseRef-Proprietary

# Entry points for developers and agents. Every target is a thin wrapper around the commands
# of app/package.json, dispatcher/package.json and runner/pyproject.toml (the app and the Dispatcher are one pnpm
# workspace, see pnpm-workspace.yaml); see TESTING.md for what each
# level means.

APP := pnpm --dir app
DISPATCHER := pnpm --dir dispatcher
RUNNER := uv --directory runner

.PHONY: help install lint lint-app lint-dispatcher lint-runner typecheck typecheck-app typecheck-dispatcher typecheck-runner \
	test-unit test-unit-app test-unit-dispatcher test-unit-runner test-integration check-licenses fix-spdx-headers generate-contracts check-contracts test-engine test-engine-smoke test-e2e test-e2e-hosted test-e2e-dynamic test-sandbox-local test-lane test-images verify

help:
	@echo "make install           install app, dispatcher and runner dependencies from the lockfiles (one pnpm-lock.yaml at the root, runner/uv.lock)"
	@echo "make lint              lint and format check, all three parts"
	@echo "make typecheck         typecheck all three parts"
	@echo "make test-unit         unit tests of all three parts"
	@echo "make test-integration  integration tests that run on the host (app, dispatcher and runner)"
	@echo "make check-licenses    fail when a dependency has a license outside license-policy.json (needs make install)"
	@echo "make generate-contracts regenerate the TypeScript types of contracts/*.v1.json (app/src/contracts, dispatcher/src/contracts)"
	@echo "make check-contracts   fail when the generated contract types differ from the schemas (part of verify)"
	@echo "make fix-spdx-headers  add the SPDX license header to every source file that lacks it (a unit test fails without it)"
	@echo "make test-engine       the real PR-Agent and the pinned OpenCode against the fakes (about 15 minutes serially, CI runs it in parallel; not part of verify)"
	@echo "make test-engine-smoke the engine tests marked smoke (about 2 minutes, not part of verify)"
	@echo "make test-e2e          Playwright journeys against a production build (ARGS=... to filter)"
	@echo "make test-e2e-hosted   the hosted deployment on fakes: app, Dispatcher and Worker over loopback (needs E2E_DATABASE_URL, a Postgres server; ARGS=... to filter)"
	@echo "make test-e2e-dynamic   the privileged Dynamic Review journey with the real OpenCode (root and nft, CI-first, ARGS=... to filter)"
	@echo "make test-sandbox-local  the Sandbox-Launcher's local mode with a real Docker daemon and the Worker image (needs Docker, not part of verify)"
	@echo "make test-lane        a whole Implementer turn on a real Docker daemon: the real agent image, reader and OpenCode under runc (needs Docker and sudo, not part of verify)"
	@echo "make test-images       build the Worker image (the sandbox target) and run its smoke test (needs Docker)"
	@echo "make verify            lint, typecheck, unit and host integration tests and the license check; run before every PR"

install:
	pnpm install --frozen-lockfile
	$(RUNNER) sync --locked

lint: lint-app lint-dispatcher lint-runner
lint-app:
	$(APP) lint
	$(APP) format:check
lint-dispatcher:
	$(DISPATCHER) lint
	$(DISPATCHER) format:check
lint-runner:
	$(RUNNER) run ruff check . ../fakes
	$(RUNNER) run ruff format --check . ../fakes

typecheck: typecheck-app typecheck-dispatcher typecheck-runner
typecheck-app:
	$(APP) typecheck
typecheck-dispatcher:
	$(DISPATCHER) typecheck
typecheck-runner:
	$(RUNNER) run pyright

test-unit: test-unit-app test-unit-dispatcher test-unit-runner
test-unit-app:
	$(APP) test
test-unit-dispatcher:
	$(DISPATCHER) test
test-unit-runner:
	$(RUNNER) run pytest -m unit

# Integration tests that need no Docker stack. The stack based suites (fakes, e2e in
# containers, engine smoke) are added with the tickets that introduce the stack.
test-integration:
	$(APP) test:int
	$(DISPATCHER) test:int
	$(RUNNER) run pytest -m "integration or contract"

# The license of every installed dependency of the app, the Dispatcher and the runner against license-policy.json
# (app/src/ci/license-check). Reads installed metadata and the lockfiles (pnpm-lock.yaml at the root, runner/uv.lock), no network.
check-licenses:
	$(APP) licenses:check

# The TypeScript types of the contract schemas (#318), committed into app/src/contracts and
# dispatcher/src/contracts so no project imports another's source. `check-contracts` fails with the
# command to regenerate when a committed file is stale; it reads the schemas only, no network.
generate-contracts:
	$(APP) contracts:generate

check-contracts:
	$(APP) contracts:check

# Adds `SPDX-License-Identifier: LicenseRef-Proprietary` (in the comment syntax of the language) to every source file
# that lacks it; changes nothing else and can be run at any time. Which files count is in
# app/src/ci/spdx-headers/rules.ts.
fix-spdx-headers:
	$(APP) spdx:add

# The real PR-Agent and the real pinned OpenCode against the fakes (runner/tests/engine). The first
# steps need the internet once (tiktoken encoding, the checksum-verified OpenCode release) and the
# OpenCode suite needs a ripgrep on the PATH; the tests themselves never leave loopback.
test-engine:
	$(RUNNER) run python scripts/prime_tiktoken_cache.py
	$(RUNNER) run python scripts/fetch_opencode.py
	$(RUNNER) run pytest -m engine

# The few engine tests that prove the runner end to end (marker smoke, #713), same set-up as above.
test-engine-smoke:
	$(RUNNER) run python scripts/prime_tiktoken_cache.py
	$(RUNNER) run python scripts/fetch_opencode.py
	$(RUNNER) run pytest -m "engine and smoke"

# Needs a browser. Without a downloaded Chromium, use an installed Chrome:
#   make test-e2e PLAYWRIGHT_CHANNEL=chrome
test-e2e:
	PLAYWRIGHT_CHANNEL=$(PLAYWRIGHT_CHANNEL) $(APP) test:e2e $(ARGS)

# The hosted lane (#332): the real app in its serverless mode, the real Dispatcher and the real Worker over the loopback
# fakes. Needs a Postgres server it may create a database on (E2E_DATABASE_URL, for example
# postgres://postgres:postgres@127.0.0.1:5432/postgres), the Dispatcher's and the runner's dependencies (`make install`)
# and a browser (PLAYWRIGHT_CHANNEL=chrome for an installed Chrome). It fails, naming what is missing; it never skips.
# CI runs it as the job `e2e-hosted`; the privileged half is `make test-e2e-dynamic`.
test-e2e-hosted:
	PLAYWRIGHT_CHANNEL=$(PLAYWRIGHT_CHANNEL) $(APP) test:e2e:hosted $(ARGS)

# The privileged Dynamic Review lane (#253): needs sudo, nft and the internet once (the pinned OpenCode
# and ripgrep). It fails, with the missing item named, where it cannot run; it never skips.
test-e2e-dynamic:
	cd runner && scripts/run_dynamic_e2e.sh $(ARGS)

# The privileged lane of the Sandbox-Launcher (#329-T09, T10): the local mode of the Sandbox double over a real Docker
# daemon, with the Worker image of the `sandbox` target and the fake App. Needs a running daemon this user may use and
# fails, naming what is missing, without one. The container reaches the fake App on the docker0 gateway
# (SANDBOX_LOCAL_APP_HOST). Not part of `make verify`; CI runs it as the job `sandbox-local`.
test-sandbox-local:
	docker build --file runner/Dockerfile --target sandbox --tag code-reviewer-worker:local .
	SANDBOX_LOCAL_IMAGE=code-reviewer-worker:local TEST_ALLOWED_HOSTS=$${SANDBOX_LOCAL_APP_HOST:-172.17.0.1} $(DISPATCHER) test:privileged

# The lane of a whole Implementer turn (#745, step 4): the real agent image, the real reader and the pinned OpenCode on a
# real Docker daemon under runc (set LANE_RUNTIME=sysbox-runc on a machine with Sysbox), as root, as Control runs. Builds the
# `sandbox` and `agent` targets; fails, with the missing item named, where it cannot run. Not part of `make verify`; CI runs it
# as the job `implementer-lane`.
test-lane:
	docker build --file runner/Dockerfile --target sandbox --tag code-reviewer-worker:lane .
	docker build --file runner/Dockerfile --target agent --tag code-reviewer-agent:lane .
	cd runner && sudo -E env LANE_WORKER_IMAGE=code-reviewer-worker:lane LANE_AGENT_IMAGE=code-reviewer-agent:lane LANE_RUNTIME=$${LANE_RUNTIME:-runc} .venv/bin/python -m pytest -m lane tests/lane -q -p no:cacheprovider

# Builds the Worker image (the `sandbox` target of runner/Dockerfile, the only image of the project) and runs
# docker/smoke/runner.sh against it. Needs a running Docker daemon and fails without one. Not part of
# `make verify` (CI runs it for pull requests that touch the runner).
test-images:
	docker build --file runner/Dockerfile --target sandbox --tag code-reviewer-runner-sandbox:local .
	docker/smoke/runner.sh code-reviewer-runner-sandbox:local

verify: lint typecheck check-contracts test-unit test-integration check-licenses
