#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary

# Runs the engine suite (pytest -m engine tests/engine) in a Linux network namespace that has nothing but a
# loopback interface: the operating system itself, not only the Python level guard of the suite,
# guarantees that the real PR-Agent can reach nobody but the fakes. For CI (GitHub's Ubuntu runners
# have passwordless sudo); on a developer machine use `uv run pytest -m engine`.
#
#   scripts/run_engine_offline.sh [--engine-shard=pragent|opencode] [pytest options]
#
# The tests run on TEST_MAX_WORKERS pytest-xdist workers (default 4, the cores of a CI runner), one
# file per worker at a time (--dist loadfile: the module-scoped engines of a file are shared by its
# tests). --engine-shard runs one half of the suite (tests/engine_shards.py; CI runs both halves as
# jobs of their own). Options only: the directory tests/engine is always the one that is collected.
#
# The tiktoken cache is filled and the pinned OpenCode and the pinned Claude Code (#856) are fetched and
# verified first, outside the namespace (the steps that need the internet). The engine also needs a trusted ripgrep on its PATH,
# which the pinned release would otherwise download from GitHub on the first grep.
set -euo pipefail
cd "$(dirname "$0")/.."

uv run python scripts/prime_tiktoken_cache.py
uv run python scripts/fetch_opencode.py
uv run python scripts/fetch_claude_code.py
command -v rg >/dev/null || { echo "ripgrep is not installed (the engine's grep and glob need it)" >&2; exit 1; }

# Inside the namespace the script proves that there is no way out, drops back to the calling user
# (the tests must not run as root) and runs the suite. `env PATH=...` because sudo replaces PATH.
sudo --preserve-env env "PATH=$PATH" "HOME=$HOME" ENGINE_USER="$(id -u):$(id -g)" \
  unshare --net -- bash -c '
    set -euo pipefail
    ip link set lo up
    if python3 -c "import socket; socket.create_connection((\"1.1.1.1\", 53), 3)" 2>/dev/null; then
      echo "the network namespace is not isolated" >&2
      exit 1
    fi
    exec setpriv --reuid="${ENGINE_USER%%:*}" --regid="${ENGINE_USER##*:}" --clear-groups --no-new-privs \
      uv run --no-sync --offline pytest -m engine -n "${TEST_MAX_WORKERS:-4}" --dist loadfile tests/engine "$@"
  ' engine-offline "$@"
