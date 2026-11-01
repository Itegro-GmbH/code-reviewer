# syntax=docker/dockerfile:1
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Image of the Code Reviewer Worker (Python, uv): the Worker image of the hosted deployment. The golden
# snapshot (docs/golden-snapshot.md) builds it inside a Vercel Sandbox VM, and every review job runs it
# there with the flags of the hardened container spec (contracts/worker-container.v1.json). Build
# context: the repository root, because the image also carries LICENSE, NOTICE and
# THIRD_PARTY_LICENSES.md from there (runner/Dockerfile.dockerignore keeps everything else out):
#   docker build -f runner/Dockerfile --target sandbox -t code-reviewer-runner-sandbox .
# `sandbox` is the only target and the last stage, so a plain build gives it. It carries both engines:
# PR-Agent (Diff) and the pinned stock OpenCode (about 186 MB, Dynamic), `nft`, a pinned `rg` and the
# dedicated engine user 10101, and the toolchain of the Implementer's agent (#761): git built from its pinned
# source, Node.js and pnpm from pinned releases, uv, a compiler, jq and unzip, and the files of the branch
# guard. Nothing enables anything by itself: the Sandbox-Launcher starts the container with its
# capabilities, and the startup self-check advertises `opencode` only when all of it is right.
#
# The Python minor version must match .python-version (a test checks it). Update the digests with
#   docker pull python:3.13-slim-bookworm && docker image inspect python:3.13-slim-bookworm --format '{{index .RepoDigests 0}}'
# The uv version should match the one CI uses on the host (.github/workflows/ci.yml, setup-uv).
ARG PYTHON_IMAGE=python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.0@sha256:cdc6093146eb3ff6a40107b38f008b789e050e77ad87865e381d9917da55a168

FROM ${UV_IMAGE} AS uv

# ---- licenses: the license files of the repository, copied into the runtime stage below ----
FROM scratch AS licenses
COPY LICENSE NOTICE THIRD_PARTY_LICENSES.md /

# ---- guard-files: the hook and the matrix of the Implementer's branch guard (#761), copied into the sandbox stage ----
FROM scratch AS guard-files
COPY runner/guard/reference-transaction runner/scripts/guard_matrix.sh /

# ---- builder: create the virtual environment from uv.lock ----
FROM ${PYTHON_IMAGE} AS builder
COPY --from=uv /uv /usr/local/bin/uv
# Use the interpreter of this image (never download one) and compile bytecode once, at build time.
# The venv is created at the path it has in the runtime stage: a venv cannot be moved, its scripts
# contain absolute paths.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON_PREFERENCE=only-system \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
WORKDIR /build
# Dependencies first (cached until pyproject.toml or uv.lock change): PR-Agent and everything it
# pins, installed from uv.lock. All of them have wheels for this Python version, so no compiler is
# needed in this stage.
COPY runner/pyproject.toml runner/uv.lock runner/.python-version ./
RUN uv sync --locked --no-dev --no-install-project
# Then the project itself, installed non-editable so the venv is self-contained.
COPY runner/src ./src
RUN uv sync --locked --no-dev --no-editable
# PR-Agent counts tokens with tiktoken, which downloads its encodings from the internet on first
# use. Download them once here, so a job never needs that connection (and parallel jobs do not race
# to write the same cache). The variable name is tiktoken's second choice; the first choice
# (TIKTOKEN_CACHE_DIR) would trip the secret scan of the image smoke test.
ENV DATA_GYM_CACHE_DIR=/opt/bpe-cache
RUN mkdir -p "$DATA_GYM_CACHE_DIR" \
    && /opt/venv/bin/python -c "import tiktoken; tiktoken.get_encoding('o200k_base'); tiktoken.get_encoding('cl100k_base')"

# ---- engine-tools: the pinned OpenCode and ripgrep, verified ----
# The one build step with the internet besides the dependency install. Both scripts accept a
# download only with the pinned size and SHA-256 (runner/opencode-pin.json, runner/ripgrep-pin.json),
# unpack only the one pinned file and check the version it reports. The scripts find their pin
# one directory above them. Nothing at run time downloads anything. Only linux-x64 is pinned: on
# another platform the scripts fail the build.
FROM ${PYTHON_IMAGE} AS engine-tools
COPY runner/scripts/fetch_opencode.py runner/scripts/fetch_ripgrep.py /fetch/scripts/
COPY runner/opencode-pin.json runner/ripgrep-pin.json /fetch/
RUN python /fetch/scripts/fetch_opencode.py --dest /engine-tools \
    && python /fetch/scripts/fetch_ripgrep.py --dest /engine-tools

# ---- toolchain-fetch: the pinned git source, Node.js and pnpm, verified (#761) ----
# The Implementer's agent builds repositories in the Worker container. The same strict way as the engine
# tools: runner/scripts/fetch_toolchain.py accepts a download only with the pinned size and SHA-256
# (runner/git-pin.json, node-pin.json, pnpm-pin.json), unpacks it into a directory below /toolchain and
# keeps an unverified tree from ever appearing there. Only linux-x64 is pinned. Node.js loses what an agent
# does not run (C++ headers, man pages, docs); a native addon that has to be built would need the headers.
FROM ${PYTHON_IMAGE} AS toolchain-fetch
COPY runner/scripts/fetch_opencode.py runner/scripts/fetch_toolchain.py /fetch/scripts/
COPY runner/git-pin.json runner/node-pin.json runner/pnpm-pin.json /fetch/
RUN python /fetch/scripts/fetch_toolchain.py --component git --dest /toolchain/git
RUN python /fetch/scripts/fetch_toolchain.py --component node --dest /toolchain/node \
    && rm -rf /toolchain/node/include /toolchain/node/share
RUN python /fetch/scripts/fetch_toolchain.py --component pnpm --dest /toolchain/pnpm \
    && chmod 0755 /toolchain/pnpm/bin/pnpm.cjs /toolchain/pnpm/bin/pnpx.cjs

# ---- git-build: git 2.53 or newer from the verified source (#761) ----
# Debian bookworm ships git 2.39. The branch guard of the Implementer is a reference-transaction hook, and
# only git 2.53 or newer shows it a switch of the branch (checkout, switch); on older git the guard is blind
# to that, so the Worker's self-test refuses to run a turn on it. The release is built here, once, from the
# pinned source: no Perl, Python, Tcl, gettext, expat or OpenSSL (nothing the agent needs; `git add -p` is the
# one loss), against the GnuTLS flavour of libcurl, and with NO_OPENSSL: git is GPL-2.0-only and OpenSSL 3
# (Apache-2.0) is not compatible with it, so no program of git may link it, neither its own `git-imap-send`
# nor libcurl's TLS in `git-remote-https` (Debian's own git takes libcurl3-gnutls for the same reason); the system
# config is in /etc (the Worker points GIT_CONFIG_SYSTEM at a file under /run per job, and the image bakes none in),
# builtins as symlinks so the copy into the final image keeps one binary.
FROM ${PYTHON_IMAGE} AS git-build
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential libcurl4-gnutls-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=toolchain-fetch /toolchain/git /git-src
WORKDIR /git-src
RUN make -j2 prefix=/usr/local sysconfdir=/etc INSTALL_SYMLINKS=1 \
        NO_GETTEXT=1 NO_PERL=1 NO_PYTHON=1 NO_TCLTK=1 NO_EXPAT=1 NO_LIBPCRE2=1 NO_OPENSSL=1 all strip \
    && make prefix=/usr/local sysconfdir=/etc INSTALL_SYMLINKS=1 \
        NO_GETTEXT=1 NO_PERL=1 NO_PYTHON=1 NO_TCLTK=1 NO_EXPAT=1 NO_LIBPCRE2=1 NO_OPENSSL=1 DESTDIR=/out install

# ---- runtime-base: Python, the venv and nothing else (no uv, no compiler, no sources) ----
FROM ${PYTHON_IMAGE} AS runtime-base
LABEL org.opencontainers.image.source="https://github.com/Itegro-GmbH/code-reviewer" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary"
# LITELLM_LOCAL_MODEL_COST_MAP makes LiteLLM use its bundled price list instead of fetching it from
# GitHub when it is imported (the runner sets it for every job as well).
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    DATA_GYM_CACHE_DIR=/opt/bpe-cache
# tini is PID 1: the Worker ends the process groups of its jobs, and the helpers it kills are
# re-parented to PID 1, which has to reap them or they stay as zombies. tini also passes SIGTERM on
# to the Worker, so a plain `docker stop` is an orderly shutdown.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
# Fixed numeric ids, like the app image. The home directory is writable so tools that cache or
# write config files (PR-Agent, git) work; the job working directories live under /tmp.
RUN groupadd --system --gid 10001 runner \
    && useradd --system --uid 10001 --gid runner --create-home --home-dir /home/runner --shell /usr/sbin/nologin runner
# The license of the project and of its dependencies travel with the image (the third party notices need it).
# html2text (GPL-3.0) is part of the venv below, with its license text in its dist-info.
COPY --from=licenses / /licenses/
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/bpe-cache /opt/bpe-cache
USER 10001:10001
WORKDIR /home/runner
ENTRYPOINT ["/usr/bin/tini", "--", "code-reviewer-runner"]

# ---- sandbox: the Worker image of the hosted deployment: the runner plus the engine (#324) ----
# Still starts as the unprivileged user 10001: without the capability list of the hardened container
# spec the runner is not the root supervisor, has no engine user configured and serves Diff jobs only.
# What this stage adds is installed root-owned and not writable by anyone else; the runner's startup
# self-check hashes both executables against the pins that travel with them
# (dynamic_review/self_check.py) before it advertises `opencode`. No Dispatcher bundle: a Vercel Sandbox
# VM runs a Worker only, one per job (`worker-once`) or the self-check alone (`probe`), started by the
# Sandbox-Launcher with the flags of the hardened container spec. This is the last stage, so a plain
# build gives it:
#   docker build -f runner/Dockerfile --target sandbox -t code-reviewer-runner-sandbox .
FROM runtime-base AS sandbox
LABEL org.opencontainers.image.title="Code Reviewer Worker (Sandbox)" \
      org.opencontainers.image.description="Worker image for the hosted deployment: runs one job (worker-once) or the startup self-check (probe)"
USER 0:0
# nft installs the engine user's network rules once, at container start (ADR 0003). Debian's signed
# package, NOT version-pinned (like tini): apt takes the version the Debian repository has when the
# image is built, so two builds on different days can differ even on the same base image digest. A
# `nftables=<version>` pin would not make it reproducible: the Debian mirrors drop superseded
# versions, so the build would break at the next point release instead.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends nftables \
    && rm -rf /var/lib/apt/lists/*
# The dedicated engine user: its own numeric ids, distinct from the Diff job user 10001, no home
# directory, no shell, no supplementary group. The runner gives the engine a home per job.
RUN groupadd --system --gid 10101 engine \
    && useradd --system --uid 10101 --gid engine --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin engine
COPY --from=engine-tools --chown=0:0 --chmod=0755 /engine-tools/ /usr/local/bin/
# The directory first: COPY would create it with the mode given to the files (0644, not enterable).
RUN install -d -m 0755 -o 0 -g 0 /opt/code-reviewer/pins
COPY --chown=0:0 --chmod=0644 runner/opencode-pin.json runner/ripgrep-pin.json /opt/code-reviewer/pins/
# ---- the toolchain of the Implementer's agent (#761) ----
# Compiler, make, jq, unzip and the GnuTLS flavour of libcurl that git needs for https (Debian's own git takes it for
# the same reason: no OpenSSL in a GPL-2.0-only program), from Debian's signed packages, NOT
# version-pinned (like nftables above); without build-essential's dpkg-dev and Perl, which saves about
# 50 MB and which no build of the agent's needs. Debian's `git` package is not installed: the git below is
# the only one, and the guard needs its version.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends gcc g++ make libc6-dev jq unzip libcurl3-gnutls \
    && rm -rf /var/lib/apt/lists/*
COPY --from=git-build --chown=0:0 /out/usr/local/ /usr/local/
COPY --from=toolchain-fetch --chown=0:0 /toolchain/node /opt/node
COPY --from=toolchain-fetch --chown=0:0 /toolchain/pnpm /opt/pnpm
COPY --from=uv --chown=0:0 /uv /uvx /usr/local/bin/
# The release licenses travel with the image: node's and pnpm's are in their trees, git's is copied.
COPY --from=toolchain-fetch --chown=0:0 /toolchain/git/COPYING /usr/local/share/doc/git/COPYING
RUN ln -s /opt/node/bin/node /usr/local/bin/node \
    && ln -s /opt/node/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /opt/node/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s /opt/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm
# The guard of the branch: the hook and the matrix that proves it, root-owned and read-only. The image bakes
# in no core.hooksPath: the Worker sets it per job in a GIT_CONFIG_SYSTEM file under /run (the root file
# system is read-only) and writes the guard configuration there.
RUN install -d -m 0755 -o 0 -g 0 /opt/code-reviewer/guard
COPY --from=guard-files --chown=0:0 --chmod=0755 / /opt/code-reviewer/guard/
USER 10001:10001
