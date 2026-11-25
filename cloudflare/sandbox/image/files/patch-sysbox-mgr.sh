#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The one patch of the Cloudflare image (#1159, spike #1149 Q2, docs/runner.md "Cloudflare placement"): `sysbox-mgr` refuses to start without
# /proc/modules ("shiftfs kernel module check failed: open /proc/modules: no such file or directory") and the Container's kernel has no module
# support, so the file does not exist and cannot be bind-mounted. The check only looks for the shiftfs module, which Sysbox does not need here
# (ID-mapped mounts are supported by the kernel). The patch points that one check at an empty regular file, by a path of the SAME length
# (a swap one byte longer shifted the binary and crashed it, spike q2b): `/proc/modules` becomes `/var//modules` (the same path as `/var/modules`).
#
# Verified at both ends, so that nothing but the pinned binary becomes the pinned result: the sha256 of sysbox-mgr of the pinned package
# (sysbox-ce 0.7.1, whose own sha256 the recipe checks) before, the exact count of the string, the same size after, and the sha256 of
# the result. A different Sysbox version fails the build here on purpose: re-derive both hashes (docs/runner.md) before bumping it.
#   51 original is not the pinned binary   52 the string is not there exactly once   53 size changed   54 the result is not the pinned one
set -euo pipefail
bin="${1:-/usr/bin/sysbox-mgr}"
original_sha256="d478b94dec845579cab456ffcad523af384977a81a14f3133704a6219f72b89b"
patched_sha256="4171c9eaa158d121b86df7992b77fc7807b9ee7ba443b7d691e3969250253ebf"
empty="${2:-/var/modules}"

fail() { echo "patch-sysbox-mgr: $2" >&2; exit "$1"; }

printf '%s  %s\n' "$original_sha256" "$bin" | sha256sum --check --status - || fail 51 "$bin is not the pinned sysbox-mgr of sysbox-ce 0.7.1"
tmp="$bin.patched"
python3 - "$bin" "$tmp" <<'PY' || exit $?
import os, shutil, sys
src, dst = sys.argv[1], sys.argv[2]
old, new = b"/proc/modules", b"/var//modules"
assert len(old) == len(new)
data = open(src, "rb").read()
if data.count(old) != 1:
    print("patch-sysbox-mgr: the string /proc/modules is not there exactly once", file=sys.stderr)
    sys.exit(52)
patched = data.replace(old, new)
if len(patched) != len(data):
    print("patch-sysbox-mgr: the size changed", file=sys.stderr)
    sys.exit(53)
open(dst, "wb").write(patched)
shutil.copymode(src, dst)
PY
printf '%s  %s\n' "$patched_sha256" "$tmp" | sha256sum --check --status - || { rm -f "$tmp"; fail 54 "the patched binary is not the pinned result"; }
mv -f "$tmp" "$bin"
# The empty file the swapped path names: a regular file, read-only, so that nothing in the Container can make shiftfs "appear".
: > "$empty"
chmod 0444 "$empty"
echo "patch-sysbox-mgr: ok"
