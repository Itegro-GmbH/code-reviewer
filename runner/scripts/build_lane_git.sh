#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary

# The pinned git for the privileged e2e lane (#767): the release of runner/git-pin.json, built from the verified source the way
# the Worker image builds it (runner/Dockerfile, stage git-build: the same make variables), into a tree laid out as /usr/local
# (the prefix) that the lane installs into its mount namespace. The lane runs the same git as the Worker image, not the one of the
# GitHub runner.
#
#   scripts/build_lane_git.sh [DESTDIR]    prints DESTDIR (default ~/.cache/code-reviewer/lane-git/<version>)
#
# Needs a C compiler, make, zlib and the libcurl headers (any flavour: only the image is held to the GnuTLS one for its licence).
# A tree that is there already, built from this pin, is used again (the CI job caches it).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(python3 -c 'import json; print(json.load(open("git-pin.json"))["version"])')"
DEST="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/code-reviewer/lane-git/$VERSION}"
if [ -x "$DEST/usr/local/bin/git" ] && [ -e "$DEST/.complete" ]; then
  echo "$DEST"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
uv run python scripts/fetch_toolchain.py --component git --dest "$WORK/src" >&2
VARIABLES=(prefix=/usr/local sysconfdir=/etc INSTALL_SYMLINKS=1 NO_GETTEXT=1 NO_PERL=1 NO_PYTHON=1 NO_TCLTK=1 NO_EXPAT=1 NO_LIBPCRE2=1 NO_OPENSSL=1)
make -C "$WORK/src" -j"$(nproc)" "${VARIABLES[@]}" all strip >&2
rm -rf "$DEST"
mkdir -p "$DEST"
make -C "$WORK/src" "${VARIABLES[@]}" DESTDIR="$DEST" install >&2
"$DEST/usr/local/bin/git" --version >&2
touch "$DEST/.complete"
echo "$DEST"
