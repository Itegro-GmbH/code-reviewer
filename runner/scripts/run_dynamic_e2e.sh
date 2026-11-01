#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary

# The privileged Dynamic e2e lane (#253, #201-T01): the journey of a pull request through the real app,
# the real Dispatcher, the real Worker as root with the capabilities of the hardened container spec and the real
# pinned OpenCode as its engine user, against the loopback fakes. It needs root, nft and a Linux kernel with network namespaces, so it runs in CI (GitHub's Ubuntu
# runners have passwordless sudo) or on a machine where you can sudo. It never skips: what is missing is
# named (app/e2e/helpers/dynamic-preflight.ts) and the run fails.
#
#   scripts/run_dynamic_e2e.sh [playwright arguments, for example --grep @smoke]
#
# Two steps:
#   1. as you, with the internet: the pinned OpenCode and ripgrep (fetch_opencode.py and fetch_ripgrep.py
#      accept only the pinned bytes), the pinned git for the Implementer (build_lane_git.sh: the release of git-pin.json
#      built from its verified source, cached) and the one production build of the app (`next build`; set
#      E2E_REUSE_BUILD=1 to use the build that is there);
#   2. as root, in `unshare --net --mount --pid --fork --mount-proc`: scripts/dynamic_e2e_namespace.sh. The
#      namespaces hold the lane: loopback is the only network (and a network guard counts and rejects every
#      attempt to leave it), the mounts and the engine user exist only inside, and when the lane ends every
#      process in it ends with it.
# The ports are private: the app listens on E2E_HOSTED_PORT (default 3617) and the Dispatcher on the next one, the
# fakes take random ones. Never 3000 or 3100. The app's database is on the Postgres server E2E_DATABASE_URL names
# (default postgres://postgres:postgres@127.0.0.1:5432/postgres); the lane has no network but loopback, so it reaches
# the server through a Unix socket that app/e2e/pg-bridge.ts forwards from outside the namespace.
set -euo pipefail
cd "$(dirname "$0")/.."
RUNNER_DIR="$PWD"
APP_DIR="$(cd ../app && pwd)"

for tool in sudo unshare setpriv ip nft; do
  command -v "$tool" >/dev/null || [ -x "/usr/sbin/$tool" ] \
    || { echo "The Dynamic e2e lane needs $tool and it is not installed." >&2; exit 1; }
done
sudo -n true 2>/dev/null \
  || { echo "The Dynamic e2e lane needs sudo without a password (root for the supervisor, nft and the engine user)." >&2; exit 1; }

# The staging directory is ours; the root part mounts a tmpfs on `lane` (inside its mount namespace
# only), so what it installs there never reaches the host and this directory stays empty.
STAGING="$(mktemp -d)"

# The root part writes into the trees it runs in (test-results, playwright-report, .next/cache, __pycache__).
# Whatever root created there is given back to you however the lane ends, so a later build as you or
# a clean-up does not fail on root-owned files. Nothing is followed: symlinks are changed, not
# their targets.
give_back() {
  sudo -n find "$APP_DIR" "$RUNNER_DIR" -xdev -user root -exec chown -h "$(id -u):$(id -g)" {} + \
    || echo "Could not give the files that root created back to $(id -un); chown them by hand." >&2
}
BRIDGE_PID=""
stop_bridge() {
  if [ -n "$BRIDGE_PID" ]; then kill "$BRIDGE_PID" 2>/dev/null || echo "The Postgres bridge had already ended." >&2; fi
}
trap 'stop_bridge; rm -rf "$STAGING"; give_back' EXIT
mkdir "$STAGING/lane" "$STAGING/pg"

# The Postgres server of the job, for the app inside the lane: a Unix socket in $STAGING/pg that forwards to its port.
export E2E_DATABASE_URL="${E2E_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/postgres}"
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$APP_DIR/e2e/pg-bridge.ts" "$STAGING/pg" "$E2E_DATABASE_URL" \
  > "$STAGING/pg-url" 2> "$STAGING/pg-bridge.log" &
BRIDGE_PID=$!
for _ in $(seq 1 50); do
  [ -s "$STAGING/pg-url" ] && break
  sleep 0.2
done
[ -s "$STAGING/pg-url" ] || { cat "$STAGING/pg-bridge.log" >&2; echo "The bridge to the Postgres server did not start." >&2; exit 1; }
LANE_DATABASE_URL="$(head -n 1 "$STAGING/pg-url")"

# Step 1: the pinned tools and the one build.
OPENCODE_BIN="$(uv run python scripts/fetch_opencode.py)"
RIPGREP_BIN="$(uv run python scripts/fetch_ripgrep.py --dest "$STAGING/ripgrep")"
GIT_TREE="$(scripts/build_lane_git.sh)"
if [ "${E2E_REUSE_BUILD:-}" != "1" ]; then
  (cd "$APP_DIR" && NEXT_TELEMETRY_DISABLED=1 pnpm build)
fi

export E2E_PORT="${E2E_PORT:-3517}"
case "$E2E_PORT:${E2E_HOSTED_PORT:-}" in
  3000:* | 3100:* | *:3000 | *:3100 | 2999:* | 3099:*)
    echo "The Dynamic e2e lane must not use the ports 3000 or 3100 (E2E_PORT=$E2E_PORT): other work runs there." >&2
    exit 1 ;;
esac

# Step 2: root, in the lane's namespaces. `env PATH=...` because sudo replaces PATH.
set +e
sudo --preserve-env env "PATH=$PATH:/usr/sbin:/sbin" "HOME=$HOME" \
  "LANE_OPENCODE_BIN=$OPENCODE_BIN" "LANE_RIPGREP_BIN=$RIPGREP_BIN" "LANE_GIT_TREE=$GIT_TREE" \
  "LANE_APP_DIR=$APP_DIR" "LANE_RUNNER_DIR=$RUNNER_DIR" "LANE_STAGE=$STAGING/lane" "E2E_PORT=$E2E_PORT" "E2E_DATABASE_URL=$LANE_DATABASE_URL" \
  unshare --net --mount --pid --fork --mount-proc -- \
  bash "$RUNNER_DIR/scripts/dynamic_e2e_namespace.sh" "$@"
status=$?
set -e
exit "$status"
