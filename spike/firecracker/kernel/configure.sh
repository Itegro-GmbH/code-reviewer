#!/usr/bin/env bash
# Spike #970: kernel source (pinned) + Firecracker's recommended config + our fragment -> .config, verified.
# Usage: configure.sh <work dir>; leaves <work dir>/linux (the tree with .config), <work dir>/added-options.txt.
# No compiler run beyond the small kconfig tools: this runs on any machine (the spike runs it first, in seconds).
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
work=$(realpath -m "${1:?work dir}")
mkdir -p "$work"
fetch_pinned "$KERNEL_URL" "$KERNEL_SHA256" "$work/linux-$KERNEL_VERSION.tar.xz"
fetch_pinned "$FC_GUEST_CONFIG_URL" "$FC_GUEST_CONFIG_SHA256" "$work/fc-base.config"
tree="$work/linux"
if [ ! -f "$tree/Makefile" ]; then
  mkdir -p "$tree"
  tar -xf "$work/linux-$KERNEL_VERSION.tar.xz" -C "$tree" --strip-components=1
fi
cp "$work/fc-base.config" "$tree/.config"
(cd "$tree" && KCONFIG_CONFIG=.config ./scripts/kconfig/merge_config.sh -m .config "$SPIKE_DIR/kernel/config.fragment" >/dev/null && make olddefconfig >/dev/null)

# Verify: every option of the fragment must have the requested value in the final .config.
missing=0
: > "$work/added-options.txt"
while IFS= read -r line; do
  case "$line" in CONFIG_*=*) ;; *) continue ;; esac
  name=${line%%=*}; want=${line#*=}
  got=$(grep -E "^$name=" "$tree/.config" | head -1 | cut -d= -f2- || true)
  base=$(grep -E "^$name=" "$work/fc-base.config" | head -1 | cut -d= -f2- || true)
  if [ "$got" != "$want" ]; then
    echo "MISSING $name: wanted $want, got '${got:-unset}' (unmet dependency?)" >&2
    missing=$((missing + 1))
  fi
  if [ "$got" = "$want" ] && [ "$base" != "$want" ]; then
    printf '%s=%s (Firecracker base: %s)\n' "$name" "$want" "${base:-unset}" >> "$work/added-options.txt"
  fi
done < "$SPIKE_DIR/kernel/config.fragment"
if [ "$missing" -ne 0 ]; then echo "$missing option(s) did not stick" >&2; exit 1; fi
log "config ok: $(wc -l < "$work/added-options.txt") options added or changed against Firecracker's base config"
