#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Verifies a final kernel .config against the fragment (#976): EVERY option of the fragment must have the requested value, or this fails; and
# RT_GROUP_SCHED must be off. configure.sh runs it on the merged configuration; the release job runs it again on the .config of the kernel
# that is published, so a kernel from the cache is held to the same rule as one that was just built.
# Usage: verify-config.sh <.config> <Firecracker base config> [<file for the options added or changed against the base>]
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
config=${1:?.config}; base_config=${2:?base config}; added=${3:-/dev/null}
fragment="$VM_DIR/kernel/config.fragment"
missing=0
: > "$added"
while IFS= read -r line; do
  case "$line" in CONFIG_*=*) ;; *) continue ;; esac
  name=${line%%=*}; want=${line#*=}
  got=$(grep -E "^$name=" "$config" | head -1 | cut -d= -f2- || true)
  base=$(grep -E "^$name=" "$base_config" | head -1 | cut -d= -f2- || true)
  # "=n" in the fragment means the option must not be set: a `# CONFIG_X is not set` line or no line at all
  if [ "$want" = n ]; then got=${got:-n}; base=${base:-n}; fi
  if [ "$got" != "$want" ]; then
    echo "MISSING $name: wanted $want, got '${got:-unset}' (unmet dependency?)" >&2
    missing=$((missing + 1))
  fi
  if [ "$got" = "$want" ] && [ "$base" != "$want" ]; then
    printf '%s=%s (Firecracker base: %s)\n' "$name" "$want" "${base:-unset}" >> "$added"
  fi
done < "$fragment"
if [ "$missing" -ne 0 ]; then echo "$missing option(s) did not stick" >&2; exit 1; fi
# The one that must never come back, said on its own so that its failure is not lost among others: with it the cpu controller cannot be
# enabled for child cgroups and vm-prepare.sh fails (docs/runner.md, "VM artifacts").
if grep -q '^CONFIG_RT_GROUP_SCHED=y' "$config"; then echo "RT_GROUP_SCHED is on" >&2; exit 1; fi
log "config ok: $(grep -c . "$added" || true) options added or changed against Firecracker's base config"
