#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Builds the Worker image and the agent image from the repository's own Dockerfile (the two targets and tags of the golden snapshot's recipe,
# generated/recipe/recipe.json) and writes each as a zstd compressed `docker save` archive under generated/inner/, where the Container image
# carries them and the boot script loads them. BuildKit writes the archive straight to the pipe: the images are never loaded into the builder's
# Docker, which has the disk for one copy only. Needs Docker with buildx, zstd and jq; CI only (3 GB of images). Run image/prepare-context.sh first.
# Usage: image/build-inner.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
recipe="$here/generated/recipe/recipe.json"
[ -f "$recipe" ] || { echo "build-inner: run prepare-context.sh first" >&2; exit 1; }
dockerfile=$(jq -r .dockerfile "$recipe")
cd "$repo"
build() { # <name> <target> <tag>
  echo "build-inner: $1 ($2 -> $3)" >&2
  docker buildx build --file "$dockerfile" --target "$2" --tag "$3" --provenance=false --output "type=docker,dest=-" . \
    | zstd -T0 -3 -q -o "$here/generated/inner/$1.tar.zst"
}
build worker "$(jq -r .worker.target "$recipe")" "$(jq -r .worker.tag "$recipe")"
build agent "$(jq -r .agent.target "$recipe")" "$(jq -r .agent.tag "$recipe")"
ls -l "$here/generated/inner" >&2
