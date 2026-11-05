#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary

# Smoke test of the Factory-Runner image (#854, R1b): runner/Dockerfile.factory-runner, the Worker image with the
# `factory-runner` command as its entry point. It proves that the command starts, answers --version, reads its
# configuration from the environment without leaking a secret, and that the agent image reference the image was
# built with is in it. It does not start a job: that needs the host's Docker and is the lane's (runner/tests/lane).
# Usage: docker/smoke/factory-runner.sh [<image>]   (default: factory-runner:local)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=docker/smoke/lib.sh
source "$here/lib.sh"

image=${1:-factory-runner:local}
require_image "$image"

step "the command answers --version with the project version and the base"
output=$(docker run --rm "$image" --version)
case "$output" in
  "factory-runner "*" (base "*")") printf '    %s\n' "$output" ;;
  *) fail "unexpected --version output: $output" ;;
esac

step "register and selftest are commands of it"
docker run --rm "$image" register --help >/dev/null || fail "register --help failed"
docker run --rm "$image" selftest --help >/dev/null || fail "selftest --help failed"

step "config show reads the environment and never prints the credential"
credential="crc_$(printf 'A%.0s' $(seq 1 43))"
shown=$(docker run --rm --env FACTORY_RUNNER_URL=https://app.example --env "FACTORY_RUNNER_CREDENTIAL=$credential" "$image" config show)
printf '%s\n' "$shown" | grep -q '"credential": "set"' || fail "config show does not say the credential is set"
if printf '%s\n' "$shown" | grep -q "$credential"; then fail "config show printed the credential"; fi

step "the agent image reference the image was built with is in it"
reference=$(docker run --rm --entrypoint cat "$image" /opt/code-reviewer/agent-image.json)
printf '%s\n' "$reference" | grep -q 'code-reviewer-agent:ci' || fail "agent-image.json does not hold the reference: $reference"

step "the pinned engine of the Worker image is in it"
docker run --rm --entrypoint opencode "$image" --version | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "opencode is not in the image"

printf 'ok: %s\n' "$image"
