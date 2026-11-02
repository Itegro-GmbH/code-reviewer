// SPDX-License-Identifier: LicenseRef-Proprietary

// The scripts the golden snapshot pipeline runs in the VMs (#330), as pure functions of the configuration so
// that a test can read, syntax check and (the scan) run them. Every one starts with `set -euo pipefail`.
// Nothing here carries a secret: the VMs have none, and the only credential of the pipeline, the platform
// token, never leaves the process that calls the platform API.
import type { PipelineConfig } from "./config.ts";
import { probeRunArguments } from "./probe-flags.ts";

export { probeRunArguments };

/** The label of each command; the logs, the errors and the Sandbox double address a command by it. */
export const STEPS = {
  recordBaseManifest: "record_base_manifest",
  installDocker: "install_docker",
  installSysbox: "install_sysbox",
  writeDaemonConfig: "write_daemon_config",
  installHostScripts: "install_host_scripts",
  startDaemon: "start_daemon",
  buildImage: "build_image",
  inspectImage: "inspect_image",
  inspectAgentImage: "inspect_agent_image",
  cleanBuilder: "clean_builder",
  checkNoContainers: "check_no_containers",
  stopDaemon: "stop_daemon",
  scanFilesystem: "scan_filesystem",
  startDaemonCheck: "start_daemon_check",
  inspectRestoredImage: "inspect_restored_image",
  inspectRestoredAgentImage: "inspect_restored_agent_image",
  probe: "probe",
  sysboxProbe: "sysbox_probe",
} as const;

/** Where files go in the VMs. The staged ones share a prefix so one `rm` removes them. */
export const PATHS = {
  daemonJson: "/tmp/golden-daemon.json",
  vmPrepare: "/tmp/golden-vm-prepare.sh",
  context: "/tmp/golden-context.tgz",
  contextDir: "/tmp/golden-ctx",
  buildLog: "/tmp/golden-build.log",
  sysboxPrepare: "/tmp/golden-sysbox-prepare.sh",
  sysboxDeb: "/tmp/golden-sysbox.deb",
  vmPrepareInstalled: "/usr/local/sbin/vm-prepare.sh",
  sysboxPrepareInstalled: "/usr/local/sbin/sysbox-prepare.sh",
  // Outside every scan root and outside /tmp (which the clean step empties): it travels in the snapshot to the check VM.
  baseManifest: "/var/lib/code-reviewer-golden/base-manifest",
} as const;

/** Exit status of the scan when the base manifest is missing or empty: the scan cannot tell what the pipeline added. */
export const EXIT_MANIFEST_MISSING = 43;
/** Exit status of the record step when the roots hold no file at all. */
export const EXIT_MANIFEST_EMPTY = 44;
/** Exit status of the scan when it listed no file under the roots (the manifest is not empty, so a tool failed). */
export const EXIT_LISTING_EMPTY = 45;
/** Exit status of the scan when the file the pipeline wrote after the record is not among the added files. */
export const EXIT_ANCHOR_MISSING = 46;
/** Exit status of the scan when `find` or `grep` failed (anything but a match or no match). */
export const EXIT_TOOL_FAILED = 47;
/** Exit status of the scan when the manifest is not the one the pipeline pinned. */
export const EXIT_MANIFEST_MODIFIED = 48;
/** Exit status of the install step when the installed docker.io is not the pinned version. */
export const EXIT_VERSION_MISMATCH = 42;
/** Exit status of the Sysbox install when the downloaded package is not the pinned one. */
export const EXIT_SYSBOX_CHECKSUM = 41;
/** Exit status of the Sysbox install when the installed package or its runtime is not the pinned version. */
export const EXIT_SYSBOX_VERSION = 44;
export const SCAN_DONE = "SCAN_DONE";
/** What the Sysbox proof prints: one `SYSBOX_PROBE ok <check>` or `SYSBOX_PROBE fail <reason>` per check, and the marker last. */
export const SYSBOX_PROBE_DONE = "SYSBOX_PROBE_DONE";

const STRICT = "set -euo pipefail";

/** One shell word, whatever the value holds. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function installDockerScript(config: PipelineConfig): string {
  const { dockerVersion, buildxVersion } = config;
  return `${STRICT}
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ${shellQuote(`docker.io=${dockerVersion}*`)} ${shellQuote(`docker-buildx=${buildxVersion}*`)}
installed=$(dpkg-query -W -f='\${Version}' docker.io)
case "$installed" in
  ${dockerVersion}*) ;;
  *) echo "docker.io is not the pinned version" >&2; exit ${EXIT_VERSION_MISMATCH} ;;
esac
`;
}

/**
 * The daemon configuration. The `sysbox-runc` runtime is registered here and used by no container that does not name it: the
 * default stays `runc`, and a daemon with a runtime whose binary is missing starts all the same (measured), so a snapshot
 * whose Sysbox install was skipped still starts its daemon exactly as before. IPv6 is off (the Worker container turns it off too, and the reduced egress ruleset
 * of kernels with only the `ip` nf_tables family does not cover it) and the platform kernel has no IPv6 tables
 * to program. Nothing opens the daemon to the network: no `hosts`, no TLS, no registry exception.
 */
export function daemonConfigJson(): string {
  return `${JSON.stringify(
    {
      ipv6: false,
      ip6tables: false,
      "live-restore": false,
      runtimes: { "sysbox-runc": { path: "/usr/bin/sysbox-runc" } },
      "log-opts": { "max-size": "10m", "max-file": "2" },
    },
    null,
    2,
  )}\n`;
}

export function writeDaemonConfigScript(): string {
  return `${STRICT}
install -D -m 0644 -o root -g root ${PATHS.daemonJson} /etc/docker/daemon.json
`;
}

/**
 * vm-prepare.sh (docker/sandbox, #325) goes into the snapshot: the Launcher runs it on every VM start. sysbox-prepare.sh goes
 * with it and is run on the Implementer's VM only (and by the snapshot's own Sysbox proof).
 */
export function installHostScriptsScript(): string {
  return `${STRICT}
install -D -m 0755 -o root -g root ${PATHS.vmPrepare} ${PATHS.vmPrepareInstalled}
install -D -m 0755 -o root -g root ${PATHS.sysboxPrepare} ${PATHS.sysboxPrepareInstalled}
`;
}

/**
 * Installs the pinned Sysbox package. Downloaded from the project's release and refused unless it has the pinned checksum;
 * `kmod` is what the package's runtime needs and the base image lacks. The package's maintainer scripts call `systemctl` when
 * a running Docker needs a restart; the VM has no systemd, so a stub that does nothing is first on the PATH of this one command
 * and is not left in the snapshot. A failed install purges what it unpacked, so that the snapshot is without Sysbox and not
 * with a half-configured one. The package edits /etc/docker/daemon.json; the next step writes the pipeline's file over it.
 */
export function installSysboxScript(config: PipelineConfig): string {
  const { sysboxVersion, sysboxSha256 } = config;
  const url = `https://github.com/nestybox/sysbox/releases/download/v${sysboxVersion}/sysbox-ce_${sysboxVersion}.linux_amd64.deb`;
  return `${STRICT}
export DEBIAN_FRONTEND=noninteractive
deb=${PATHS.sysboxDeb}
stub=$(mktemp -d)
cleanup() {
  local status=$?
  rm -rf "$stub" "$deb"
  if [ "$status" -ne 0 ]; then dpkg --purge --force-all sysbox-ce > /dev/null 2>&1 || true; fi
}
trap cleanup EXIT
curl --fail --silent --show-error --location --retry 3 --max-time 180 --output "$deb" ${shellQuote(url)}
if ! printf '%s  %s\\n' ${shellQuote(sysboxSha256)} "$deb" | sha256sum --check --status -; then
  echo "the Sysbox package is not the pinned one" >&2
  exit ${EXIT_SYSBOX_CHECKSUM}
fi
printf '#!/bin/sh\\nexit 0\\n' > "$stub/systemctl"
chmod 0755 "$stub/systemctl"
PATH="$stub:$PATH" apt-get install -y -qq "$deb" kmod
installed=$(dpkg-query -W -f='\${Version}' sysbox-ce)
case "$installed" in
  ${sysboxVersion}*) ;;
  *) echo "sysbox-ce is not the pinned version" >&2; exit ${EXIT_SYSBOX_VERSION} ;;
esac
sysbox-runc --version > /dev/null
`;
}

/** The cgroup preparation and `dockerd`, exactly as the Launcher will start a VM (spike finding F1). */
export function startDaemonScript(): string {
  return `${STRICT}
${PATHS.vmPrepareInstalled}
`;
}

/** Builds the target from the commit's tarball. The build log is kept off the output; only its tail is shown on failure. */
export function buildImageScript(config: PipelineConfig): string {
  return `${STRICT}
rm -rf ${PATHS.contextDir}
mkdir -p ${PATHS.contextDir}
tar xzf ${PATHS.context} -C ${PATHS.contextDir}
cd ${PATHS.contextDir}
if ! DOCKER_BUILDKIT=1 docker build --file ${shellQuote(config.dockerfile)} --target ${shellQuote(config.target)} --tag ${shellQuote(config.imageTag)} . > ${PATHS.buildLog} 2>&1; then
  tail -n 40 ${PATHS.buildLog} >&2
  exit 1
fi
# The Implementer's agent image: the same Dockerfile, its other target. The stages both need are in the build cache.
if ! DOCKER_BUILDKIT=1 docker build --file ${shellQuote(config.dockerfile)} --target ${shellQuote(config.agentTarget)} --tag ${shellQuote(config.agentImageTag)} . >> ${PATHS.buildLog} 2>&1; then
  tail -n 40 ${PATHS.buildLog} >&2
  exit 1
fi
`;
}

export function inspectImageScript(config: PipelineConfig): string {
  return `${STRICT}
docker image inspect --format '{{.Id}}' ${shellQuote(config.imageTag)}
`;
}

export function inspectAgentImageScript(config: PipelineConfig): string {
  return `${STRICT}
docker image inspect --format '{{.Id}}' ${shellQuote(config.agentImageTag)}
`;
}

/** Leaves the image, drops the build cache and the staged files. */
export function cleanBuilderScript(): string {
  return `${STRICT}
docker builder prune -af > /dev/null
docker image prune -f > /dev/null
rm -rf /tmp/golden-*
apt-get clean
sync
`;
}

/** Prints the id of every container, running or not. */
export function checkNoContainersScript(): string {
  return `${STRICT}
docker ps -aq
`;
}

/** SIGTERM to the daemon, then waits until it, containerd and any shim are gone. Never SIGKILL. */
export function stopDaemonScript(): string {
  return `${STRICT}
pids=$(pgrep -x dockerd || true)
if [ -n "$pids" ]; then
  kill -TERM $pids
fi
for _ in $(seq 1 300); do
  if ! pgrep -x 'dockerd|containerd|containerd-shim' > /dev/null; then
    sync
    exit 0
  fi
  sleep 0.2
done
echo "the container engine is still running" >&2
exit 1
`;
}

/** The directories the pipeline's scan looks into: the record of the base image and the scan share them. */
export const SCAN_ROOTS = [
  "/root",
  "/home",
  "/etc",
  "/opt",
  "/usr/local",
  "/var/tmp",
  "/var/log",
] as const;
const DEFAULT_DOCKER_ROOT = "/var/lib/docker";
const SHA256_HEX = /^[0-9a-f]{64}$/;

// One file per record, NUL separated so that a name with a newline or a tab stays one record: path, size in
// bytes, modification time and status change time with their fractions. A user space tool can restore the
// modification time (`touch -r`, `cp -p`, tar) but not the status change time. The record script and the scan
// both print it, byte for byte alike.
const RECORD_FORMAT = "%p\\t%s\\t%T@\\t%C@\\0";

/**
 * The manifest of the platform's base image (first command of the builder, before anything is installed): the
 * files of the scan roots with their size, modification time and status change time, sorted. The scan reports only what is not in
 * it or differs from it, so the files the platform ships (the docs and bundles of its global Node packages hold
 * example keys and placeholder tokens) are not mistaken for something the pipeline left. A file that is new
 * (an apt package, a script of ours) or changed is not in it: it is scanned. Errors of `find` (a file that
 * vanishes at boot) are tolerated: a file missed here is only scanned later, never skipped. It prints
 * `MANIFEST_SHA256 <hex>` of the finished file: the pipeline keeps that hash outside the VM and the scan
 * refuses a manifest that does not match it.
 */
export function recordBaseManifestScript(
  options: { roots?: readonly string[]; manifestPath?: string } = {},
): string {
  const roots = options.roots ?? SCAN_ROOTS;
  const manifest = options.manifestPath ?? PATHS.baseManifest;
  return `${STRICT}
roots=(${roots.map(shellQuote).join(" ")})
manifest=${shellQuote(manifest)}
mkdir -p "$(dirname "$manifest")"
chmod 0700 "$(dirname "$manifest")"
for root in "\${roots[@]}"; do
  [ -d "$root" ] || continue
  find "$root" -xdev -type f -printf '${RECORD_FORMAT}' 2>/dev/null || true
done | LC_ALL=C sort -zu > "$manifest.tmp"
if [ ! -s "$manifest.tmp" ]; then
  rm -f "$manifest.tmp"
  echo "the base image has no file under the scan roots" >&2
  exit ${EXIT_MANIFEST_EMPTY}
fi
mv "$manifest.tmp" "$manifest"
chmod 0600 "$manifest"
sync
printf 'MANIFEST_SHA256 %s\\n' "$(sha256sum "$manifest" | cut -d ' ' -f 1)"
`;
}

// High-confidence shapes only: a false finding stops a release. The per-job credential of the Worker API, the
// tokens of the services the product talks to, and assignments of the variables that hold them.
const TOKEN_PATTERNS = [
  "gh[pousr]_[A-Za-z0-9]{36,}",
  "github_pat_[A-Za-z0-9_]{22,}",
  "sk-or-v1-[A-Za-z0-9]{16,}",
  "sk-ant-[A-Za-z0-9_-]{20,}",
  "AKIA[0-9A-Z]{16}",
  "xox[abprs]-[A-Za-z0-9-]{10,}",
  "crj_[A-Za-z0-9_-]{20,}",
  "_authToken=[^[:space:]]{8,}",
  "(RUNNER_TOKEN|VERCEL_TOKEN|VERCEL_OIDC_TOKEN|OPENROUTER_API_KEY|GITHUB_TOKEN|GH_TOKEN)=[^[:space:]]{8,}",
];
const PRIVATE_KEY_PATTERN = "-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----";

/**
 * The final scan of the restored snapshot: no secret and no job data. It prints `FINDING <kind> <path>` per
 * finding (never a content) and `SCAN_DONE` last; a caller that does not see the marker treats the scan as
 * failed. It reads files only: the daemon need not run. Kinds: secret_file, history, docker_auth,
 * private_key, token, job_data.
 *
 * The file checks cover what the pipeline added or changed since the base manifest (`recordBaseManifestScript`)
 * plus every file of Docker's `containers` and `volumes`. `job_data` is any entry of those two Docker
 * directories except the two artifacts `dockerd` creates in `volumes` at every start: `metadata.db` as a
 * regular file and `backingFsBlockDev` as a block device (a file, a directory or a link of that name is job data).
 *
 * Fail closed: the scan ends without its marker, with an exit status of its own, when the manifest is missing,
 * empty or not the pinned one, when `find` or `grep` fails (only a match and no match are answers), when it
 * lists no file, and when `anchorPath` (the file the pipeline wrote after the record: vm-prepare.sh) is not among
 * the added files, which is what an empty or failed listing looks like. Nothing in it ignores a tool's error.
 */
export function scanScript(
  options: {
    roots?: readonly string[];
    dockerRoot?: string;
    manifestPath?: string;
    /** sha256 the pipeline pinned when it recorded the manifest; the scan refuses a manifest that differs. */
    manifestSha256?: string;
    anchorPath?: string;
  } = {},
): string {
  const roots = options.roots ?? SCAN_ROOTS;
  const dockerRoot = options.dockerRoot ?? DEFAULT_DOCKER_ROOT;
  const manifest = options.manifestPath ?? PATHS.baseManifest;
  const anchor = options.anchorPath ?? PATHS.vmPrepareInstalled;
  if (
    options.manifestSha256 !== undefined &&
    !SHA256_HEX.test(options.manifestSha256)
  )
    throw new Error("manifestSha256 is not 64 hex digits");
  const tokenArgs = TOKEN_PATTERNS.map(
    (pattern) => `-e ${shellQuote(pattern)}`,
  ).join(" ");
  const pin =
    options.manifestSha256 === undefined
      ? ""
      : `if ! printf '%s  %s\\n' ${shellQuote(options.manifestSha256)} "$manifest" | sha256sum --check --status -; then
  echo "the base manifest is not the one the pipeline recorded" >&2
  exit ${EXIT_MANIFEST_MODIFIED}
fi
`;
  return `${STRICT}
roots=(${roots.map(shellQuote).join(" ")})
docker_root=${shellQuote(dockerRoot)}
manifest=${shellQuote(manifest)}
anchor=${shellQuote(anchor)}
report() { printf 'FINDING %s %s\\n' "$1" "$2"; }
fail() { echo "$2" >&2; exit "$1"; }
if [ ! -s "$manifest" ]; then
  fail ${EXIT_MANIFEST_MISSING} "the base manifest is missing or empty"
fi
${pin}work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# One batch of \`grep\` for xargs: the options, \`--\`, the files. Only a match (0) and no match (1) are answers. On
# any other status the files are asked one by one: a file that is gone by then was a temporary file of the
# platform's boot (listed, then renamed or removed) and holds nothing; an error on a file that is still there stops
# xargs at once (255, so 124), so that a failing tool never reads as "nothing found".
grep_batch() {
  local options=() file status=0
  while [ "$1" != "--" ]; do options+=("$1"); shift; done
  shift
  grep -IlZ "\${options[@]}" -- "$@" || status=$?
  if [ "$status" -le 1 ]; then return 0; fi
  for file in "$@"; do
    status=0
    grep -IlZ "\${options[@]}" -- "$file" || status=$?
    if [ "$status" -gt 1 ] && [ -e "$file" ]; then exit 255; fi
  done
}
export -f grep_batch
# \`grep_batch\` over the paths in $work/files; \`sort -u\` drops a hit that a batch and its retry both printed.
grep_files() {
  local kind=$1 status=0
  shift
  xargs -0 -r -a "$work/files" bash -c 'grep_batch "$@"' grep_batch "$@" -- > "$work/hits" || status=$?
  case "$status" in
    0|123) ;;
    *) fail ${EXIT_TOOL_FAILED} "grep failed (status $status)" ;;
  esac
  LC_ALL=C sort -zu "$work/hits" > "$work/hits.sorted"
  while IFS= read -r -d '' path; do report "$kind" "$path"; done < "$work/hits.sorted"
}
# The listing is asked up to three times: \`find\` ends with 1 when a file it walked past is gone by the time it
# looks at it, which happens while the VM boots. A listing that keeps failing fails the scan.
list_files() {
  local attempt
  for attempt in 1 2 3; do
    if for root in "\${roots[@]}"; do
      [ -d "$root" ] || continue
      find "$root" -xdev -type f -printf '${RECORD_FORMAT}'
    done | LC_ALL=C sort -zu > "$work/current"; then return 0; fi
    sleep 1
  done
  return 1
}
# The files of the roots now, in the manifest's format; the records that are not in the manifest are the new
# and the changed files. Their paths, and every file of Docker's own data, are what the checks read.
list_files || fail ${EXIT_TOOL_FAILED} "find or sort failed"
[ -s "$work/current" ] || fail ${EXIT_LISTING_EMPTY} "no file was listed under the scan roots"
LC_ALL=C comm -z -13 "$manifest" "$work/current" | sed -z 's/\\t[0-9]*\\t[0-9.]*\\t[0-9.]*$//' > "$work/files"
found=
while IFS= read -r -d '' path; do
  if [ "$path" = "$anchor" ]; then found=1; break; fi
done < "$work/files"
[ -n "$found" ] || fail ${EXIT_ANCHOR_MISSING} "the file the pipeline wrote is not among the added files"
for dir in "$docker_root/containers" "$docker_root/volumes"; do
  [ -d "$dir" ] || continue
  find "$dir" -xdev -type f -print0 >> "$work/files"
done
while IFS= read -r -d '' path; do
  name=\${path##*/}
  case "$name" in
    .env.example) ;;
    .env|.env.*|.netrc|.git-credentials|id_rsa|id_dsa|id_ecdsa|id_ed25519) report secret_file "$path" ;;
    .bash_history|.zsh_history|.python_history|.node_repl_history) report history "$path" ;;
  esac
  case "$path" in
    */.docker/config.json)
      status=0
      grep -qE '"(auth|identitytoken|registrytoken)"[[:space:]]*:[[:space:]]*"[^"]+"' "$path" || status=$?
      case "$status" in
        0) report docker_auth "$path" ;;
        1) ;;
        *) fail ${EXIT_TOOL_FAILED} "grep failed (status $status)" ;;
      esac ;;
  esac
done < "$work/files"
grep_files private_key --exclude=ssl-cert-snakeoil.key -E -e ${shellQuote(PRIVATE_KEY_PATTERN)}
grep_files token -E ${tokenArgs}
if [ -d "$docker_root/containers" ]; then
  find "$docker_root/containers" -mindepth 1 -maxdepth 1 -print0 > "$work/job_data"
  while IFS= read -r -d '' path; do report job_data "$path"; done < "$work/job_data"
fi
if [ -d "$docker_root/volumes" ]; then
  find "$docker_root/volumes" -mindepth 1 -maxdepth 1 ! \\( -name metadata.db -type f \\) ! \\( -name backingFsBlockDev -type b \\) -print0 > "$work/job_data"
  while IFS= read -r -d '' path; do report job_data "$path"; done < "$work/job_data"
fi
echo ${SCAN_DONE}
`;
}

/** Runs the image in `probe` mode (#324): one JSON line, the verdict. The timeout is a backstop. The flags are the renderer's. */
export function probeScript(config: PipelineConfig): string {
  return `${STRICT}
timeout 180 docker ${probeRunArguments(config).map(shellQuote).join(" ")}
`;
}

/** The port of the listener the Sysbox proof opens on the VM, and what it is reached from. */
const SYSBOX_PROBE_PORT = 38417;

/**
 * The proof that Sysbox works on this kernel, run in the check VM, as root, with the daemon up (`vm-prepare.sh`): the same
 * `sysbox-prepare.sh` a job VM runs, then a container with `--runtime=sysbox-runc` that starts its own `dockerd` and runs a
 * container of its own, on the network the Implementer's agent will have (`--internal` and `gateway_mode_ipv4=isolated`). From
 * inside it, the VM's addresses, the other network's bridge, an outside address and an outside name must all be unreachable.
 * A plain `--internal` network is the control: the VM's listener must be reachable from it, or a "blocked" would prove nothing
 * (`sysbox_network_check_inconclusive`). It is a connectivity check, not an attack test.
 *
 * It prints one `SYSBOX_PROBE ok <check>` or `SYSBOX_PROBE fail <reason>` per check and `SYSBOX_PROBE_DONE` last, and ends 0
 * whatever it found: the pipeline reads the lines. Reasons: the names of `sysbox-prepare.sh`, `sysbox_probe_image_unavailable`
 * (the pull failed: the proof did not run), `sysbox_container_failed`, `sysbox_inner_docker_failed`,
 * `sysbox_inner_container_failed`, `sysbox_network_check_inconclusive`, `sysbox_network_not_isolated`.
 */
export function sysboxProbeScript(config: PipelineConfig): string {
  const image = shellQuote(config.agentImageTag);
  return `set -uo pipefail
image=${image}
port=${SYSBOX_PROBE_PORT}
box=sbxp-box
iso=sbxp-isolated
ctl=sbxp-control
listener=
report() { printf 'SYSBOX_PROBE %s\\n' "$*"; }
cleanup() {
  docker rm -f "$box" > /dev/null 2>&1
  docker network rm "$iso" "$ctl" > /dev/null 2>&1
  if [ -n "$listener" ]; then kill "$listener" > /dev/null 2>&1; fi
}
finish() { cleanup; echo ${SYSBOX_PROBE_DONE}; exit 0; }
trap cleanup EXIT

if ! boot_error=$(${PATHS.sysboxPrepareInstalled} 2>&1 > /dev/null); then
  name=$(printf '%s' "$boot_error" | grep -o 'sysbox_[a-z_]*' | head -n 1)
  report "fail \${name:-sysbox_boot_failed}"
  finish
fi
report ok boot

# The image the Implementer ships is in the snapshot: nothing is pulled, so the proof does not depend on a registry.
if ! docker image inspect "$image" > /dev/null 2>&1; then
  report fail sysbox_probe_image_unavailable
  finish
fi

if ! docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated "$iso" > /dev/null 2>&1 ||
   ! docker network create --internal "$ctl" > /dev/null 2>&1; then
  report fail sysbox_network_create_failed
  finish
fi

# The agent's container as the Implementer starts it: the image's own init, which starts the inner Docker and says so.
if ! docker run --detach --runtime=sysbox-runc --network "$iso" --name "$box" "$image" > /dev/null 2>&1; then
  report fail sysbox_container_failed
  finish
fi
ready=
for _ in $(seq 1 300); do
  if docker exec "$box" test -e /run/agent-ready > /dev/null 2>&1 && docker exec "$box" docker info > /dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
if [ -z "$ready" ]; then
  report fail sysbox_inner_docker_failed
  finish
fi
report ok inner_docker

# The inner container's image is made from one static file of the container itself: nothing is pulled.
inner=$(docker exec "$box" sh -c 'tar -C / -cf - usr/local/bin/docker-init | docker import - sbxp-inner > /dev/null && docker run --rm --entrypoint /usr/local/bin/docker-init sbxp-inner --version' 2> /dev/null)
case "$inner" in
  *"tini version"*) report ok inner_container ;;
  *) report fail sysbox_inner_container_failed ;;
esac

# The control: a listener on the VM, reached from a plain --internal network through its bridge address.
python3 -c 'import socket, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", '$port'))
s.listen(16)
time.sleep(120)' > /dev/null 2>&1 &
listener=$!
sleep 0.5
control_gateway=$(docker network inspect "$ctl" --format '{{(index .IPAM.Config 0).Gateway}}' 2> /dev/null)
if [ -n "$control_gateway" ] && docker run --rm --network "$ctl" --entrypoint sh "$image" -c "nc -w 3 -z $control_gateway $port" > /dev/null 2>&1; then
  report ok network_control
else
  report fail sysbox_network_check_inconclusive
  finish
fi

# The outside targets get the same control: a plain container on the VM must reach them with the same tools, or a "blocked"
# from the isolated box could only mean "no way out from here" or "no nc / ping in the image".
outside_control() { docker run --rm --entrypoint sh "$image" -c "$1" > /dev/null 2>&1; }
if outside_control 'nc -w 3 -z 1.1.1.1 443' && outside_control 'ping -c 1 -W 3 example.com'; then
  report ok outside_control
else
  report fail sysbox_network_check_inconclusive
  finish
fi

# The isolated network: every address the VM has, the control network's bridge, an outside address and an outside name.
# A box that is gone makes every \`docker exec\` fail, which would read as "blocked": it must answer before and after.
box_alive() { docker exec "$box" true > /dev/null 2>&1; }
if ! box_alive; then
  report fail sysbox_network_check_inconclusive
  finish
fi
targets="$control_gateway $(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | tr '\\n' ' ')"
leaks=0
for target in $targets; do
  if docker exec "$box" sh -c "nc -w 3 -z $target $port" > /dev/null 2>&1; then leaks=$((leaks + 1)); fi
done
if docker exec "$box" sh -c 'nc -w 3 -z 1.1.1.1 443' > /dev/null 2>&1; then leaks=$((leaks + 1)); fi
if docker exec "$box" sh -c 'ping -c 1 -W 3 example.com' > /dev/null 2>&1; then leaks=$((leaks + 1)); fi
if [ "$leaks" -ne 0 ]; then
  report fail sysbox_network_not_isolated
elif ! box_alive; then
  report fail sysbox_network_check_inconclusive
else
  report ok network_isolated
fi
finish
`;
}
