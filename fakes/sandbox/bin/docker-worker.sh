#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# A stand-in for the `docker` executable for the hosted end-to-end journeys (#332): it takes the `docker run` the
# Sandbox-Launcher renders (the real flags of the hardened container spec, the image id, the entry mode) and runs the
# REAL Worker for it as a local process, where a daemon would have run the container. Nothing of the Worker is
# replaced; what is not there is the container itself (no namespaces, no limits, no capabilities), which the
# privileged lane adds with E2E_WORKER_WRAPPER and `sandbox-local` proves with a real daemon.
#
#   E2E_DOCKER_DIR            where the records go (required); never inside the "VM" directory
#   E2E_IMAGE_ID              what `docker image inspect --format {{.Id}}` prints (required)
#   E2E_WORKER_COMMAND        the program of the image's entry point, `code-reviewer-runner` (required)
#   E2E_WORKER_WRAPPER        optional: a program that runs the entry point in the way of the container, called as
#                             `wrapper <program> <mode>`, and that must `exec` the program (the privileged lane's
#                             read-only root and capabilities)
#   E2E_WORKER_PASS_<NAME>    given to the Worker as `<NAME>`, for what the image carries itself (the fake LLM's job
#                             command, the tiktoken cache)
#   E2E_WORKER_ONCE_UNSET     optional: names (space separated) taken out of the environment of `worker-once` only. The
#                             container is root with capabilities and its Worker starts with the Dynamic startup (the
#                             network rules, the end of NET_ADMIN) when `RUNNER_DIFF_JOB_USER` is set; a host process
#                             without root cannot, so a lane that is not privileged unsets it and serves Diff jobs. The
#                             `probe` mode keeps it: its verdict is the answer of an environment that cannot do that.
#   E2E_WORKER_GATE           optional path: the Worker is not started while a file exists there
#   E2E_WORKER_EXIT_FILE      optional path: while a file exists there, a `worker-once` container does not run the Worker: it
#                             lives for 3 seconds, which is past the hand-over of the journeys (1 second), and ends with
#                             the exit code the file holds (#375): a Worker that took over and then died of a setup error
#                             or a kill, without a result
#   E2E_STDIN_COPY_DIR        optional: a copy of the start document of every `worker-once` (it holds the per-job
#                             credential) goes to `run-<n>.stdin` there, so that a test can search every log for the value
#                             that really was a secret. A directory no log is scanned in, never the records directory.
#   E2E_WORKER_PATH           the PATH of the Worker (default: the PATH of this process)
#
# The Worker's environment is closed, like a container's: the `--env` flags of the rendered command, the
# E2E_WORKER_PASS_ variables, and a PATH, a HOME and a TMPDIR of its own. Nothing else of this process reaches it, so a
# secret of the Dispatcher's or the test's environment cannot. The start document comes on stdin as it does into the
# container. `docker rm --force <name>` ends the Worker's whole tree, which is what the end of a container does.
#
# Records (`run-<n>.args` appears last, by a rename, so a container is listed only when its records are complete):
# run-<n>.args (one argument per line), run-<n>.env (the Worker's environment, names and values),
# run-<n>.pid (the Worker's process id) and run-<n>.log (what the Worker wrote to stderr, and to
# stdout unless the mode is `probe`, whose stdout is the verdict) for each `docker run`; commands.log for every other
# command. An argument this script does not know is refused with 125, like a daemon refuses one it does not know:
# a new flag of the spec is a decision, not something to ignore.
set -eu
dir="${E2E_DOCKER_DIR:?E2E_DOCKER_DIR is required}"

# The processes below one, children first as they are found. A job process starts in a session of its own, so neither
# the Worker's group nor its session holds it: the tree is followed by parent.
descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    descendants "$child"
    echo "$child"
  done
}

# Ends everything a started container runs (a container's PID namespace ends with it): the tree is collected before
# anything dies, because the children of a dead process are no longer found below it.
kill_tree() {
  local file="$1" pid all
  [ -f "$file" ] || return 0
  pid="$(cat "$file")"
  all="$(descendants "$pid") $pid"
  # shellcheck disable=SC2086
  kill -KILL $all 2>/dev/null || true
}

case "${1:-}" in
  image)
    printf '%s\n' "${E2E_IMAGE_ID:?E2E_IMAGE_ID is required}"
    ;;
  rm)
    printf '%s\n' "$*" >>"$dir/commands.log"
    # `rm --force <name>`: the container of that name, if it is running.
    name="${*: -1}"
    for file in "$dir"/run-*.name; do
      [ -f "$file" ] || continue
      if [ "$(cat "$file")" = "$name" ]; then kill_tree "${file%.name}.pid"; fi
    done
    ;;
  run)
    declare -a given=("$@")
    shift
    name=""
    image=""
    mode=""
    mounts=0
    declare -a worker_env=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --interactive | --rm | --read-only) shift ;;
        --name) name="$2"; shift 2 ;;
        --env) worker_env+=("$2"); shift 2 ;;
        # The work volume of the Implementer's profile (#760) and nothing else: one named volume at /work. The name has
        # no comma and no equals sign, so that it cannot add an option (`readonly=false`, `bind-propagation=...`,
        # `volume-opt=...`, a second `target=`); a bind or any other mount is refused. Matched as a whole, never as a glob.
        --mount)
          if [ "$mounts" = 0 ] && [[ "${2:-}" =~ ^type=volume,source=code-reviewer-work-[A-Za-z0-9][A-Za-z0-9_.-]*,target=/work$ ]]; then
            mounts=1
            shift 2
          else
            echo "docker-worker: unknown mount ${2:-}" >&2
            exit 125
          fi ;;
        --user | --cap-drop | --cap-add | --security-opt | --tmpfs | --memory | --memory-reservation | \
          --memory-swap | --pids-limit | --stop-timeout | --network | --sysctl)
          shift 2 ;;
        -*)
          echo "docker-worker: unknown flag $1" >&2
          exit 125 ;;
        *)
          image="$1"
          mode="${2:-}"
          shift "$#" ;;
      esac
    done
    if [ -z "$image" ] || [ -z "$mode" ]; then
      echo "docker-worker: no image or no entry mode" >&2
      exit 125
    fi
    n="$(date +%s%N)"
    # The record of a container is complete when `run-<n>.args` exists (the harness lists containers by it, #380): it is
    # written under a temporary name here and renamed after `.name`, `.pid` and `.env`, so a reader never sees a partial one.
    printf '%s\n' "${given[@]}" >"$dir/run-$n.args.tmp"
    printf '%s' "$name" >"$dir/run-$n.name"
    printf '%s\n' "$$" >"$dir/run-$n.pid"

    # The Worker's home, in the "VM" directory (the working directory): it goes with the VM, and a wrapper that puts a
    # fresh /tmp over the real one does not hide it.
    home="$(mktemp -d "$PWD/cr-container-XXXXXX")"
    worker_path="${E2E_WORKER_PATH:-$PATH}"
    declare -a environment=("PATH=$worker_path" "HOME=$home" "TMPDIR=$home" "LANG=C.UTF-8")
    # A later entry wins in `env`, so a HOME of the flags replaces the one made here.
    environment+=("${worker_env[@]+"${worker_env[@]}"}")
    while IFS='=' read -r variable value; do
      case "$variable" in E2E_WORKER_PASS_*) environment+=("${variable/E2E_WORKER_PASS_/}=$value") ;; esac
    done < <(env)
    if [ "$mode" = "worker-once" ] && [ -n "${E2E_WORKER_ONCE_UNSET:-}" ]; then
      declare -a kept=()
      for pair in "${environment[@]}"; do
        drop=0
        for unset_name in $E2E_WORKER_ONCE_UNSET; do
          case "$pair" in "$unset_name="*) drop=1 ;; esac
        done
        [ "$drop" = 1 ] || kept+=("$pair")
      done
      environment=("${kept[@]}")
    fi
    printf '%s\n' "${environment[@]}" | sort >"$dir/run-$n.env"
    mv "$dir/run-$n.args.tmp" "$dir/run-$n.args"

    # A container that is held (a test that wants a Worker that has not started yet, or one that is still there).
    # In short steps, so that a killed client leaves no long sleep behind.
    while [ -n "${E2E_WORKER_GATE:-}" ] && [ -e "$E2E_WORKER_GATE" ]; do sleep 0.1; done

    if [ "$mode" = "worker-once" ] && [ -n "${E2E_WORKER_EXIT_FILE:-}" ] && [ -e "$E2E_WORKER_EXIT_FILE" ]; then
      sleep 3
      exit "$(cat "$E2E_WORKER_EXIT_FILE")"
    fi

    if [ -n "${E2E_STDIN_COPY_DIR:-}" ] && [ "$mode" = "worker-once" ]; then
      document="$(cat)"
      mkdir -p "$E2E_STDIN_COPY_DIR"
      (umask 077 && printf '%s\n' "$document" >"$E2E_STDIN_COPY_DIR/run-$n.stdin")
      exec <<<"$document"
    fi

    exec 2>>"$dir/run-$n.log"
    [ "$mode" = "probe" ] || exec 1>>"$dir/run-$n.log"
    if [ -n "${E2E_WORKER_WRAPPER:-}" ]; then
      exec setsid --wait env -i "${environment[@]}" "$E2E_WORKER_WRAPPER" "${E2E_WORKER_COMMAND:?E2E_WORKER_COMMAND is required}" "$mode"
    fi
    exec setsid --wait env -i "${environment[@]}" "${E2E_WORKER_COMMAND:?E2E_WORKER_COMMAND is required}" "$mode"
    ;;
  *)
    printf '%s\n' "$*" >>"$dir/commands.log"
    ;;
esac
