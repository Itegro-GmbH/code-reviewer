# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005 helpers: `ix` runs incus in the incus-admin group without a new login, quietly.
# `</dev/null`: `incus init`/`launch` read an instance config from stdin when it is not a terminal, and hang on a pipe that never closes (seen twice in the 7.6 re-measure).
ix() { sg incus-admin -c "incus $(printf '%q ' "$@") </dev/null" 2>&1 | tr '\r' '\n' | grep -v -E '^(Retrieving|Pushing|Pulling)|^ *$' ; return "${PIPESTATUS[0]}"; }
# run a command in an instance as root
ixe() { local i=$1; shift; ix exec "$i" -- "$@"; }
# run a script from stdin in an instance (no quoting trouble): ixs <instance> <<'EOF2' ... EOF2
ixs() { local i=$1; sg incus-admin -c "incus exec $i -- bash -s" 2>&1 | tr '\r' '\n'; return "${PIPESTATUS[0]}"; }
