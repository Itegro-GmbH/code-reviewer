#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The lane of the program release (#1002): the REAL tarball (build_program.py, with the pinned Python, Firecracker and wheels), signed with a
# throwaway key the way the release job signs (`openssl dgst`), verified with the verifier the release job runs (verify-release.sh), and taken
# by the real `runner/install/install.sh`, as root on a GitHub runner with a real systemd and a real `nft`: install, update, switch, rollback,
# uninstall. What the installer lane (`runner/tests/kvm/installer`, a stand-in program) cannot prove and this does:
#   - the build is reproducible (the same commit and number give the same bytes);
#   - the tarball passes the installer's checks for real (names, links, `nft -c -f` of the rendered table on this kernel);
#   - the REAL program runs as the service user with an empty environment, from a tree that user cannot write: the bundled Python, the wheels
#     (`cryptography` is a compiled extension), the package and Firecracker (`--version` of both is the installer's smoke test at every switch);
#   - an update takes release 2 as a pair with the VM artifacts, a rollback goes back and does not take the release it left again.
# No token is given, so the service is installed and not started (it would need an app to register with and VM artifacts that boot); the VM
# artifacts are the installer tests' stand-ins and the KVM lane has the real ones. Needs sudo, jq, zstd, openssl, nft (installed here), python3 and uv.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
cache="${PROGRAM_BUILD_CACHE:-$work/cache}"
port=8444
server=""
commit=$(git -C "$repo" rev-parse HEAD)

fail() { echo "LANE FAILED: $*" >&2; exit 1; }

report() {
  echo "---- state" >&2
  sudo ls -laR /opt/code-reviewer 2>&1 | head -40 >&2 || true
  sudo ls -la /var/lib/code-reviewer /etc/code-reviewer 2>&1 | head -30 >&2 || true
}
cleanup() {
  status=$?
  if [ "$status" != 0 ]; then report; fi
  [ -z "$server" ] || kill "$server" 2> /dev/null || true
  sudo sh "$repo/runner/install/install.sh" --uninstall > /dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

build() { # build N OUT
  python3 "$here/build_program.py" --release "$1" --commit "$commit" --out "$2" --cache "$cache" --root "$repo"
}

echo "== tools"
sudo apt-get install -y -qq nftables > /dev/null
sudo modprobe tun || true
ls -l /dev/kvm /dev/net/tun
getent group kvm

echo "== the build: release 1 twice (reproducible), release 2"
time build 1 "$work/build1"
build 1 "$work/build1b"
cmp "$work/build1/factory-runner-1-x86_64.tar.zst" "$work/build1b/factory-runner-1-x86_64.tar.zst" || fail "two builds of the same commit and release number differ"
cmp "$work/build1/manifest.json" "$work/build1b/manifest.json"
build 2 "$work/build2"
size=$(stat -c %s "$work/build1/factory-runner-1-x86_64.tar.zst")
echo "the tarball is $((size / 1048576)) MiB"
[ "$size" -lt 104857600 ] || fail "the tarball is bigger than 100 MiB: the program ships something it should not"

echo "== a throwaway key, signed like the release job signs, verified like the release job verifies"
openssl ecparam -genkey -name prime256v1 -noout -out "$work/key.pem"
mkdir -p "$work/served" "$work/channels"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$work/server.key" -out "$work/ca.pem" -days 1 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2> /dev/null
printf 'cacert = "%s"\n' "$work/ca.pem" > "$work/curlrc"
uv run --no-project --python 3.13 --with cryptography python "$here/lane_vm.py" \
  --served "$work/served" --keyfile "$work/key.pem" --vm 10 --channels "$work/channels" --base "https://localhost:$port/"

publish() { # publish N: sign the manifest of build N, check it, and put it where the channel points
  openssl dgst -sha256 -sign "$work/key.pem" -out "$work/build$1/manifest.sig" "$work/build$1/manifest.json"
  bash "$here/verify-release.sh" --dir "$work/build$1" --manifest "$work/build$1/manifest.json" --signature "$work/build$1/manifest.sig" \
    --channel "$work/channels/program-channel.json" --release "$1" --commit "$commit" --exact-dir
  cp "$work/build$1/factory-runner-$1-x86_64.tar.zst" "$work/served/"
  cp "$work/build$1/manifest.json" "$work/served/runner-manifest.json"
  cp "$work/build$1/manifest.sig" "$work/served/runner-manifest.sig"
}
publish 1

python3 "$here/serve.py" "$work/served" "$work/ca.pem" "$work/server.key" "$port" &
server=$!
sleep 1
curl --silent --fail --cacert "$work/ca.pem" "https://localhost:$port/runner-manifest.json" > /dev/null || fail "the https server does not answer"

echo "== install the real program (no token: installed, not started)"
sudo sh "$repo/runner/install/install.sh" --program-channel-file "$work/channels/program-channel.json" \
  --vm-channel-file "$work/channels/vm-channel.json" --curl-config "$work/curlrc" --labels lane
test "$(readlink /opt/code-reviewer/current)" = "releases/1" || fail "current is not release 1"
test "$(stat -c '%U:%G' /opt/code-reviewer/current/bin/factory-runner)" = "root:root" || fail "the program is not root's"
for part in bin/factory-runner bin/firecracker libexec/host.sh share/outer-wall.nft share/release.json python/bin/python3; do
  test -e "/opt/code-reviewer/current/$part" || fail "the release has no $part"
done
if find /opt/code-reviewer/releases/1 -perm /022 ! -type l | grep -q .; then fail "something in the program is writable by group or others"; fi
sudo nft list table inet code_reviewer_wall > /dev/null

echo "== the real program as the service user, with an empty environment, from a tree it cannot write"
as_service() { sudo -u factory-runner env -i "$@"; }
as_service /opt/code-reviewer/current/bin/factory-runner --version | tee "$work/version.txt"
grep -q '^factory-runner 0\.' "$work/version.txt" || fail "the program does not say its version"
as_service /opt/code-reviewer/current/bin/firecracker --version | head -1 | grep -q '^Firecracker v' || fail "firecracker does not say its version"
as_service /opt/code-reviewer/current/python/bin/python3 -I -c "
import cryptography, cffi, ssl, sqlite3, asyncio, importlib.metadata as m
from cryptography.hazmat.primitives.asymmetric import ec
ec.generate_private_key(ec.SECP256R1())
print('python', __import__('sys').version.split()[0], 'cryptography', cryptography.__version__, m.version('code-reviewer-runner'))
"
as_service /opt/code-reviewer/current/bin/factory-runner config show > /dev/null 2>&1 || true
if as_service sh -c 'touch /opt/code-reviewer/current/should-not-exist' 2> /dev/null; then fail "the service user can write into the program"; fi
jq -e --arg c "$commit" '.release == 1 and .commit == $c' /opt/code-reviewer/current/share/release.json > /dev/null || fail "release.json does not name release 1 and this commit"
jq . /opt/code-reviewer/current/share/release.json

echo "== update: release 2 is staged as a pair with newer VM artifacts, the switch runs the smoke test of the new release"
publish 2
uv run --no-project --python 3.13 --with cryptography python "$here/lane_vm.py" \
  --served "$work/served" --keyfile "$work/key.pem" --vm 11 --channels "$work/channels2" --base "https://localhost:$port/"
sudo factory-runner update | tee "$work/update.out"
grep -q "staged the program release 2" "$work/update.out" || fail "release 2 was not staged"
grep -q "staged the VM artifacts release 11" "$work/update.out" || fail "the VM artifacts release 11 was not staged with it"
grep -q '^pair=1$' /var/lib/code-reviewer/pending || fail "the two parts were not staged as a pair"
test "$(readlink /opt/code-reviewer/current)" = "releases/1" || fail "the update switched by itself"
sudo sh /opt/code-reviewer/current/libexec/host.sh switch
test "$(readlink /opt/code-reviewer/current)" = "releases/2" || fail "current is not release 2"
test "$(readlink /opt/code-reviewer/previous)" = "releases/1" || fail "previous is not release 1"
test "$(readlink /var/lib/code-reviewer/artifacts)" = "artifact-releases/11" || fail "the VM artifacts did not switch with the program"
as_service /opt/code-reviewer/current/bin/factory-runner --version | grep -q '^factory-runner 0\.' || fail "release 2 does not run"
sudo factory-runner status

echo "== rollback goes back and the release it left is not taken again"
sudo factory-runner rollback
sudo sh /opt/code-reviewer/current/libexec/host.sh switch
test "$(readlink /opt/code-reviewer/current)" = "releases/1" || fail "the rollback did not go back to release 1"
test "$(readlink /var/lib/code-reviewer/artifacts)" = "artifact-releases/10" || fail "the VM artifacts did not go back with the program"
sudo factory-runner update | tee "$work/update2.out"
grep -q "was rolled back" "$work/update2.out" || fail "the update took the release the rollback left"
test ! -e /var/lib/code-reviewer/pending || fail "a rolled back release is staged again"

echo "== uninstall leaves nothing behind"
sudo factory-runner uninstall
if sudo nft list table inet code_reviewer_wall 2> /dev/null; then fail "the table is still loaded"; fi
if getent passwd factory-runner > /dev/null; then fail "the user is left"; fi
for path in /opt/code-reviewer /var/lib/code-reviewer /var/lib/factory-runner /etc/code-reviewer /usr/local/bin/factory-runner; do
  test ! -e "$path" || fail "$path is left"
done
echo "LANE OK"
