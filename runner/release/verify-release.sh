#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Verifies a program release (#1002) the way a customer's machine does, before anything is published: what `runner/install/install.sh`
# checks of the program (`stage_program`, `verify_signature`, `fetch_manifest`), with the same tools (openssl, jq, zstd, tar, sha256sum)
# and no Node or Python: the job that holds the signing key runs this and nothing it has to install.
#
#   verify-release.sh --dir DIR --manifest FILE --signature FILE --channel FILE
#                     [--release N] [--commit SHA] [--vm N] [--min-release N] [--exact-dir]
#
# The signature must verify with the public key of the channel (an ECDSA P-256 key) over the exact bytes of the manifest; the manifest names
# the tarball by size and sha256; the tarball lists only names the installer accepts (no absolute path, no `..`, no odd character), holds no
# device, socket or link out of its tree, carries the four parts the installer looks for, and its `share/release.json` names the release and
# the commit that were asked for, and the VM artifacts release it needs (`vmArtifacts`, a whole number, which the installer takes together with the
# program: `--vm`, the release the pair of the repository names). `--min-release`: the number must be higher (the number only grows). `--exact-dir`: nothing but the tarball,
# the manifest and the signature is in DIR (what is published is what was signed).
set -euo pipefail

fail() { echo "verify-release: $*" >&2; exit 1; }

dir="" manifest="" signature="" channel="" release="" commit="" vm="" min_release="" exact=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="${2:?}"; shift 2 ;;
    --manifest) manifest="${2:?}"; shift 2 ;;
    --signature) signature="${2:?}"; shift 2 ;;
    --channel) channel="${2:?}"; shift 2 ;;
    --release) release="${2:?}"; shift 2 ;;
    --commit) commit="${2:?}"; shift 2 ;;
    --vm) vm="${2:?}"; shift 2 ;;
    --min-release) min_release="${2:?}"; shift 2 ;;
    --exact-dir) exact=1; shift ;;
    *) fail "unknown option: $1" ;;
  esac
done
for need in dir manifest signature channel; do
  [ -n "${!need}" ] || fail "--${need//_/-} is required"
done
for tool in openssl jq zstd tar sha256sum base64 find; do
  command -v "$tool" > /dev/null || fail "$tool is not installed"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The key of the channel: base64 of the DER of an ECDSA P-256 public key, as install.sh reads it.
key_b64=$(jq -r '.publicKey // ""' "$channel")
[ -n "$key_b64" ] || fail "$channel has no publicKey"
case "$key_b64" in *[!A-Za-z0-9+/=]*) fail "the public key of the channel is not base64" ;; esac
printf '%s' "$key_b64" | base64 -d > "$work/key.der" 2> /dev/null || fail "the public key of the channel cannot be read"
openssl pkey -pubin -inform DER -in "$work/key.der" -out "$work/key.pem" > /dev/null 2>&1 || fail "the public key of the channel cannot be read"
openssl pkey -pubin -in "$work/key.pem" -noout -text 2> /dev/null | grep -Eq 'prime256v1|P-256' || fail "the public key of the channel is not an ECDSA P-256 key"
openssl dgst -sha256 -verify "$work/key.pem" -signature "$signature" "$manifest" > /dev/null 2>&1 \
  || fail "the signature of the manifest is not valid for the key of $channel"

# The manifest, as install.sh reads it.
jq -e '.version == 1 and (.file.name | type) == "string" and (.file.size | type) == "number" and (.file.sha256 | type) == "string"' "$manifest" > /dev/null \
  || fail "the manifest is not a program manifest"
number=$(jq -r 'if (.release | type) == "number" and .release >= 1 and .release == (.release | floor) then .release else empty end' "$manifest")
[ -n "$number" ] || fail "the manifest has no release number"
[ "$(jq -r '.arch // ""' "$manifest")" = x86_64 ] || fail "the manifest is not for x86_64"
[ -z "$release" ] || [ "$number" = "$release" ] || fail "the manifest is release $number, not $release"
[ -z "$min_release" ] || [ "$number" -gt "$min_release" ] || fail "release $number is not higher than $min_release: the number only grows"
name=$(jq -r .file.name "$manifest")
size=$(jq -r .file.size "$manifest")
digest=$(jq -r .file.sha256 "$manifest")
printf '%s' "$name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._+=@-]*$' || fail "the manifest names a file in a form the installer does not accept: $name"
[ "$name" = "factory-runner-$number-x86_64.tar.zst" ] || fail "the file is named $name, not factory-runner-$number-x86_64.tar.zst"
printf '%s' "$digest" | grep -Eq '^[0-9a-f]{64}$' || fail "the digest in the manifest is not a sha256"

# The tarball: the size and the digest the manifest names.
tarball="$dir/$name"
[ -f "$tarball" ] || fail "$tarball does not exist"
[ "$(stat -c %s "$tarball")" = "$size" ] || fail "the tarball is not the size its manifest names"
[ "$(sha256sum "$tarball" | cut -d' ' -f1)" = "$digest" ] || fail "the tarball does not match the digest in its manifest"

if [ "$exact" = 1 ]; then
  expected=$(printf '%s\n' "$name" "$(basename "$manifest")" "$(basename "$signature")" | sort)
  found=$(find "$dir" -mindepth 1 -printf '%P\n' | sort)
  [ "$found" = "$expected" ] || fail "the directory holds other files than the tarball, the manifest and the signature: $(printf '%s' "$found" | tr '\n' ' ')"
fi

# What the installer lists before it unpacks.
zstd -dcq "$tarball" | tar -tf - > "$work/names" 2> /dev/null || fail "the tarball is not a tar archive in zstd"
if grep -Eq '(^/|(^|/)\.\.(/|$)|[^A-Za-z0-9._+/@=-])' "$work/names"; then
  fail "the tarball holds a path outside its own tree or an odd name: $(grep -E '(^/|(^|/)\.\.(/|$)|[^A-Za-z0-9._+/@=-])' "$work/names" | head -3 | tr '\n' ' ')"
fi
mkdir "$work/tree"
zstd -dcq "$tarball" | tar -xf - -C "$work/tree" --no-same-owner --no-same-permissions 2> /dev/null || fail "the tarball cannot be unpacked"
[ -z "$(find "$work/tree" \( -type b -o -type c -o -type p -o -type s \))" ] || fail "the tarball holds a device or a socket"
[ -z "$(find "$work/tree" -type f -size +1048576k)" ] || fail "the tarball holds a file bigger than the installer's limit of 1 GiB"
while IFS= read -r link; do
  case "$(readlink -f "$link" 2> /dev/null || true)" in
    "$work/tree"/*) ;;
    *) fail "the tarball holds a link that points out of its tree: ${link#"$work/tree/"}" ;;
  esac
done < <(find "$work/tree" -type l)
for part in bin/factory-runner bin/firecracker libexec/host.sh share/outer-wall.nft; do
  [ -f "$work/tree/$part" ] || fail "the tarball has no $part: it is not a runner release"
done
grep -q '@SLOT_NETWORK@' "$work/tree/share/outer-wall.nft" || fail "share/outer-wall.nft is not the template the installer renders (no @SLOT_NETWORK@)"
sh -n "$work/tree/libexec/host.sh" || fail "libexec/host.sh is not a shell script"

# The release says what it is: this number, this commit.
info="$work/tree/share/release.json"
[ -f "$info" ] || fail "the tarball has no share/release.json"
[ "$(jq -r .release "$info")" = "$number" ] || fail "share/release.json is release $(jq -r .release "$info"), not $number"
[ -z "$commit" ] || [ "$(jq -r .commit "$info")" = "$commit" ] || fail "share/release.json names the commit $(jq -r .commit "$info"), not $commit"

needed=$(jq -r 'if (.vmArtifacts | type) == "number" and .vmArtifacts >= 1 and .vmArtifacts == (.vmArtifacts | floor) then .vmArtifacts else empty end' "$info")
[ -n "$needed" ] || fail "share/release.json does not name the VM artifacts release it needs (vmArtifacts): the installer would not take the program"
[ -z "$vm" ] || [ "$needed" = "$vm" ] || fail "share/release.json names the VM artifacts release $needed, not $vm"

echo "verify-release: release $number ok ($name, $size bytes, sha256 $digest, vm artifacts release $(jq -r .vmArtifacts "$info"))"
