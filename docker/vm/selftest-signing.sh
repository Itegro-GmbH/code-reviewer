#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Proves, on the real files of a build, the chain the release signs and a host verifies (#976-T01): a throwaway key signs the manifest the way the
# release does (`openssl dgst -sha256 -sign`), the verifier accepts it, and then refuses a changed byte in a file, a changed byte in the manifest
# and a signature of another key. The throwaway key never leaves this script's temp directory. The release's own key is not used here.
# Usage: selftest-signing.sh <release dir with manifest.json>
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
dir=$(realpath "${1:?release dir}")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
verify() { # verify <dir> <manifest> <signature> <public key b64>
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$REPO_DIR/dispatcher/src/vm-artifacts/verify-main.ts" \
    --dir "$1" --manifest "$2" --signature "$3" --public-key "$4"
}
newkey() { # newkey <name>: writes $tmp/<name>.pem, prints the public key as base64 of the DER SubjectPublicKeyInfo
  openssl ecparam -genkey -name prime256v1 -noout -out "$tmp/$1.pem" 2> /dev/null
  openssl pkey -in "$tmp/$1.pem" -pubout -outform DER 2> /dev/null | base64 -w0
}
key=$(newkey release); other=$(newkey other)
openssl dgst -sha256 -sign "$tmp/release.pem" -out "$tmp/manifest.sig" "$dir/manifest.json"

log "the signed release verifies"
verify "$dir" "$dir/manifest.json" "$tmp/manifest.sig" "$key"

expect_failure() { # expect_failure <code> <command...>
  local code=$1; shift
  if out=$("$@" 2>&1); then echo "expected $code, but the check passed" >&2; exit 1; fi
  case "$out" in *"$code"*) log "refused as it must be: $code" ;; *) echo "expected $code, got: $out" >&2; exit 1 ;; esac
}

log "one changed byte of the kernel"
mkdir "$tmp/tampered"
for f in "$dir"/*; do ln -s "$f" "$tmp/tampered/$(basename "$f")"; done
rm "$tmp/tampered/vmlinux"; cp "$dir/vmlinux" "$tmp/tampered/vmlinux"
printf '\x5a' | dd of="$tmp/tampered/vmlinux" bs=1 seek=4096 conv=notrunc 2> /dev/null
expect_failure digest_mismatch verify "$tmp/tampered" "$dir/manifest.json" "$tmp/manifest.sig" "$key"

log "one changed byte of the manifest"
cp "$dir/manifest.json" "$tmp/manifest.json"
sed -i '0,/"release": \([0-9]\)/s//"release": 9\1/' "$tmp/manifest.json"
expect_failure signature_invalid verify "$dir" "$tmp/manifest.json" "$tmp/manifest.sig" "$key"

log "another key"
expect_failure signature_invalid verify "$dir" "$dir/manifest.json" "$tmp/manifest.sig" "$other"
log "signing chain ok"
