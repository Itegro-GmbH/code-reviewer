#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The golden image of the Incus whole-job lane (#1020): the product's golden image (docker/incus/build-golden.sh) built from a Worker image that also
# trusts the lane's test CA. A job clones over https and calls its provider over https, and the lane has neither a git host nor a provider on the
# internet: its fakes answer with certificates of a CA made here (runner/tests/kvm/lane_pki.py: one domain only, a critical name constraint), and ONLY
# this lane-only copy of the Worker image trusts it (the CA appended to the image's bundle). The CA's key stays in the PKI directory; nothing is
# committed or published.
#
#   runner/tests/incus/build-lane-image.sh <pki dir> [--pool POOL] [--prefix PREFIX] [--alias ALIAS] [--ca-days N]
#
# It expects the two images of the recipe in the caller's Docker (`code-reviewer-worker:golden`, `code-reviewer-agent:golden`: runner/Dockerfile,
# targets `sandbox` and `agent`), makes the CA in <pki dir> unless it is there, derives the Worker image (same tag, the CA appended), runs build-golden.sh
# for the alias (default `crlane-golden`) and removes the derived Worker image from the caller's Docker again. It prints the variables of the lane:
# CR_INCUS_JOB_IMAGE, CR_INCUS_JOB_IMAGE_ID, CR_INCUS_JOB_PKI. Run it as a member of `incus-admin` (see build-golden.sh).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PKI="${1:?usage: build-lane-image.sh <pki dir> [--pool POOL] [--prefix PREFIX] [--alias ALIAS] [--ca-days N]}"
shift
ALIAS="crlane-golden"
PREFIX="crlane"
POOL=""
DAYS=30
while [ $# -gt 0 ]; do
  case "$1" in
    --pool) POOL="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --alias) ALIAS="$2"; shift 2 ;;
    --ca-days) DAYS="$2"; shift 2 ;;
    *) echo "build-lane-image: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$POOL" ] || { echo "build-lane-image: --pool is required" >&2; exit 2; }
WORKER="code-reviewer-worker:golden"

mkdir -p "$PKI"
if [ ! -f "$PKI/lane-ca.crt" ]; then
  (cd "$REPO/runner" && uv run --frozen python tests/kvm/lane_pki.py ca "$PKI" "$DAYS" >/dev/null)
fi

context="$(mktemp -d "$PKI/image-context.XXXXXX")"
trap 'rm -rf "$context"' EXIT
cp "$PKI/lane-ca.crt" "$context/lane-ca.crt"
worker_user="$(docker image inspect --format '{{.Config.User}}' "$WORKER")"
cat > "$context/Dockerfile" <<DOCKERFILE
FROM $WORKER
USER 0:0
COPY lane-ca.crt /usr/local/share/ca-certificates/lane-ca.crt
RUN cat /usr/local/share/ca-certificates/lane-ca.crt >> /etc/ssl/certs/ca-certificates.crt
USER $worker_user
DOCKERFILE
# The daemon's own builder: the base is the image the daemon already has, which a builder container would not see. The same tag, so the launcher's
# Control starts the same reference; the image id is the lane's own (build-golden.sh prints it).
docker buildx build --builder default --load --tag "$WORKER" "$context"

out="$("$REPO/docker/incus/build-golden.sh" --alias "$ALIAS" --pool "$POOL" --prefix "$PREFIX" --replace | tee /dev/stderr)"
image_id="$(printf '%s\n' "$out" | sed -n 's/^FACTORY_RUNNER_VM_IMAGE_ID=//p')"
[ -n "$image_id" ] || { echo "build-lane-image: build-golden.sh did not print the Worker image's id" >&2; exit 1; }
echo "CR_INCUS_JOB_IMAGE=$ALIAS"
echo "CR_INCUS_JOB_IMAGE_ID=$image_id"
echo "CR_INCUS_JOB_PKI=$PKI"
