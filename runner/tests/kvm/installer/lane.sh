#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The installer lane (#982): runner/install/install.sh on a REAL systemd, a REAL nft and real `ip tuntap`, as root on a GitHub runner, with a
# stand-in program (tests/kvm/installer/lane-runner.sh) and small signed releases served over https on the loopback (a throwaway CA, given to
# the installer's curl with --curl-config, as a protected release address would be reached). What the unit tests cannot know and this does:
#   - the unit loads under systemd (systemd-analyze verify) and every sandboxing option lets the service do what a dispatcher and its VMs do as the
#     service user: open /dev/kvm, attach to its TAP device, make a cgroup per VM with limits under its own delegated subtree, write vms/ and its home
#     and nothing else (the probe in lane_service.py, run INSIDE the unit);
#   - the outer wall table is loaded and listed, `prestart` makes the TAP and fails without the table;
#   - an update is staged by root, the service ends with exit code 10 between jobs, the start switches releases; a rollback goes back; a bad
#     signature is refused; the uninstall leaves nothing.
#   - the slots' network is the first one that overlaps no address of the machine (a dummy interface sits on the first candidate), and the
#     nft table and the TAP devices carry it;
#   - the pair is the program's own statement: an update takes the VM artifacts release the new program names (`share/release.json`), not the
#     newest one that exists, and a program whose VM release is not published is not taken;
#   - an update whose VM artifacts download slowly does not stop the service, a start or the status, and stages both parts as a pair; a failed
#     stage of the VM artifacts stages no program;
#   - a flushed ruleset while the service runs ends in a restart that loads the outer wall again (the root timer, within 40 s).
# No VM boots here (that is the launcher lane, which has the artifacts). Needs sudo, jq, zstd, nft, python3 and uv.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
work=$(mktemp -d)
port=8443
server=""

fail() { echo "LANE FAILED: $*" >&2; exit 1; }

report() {
  echo "---- journal of the service" >&2
  sudo journalctl -u factory-runner --no-pager -n 60 >&2 || true
  echo "---- state" >&2
  sudo ls -la /opt/code-reviewer /var/lib/code-reviewer /etc/code-reviewer 2>&1 | head -50 >&2 || true
  sudo cat /var/lib/code-reviewer/vms/lane-probe.json >&2 2>/dev/null || true
}
cleanup() {
  status=$?
  if [ "$status" != 0 ]; then report; fi
  [ -z "$server" ] || kill "$server" 2>/dev/null || true
  sudo ip link delete lane-ovl 2>/dev/null || true
  sudo sh "$repo/runner/install/install.sh" --uninstall >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

release() { # release PROGRAM VM [--tamper X]...
  (cd "$repo/runner" && uv run --no-project --python 3.13 --with cryptography python "$here/make_release.py" \
    --served "$work/served" --keyfile "$work/key.pem" --program "$1" --vm "$2" "${@:3}")
}

wait_for_release() { # the stand-in program of this release wrote its probe
  for _ in $(seq 1 90); do
    if [ "$(sudo jq -r .release /var/lib/code-reviewer/vms/lane-probe.json 2>/dev/null || true)" = "$1" ]; then return 0; fi
    sleep 1
  done
  fail "the service did not come up on release $1 within 90 s"
}

echo "== tools"
sudo apt-get install -y -qq nftables > /dev/null
sudo modprobe tun || true
ls -l /dev/kvm /dev/net/tun
getent group kvm

echo "== a throwaway CA and an https server on the loopback"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$work/server.key" -out "$work/ca.pem" -days 1 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
printf 'cacert = "%s"\n' "$work/ca.pem" > "$work/curlrc"
mkdir -p "$work/served" "$work/channels"
release 1 10 --channels "$work/channels" --base "https://localhost:$port/"
python3 "$here/serve.py" "$work/served" "$work/ca.pem" "$work/server.key" "$port" &
server=$!
sleep 1
curl --silent --fail --cacert "$work/ca.pem" "https://localhost:$port/runner-manifest.json" > /dev/null || fail "the https server does not answer"
printf 'crt_%s' "$(printf 'L%.0s' $(seq 1 43))" > "$work/token"

echo "== T01: without /dev/kvm the installer stops and changes nothing (a copy of the installer that looks for another device)"
sed "s#KVM=\"\$ROOT/dev/kvm\"#KVM=\"\$ROOT/dev/kvm-absent\"#" "$repo/runner/install/install.sh" > "$work/no-kvm.sh"
grep -q 'kvm-absent' "$work/no-kvm.sh" || fail "the installer's KVM path changed: update this lane"
if sudo sh "$work/no-kvm.sh" --program-channel-file "$work/channels/program-channel.json" --vm-channel-file "$work/channels/vm-channel.json" \
  --curl-config "$work/curlrc" --token-file "$work/token" 2> "$work/no-kvm.err"; then fail "an install without /dev/kvm succeeded"; fi
grep -q "NESTED VIRTUALIZATION" "$work/no-kvm.err" || fail "the message about nested virtualization is missing"
if [ -e /etc/code-reviewer ] || [ -e /opt/code-reviewer ] || getent passwd factory-runner > /dev/null; then fail "the stopped install changed the machine"; fi

echo "== the slots' network: a route that overlaps the first candidate makes the install take the next one"
sudo ip link add lane-ovl type dummy
sudo ip addr add 10.250.0.1/24 dev lane-ovl
sudo ip link set lane-ovl up
echo "== install (real systemd, nft, ip tuntap)"
sudo sh "$repo/runner/install/install.sh" --program-channel-file "$work/channels/program-channel.json" --vm-channel-file "$work/channels/vm-channel.json" \
  --curl-config "$work/curlrc" --token-file "$work/token" --labels lane --parallel-runs 2
sudo nft list table inet code_reviewer_wall > /dev/null
ip link show fctap0 > /dev/null && ip link show fctap1 > /dev/null
grep -q '^slot_network=10.251.0.0/24$' /etc/code-reviewer/install.state || fail "the install did not pick the network after the overlapping one"
grep -q '^FACTORY_RUNNER_SLOT_NETWORK=10.251.0.0/24$' /etc/code-reviewer/runner.env || fail "the network is not in the settings of the service"
ip -4 -o addr show dev fctap0 | grep -q '10.251.0.1/30' || fail "fctap0 has not the first address of the chosen network"
ip -4 -o addr show dev fctap1 | grep -q '10.251.0.5/30' || fail "fctap1 has not the second slot's address"
sudo nft list table inet code_reviewer_wall | grep -q '10.251.0.0/24' || fail "the nft table is not rendered for the chosen network"
if sudo nft list table inet code_reviewer_wall | grep -q '172.31'; then fail "the nft table still names 172.31"; fi
sudo ip link delete lane-ovl
systemctl show factory-runner -p After -p PartOf | tee "$work/unit-deps.txt"
grep -q 'nftables.service' "$work/unit-deps.txt" || fail "the unit does not follow nftables.service"
systemctl is-active --quiet factory-runner-wall.timer || fail "the wall timer is not running"
id factory-runner | grep -q kvm || fail "the service user is not in kvm"
systemd-analyze verify /etc/systemd/system/factory-runner.service 2>&1 | tee "$work/verify.txt" || true
if grep -Eiq "unknown (key|lvalue|assignment|section)|failed to parse|invalid|bad unit" "$work/verify.txt"; then fail "systemd does not accept the unit"; fi
test "$(stat -c '%U:%G %a' /var/lib/code-reviewer/artifacts/vmlinux)" = "root:root 644" || fail "the kernel is not root's and read-only"
test "$(stat -c '%a' /var/lib/code-reviewer/artifacts/)" = "755" || fail "the artifacts directory is not 0755"

echo "== the service runs under its sandbox and the probe inside it passes"
wait_for_release 1
sudo jq . /var/lib/code-reviewer/vms/lane-probe.json
bad=$(sudo jq -r '.checks | to_entries[] | select(.value != "ok") | "\(.key): \(.value)"' /var/lib/code-reviewer/vms/lane-probe.json)
[ -z "$bad" ] || fail "the unit's sandbox stops the service from doing: $bad"
systemctl is-active --quiet factory-runner
systemctl show factory-runner -p LimitNOFILE -p TasksMax -p Delegate
systemd-analyze security factory-runner --no-pager 2>&1 | tail -5 || true

echo "== the table is loaded again at every start, and listed before the service runs"
sudo systemctl stop factory-runner
sudo nft delete table inet code_reviewer_wall
if sudo nft list table inet code_reviewer_wall 2> /dev/null; then fail "the table was not deleted"; fi
sudo systemctl start factory-runner
wait_for_release 1
sudo nft list table inet code_reviewer_wall > /dev/null || fail "prestart did not load the table"

echo "== a TAP device a restart of the machine took is made again at the start"
sudo systemctl stop factory-runner
sudo ip link delete fctap1
sudo systemctl start factory-runner
wait_for_release 1
ip link show fctap1 > /dev/null || fail "prestart did not make fctap1"

echo "== update: staged by root, the service ends between jobs (exit 10), the start switches"
release 2 11 --channels "$work/channels2" --base "https://localhost:$port/"
sudo factory-runner update
test -f /var/lib/code-reviewer/pending || fail "no release is staged"
test "$(readlink /opt/code-reviewer/current)" = "releases/1" || fail "the update switched while the service ran"
wait_for_release 2
test "$(readlink /opt/code-reviewer/current)" = "releases/2" || fail "current is not release 2"
test "$(readlink /opt/code-reviewer/previous)" = "releases/1" || fail "previous is not release 1"
test "$(readlink /var/lib/code-reviewer/artifacts)" = "artifact-releases/11" || fail "the artifacts are not release 11"
sudo factory-runner status

echo "== rollback"
sudo factory-runner rollback --now
wait_for_release 1
test "$(readlink /opt/code-reviewer/current)" = "releases/1" || fail "the rollback did not go back"
sudo factory-runner update | tee "$work/update.out"
grep -q "was rolled back" "$work/update.out" || fail "the update took the release the rollback left"
test ! -e /var/lib/code-reviewer/pending

echo "== a bad signature is refused and the running release stays"
release 3 12 --tamper program-bad-signature
if sudo factory-runner update 2> "$work/bad.err"; then fail "an update with a bad signature was accepted"; fi
grep -q "signature of the program release manifest is not valid" "$work/bad.err" || fail "the refusal does not say why"
test "$(readlink /opt/code-reviewer/current)" = "releases/1"
test ! -e /var/lib/code-reviewer/pending

echo "== an update with a slow download of the VM artifacts does not stop the service, a start or a rollback"
release 4 13 --channels "$work/channels4" --base "https://localhost:$port/"
printf 25 > "$work/served/vm/13/vmlinux.slow"
# shellcheck disable=SC2024 # the file is the lane's own, made by the lane's user
sudo factory-runner update > "$work/slow-update.out" 2>&1 &
updater=$!
sleep 4
test ! -e /var/lib/code-reviewer/pending || fail "a release is staged before the download is over"
systemctl is-active --quiet factory-runner || fail "the service stopped while an update downloaded"
sudo flock -n /var/lib/code-reviewer/switch.lock true || fail "the switch lock is held across the download"
timeout 10 sudo factory-runner status > /dev/null || fail "the status waited for the download"
timeout 10 sudo sh /opt/code-reviewer/current/libexec/host.sh switch || fail "a start waited for the download"
wait "$updater" || { cat "$work/slow-update.out" >&2; fail "the slow update failed"; }
rm -f "$work/served/vm/13/vmlinux.slow"
grep -q '^pair=1$' /var/lib/code-reviewer/pending || fail "the two releases were not staged as a pair"
wait_for_release 4
test "$(readlink /var/lib/code-reviewer/artifacts)" = "artifact-releases/13" || fail "the artifacts are not release 13"

echo "== a failed stage of the VM artifacts switches nothing and stages no program"
release 5 14 --tamper vm-flip-kernel
if sudo factory-runner update 2> "$work/flip.err"; then fail "an update with a flipped kernel was accepted"; fi
test ! -e /var/lib/code-reviewer/pending || fail "a pair with a failed part is staged"
test ! -e /opt/code-reviewer/releases/5 || fail "the program of a failed pair is staged"
test "$(readlink /opt/code-reviewer/current)" = "releases/4"

echo "== the pair: the program names its VM artifacts release, a newer one that exists is not taken with it"
release 6 15 --also-vm 20 --channels "$work/channels6" --base "https://localhost:$port/"
sudo factory-runner update | tee "$work/pair.out"
grep -q "staged the VM artifacts release 15" "$work/pair.out" || fail "the VM artifacts release the program names were not staged"
grep -q '^vm=15$' /var/lib/code-reviewer/pending || fail "the pair is not the program's VM release"
test ! -e /var/lib/code-reviewer/artifact-releases/20 || fail "the newest VM release was taken though no program names it"
wait_for_release 6
test "$(readlink /var/lib/code-reviewer/artifacts)" = "artifact-releases/15" || fail "the artifacts are not release 15"

echo "== a program published before its VM artifacts is not taken, nothing is staged"
release 7 16 --without-vm
if sudo factory-runner update 2> "$work/early.err"; then fail "a program without its VM artifacts was accepted"; fi
grep -q "not taken" "$work/early.err" || fail "the refusal does not say that the program is not taken"
test ! -e /var/lib/code-reviewer/pending || fail "a program without its VM artifacts is staged"
test ! -e /opt/code-reviewer/releases/7 || fail "the program of a pair that is not there is staged"
test "$(readlink /opt/code-reviewer/current)" = "releases/6"
systemctl is-active --quiet factory-runner || fail "the service stopped"

echo "== the outer wall is checked while the service runs: a flushed ruleset ends in a restart that loads the table again"
before=$(systemctl show factory-runner -p InvocationID --value)
sudo nft flush ruleset
if sudo nft list table inet code_reviewer_wall 2> /dev/null; then fail "the ruleset was not flushed"; fi
back=0
for _ in $(seq 1 40); do
  if sudo nft list table inet code_reviewer_wall > /dev/null 2>&1 && [ "$(systemctl show factory-runner -p InvocationID --value)" != "$before" ]; then back=1; break; fi
  sleep 1
done
[ "$back" = 1 ] || fail "within 40 s the table was not loaded again and the service not restarted"
systemctl is-active --quiet factory-runner || fail "the service does not run after the wall came back"
sudo journalctl -u factory-runner-wall --no-pager -n 20 | grep -q "gone while the service runs" || fail "the check did not say why it restarted the service"
sudo sh /opt/code-reviewer/current/libexec/host.sh check-wall

echo "== uninstall leaves nothing behind"
sudo factory-runner uninstall
if sudo nft list table inet code_reviewer_wall 2> /dev/null; then fail "the table is still loaded"; fi
if ip link show fctap0 2> /dev/null; then fail "a TAP device is left"; fi
if getent passwd factory-runner > /dev/null; then fail "the user is left"; fi
for path in /opt/code-reviewer /var/lib/code-reviewer /var/lib/factory-runner /etc/code-reviewer /usr/local/bin/factory-runner \
  /etc/systemd/system/factory-runner.service /etc/systemd/system/factory-runner-update.service /etc/systemd/system/factory-runner-update.timer \
  /etc/systemd/system/factory-runner-wall.service /etc/systemd/system/factory-runner-wall.timer; do
  test ! -e "$path" || fail "$path is left"
done
echo "LANE OK"
