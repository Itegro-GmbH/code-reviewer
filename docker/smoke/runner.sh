#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary

# Smoke test of the Worker image, the `sandbox` target of runner/Dockerfile and the only image of the project: the
# golden snapshot of the hosted deployment builds it and every review job runs it in a Vercel Sandbox VM.
# Usage: docker/smoke/runner.sh [<image>]   (default: code-reviewer-runner-sandbox:local)
#
# It proves that the image starts, runs unprivileged, can write to its temporary directory and holds nothing that
# must stay out of an image; that the pinned PR-Agent is installed and works offline (the version equals the pin, its
# tiktoken encodings are baked in, and a job run through the real PR-Agent with no network at all ends in a well
# formed failure result without a secret in it); that the engine is the pinned one, runs as its own user, and that
# the startup self-check advertises `opencode` exactly when it should (#202). The entry modes are proven with the
# flags of the hardened container spec (#324): `probe` prints a JSON verdict, `worker-once` runs one job against the
# fake App (Node) and `worker-reap` is on the PATH; the image carries no Dispatcher bundle. The toolchain of the
# Implementer's agent (#761) is proven here too: git 2.53 or newer, Node.js, pnpm, Python, uv, a compiler, jq and
# unzip at the pinned versions, the guard hook root-owned with no hooksPath baked in, the guard matrix passing as
# the engine user in the production layout, and the size of the image against the budget of the shared image. A real
# Dynamic review runs in the image with the production flags against fakes of GitHub, the App and the model.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$here/../.." && pwd)
# shellcheck source=docker/smoke/lib.sh
source "$here/lib.sh"

image=${1:-code-reviewer-runner-sandbox:local}
require_image "$image"

# Number of lines in a string (wc pads its output on macOS, hence tr).
line_count() { printf '%s\n' "$1" | wc -l | tr -d ' '; }

step "the entry point answers --version with the project version"
expected=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$repo_root/runner/pyproject.toml" | head -n 1)
[ -n "$expected" ] || fail "cannot read the version from runner/pyproject.toml"
output=$(docker run --rm "$image" --version)
[ "$output" = "code-reviewer-runner $expected" ] ||
  fail "expected 'code-reviewer-runner $expected', got '$output'"
printf '    %s\n' "$output"

# CR-29: a process that kills its jobs' process groups needs an init process that reaps the orphans.
step "the entry point starts with tini, so killed helpers do not stay as zombies"
entrypoint=$(docker inspect --format '{{json .Config.Entrypoint}}' "$image")
[[ "$entrypoint" == '["/usr/bin/tini","--","code-reviewer-runner"]' ]] ||
  fail "expected tini in front of the Worker, got $entrypoint"
# A job's helpers are killed with their process group and re-parented to PID 1; none may stay a zombie.
zombie_check='
import os, signal, subprocess, time
job = subprocess.Popen(["sh", "-c", "sleep 30 & sleep 30 & wait"], start_new_session=True)
time.sleep(0.5)
os.killpg(job.pid, signal.SIGKILL)
job.wait()
time.sleep(1)
zombies = [d for d in os.listdir("/proc") if d.isdigit()
           and open(f"/proc/{d}/stat").read().rsplit(")", 1)[1].split()[0] == "Z"]
print(len(zombies))
'
zombies=$(docker run --rm --entrypoint /usr/bin/tini "$image" -- python -c "$zombie_check")
[ "$zombies" = "0" ] || fail "$zombies zombie process(es) after ending a process group under tini"

# The entry point takes the mode as its argument; without one, or with an unknown one, it says so and stops.
step "the entry point refuses to start without a mode and does not echo an unknown one"
no_mode_errors=$(docker run --rm "$image" 2>&1) && status=0 || status=$?
[ "$status" = "2" ] || fail "the entry point without a mode must exit with 2, got $status"
grep -q "invalid arguments" <<<"$no_mode_errors" || fail "expected a refusal that names the usage, got: $no_mode_errors"
unknown_errors=$(docker run --rm "$image" smoke-secret-mode-0123456789 2>&1) && status=0 || status=$?
[ "$status" = "2" ] || fail "an unknown mode must exit with 2, got $status"
if grep -qF "smoke-secret-mode-0123456789" <<<"$unknown_errors"; then fail "the unknown mode is in the output"; fi

# CR-17-T06
step "the installed PR-Agent is the pinned version"
pinned=$(sed -n 's/^ *"pr-agent==\(.*\)",$/\1/p' "$repo_root/runner/pyproject.toml" | head -n 1)
[ -n "$pinned" ] || fail "cannot read the pr-agent pin from runner/pyproject.toml"
installed=$(in_image "$image" python -c "from importlib.metadata import version; print(version('pr-agent'))")
[ "$installed" = "$pinned" ] || fail "pr-agent $installed is installed, runner/pyproject.toml pins $pinned"
printf '    pr-agent %s\n' "$installed"

# CR-10-T03: the identity patch needs this private method; the runner refuses to start without it.
step "PR-Agent imports and still has the method the identity patch replaces"
in_image "$image" python -c "
from pr_agent.git_providers.github_provider import GithubProvider
assert callable(GithubProvider._resolve_user_login)" ||
  fail "PR-Agent does not import or has no GithubProvider._resolve_user_login"

step "the tiktoken encodings are baked into the image (no network needed)"
docker run --rm --network none --entrypoint python "$image" -c \
  "import tiktoken; tiktoken.get_encoding('o200k_base'); tiktoken.get_encoding('cl100k_base')" ||
  fail "tiktoken needs the network: the encodings are not cached in the image"

# CR-10-T04
step "the job entry point refuses an invalid job with one line of JSON"
refused=$(echo '{}' | docker run --rm -i --entrypoint code-reviewer-run-job "$image") && status=0 || status=$?
[ "$status" = "1" ] || fail "an invalid job must exit with 1, got $status"
[ "$(line_count "$refused")" = "1" ] || fail "an invalid job must give one line of output, got: $refused"
grep -q '"errorCode":"invalid_job"' <<<"$refused" || fail "expected invalid_job, got: $refused"

# CR-10-T07: real PR-Agent, no network. The pull request lives on an address nothing listens on, so
# the job fails while PR-Agent creates its GitHub client; the result must say so and carry no secret.
step "a job through the real PR-Agent without network fails cleanly and leaks nothing"
smoke_token="smoke-installation-token-0123456789"
smoke_key="smoke-openrouter-key-0123456789"
job='{"prUrl":"http://127.0.0.1:9/octo/repo/pull/7","command":"review","git":{"provider":"github","baseUrl":"http://127.0.0.1:9/api/v3","token":"'$smoke_token'","botLogin":"code-reviewer"},"llm":{"provider":"openrouter","model":"deepseek/deepseek-chat","apiKey":"'$smoke_key'","baseUrl":"http://127.0.0.1:9/api/v1","maxTokens":32000}}'
errors=$(mktemp)
result=$(docker run --rm -i --network none --entrypoint code-reviewer-run-job "$image" <<<"$job" 2>"$errors") && status=0 || status=$?
[ "$status" = "1" ] || fail "a job without network must exit with 1, got $status: $result"
[ "$(line_count "$result")" = "1" ] || fail "a job must give one line of output, got: $result"
grep -q '"ok":false' <<<"$result" && grep -q '"errorCode":"git_unavailable"' <<<"$result" ||
  fail "unexpected result for a job without network: $result"
if grep -qF -e "$smoke_token" -e "$smoke_key" <<<"$result" || grep -qF -e "$smoke_token" -e "$smoke_key" "$errors"; then
  fail "a secret of the job is in the output of the runner"
fi
rm -f "$errors"
printf '    %s\n' "$result"

# #202 (follow-up of #198): the Dynamic Review prompt files and the license notices are package data of
# the installed (non-editable) runner, so the image has them without the repository checkout.
step "the installed runner package carries the Dynamic Review prompts and the license notices"
in_image "$image" python -c "
from importlib.resources import files
package = files('code_reviewer_runner')
required = (
    'dynamic_review/review-skill.md',
    'dynamic_review/prompt_core.py',
    'licenses/LICENSE',
    'licenses/NOTICE',
    'licenses/THIRD_PARTY_LICENSES.md',
)
missing = [name for name in required if not package.joinpath(name).is_file()]
assert not missing, missing" ||
  fail "the installed runner package is missing a Dynamic Review prompt file or a license notice"

# CR-17-T07
step "the image sets a numeric non-root user"
assert_image_user_is_numeric_non_root "$image"

# #118-T03
step "the image ships the license files and carries the license label"
assert_image_ships_license_files "$image"

step "the process of the entry point runs as a non-root user"
# The entry point exits at once without a mode, so the same image user is asked from inside a container.
uid=$(in_image "$image" id -u)
[[ "$uid" =~ ^[0-9]+$ ]] && [ "$uid" != "0" ] || fail "a process in the image runs with uid '$uid'"
printf '    process uid: %s\n' "$uid"

# CR-17-T05 (partly): jobs work in the temporary directory and the home directory.
step "the unprivileged user can write to the temporary and home directories"
# shellcheck disable=SC2016 # $HOME must expand inside the container, not here
in_image "$image" sh -c 'touch /tmp/smoke-write && touch "$HOME/smoke-write"' ||
  fail "the unprivileged user cannot write to /tmp or its home directory"

# CR-17-T09
step "the image holds no environment files, git data, keys or secrets"
assert_image_has_no_secrets "$image" "/opt/venv/lib/python*/site-packages/code_reviewer_runner /home /root /tmp"
# Only our own package is checked for tests: third-party packages may ship a tests directory.
scan_in_image "$image" "0" sh -c \
  "find /opt/venv/lib/python*/site-packages/code_reviewer_runner /home -name tests -o -name 'test_*.py' -o -name '*_test.py' -o -name conftest.py"
[ -z "$SCAN_OUTPUT" ] || fail "tests are inside the image:
$SCAN_OUTPUT"
# shellcheck disable=SC2016 # $dir must expand inside the container, not here
scan_in_image "$image" "0" sh -c 'for dir in /build /src /tests; do [ ! -e "$dir" ] || echo "$dir"; done'
[ -z "$SCAN_OUTPUT" ] || fail "build directories are inside the image:
$SCAN_OUTPUT"

# ---- #202: what the image holds of the engine, and what the startup self-check says ----------------

# A file in a detached container, waited for until it exists. Fails with the log of the container.
# Usage: wait_for_file <container> <path> <seconds>
wait_for_file() {
  local container=$1 path=$2 seconds=$3 waited=0
  until docker exec "$container" test -f "$path" 2>/dev/null; do
    [ "$waited" -lt "$seconds" ] || {
      docker logs "$container" >&2 || true
      fail "$container did not write $path within ${seconds}s"
    }
    sleep 1
    waited=$((waited + 1))
  done
}

# ---- #324: the entry modes of the image -----------------------------------------------------------

# One field of the JSON verdict of `probe`, read on the host: <json text> <python expression of v>
json_value() {
  python3 -I -c 'import json, sys
v = json.loads(sys.argv[1])
print(eval(sys.argv[2]))' "$1" "$2"
}

# Runs `probe` in a container made with the given arguments and checks the verdict: exactly one line
# of JSON with the three keys, the expected engines, a reason that matches, and no value of the environment.
# Usage: assert_probe <engines> <reasons, an extended regex> <docker run arguments...>   (e.g. "pr-agent" "network_rules_not_installed")
probe_token="smoke-probe-token-0123456789-abcdef-0123456789"
assert_probe() {
  local engines=$1 reasons=$2 output status=0
  shift 2
  output=$(docker run --rm --network none --env RUNNER_TOKEN="$probe_token" "$@" "$image" probe 2>/dev/null) || status=$?
  [ "$status" = "0" ] || fail "probe exited with $status"
  [ "$(line_count "$output")" = "1" ] || fail "probe must print one line, got: $output"
  [ "$(json_value "$output" 'sorted(v)')" = "['engines', 'reasons', 'version']" ] || fail "unexpected probe keys: $output"
  [ "$(json_value "$output" '",".join(v["engines"])')" = "$engines" ] || fail "probe engines: expected '$engines', got: $output"
  [[ "$(json_value "$output" '",".join(v["reasons"])')" =~ ^($reasons)$ ]] || fail "probe reasons: expected '$reasons', got: $output"
  if grep -qF "$probe_token" <<<"$output"; then fail "a value of the environment is in the probe verdict"; fi
  printf '    %s\n' "$output"
}

step "probe on a container with the image's own settings advertises pr-agent only"
assert_probe pr-agent not_a_dynamic_runner

step "worker-reap is on the PATH and has nothing to do without an engine user"
docker run --rm --entrypoint worker-reap "$image" || fail "worker-reap failed in a container without an engine user"

step "the image sets no variable that enables Dynamic Review"
image_env=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image")
if grep -Eq '^(RUNNER_DYNAMIC|RUNNER_OPENCODE|RUNNER_ADVERTISED|RUNNER_DIFF_JOB_USER)' <<<"$image_env"; then
  fail "the image sets a Dynamic variable: $(grep -E '^RUNNER_' <<<"$image_env")"
fi

# ---- the engine ----------------------------------------------------------------------------------

# A value of a pin file, read on the host: <file> <key>...
pin_value() {
  python3 -I -c 'import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
for key in sys.argv[2:]:
    value = value[key]
print(value)' "$@"
}

opencode_pin="$repo_root/runner/opencode-pin.json"
ripgrep_pin="$repo_root/runner/ripgrep-pin.json"

# #202-T01: the exact pinned artifacts, root-owned and not writable by anyone else.
for tool in opencode:"$opencode_pin" rg:"$ripgrep_pin"; do
  name=${tool%%:*}
  pin=${tool#*:}
  step "$name in the image is the pinned executable, owned by root and not writable by others"
  expected_sha=$(pin_value "$pin" platforms linux-x64 executableSha256)
  expected_bytes=$(pin_value "$pin" platforms linux-x64 executableBytes)
  actual_sha=$(in_image "$image" sha256sum "/usr/local/bin/$name" | cut -d ' ' -f 1)
  [ "$actual_sha" = "$expected_sha" ] || fail "/usr/local/bin/$name has SHA-256 $actual_sha, the pin says $expected_sha"
  facts=$(in_image "$image" stat -c '%u:%g %a %s %F' "/usr/local/bin/$name")
  [ "$facts" = "0:0 755 $expected_bytes regular file" ] || fail "/usr/local/bin/$name is '$facts', expected '0:0 755 $expected_bytes regular file'"
  in_image "$image" cat "/opt/code-reviewer/pins/$(basename "$pin")" | cmp -s - "$pin" ||
    fail "the pin file in the image differs from $(basename "$pin")"
  printf '    %s  %s\n' "$actual_sha" "$name"
done

# #202-T01: offline, as the engine user, with no network at all.
step "opencode reports the pinned version as the engine user, offline"
pinned_version=$(pin_value "$opencode_pin" version)
reported=$(docker run --rm --network none --user 10101:10101 --env HOME=/tmp --env NO_COLOR=1 \
  --entrypoint /usr/local/bin/opencode "$image" --version) || fail "opencode --version failed as the engine user"
[ "$reported" = "$pinned_version" ] || fail "opencode reports '$reported', the pin says '$pinned_version'"
printf '    opencode %s\n' "$reported"

step "rg reports the pinned version"
rg_version=$(pin_value "$ripgrep_pin" version)
rg_output=$(docker run --rm --network none --user 10101:10101 --entrypoint /usr/local/bin/rg "$image" --version)
rg_reported=${rg_output%%$'\n'*}
[[ "$rg_reported" == "ripgrep $rg_version"* ]] || fail "rg reports '$rg_reported', the pin says $rg_version"

step "nft is installed"
in_image "$image" sh -c 'command -v nft >/dev/null || [ -x /usr/sbin/nft ]' || fail "nft is not installed in the image"

# #202-T01: nothing in the Dynamic image runs with more privilege than in its base image. The base
# image is the one runner/Dockerfile pins (its ARG), measured the same way, so the Debian packages the
# Dynamic target adds (nftables and its libraries) are held to the base image's own set of setuid and
# setgid files (the shadow and util-linux tools), not to a list typed here.
setuid_in_image() {
  docker run --rm --network none --user 0 --entrypoint find "$1" / -xdev -type f \
    \( -perm -4000 -o -perm -2000 \) | sort
}

step "the Dynamic image adds no setuid or setgid file to those of its base image"
base_image=$(sed -n 's/^ARG PYTHON_IMAGE=//p' "$repo_root/runner/Dockerfile")
[ -n "$base_image" ] || fail "no ARG PYTHON_IMAGE in runner/Dockerfile"
base_setuid=$(setuid_in_image "$base_image")
image_setuid=$(setuid_in_image "$image")
added_setuid=$(comm -13 <(printf '%s\n' "$base_setuid") <(printf '%s\n' "$image_setuid"))
[ -z "$added_setuid" ] || fail "the Dynamic image has added setuid or setgid files:
$added_setuid"
printf '    %s setuid or setgid files, all of them in the base image\n' "$(grep -c . <<<"$image_setuid" || true)"

step "the engine user 10101 exists with its own group, no shell and no other group; 10001 stays the Diff user"
[ "$(in_image "$image" id 10101)" = "uid=10101(engine) gid=10101(engine) groups=10101(engine)" ] ||
  fail "unexpected engine user: $(in_image "$image" id 10101)"
in_image "$image" getent passwd 10101 | grep -q ':/usr/sbin/nologin$' || fail "the engine user has a login shell"
[ "$(in_image "$image" id -u runner)" = "10001" ] || fail "the Diff job user is not 10001"

# #202-T01 / #195-T09: the startup self-check, run for real in a container created like the one
# Sandbox-Launcher creates (same user, capabilities, no-new-privileges), without any network.
dynamic_caps=(
  --user 0:0 --cap-drop ALL
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN --cap-add DAC_OVERRIDE
  --cap-add FOWNER --cap-add NET_ADMIN --cap-add SETPCAP
  --security-opt no-new-privileges:true
)
dynamic_env=(--env HOME=/home/runner --env RUNNER_DIFF_JOB_USER=10001:10001)
# #249: the root filesystem is read-only, and the only writable paths are three private tmpfs (the
# `readOnlyRoot` and `tmpfs` of contracts/worker-container.v1.json).
dynamic_rootfs=(
  --read-only
  --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777"
  --tmpfs "/run:rw,noexec,nosuid,nodev,size=1m,mode=0755"
  --tmpfs "/home/runner:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700"
)

# A Worker with the production flags that has done its startup (rules, end of NET_ADMIN, self-check) and now waits
# for its start document on stdin: its verdict is in the engines file on the /run tmpfs.
# Usage: start_worker <container> <docker run arguments...>   (the image and `worker-once` are added)
start_worker() {
  local name=$1
  shift
  CLEANUP_CONTAINERS+=("$name")
  docker run --detach --name "$name" --network none --interactive "$@" "$image" worker-once >/dev/null
}

# The engines the verdict of a started Worker names, read from its engines file.
worker_engines() {
  json_value "$(docker exec "$1" cat /run/code-reviewer-engines.json)" '",".join(v["engines"])'
}

step "the self-check of the Worker passes and opencode is advertised"
start_worker smoke-worker-capable "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}"
wait_for_file smoke-worker-capable /run/code-reviewer-engines.json 90
[ "$(worker_engines smoke-worker-capable)" = "pr-agent,opencode" ] || fail "the capable Worker did not advertise opencode"
[ "$(docker inspect --format '{{.State.Running}}' smoke-worker-capable)" = true ] || fail "the capable Worker stopped"

# #249-T01: what a compromised root supervisor can leave behind does not survive a restart. A root
# process inside the container cannot change the tools that run with NET_ADMIN at the next start, and
# what it writes into the three tmpfs is gone after the restart, which runs the self-check again.
step "a restart gives back the same clean container: tools unchanged, tmpfs empty, Docker's /etc files read-only, opencode advertised again"
tools_hash() { docker exec smoke-worker-capable sha256sum /usr/sbin/nft /usr/bin/tini; }
tools_before=$(tools_hash) || fail "cannot hash nft and tini"
docker exec smoke-worker-capable sh -c 'touch /tmp/planted /run/planted /home/runner/planted' ||
  fail "root cannot write to the tmpfs of the container"
# The three files Docker binds into /etc (hosts, hostname, resolv.conf) live in the host's container
# directory and would outlive a restart if root could write them. With `read_only` they are read-only
# too; a root that could append would be a persistence path, so it is checked, not assumed.
docker exec smoke-worker-capable sh -c 'for f in /etc/hosts /etc/hostname /etc/resolv.conf; do [ -f "$f" ] || exit 2; if cat /dev/null >> "$f"; then exit 1; fi; done' 2>/dev/null ||
  fail "root can write to /etc/hosts, /etc/hostname or /etc/resolv.conf, or one of them is missing"
# Exit status 0 only if both files exist and neither can be appended to (a missing path also fails).
docker exec smoke-worker-capable sh -c 'for f in /usr/sbin/nft /usr/bin/tini; do [ -f "$f" ] || exit 2; if cat /dev/null >> "$f"; then exit 1; fi; done' 2>/dev/null ||
  fail "root changed nft or tini on the root filesystem, or one of them is missing"
docker restart smoke-worker-capable >/dev/null
# The tmpfs is empty again after the restart, so the engines file is the Worker's new start.
wait_for_file smoke-worker-capable /run/code-reviewer-engines.json 90
[ "$(worker_engines smoke-worker-capable)" = "pr-agent,opencode" ] || fail "opencode was not advertised again after the restart"
docker exec smoke-worker-capable sh -c '[ ! -e /tmp/planted ] && [ ! -e /run/planted ] && [ ! -e /home/runner/planted ]' ||
  fail "a file written into a tmpfs survived the restart"
[ "$(tools_hash)" = "$tools_before" ] || fail "nft or tini differ after the restart"
docker rm --force smoke-worker-capable >/dev/null

# #249-T01 / T02: the layout, judged from inside a container created like the Sandbox-Launcher creates
# it, by the strongest process of a job: root with its capabilities (DAC_OVERRIDE, CHOWN, FOWNER).
readonly_check='
import errno, os, shutil, subprocess
import code_reviewer_runner

problems = []
paths = [
    shutil.which("nft"), shutil.which("tini"), "/usr/local/bin/opencode", "/usr/local/bin/rg",
    "/opt/code-reviewer/pins/opencode-pin.json", "/opt/code-reviewer/pins/ripgrep-pin.json",
    "/etc/passwd", "/opt/venv/bin/code-reviewer-runner", os.path.realpath(code_reviewer_runner.__file__),
]
for path in paths:
    if not path or not os.path.exists(path):
        problems.append(f"missing: {path}")
        continue
    directory = os.path.dirname(path)
    attempts = {
        "append": lambda: open(path, "ab").close(),
        "chmod": lambda: os.chmod(path, os.stat(path).st_mode),
        "unlink": lambda: os.unlink(path),
        "create next to it": lambda: os.close(os.open(directory + "/.planted", os.O_CREAT | os.O_WRONLY)),
    }
    for what, attempt in attempts.items():
        try:
            attempt()
        except OSError as error:
            if error.errno != errno.EROFS:
                problems.append(f"{path}: {what}: {error}")
        else:
            problems.append(f"{path}: {what} succeeded")
for directory in ("/", "/usr", "/usr/local/bin", "/opt", "/opt/venv", "/etc", "/var", "/home"):
    try:
        os.close(os.open(directory + "/.planted", os.O_CREAT | os.O_WRONLY))
    except OSError as error:
        if error.errno != errno.EROFS:
            problems.append(f"{directory}: create: {error}")
    else:
        problems.append(f"{directory}: create succeeded")

mounts = {}
for line in open("/proc/self/mountinfo"):
    before, _, after = line.partition(" - ")
    fields, rest = before.split(), after.split()
    mounts[fields[4]] = (set(fields[5].split(",")), rest[0], set(rest[2].split(",")))
if "ro" not in mounts["/"][0]:
    problems.append("the root filesystem is not mounted read-only")
# Every other writable mount is a tmpfs of ours or one of Docker itself: the pseudo filesystems, /dev
# and the masked paths under /proc. The files Docker binds into /etc are read-only with read_only.
pseudo = {"proc", "sysfs", "cgroup", "cgroup2", "devpts", "mqueue"}
writable = sorted(
    mountpoint for mountpoint, (options, fstype, _) in mounts.items()
    if "rw" in options and fstype not in pseudo and not mountpoint.startswith("/dev")
    and not mountpoint.startswith(("/proc/", "/sys/"))
)
if writable != ["/home/runner", "/run", "/tmp"]:
    problems.append(f"writable mounts: {writable}")
for mountpoint, owner, mode in (("/tmp", 0, 0o1777), ("/run", 0, 0o755), ("/home/runner", 10001, 0o700)):
    options, fstype, super_options = mounts[mountpoint]
    if fstype != "tmpfs" or not {"noexec", "nosuid", "nodev"} <= options:
        problems.append(f"{mountpoint}: {fstype} {sorted(options)}")
    if not any(option.startswith("size=") for option in super_options):
        problems.append(f"{mountpoint}: no size limit")
    facts = os.stat(mountpoint)
    if (facts.st_uid, facts.st_mode & 0o7777) != (owner, mode):
        problems.append(f"{mountpoint}: owner {facts.st_uid} mode {facts.st_mode & 0o7777:o}")
    path = mountpoint + "/written-by-root"
    with open(path, "w") as stream:
        stream.write("ok")
    os.chmod(path, 0o755)
    try:
        subprocess.run([path], check=False)
    except OSError as error:
        if error.errno != errno.EACCES:
            problems.append(f"{mountpoint}: exec: {error}")
    else:
        problems.append(f"{mountpoint}: a file written there could be executed")
    os.unlink(path)
print("\n".join(problems))
'
step "the root filesystem is read-only: root with its capabilities changes nothing outside the three tmpfs"
problems=$(docker run --rm --network none "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" --entrypoint python "$image" -c "$readonly_check") ||
  fail "the read-only check could not run: $problems"
[ -z "$problems" ] || fail "the root filesystem is not read-only as configured:
$problems"

# #249 (review of #259, minor 1): a Dynamic Worker serves Diff jobs as well. One job through the real
# PR-Agent, the way the Worker runs it (user 10001, HOME in the tmpfs, working directory in /tmp), in the
# read-only layout: a library or git that writes where nothing is writable fails here, not on the first
# real Diff job. The fake GitHub and LLM are the engine suite's, on the loopback of the host. The job
# writes nothing today (see the script); the step is the guard for a future dependency that does.
step "a Diff job through the real PR-Agent runs in the read-only layout, against the fake GitHub and LLM"
python3 -B "$here/diff_job_fakes.py" "$image" "${dynamic_rootfs[@]}" ||
  fail "a Diff job does not run in the read-only layout"

# #249-T01: the engine user (and the Diff job user) gain no write path from the layout. The paths a
# user can write in the container, with the settings of the hardened container spec, must be among those it
# can write in the same image without them.
writable_by() {
  local user=$1
  shift
  # find exits non-zero for the directories the user may not enter; only what it prints matters.
  { docker run --rm --network none --user "$user" --workdir / --cap-drop ALL \
    --security-opt no-new-privileges:true "$@" --entrypoint find "$image" / \
    \( -path /proc -o -path /sys \) -prune -o \( -type d -o -type f \) -writable -print 2>/dev/null || true; } | sort
}
for user in 10101:10101 10001:10001; do
  step "user $user can write nowhere that it could not before: the layout adds no write path"
  before=$(writable_by "$user")
  after=$(writable_by "$user" "${dynamic_rootfs[@]}")
  added=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))
  [ -z "$added" ] || fail "the read-only layout lets $user write in addition:
$added"
  printf '    %s\n' "$(tr '\n' ' ' <<<"$after")"
done
step "the engine user can write only in /tmp, besides Docker's own /dev mounts"
engine_writable=$(writable_by 10101:10101 "${dynamic_rootfs[@]}" | grep -vE '^/dev/(shm|mqueue)$' || true)
[ "$engine_writable" = "/tmp" ] || fail "the engine user can write in: $engine_writable"

# #202-T09: each broken prerequisite is "not advertised", with its stable reason, and the Worker
# still serves Diff jobs.
step "with an engine user that does not exist: not advertised"
assert_probe pr-agent engine_user_invalid \
  "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}" --env RUNNER_DYNAMIC_ENGINE_UID=10999 --env RUNNER_DYNAMIC_ENGINE_GID=10999

step "with an engine binary that is not the pinned one: not advertised"
replaced=$(mktemp)
extra_cleanup() { rm -f "$replaced"; }
printf '#!/bin/sh\necho 1.19.0\n' >"$replaced"
chmod 755 "$replaced"
assert_probe pr-agent 'engine_binary_(untrusted|checksum_mismatch)' \
  "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}" --volume "$replaced:/usr/local/bin/opencode:ro"

# ---- #324: probe and worker-once with the production flags ----------------------------------------

# #324-T04: a Worker with the image's own settings (user 10001, Diff only): one job against the fake
# App (Node, on the host; the container reaches it through the host gateway), exit codes 0 and 1.
step "worker-once runs one job against the fake App and exits with the job's outcome"
python3 -B "$here/worker_once_fake_app.py" "$image" || fail "worker-once did not run the job as expected"

# #324-T01: the same container as the capable Worker above, asked for its verdict.
step "probe with the production flags advertises opencode and names no reason"
assert_probe "pr-agent,opencode" "" "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}"

# #324-T02: each missing property is pr-agent only with its stable reason, and exit status 0 (the
# verdict is the answer). No value of the environment is in the verdict.
step "probe without NET_ADMIN: pr-agent only, network_rules_not_installed"
assert_probe pr-agent network_rules_not_installed \
  --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN \
  --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETPCAP --security-opt no-new-privileges:true \
  "${dynamic_rootfs[@]}" "${dynamic_env[@]}"

step "probe without SETPCAP: pr-agent only, capabilities_not_dropped"
assert_probe pr-agent capabilities_not_dropped \
  --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN \
  --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add NET_ADMIN --security-opt no-new-privileges:true \
  "${dynamic_rootfs[@]}" "${dynamic_env[@]}"

step "probe without nft: pr-agent only, network_rules_not_installed"
no_nft=$(mktemp)
extra_cleanup() { rm -f "$replaced" "$no_nft"; }
printf 'not an executable\n' >"$no_nft"
chmod 644 "$no_nft"
assert_probe pr-agent network_rules_not_installed \
  "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}" --volume "$no_nft:/usr/sbin/nft:ro"

step "probe with a writable root filesystem: pr-agent only, root_filesystem_writable"
# The tmpfs of the layout without its first element, `--read-only`.
writable_rootfs=("${dynamic_rootfs[@]:1}")
assert_probe pr-agent root_filesystem_writable \
  "${dynamic_caps[@]}" "${dynamic_env[@]}" "${writable_rootfs[@]}"

# #324-T04 / #324-T07: a Worker started like the hardened container spec starts it does the startup
# (rules, end of NET_ADMIN, self-check) before it reads its job, and delivers it.
step "worker-once with the production flags runs one job against the fake App"
python3 -B "$here/worker_once_fake_app.py" "$image" "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}" ||
  fail "worker-once with the production flags did not run the job as expected"

# #761 (review of #777): the canary and the steps above call `POST /probe` or run a stand-in job process; this one runs a
# real Dynamic review in the image with the production flags: the Worker claims it, prepares the pull request from a
# real Git repository over smart HTTP, starts the pinned OpenCode as its engine user behind the network rules, and publishes the review. The
# fakes share the Worker's loopback (the runner takes plain http for loopback only), see dynamic_job_fakes.py.
step "worker-once with the production flags runs a real Dynamic review: engine, preparation and publication"
python3 -B "$here/dynamic_job_fakes.py" "$image" "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}" ||
  fail "a Dynamic review did not run in the image"

step "the startup of the Worker leaves the verdict in a root-only file on the /run tmpfs"
start_worker smoke-worker-engines-file "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}"
wait_for_file smoke-worker-engines-file /run/code-reviewer-engines.json 90
[ "$(docker exec smoke-worker-engines-file stat -c '%u:%g %a' /run/code-reviewer-engines.json)" = "0:0 600" ] ||
  fail "the engines file is not owned by root with mode 600"
run_mounts=$(docker exec smoke-worker-engines-file cat /proc/self/mountinfo)
grep -Eq '^[0-9]+ [0-9]+ [0-9]+:[0-9]+ [^ ]+ /run .* - tmpfs ' <<<"$run_mounts" || fail "/run is not a tmpfs in the container"
[ "$(worker_engines smoke-worker-engines-file)" = "pr-agent,opencode" ] || fail "unexpected engines file"
docker rm --force smoke-worker-engines-file >/dev/null

# #324-T10: the sweep helper works in the hardened container (nothing of the engine user runs).
step "worker-reap in the hardened container finds nothing of the engine user to end"
docker run --rm --network none "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}" \
  --entrypoint worker-reap "$image" || fail "worker-reap failed in the hardened container"

# #324-T09: the Worker image carries nothing of a Dispatcher. Node.js is there since #761, as the pinned
# toolchain of the agent (checked below); only a Dispatcher bundle and a Node.js from the distribution are not.
step "the image carries no Dispatcher bundle and no Node.js other than the pinned one"
scan_in_image "$image" "0" sh -c 'for path in /opt/code-reviewer/dispatcher /usr/bin/node /usr/bin/nodejs; do [ ! -e "$path" ] || echo "$path"; done'
[ -z "$SCAN_OUTPUT" ] || fail "the image holds parts of a Dispatcher or a distribution Node.js:
$SCAN_OUTPUT"

# ---- #761: the toolchain of the Implementer's agent ----------------------------------------------------
git_pin="$repo_root/runner/git-pin.json"
node_pin="$repo_root/runner/node-pin.json"
pnpm_pin="$repo_root/runner/pnpm-pin.json"

# One command as the engine user, offline, with a writable HOME: <command> [args...]
as_engine() {
  docker run --rm --network none --user 10101:10101 --env HOME=/tmp --env NO_COLOR=1 --entrypoint "$1" "$image" "${@:2}"
}

# #761-T01
step "git is the pinned release, 2.53 or newer, and the only git of the image"
git_pinned=$(pin_value "$git_pin" version)
git_reported=$(as_engine git --version) || fail "git --version failed as the engine user"
[ "$git_reported" = "git version $git_pinned" ] || fail "git reports '$git_reported', the pin says '$git_pinned'"
[ "$(printf '%s\n%s\n' 2.53.0 "$git_pinned" | sort -V | head -n 1)" = 2.53.0 ] || fail "the pinned git $git_pinned is older than 2.53.0"
git_paths=$(in_image "$image" sh -c 'command -v git; ls /usr/bin/git 2>/dev/null; ls /usr/local/libexec/git-core/git-remote-https') || fail "git or its https helper is missing"
[ "$git_paths" = "$(printf '/usr/local/bin/git\n/usr/local/libexec/git-core/git-remote-https')" ] ||
  fail "unexpected git files (a distribution git, or no https helper):
$git_paths"
printf '    %s\n' "$git_reported"

# #761-T07: git is GPL-2.0-only, so OpenSSL 3 (Apache-2.0) must not be linked into a program of it. NO_OPENSSL keeps it out
# of `git-imap-send` itself, and the GnuTLS flavour of libcurl takes it out of the TLS of the https helper. What is left is
# libssh2 (scp and sftp inside libcurl, which Debian's own git has too) with its own link to libcrypto: a separate
# library of the system, not a link of git. So the direct dependencies of git's programs and the TLS of libcurl are judged.
step "no program of git links OpenSSL directly, and https goes through the GnuTLS libcurl"
needed=$(in_image "$image" sh -c 'for f in /usr/local/bin/git /usr/local/libexec/git-core/git-imap-send /usr/local/libexec/git-core/git-remote-https /lib/x86_64-linux-gnu/libcurl-gnutls.so.4; do readelf -d "$f"; done | grep NEEDED')
if grep -Eq 'libssl|libcrypto' <<<"$needed"; then
  fail "a program of git or its libcurl needs OpenSSL:
$(grep -E 'libssl|libcrypto' <<<"$needed")"
fi
grep -q 'libgnutls\.so' <<<"$needed" || fail "the libcurl of git does not use GnuTLS"
grep -q 'libcurl-gnutls\.so' <<<"$needed" || fail "git's https helper does not use the GnuTLS libcurl"

# #761-T02
step "node, pnpm, python3, uv, gcc, make, jq and unzip are there at the pinned versions"
node_pinned=$(pin_value "$node_pin" version)
[ "$(as_engine node --version)" = "v$node_pinned" ] || fail "node does not report v$node_pinned"
[ "$(as_engine node -e 'process.stdout.write(String(1 + 1))')" = 2 ] || fail "node does not run a script"
[ "$(as_engine pnpm --version)" = "$(pin_value "$pnpm_pin" version)" ] || fail "pnpm does not report the pinned version"
as_engine npm --version >/dev/null || fail "npm does not run"
[[ "$(as_engine python3 --version)" == "Python $(sed -n 's/^\([0-9]*\.[0-9]*\).*/\1/p' "$repo_root/runner/.python-version" | head -n 1)."* ]] ||
  fail "python3 is not the Python of .python-version"
uv_pinned=$(sed -n 's/^ARG UV_IMAGE=ghcr.io\/astral-sh\/uv:\([0-9.]*\)@.*/\1/p' "$repo_root/runner/Dockerfile")
[ "$(as_engine uv --version | cut -d ' ' -f 1,2)" = "uv $uv_pinned" ] || fail "uv does not report $uv_pinned"
for tool in gcc g++ make jq; do
  as_engine "$tool" --version >/dev/null || fail "$tool does not run as the engine user"
done
as_engine unzip -v >/dev/null || fail "unzip does not run as the engine user"
printf 'int main(void) { return 0; }\n' |
  docker run --rm -i --network none --user 10101:10101 --env HOME=/tmp --entrypoint gcc "$image" -x c - -o /dev/null ||
  fail "gcc cannot compile and link a program as the engine user"
printf '    node v%s, pnpm %s, uv %s\n' "$node_pinned" "$(pin_value "$pnpm_pin" version)" "$uv_pinned"

# #761-T02: the files the build verified against the pins are the files that are in the image, and nobody but
# root can change them.
step "the Node.js and pnpm files in the image are the pinned ones, owned by root and not writable by others"
node_sha=$(in_image "$image" sha256sum /opt/node/bin/node | cut -d ' ' -f 1)
[ "$node_sha" = "$(pin_value "$node_pin" platforms linux-x64 executableSha256)" ] || fail "/opt/node/bin/node is not the pinned executable"
pnpm_sha=$(in_image "$image" sha256sum /opt/pnpm/dist/pnpm.cjs | cut -d ' ' -f 1)
[ "$pnpm_sha" = "$(pin_value "$pnpm_pin" platforms linux-x64 executableSha256)" ] || fail "/opt/pnpm/dist/pnpm.cjs is not the pinned bundle"
scan_in_image "$image" "0" find /opt/node /opt/pnpm /usr/local/libexec/git-core /usr/local/bin /opt/code-reviewer \
  \( ! -user root -o -perm /022 \) ! -type l -print
[ -z "$SCAN_OUTPUT" ] || fail "toolchain files that are not root-owned or are writable by others:
$SCAN_OUTPUT"

# #761-T03
step "the guard hook is root-owned, mode 0755, not writable by the engine user, and no hooksPath is baked in"
facts=$(in_image "$image" stat -c '%n %u:%g %a' /opt/code-reviewer/guard /opt/code-reviewer/guard/reference-transaction /opt/code-reviewer/guard/guard_matrix.sh)
[ "$facts" = "$(printf '/opt/code-reviewer/guard 0:0 755\n/opt/code-reviewer/guard/reference-transaction 0:0 755\n/opt/code-reviewer/guard/guard_matrix.sh 0:0 755')" ] ||
  fail "unexpected owner or mode of the guard files:
$facts"
as_engine sh -c 'test ! -w /opt/code-reviewer/guard && test ! -w /opt/code-reviewer/guard/reference-transaction && ! touch /opt/code-reviewer/guard/x 2>/dev/null' ||
  fail "the engine user can write the guard directory or hook"
for user in 0 10101; do
  scope=$(docker run --rm --user "$user" --env HOME=/tmp --entrypoint git "$image" config --list --show-origin 2>/dev/null || true)
  [[ "$scope" != *hooksPath* ]] || fail "core.hooksPath is configured in the image for user $user:
$scope"
done
configs=$(in_image "$image" sh -c 'ls /etc/gitconfig /usr/local/etc/gitconfig /root/.gitconfig /root/.config/git/config /home/runner/.gitconfig 2>/dev/null || true')
[ -z "$configs" ] || fail "the image bakes in a git configuration file:
$configs"

# #761-T04: the matrix as the engine user, in the production layout (read-only root, noexec tmpfs, no capability).
step "the guard matrix passes as the engine user in the production layout"
matrix_out=$(docker run --rm --network none --user 10101:10101 --cap-drop ALL --security-opt no-new-privileges:true \
  "${dynamic_rootfs[@]}" --env HOME=/tmp --entrypoint /opt/code-reviewer/guard/guard_matrix.sh "$image") ||
  fail "the guard matrix failed in the image:
$matrix_out"
matrix_line=$(printf '%s\n' "$matrix_out" | grep -E '^guard matrix: ') || fail "the guard matrix printed no verdict"
[[ "$matrix_line" =~ ^guard\ matrix:\ ([0-9]+)\ passed,\ 0\ failed ]] || fail "the guard matrix has failures: $matrix_line"
[ "${BASH_REMATCH[1]}" -ge 28 ] || fail "the guard matrix ran only ${BASH_REMATCH[1]} actions"
printf '    %s\n' "$matrix_line"
# A matrix that cannot find the hook says so and fails (exit status 2); it never passes quietly.
status=0
docker run --rm --network none --user 10101:10101 --env HOME=/tmp --env GUARD_DIR=/nonexistent \
  --entrypoint /opt/code-reviewer/guard/guard_matrix.sh "$image" >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || fail "the guard matrix without a hook ended with status $status, expected 2"

# #761-T05: the image serves every kind of job, so the reviewer pays for what the Implementer needs. The growth is
# the sum of the layers above the layer of the pin files (the toolchain layer and what follows it), in bytes as
# `docker history` reports them (uncompressed). It is measured inside this one image, so it is the same under every
# image store and needs no baseline from another build. Above the budget the PR must propose a per-kind image.
GROWTH_BUDGET_BYTES=600000000
step "the toolchain layer grew the image by less than the budget of the shared Worker image"
history=$(docker history --human=false --no-trunc --format '{{.Size}} {{.CreatedBy}}' "$image")
image_bytes=$(printf '%s\n' "$history" | awk '{ total += $1 } END { printf "%d", total }')
growth=$(printf '%s\n' "$history" | awk '/ripgrep-pin.json \/opt\/code-reviewer\/pins/ { exit } { total += $1 } END { printf "%d", total }')
printf '%s\n' "$history" | awk '$1 > 1000000 { printf "    %6d MB  %s\n", $1 / 1000000, substr($0, index($0, " ") + 1, 90) }'
printf '    image %d MB (layers), the layers above the pins layer add %d MB, budget %d MB\n' \
  $((image_bytes / 1000000)) $((growth / 1000000)) $((GROWTH_BUDGET_BYTES / 1000000))
[ "$growth" -gt 100000000 ] || fail "the growth of $((growth / 1000000)) MB is implausibly small: is the pins layer still there?"
[ "$growth" -le "$GROWTH_BUDGET_BYTES" ] ||
  fail "the toolchain layer added $((growth / 1000000)) MB, above the budget of $((GROWTH_BUDGET_BYTES / 1000000)) MB: propose a per-kind image"

step "the image is labelled as the Worker image"
title=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.title"}}' "$image")
[[ "$title" == *Sandbox* ]] || fail "unexpected image title: $title"

step "Worker image smoke test passed"
