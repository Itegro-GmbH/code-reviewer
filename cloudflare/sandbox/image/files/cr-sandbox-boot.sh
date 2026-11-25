#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The boot of the Cloudflare image (#1159): the Worker `cr-sandbox` runs it once, as root, right after the Container started, and answers
# `POST /v1/vms` when it ends with 0. It does what the golden snapshot cannot carry as files and the Dispatcher's VM steps do not do:
#
#   1. the intercept CA. The outbound handler terminates TLS; Cloudflare writes its CA to /etc/cloudflare/certs/cloudflare-containers-ca.crt when
#      the handlers are registered before the start. It goes into the system store, and the files the VM steps hand to the containers are made:
#        /etc/cr-sandbox/intercept-ca.crt   the CA alone
#        /etc/cr-sandbox/ca-bundle.crt      the system bundle with the CA (mounted read-only into the Worker, door and agent containers)
#        /etc/cr-sandbox/ca.env             KEY=VALUE lines: SSL_CERT_FILE, NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE
#   2. the images. The Worker and agent images travel in this image as `docker save` archives (zstd), because a Container cannot pull from Docker
#      Hub (429 for the platform's addresses). vm-prepare.sh (the golden snapshot's own script: the cgroup fix, then dockerd) starts the daemon,
#      both archives are loaded, the tags are checked, the archives are deleted (they would take 1.4 GB of the 20 GB disk) and the daemon is
#      stopped cleanly. The daemon is NOT running when this ends: the Dispatcher's steps (run directories on tmpfs, vm-prepare.sh, the image
#      check, sysbox-prepare.sh) start it as they do on the Vercel snapshot.
#
# CR_SANDBOX_SELF_CHECK=1 is the build's own run of it (cloudflare/sandbox/image/self-check.sh, in a privileged container on a CI runner): no CA exists
# there (step 1 is skipped), and it prints what the build reads from the images:  IMAGE_ID <tag> <id>  and  WORKER_FEATURES <names|none>.
#
# Exit statuses: 30 no intercept CA  31 the CA is not in the bundle  32 vm-prepare.sh failed  33 an archive is missing  34 a load failed
#                35 a tag is missing after the load  36 the daemon did not stop  37 the features could not be read
set -euo pipefail
inner=/opt/cr-sandbox/inner
etc=/etc/cr-sandbox
ca_source=/etc/cloudflare/certs/cloudflare-containers-ca.crt
self_check="${CR_SANDBOX_SELF_CHECK:-0}"
start=$SECONDS
step() { echo "boot: $1 at +$((SECONDS - start)) s" >&2; }
die() { echo "boot: $2" >&2; exit "$1"; }

install -d -m 0755 "$etc"

# 1. the intercept CA
if [ "$self_check" != 1 ]; then
  [ -s "$ca_source" ] || die 30 "no intercept CA at $ca_source (the handlers must be registered before the Container starts)"
  install -m 0644 "$ca_source" "$etc/intercept-ca.crt"
  install -m 0644 "$ca_source" /usr/local/share/ca-certificates/cr-sandbox-intercept.crt
  update-ca-certificates > /dev/null
  cp /etc/ssl/certs/ca-certificates.crt "$etc/ca-bundle.crt"
  chmod 0644 "$etc/ca-bundle.crt"
  # The first certificate line of the CA must be in the bundle, or the files above are of no use.
  first_line=$(sed -n '2p' "$ca_source")
  grep -qF -- "$first_line" "$etc/ca-bundle.crt" || die 31 "the intercept CA is not in the bundle"
  cat > "$etc/ca.env" <<ENV
SSL_CERT_FILE=$etc/ca-bundle.crt
NODE_EXTRA_CA_CERTS=$etc/ca-bundle.crt
GIT_SSL_CAINFO=$etc/ca-bundle.crt
REQUESTS_CA_BUNDLE=$etc/ca-bundle.crt
CURL_CA_BUNDLE=$etc/ca-bundle.crt
ENV
  chmod 0644 "$etc/ca.env"
  step "ca-installed"
fi

# 2. the images
/usr/local/sbin/vm-prepare.sh || die 32 "vm-prepare.sh failed"
step "dockerd-ready"
mapfile -t archives < <(find "$inner" -maxdepth 1 -name '*.tar.zst' | sort)
[ "${#archives[@]}" -ge 2 ] || die 33 "the image archives are missing under $inner"
# Both at once: the unpack is CPU bound and the Container has 4 vCPU (the golden snapshot's two images share their base layers, which the second load finds).
pids=()
for archive in "${archives[@]}"; do
  ( zstd -dc -T0 "$archive" | docker load > /dev/null ) &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
[ "$failed" = 0 ] || die 34 "docker load failed"
step "images-loaded"
worker_tag=$(jq -r '.worker.tag' /etc/code-reviewer-vm/recipe.json)
agent_tag=$(jq -r '.agent.tag' /etc/code-reviewer-vm/recipe.json)
for tag in "$worker_tag" "$agent_tag"; do
  id=$(docker image inspect --format '{{.Id}}' "$tag" 2> /dev/null) || die 35 "the image $tag is missing after the load"
  echo "IMAGE_ID $tag $id"
done
rm -f "${archives[@]}"

# What the build reads from the Worker image itself, as the golden snapshot's `worker_features` step does (no network, no job content).
if [ "$self_check" = 1 ]; then
  features=$(timeout 120 docker run --rm --network none --entrypoint /opt/venv/bin/python "$worker_tag" -c \
    'from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES; print("WORKER_FEATURES " + (",".join(WORKER_FEATURES) or "none"))' < /dev/null) \
    || die 37 "the Worker features could not be read"
  echo "$features"
fi

# 3. the daemon stops, as the pipeline's stop_daemon does: SIGTERM, then wait until it, containerd and any shim are gone. Never SIGKILL.
pkill -TERM -x dockerd || true
for _ in $(seq 1 300); do
  if ! pgrep -x 'dockerd|containerd|containerd-shim' > /dev/null; then
    sync
    step "ready"
    exit 0
  fi
  sleep 0.2
done
die 36 "the container engine is still running"
