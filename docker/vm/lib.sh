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

# mounted_under <dir>: every mount point of this host that is <dir> or below it, one per line. Fails when it cannot list them.
# findmnt writes a space or a backslash in a target as an escape, so remove_tree refuses a <dir> that has one.
mounted_under() {
  local dir=$1
  findmnt -rn -o TARGET | awk -v dir="$dir" 'index($0, dir) == 1 && (length($0) == length(dir) || substr($0, length(dir) + 1, 1) == "/")'
}

# remove_tree <dir>: deletes a tree that was built as root with /dev, /proc and the like bind-mounted into it. A `rm -rf` of it while one of
# those is still mounted deletes the host's own devices, so it refuses while anything under <dir> is mounted (or when it cannot tell), and
# `--one-file-system` stops it at a mount it did not know about.
remove_tree() {
  local dir=$1 mounted
  case "$dir" in
    /?*) ;;
    *) echo "remove_tree: refusing '$dir': not an absolute path below /" >&2; return 1 ;;
  esac
  case "$dir" in
    *[[:space:]\\]*) echo "remove_tree: refusing '$dir': a space or a backslash in it" >&2; return 1 ;;
  esac
  mounted=$(mounted_under "$dir") || { echo "remove_tree: cannot list the mounts, refusing to delete $dir" >&2; return 1; }
  if [ -n "$mounted" ]; then
    echo "remove_tree: refusing to delete $dir, still mounted: $(printf '%s' "$mounted" | tr '\n' ' ')" >&2
    return 1
  fi
  rm -rf --one-file-system -- "$dir"
}
