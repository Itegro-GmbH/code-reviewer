#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The one install hook of vm-init (#977): puts it into a root file system that is being built (#976). Run it as the user
# that builds the file system, with the directory the file system is assembled in; it writes two files and nothing else:
#
#   <root>/usr/local/sbin/vm-init                     the program: a zipapp of runner/src/code_reviewer_runner/vm_init/, standard
#                                                     library only, started with `python3` (the shebang names VM_INIT_PYTHON)
#   <root>/etc/code-reviewer/control-seccomp.json     the seccomp profile of the Control container: Docker's default profile
#                                                     with AF_VSOCK allowed (runner/vm-init/README.md, "The seccomp profile")
#
# It needs `python3` (3.8 or newer, for `zipapp`) and `install`. The output is the same bytes on every run from the same
# sources: the files of the package get a fixed modification time before they are packed. What the root file system must
# have besides these two files is in runner/vm-init/README.md ("What the root file system must provide").
set -euo pipefail

usage() {
  echo "usage: install.sh <root-file-system-directory>" >&2
  exit 64
}

[ $# -eq 1 ] || usage
root="$1"
[ -d "$root" ] || { echo "install.sh: $root is not a directory" >&2; exit 66; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package="$here/../src/code_reviewer_runner/vm_init"
python="${VM_INIT_PYTHON:-/usr/bin/python3}"
# 2000-01-01T00:00:00Z: the zip format cannot hold a time before 1980.
fixed_time=946684800

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir "$stage/vm_init"
for source in "$package"/*.py; do
  cp "$source" "$stage/vm_init/"
done
find "$stage" -exec touch -h -d "@$fixed_time" {} +

install -d -m 0755 "$root/usr/local/sbin" "$root/etc/code-reviewer"
# The package is imported as `vm_init` here; its modules import each other relatively, so the name does not matter to them.
python3 -m zipapp "$stage" -m "vm_init.__main__:run" -p "$python" -o "$stage/vm-init.pyz"
install -m 0755 "$stage/vm-init.pyz" "$root/usr/local/sbin/vm-init"
install -m 0644 "$here/control-seccomp.json" "$root/etc/code-reviewer/control-seccomp.json"
