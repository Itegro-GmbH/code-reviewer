#!/usr/bin/env bash
# Shared helpers of the spike scripts (source this file).
set -euo pipefail
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SPIKE_DIR/versions.env"

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

# now_ms: wall clock in milliseconds (the host and the guest share no clock source we trust, so all timing is taken on the host)
now_ms() { date +%s%3N; }
