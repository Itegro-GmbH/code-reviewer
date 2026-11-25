#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 driver: cf.sh <box a|b> <action> [data-file] [query]. The secret and the URL come from the file in $CF_SPIKE_ENV
# (mode 0600, outside the repo, never committed): `export CF_URL=https://<worker>.workers.dev` and `export CF_SECRET=<random>`.
set -euo pipefail
. "${CF_SPIKE_ENV:?set CF_SPIKE_ENV to the 0600 env file}"
box=$1 action=$2 data=${3:-} q=${4:-}
args=(-sS -m "${CF_TIMEOUT:-300}" -X POST -H "x-spike-secret: $CF_SECRET")
[ -n "$data" ] && [ "$data" != "-" ] && args+=(--data-binary "@$data")
curl "${args[@]}" "$CF_URL/$box/$action$q"
echo
