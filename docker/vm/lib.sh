#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Shared helpers of the VM artifact scripts (#976); source this file.
set -euo pipefail
VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$VM_DIR/../.." && pwd)"
# shellcheck disable=SC1091
. "$VM_DIR/pins.env"

log() { printf '[%(%T)T] %s\n' -1 "$*" >&2; }

# fetch_pinned <url> <sha256> <dest>: download unless <dest> already has the checksum; always verify.
fetch_pinned() {
  local url=$1 sha=$2 dest=$3
  if [ -f "$dest" ] && printf '%s  %s\n' "$sha" "$dest" | sha256sum --check --status -; then
    log "have $(basename "$dest") ($sha)"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  log "download $url"
  curl -fsSL --retry 3 --max-time 600 -o "$dest.part" "$url"
  if ! printf '%s  %s\n' "$sha" "$dest.part" | sha256sum --check --status -; then
    echo "CHECKSUM MISMATCH for $url (pinned $sha, got $(sha256sum "$dest.part" | cut -d' ' -f1))" >&2
    rm -f "$dest.part"
    return 1
  fi
  mv "$dest.part" "$dest"
  log "verified $(basename "$dest") ($sha)"
}
