#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Timing helpers of the Incus/Docker bench (#1013). Sourced by bench.sh (on the host) and guest.sh (inside an instance, or on the host
# for the control that has no Incus). Every measurement goes to $BENCH_OUT as one tab-separated line
#
#   variant  metric  rep  value  note
#
# where value is the seconds with three decimals, or the word FAILED (the reason in note). A command that failed, or whose output
# is not what it must be, records FAILED and NO time: a failed command is usually a fast one, so a time must never exist for it.
# summarize.py fails the job on any FAILED of a required series.
export LC_ALL=C   # EPOCHREALTIME and awk must use a decimal point

: "${BENCH_OUT:?BENCH_OUT must name the file the samples go to}"
BENCH_VARIANT=${BENCH_VARIANT:-}
TIMED_OUT=''
TIMED_SECS=''

# elapsed <start> <end>: seconds with three decimals
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f", b - a }'; }

# flat <text>: the last 300 characters on one line, so a note never breaks the file's format
flat() { printf '%s' "$1" | tr '\t\r\n' '   ' | tail -c 300; }

# record <metric> <rep> <value> [note]
record() { printf '%s\t%s\t%s\t%s\t%s\n' "$BENCH_VARIANT" "$1" "$2" "$3" "${4:-}" >>"$BENCH_OUT"; }

# expect_samples <metric> <count>: the series must end with this many good samples (rep 1 and up; rep 0 is the warm-up)
expect_samples() { record "$1" n "$2" 'expect'; }

# timed <metric> <rep> [-e <regex>] -- <command...>
# Runs the command with stdin closed (`incus init` reads a config from stdin and hangs on an open pipe) and its output captured in
# TIMED_OUT. Records the seconds only when the command exited 0 and, with -e, printed something that matches the regex. Returns non-zero otherwise.
timed() {
  local metric=$1 rep=$2 pattern='' out t0 t1 rc
  shift 2
  if [ "${1:-}" = -e ]; then pattern=$2; shift 2; fi
  if [ "${1:-}" != -- ]; then echo "timed: the command must follow --" >&2; return 2; fi
  shift
  out=$(mktemp)
  t0=$EPOCHREALTIME
  "$@" </dev/null >"$out" 2>&1
  rc=$?
  t1=$EPOCHREALTIME
  TIMED_OUT=$(head -c 8192 "$out")
  rm -f "$out"
  if [ "$rc" -ne 0 ]; then
    record "$metric" "$rep" FAILED "exit $rc: $(flat "$TIMED_OUT")"
    return "$rc"
  fi
  if [ -n "$pattern" ] && ! printf '%s\n' "$TIMED_OUT" | grep -Eq -- "$pattern"; then
    record "$metric" "$rep" FAILED "output does not match /$pattern/: $(flat "$TIMED_OUT")"
    return 65
  fi
  TIMED_SECS=$(elapsed "$t0" "$t1")
  record "$metric" "$rep" "$TIMED_SECS"
}

# timed_build <metric> <rep> <tag> <context-dir>
# A `docker build` of a context whose Dockerfile writes `built` to /built.txt. The time is recorded only after the build exited 0, printed an image id,
# left an image with the tag, and a container of that image printed `built`. The checks are not part of the time. The image is removed afterwards.
# (The first spike's bench discarded the build's output: a build that failed at once looked like the fastest one.)
timed_build() {
  local metric=$1 rep=$2 tag=$3 ctx=$4 err t0 t1 rc id got
  err=$(mktemp)
  t0=$EPOCHREALTIME
  id=$(docker build -q --no-cache -t "$tag" "$ctx" 2>"$err" </dev/null)
  rc=$?
  t1=$EPOCHREALTIME
  if [ "$rc" -ne 0 ]; then
    record "$metric" "$rep" FAILED "docker build exit $rc: $(flat "$(cat "$err")")"
    rm -f "$err"; return 1
  fi
  rm -f "$err"
  case $id in
    sha256:*) ;;
    *) record "$metric" "$rep" FAILED "docker build printed no image id: $(flat "$id")"; return 1 ;;
  esac
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    record "$metric" "$rep" FAILED "no image $tag after the build"; return 1
  fi
  got=$(docker run --rm --pull=never "$tag" cat /built.txt 2>&1 </dev/null)
  if [ "$got" != built ]; then
    record "$metric" "$rep" FAILED "the built image printed '$(flat "$got")', not 'built'"
    docker rmi -f "$tag" >/dev/null 2>&1; return 1
  fi
  docker rmi -f "$tag" >/dev/null 2>&1
  TIMED_SECS=$(elapsed "$t0" "$t1")
  record "$metric" "$rep" "$TIMED_SECS"
}

# sum <a> <b> ...: the sum with three decimals
sum() { awk 'BEGIN { s = 0; for (i = 1; i < ARGC; i++) s += ARGV[i]; printf "%.3f", s }' "$@"; }
