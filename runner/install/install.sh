#!/bin/sh
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Installs the Factory-Runner (#855, R2) on a Linux machine with Docker and systemd:
#
#   curl -fsSL https://raw.githubusercontent.com/Itegro-GmbH/code-reviewer/main/runner/install/install.sh \
#     | sudo FACTORY_RUNNER_TOKEN=crt_... sh
#
# or, with the token out of the environment and out of the shell history, from a file:
#
#   sudo sh install.sh --token-file /root/runner-token
#
# What it does, in this order: checks Docker and systemd; reads the release channel (the repository
# and the public key of the runner image, runner/release-channel.json), fetches the signed release
# manifest and VERIFIES its signature with `openssl`; pulls the image by the digest the manifest
# names and names it `factory-runner:current` (docs/runner.md, "Updates"); writes the systemd unit
# `factory-runner.service` and the command `factory-runner`; registers the machine with the token;
# starts the service. It is safe to run again: nothing is registered twice, a service that runs is
# not restarted (it switches to a new image by itself between jobs), a setting you pass is applied
# with `config set`. Sysbox is a separate step you ask for (`--sysbox`), with its warnings.
#
# The token is never an argument: it comes from --token-file FILE (`-` reads the standard input,
# which is the script itself under `curl | sh`: save the script first), from FACTORY_RUNNER_TOKEN,
# or is asked for on the terminal without echo.
#
# `--dry-run` says what would be done and changes nothing. FACTORY_RUNNER_ROOT puts the files of the
# installer below another directory, and FACTORY_RUNNER_NO_SYSTEMCTL=1 leaves systemctl alone (both
# are for the tests that run this script against stand-ins; not for a real machine).

set -eu

# -- pins ------------------------------------------------------------------------------------------
# Sysbox as the golden snapshot installs it (dispatcher/src/snapshot/config.ts).
SYSBOX_VERSION="0.7.1"
SYSBOX_SHA256="9d6d5484f980d0a17f86c492c1262015c2afb66280bdb97215b79fde6a0261c5"

# -- the release channel: where the signed manifest is and what proves it (runner/release-channel.json,
# the file the runner image carries; the owner fills it) ----------------------------------------------
CHANNEL_URL="https://raw.githubusercontent.com/Itegro-GmbH/code-reviewer/main/runner/release-channel.json"
CURRENT="factory-runner:current"
PREVIOUS="factory-runner:previous"

ROOT="${FACTORY_RUNNER_ROOT:-}"
SYSTEMCTL=1
if [ "${FACTORY_RUNNER_NO_SYSTEMCTL:-}" = 1 ]; then SYSTEMCTL=0; fi
UNIT="$ROOT/etc/systemd/system/factory-runner.service"
COMMAND="$ROOT/usr/local/bin/factory-runner"

DRY_RUN=0
ASSUME_YES=0
WITH_SYSBOX=0
UNINSTALL=0
PURGE=0
TOKEN_FILE=""
CHANNEL_FILE=""
RUNNER_NAME=""
RUNNER_LABELS=""
RUNNER_URL=""
RUNNER_CPUS=""
RUNNER_MEMORY=""
RUNNER_DISK=""

# Temporary directories, removed when the script ends however it ends.
TMPDIRS=""
# shellcheck disable=SC2086 # mktemp paths hold no space
trap 'rm -rf $TMPDIRS' EXIT

say() { printf '%s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sh install.sh [options]
  --token-file FILE   registration token from a file (- = standard input); else FACTORY_RUNNER_TOKEN,
                      else asked on the terminal. Never an argument.
  --name NAME         the name in the list of runners (default: the host name)
  --labels a,b        labels the runner announces (e.g. linux,gpu)
  --url URL           the app (default: https://code-review.com)
  --cpus N            CPUs the agent's and the setup container may use
  --memory-mb N       memory of the agent's and the setup container
  --disk-gb N         the disk budget of a job (/work and its containers)
  --channel-file F    read the release channel from this file instead of downloading runner/release-channel.json
  --sysbox            also install Sysbox (asks first; see the warnings it prints)
  --yes               accept the Sysbox warnings without asking
  --dry-run           say what would be done, change nothing
  --uninstall         remove the service and the command (--purge: also the configuration and /work)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token-file) [ $# -ge 2 ] || fail "--token-file needs a file"; TOKEN_FILE="$2"; shift 2 ;;
    --name) [ $# -ge 2 ] || fail "--name needs a value"; RUNNER_NAME="$2"; shift 2 ;;
    --labels) [ $# -ge 2 ] || fail "--labels needs a value"; RUNNER_LABELS="$2"; shift 2 ;;
    --url) [ $# -ge 2 ] || fail "--url needs a value"; RUNNER_URL="$2"; shift 2 ;;
    --cpus) [ $# -ge 2 ] || fail "--cpus needs a value"; RUNNER_CPUS="$2"; shift 2 ;;
    --memory-mb) [ $# -ge 2 ] || fail "--memory-mb needs a value"; RUNNER_MEMORY="$2"; shift 2 ;;
    --disk-gb) [ $# -ge 2 ] || fail "--disk-gb needs a value"; RUNNER_DISK="$2"; shift 2 ;;
    --channel-file) [ $# -ge 2 ] || fail "--channel-file needs a file"; CHANNEL_FILE="$2"; shift 2 ;;
    --sysbox) WITH_SYSBOX=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --token|--token=*) fail "a token is never an argument (it would be in the process list and the shell history): use --token-file, FACTORY_RUNNER_TOKEN or the prompt" ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

# Every change goes through `act`: with --dry-run it is only said.
act() {
  if [ "$DRY_RUN" = 1 ]; then
    say "would run: $*"
  else
    "$@"
  fi
}

# -- checks ------------------------------------------------------------------------------------------

preflight() {
  [ "$(uname -s)" = "Linux" ] || fail "Linux only (this is $(uname -s))"
  [ "$(uname -m)" = "x86_64" ] || fail "x86_64 only for now (this is $(uname -m))"
  if [ "$(id -u)" != 0 ]; then
    fail "run as root: sudo sh install.sh"
  fi
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed (the engine, not rootless: https://docs.docker.com/engine/install/)"
  docker info >/dev/null 2>&1 || fail "the Docker daemon does not answer (is it running, and are you root?)"
  case "$(docker info --format '{{.SecurityOptions}}' 2>/dev/null)" in
    *rootless*) fail "rootless Docker is not supported: the runner needs the engine's socket" ;;
  esac
  [ -d "$ROOT/run/systemd/system" ] || fail "systemd is not the init of this machine (/run/systemd/system is missing)"
  command -v systemctl >/dev/null 2>&1 || fail "systemctl is not available"
  command -v curl >/dev/null 2>&1 || fail "curl is not installed"
  command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is not installed"
  command -v openssl >/dev/null 2>&1 || fail "openssl is not installed (it checks the signature of the release)"
  command -v base64 >/dev/null 2>&1 || fail "base64 is not installed"
}

# -- the release channel and the proof -------------------------------------------------------------------

# The value of a string key of a flat JSON file (the channel and the manifest hold no escapes).
json_value() { # json_value KEY FILE
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$2" | head -n 1
}

json_number() { # json_number KEY FILE
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$2" | head -n 1
}

# Download the channel and the signed manifest, prove the manifest, and name the image it announces
# `current`. The image is pulled by the digest the verified manifest names: nothing unproven is pulled.
stage_image() {
  work="$(mktemp -d)"
  TMPDIRS="$TMPDIRS $work"
  channel="$CHANNEL_FILE"
  if [ -z "$channel" ]; then
    channel="$work/release-channel.json"
    curl -fsSL -o "$channel" "$CHANNEL_URL" || fail "the release channel could not be downloaded"
  fi
  [ -r "$channel" ] || fail "the release channel file cannot be read"
  repository="$(json_value repository "$channel")"
  manifest_url="$(json_value manifestUrl "$channel")"
  signature_url="$(json_value signatureUrl "$channel")"
  public_key="$(json_value publicKey "$channel")"
  if [ -z "$repository" ] || [ -z "$manifest_url" ] || [ -z "$signature_url" ] || [ -z "$public_key" ]; then
    fail "no runner image is published yet: the release channel (runner/release-channel.json) is empty until the owner fills it"
  fi
  case "$manifest_url$signature_url" in
    https://*https://*) ;;
    *) fail "the release channel must name https addresses" ;;
  esac
  say "reading the release manifest"
  if [ "$DRY_RUN" = 1 ]; then
    say "would run: download the manifest and its signature, verify them with openssl, docker pull $repository@<digest>, docker tag ... $CURRENT"
    return
  fi
  curl -fsSL -o "$work/manifest.json" "$manifest_url" || fail "the release manifest could not be downloaded"
  curl -fsSL -o "$work/manifest.sig" "$signature_url" || fail "the signature could not be downloaded"
  printf '%s' "$public_key" | base64 -d >"$work/key.der" 2>/dev/null || fail "the public key of the channel cannot be read"
  openssl pkey -pubin -inform DER -in "$work/key.der" -out "$work/key.pem" >/dev/null 2>&1 \
    || fail "the public key of the channel cannot be read"
  openssl dgst -sha256 -verify "$work/key.pem" -signature "$work/manifest.sig" "$work/manifest.json" >/dev/null 2>&1 \
    || fail "the signature of the release manifest is not valid: this is not our release, nothing was installed"
  digest="$(json_value digest "$work/manifest.json")"
  release="$(json_number release "$work/manifest.json")"
  [ "$(json_value repository "$work/manifest.json")" = "$repository" ] || fail "the manifest is not one of this channel"
  case "$digest" in
    sha256:????????????????????????????????????????????????????????????????) ;;
    *) fail "the manifest has no digest" ;;
  esac
  [ -n "$release" ] || fail "the manifest has no release number"
  say "pulling $repository@$digest (release $release)"
  docker pull -q "$repository@$digest" >/dev/null || fail "the image could not be pulled"
  label="$(docker image inspect --format '{{index .Config.Labels "code-reviewer.runner.release"}}' "$repository@$digest")"
  if [ "$label" != "$release" ]; then
    docker rmi "$repository@$digest" >/dev/null 2>&1 || true
    fail "the image is not the release its manifest names: nothing was installed"
  fi
  if docker image inspect "$CURRENT" >/dev/null 2>&1; then
    docker tag "$CURRENT" "$PREVIOUS"
  fi
  docker tag "$repository@$digest" "$CURRENT"
  say "verified release $release ($digest)"
}

# -- the command and the unit ------------------------------------------------------------------------------

write_file() { # write_file PATH MODE  (content on stdin); sets CHANGED=1 when the file differs
  target="$1"
  mode="$2"
  content="$(cat)"
  if [ -f "$target" ] && [ "$(cat "$target")" = "$content" ]; then
    return
  fi
  CHANGED=1
  if [ "$DRY_RUN" = 1 ]; then
    say "would write $target"
    return
  fi
  mkdir -p "$(dirname "$target")"
  printf '%s\n' "$content" >"$target.new"
  chmod "$mode" "$target.new"
  mv "$target.new" "$target"
  say "wrote $target"
}

write_command() {
  docker_bin="$(command -v docker)"
  write_file "$COMMAND" 0755 <<EOF
#!/bin/sh
# The command of the Factory-Runner: runs in a throwaway container of the image the service runs.
# Written by install.sh; the configuration is the volume factory-runner-home.
tty=""
[ -t 0 ] && [ -t 1 ] && tty="-t"
exec $docker_bin run --rm -i \$tty \\
  -v /var/run/docker.sock:/run/docker.sock \\
  -v factory-runner-home:/var/lib/factory-runner \\
  -v factory-runner-work:/work \\
  $CURRENT "\$@"
EOF
}

write_unit() {
  docker_bin="$(command -v docker)"
  write_file "$UNIT" 0644 <<EOF
[Unit]
Description=Factory-Runner (Code Reviewer)
Documentation=https://github.com/Itegro-GmbH/code-reviewer/blob/main/docs/runner.md
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
# The runner ends with exit code 10 when it switched to an updated image between two jobs: this
# starts it again, from the image behind $CURRENT. 4 (revoked), 6 (configuration) and 9 (another
# runner on this daemon) are not made better by a restart.
Restart=always
RestartSec=10
RestartPreventExitStatus=4 6 9
# --stop-timeout 150: a job in progress is given back to the queue and wound down (up to 130 s).
TimeoutStopSec=170
ExecStartPre=-$docker_bin rm -f factory-runner
ExecStart=$docker_bin run --rm --name factory-runner --stop-timeout 150 \\
  -e FACTORY_RUNNER_IMAGE_TAG=$CURRENT \\
  -v /var/run/docker.sock:/run/docker.sock \\
  -v factory-runner-home:/var/lib/factory-runner \\
  -v factory-runner-work:/work \\
  $CURRENT run
ExecStop=$docker_bin stop --time 150 factory-runner

[Install]
WantedBy=multi-user.target
EOF
}

# -- registration ----------------------------------------------------------------------------------------------

runner_cli() { # runner_cli ARGS...: the command in a throwaway container (stdin passed on)
  docker run --rm -i -v /var/run/docker.sock:/run/docker.sock -v factory-runner-home:/var/lib/factory-runner \
    -v factory-runner-work:/work "$CURRENT" "$@"
}

is_registered() {
  # A dry run has not pulled the image: it cannot ask it.
  if [ "$DRY_RUN" = 1 ] && [ -z "$(docker images -q "$CURRENT" 2>/dev/null)" ]; then
    return 1
  fi
  runner_cli credential show </dev/null 2>/dev/null | grep -q '^credential: set'
}

# A terminal to ask on. `[ -r /dev/tty ]` is true without one (the file exists); only opening it tells.
have_tty() { (exec </dev/tty) 2>/dev/null; }

read_token() { # prints the token, or nothing
  if [ -n "$TOKEN_FILE" ]; then
    if [ "$TOKEN_FILE" = "-" ]; then cat; else cat "$TOKEN_FILE"; fi
  elif [ -n "${FACTORY_RUNNER_TOKEN:-}" ]; then
    printf '%s' "$FACTORY_RUNNER_TOKEN"
  elif [ "$DRY_RUN" != 1 ] && have_tty; then
    printf 'Registration token (from the app: Runners, "Add a runner"; input is hidden): ' >/dev/tty
    stty -echo </dev/tty 2>/dev/null || true
    IFS= read -r line </dev/tty || line=""
    stty echo </dev/tty 2>/dev/null || true
    printf '\n' >/dev/tty
    printf '%s' "$line"
  fi
}

register_or_configure() {
  # The settings as arguments, one word each (a name may hold a space).
  set --
  if [ -n "$RUNNER_NAME" ]; then set -- "$@" --name "$RUNNER_NAME"; fi
  if [ -n "$RUNNER_LABELS" ]; then set -- "$@" --labels "$RUNNER_LABELS"; fi
  if [ -n "$RUNNER_CPUS" ]; then set -- "$@" --cpus "$RUNNER_CPUS"; fi
  if [ -n "$RUNNER_MEMORY" ]; then set -- "$@" --memory-mb "$RUNNER_MEMORY"; fi
  if [ -n "$RUNNER_DISK" ]; then set -- "$@" --disk-gb "$RUNNER_DISK"; fi
  if is_registered; then
    say "this machine is registered already: the token (if any) is not used"
    if [ $# -gt 0 ]; then
      act runner_cli config set "$@"
      say "the settings are saved; the running service reads them when it starts"
    fi
    return 0
  fi
  token="$(read_token || true)"
  if [ -z "$token" ]; then
    say "no registration token: the service is installed but not started."
    say "register it, then start it:  factory-runner register --token-file FILE ...  &&  systemctl enable --now factory-runner"
    NO_TOKEN=1
    return 0
  fi
  if ! printf '%s' "$token" | grep -Eq '^crt_[A-Za-z0-9_-]{43}$'; then
    fail "the registration token does not have the form of a token (crt_...)"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "would run: factory-runner register (the token on the standard input)"
    return 0
  fi
  if [ -n "$RUNNER_URL" ]; then set -- "$@" --url "$RUNNER_URL"; fi
  # The token goes in on the standard input of the container: no argument, no environment.
  printf '%s' "$token" | runner_cli register --token-file - "$@"
}

# -- sysbox (a step of its own) --------------------------------------------------------------------------------

install_sysbox() {
  say ""
  say "Sysbox: what this step does to this machine"
  say "  - it installs the package sysbox-ce $SYSBOX_VERSION (pinned, checked against its SHA-256),"
  say "  - the package REWRITES /etc/docker/daemon.json: the sysbox-runc runtime, bip 172.20.0.1/16 and"
  say "    default-address-pools 172.25.0.0/16: the network ranges of your containers can change,"
  say "  - it RESTARTS Docker when no container is running (so none may be),"
  say "  - it needs jq and systemctl, and runs the daemons sysbox-mgr and sysbox-fs as services,"
  say "  - it is tested on Ubuntu 22.04/24.04 (officially supported); 26.04 was tested, not supported."
  say "  What you get: the agent can run its own Docker (the capability agent-docker)."
  say "  Without it the runner works, the agent just has no Docker of its own."
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}-${VERSION_ID:-}" in
      ubuntu-22.04|ubuntu-24.04) ;;
      *) say "  This is ${PRETTY_NAME:-an unknown distribution}: not a supported one." ;;
    esac
  fi
  command -v jq >/dev/null 2>&1 || fail "Sysbox needs jq (apt-get install jq)"
  command -v apt-get >/dev/null 2>&1 || fail "this step installs a .deb with apt-get: this machine has none"
  if [ -n "$(docker ps -q)" ]; then
    fail "containers are running and the Sysbox package restarts Docker: stop them (systemctl stop factory-runner) and run this step again"
  fi
  if [ "$ASSUME_YES" != 1 ]; then
    if [ "$DRY_RUN" = 1 ]; then
      say "would ask for confirmation"
      return 0
    fi
    have_tty || fail "no terminal to ask on: pass --yes after reading the warnings above"
    printf 'Install Sysbox? Type "yes": ' >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    [ "$answer" = "yes" ] || fail "Sysbox was not installed"
  fi
  package="sysbox-ce_$SYSBOX_VERSION.linux_amd64.deb"
  if [ "$DRY_RUN" = 1 ]; then
    say "would run: download $package, check its SHA-256, apt-get install it"
    return
  fi
  work="$(mktemp -d)"
  TMPDIRS="$TMPDIRS $work"
  curl -fsSL -o "$work/$package" "https://github.com/nestybox/sysbox/releases/download/v$SYSBOX_VERSION/$package" \
    || fail "the Sysbox package could not be downloaded"
  [ "$(sha256sum "$work/$package" | cut -d' ' -f1)" = "$SYSBOX_SHA256" ] \
    || fail "the downloaded package is not the pinned one: nothing was installed"
  apt-get install -y "$work/$package"
  docker info --format '{{json .Runtimes}}' | grep -q sysbox-runc \
    || fail "Sysbox is installed but Docker does not list the sysbox-runc runtime: restart Docker"
  say "Sysbox is installed. Restart the runner so that it uses it: systemctl restart factory-runner"
}

# -- uninstall ----------------------------------------------------------------------------------------------------

uninstall() {
  say "removing the service and the command"
  if [ "$SYSTEMCTL" = 1 ]; then
    act systemctl disable --now factory-runner || true
  fi
  act docker rm -f factory-runner || true
  act rm -f "$UNIT" "$COMMAND"
  if [ "$SYSTEMCTL" = 1 ]; then
    act systemctl daemon-reload
  fi
  act docker rmi "$CURRENT" "$PREVIOUS" || true
  if [ "$PURGE" = 1 ]; then
    act docker volume rm factory-runner-home factory-runner-work || true
    say "the configuration (with the credential) and /work are removed"
  else
    say "the configuration (volume factory-runner-home) and /work (factory-runner-work) are kept; --purge removes them"
  fi
  say "revoke this runner in the app (Runners) so that its credential stops working"
}

# -- main ------------------------------------------------------------------------------------------------------------

CHANGED=0
NO_TOKEN=0
preflight
if [ "$UNINSTALL" = 1 ]; then
  uninstall
  exit 0
fi
stage_image
write_command
CHANGED=0
write_unit
register_or_configure
if [ "$WITH_SYSBOX" = 1 ]; then
  install_sysbox
fi
if [ "$DRY_RUN" = 1 ]; then
  say "dry run: nothing was changed"
  exit 0
fi
if [ "$SYSTEMCTL" = 1 ]; then
  if [ "$CHANGED" = 1 ]; then
    systemctl daemon-reload
  fi
  if [ "$NO_TOKEN" = 1 ]; then
    systemctl enable factory-runner >/dev/null 2>&1 || true
  else
    systemctl enable factory-runner >/dev/null 2>&1
    if systemctl is-active --quiet factory-runner; then
      say "the service runs: it is not restarted (it switches to a new image between two jobs by itself)"
      if [ "$CHANGED" = 1 ]; then
        say "the unit changed: it takes effect at the next restart (systemctl restart factory-runner)"
      fi
    else
      systemctl start factory-runner
      say "the service is started: journalctl -u factory-runner -f"
    fi
  fi
fi
say "done. Try: factory-runner selftest"
