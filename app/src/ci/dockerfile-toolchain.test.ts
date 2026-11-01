// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the toolchain layer of the Worker image (#761): git 2.53 or newer, Node.js with pnpm, Python
// with uv, a compiler, jq and unzip, and the files of the Implementer's accident guard. The agent builds
// repositories inside the Worker container with these. Everything downloaded is pinned and verified
// (runner/<name>-pin.json, runner/scripts/fetch_toolchain.py); git is built from its pinned source because
// Debian's is older than the 2.53 the guard needs. Whether the built image behaves (versions, owners, the
// guard matrix, the size budget) is judged by docker/smoke/runner.sh, which CI runs; here the Dockerfile
// that makes it is.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packageManagerRuns } from "./dockerfile-package-managers";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dockerfile = readFileSync(`${repoRoot}runner/Dockerfile`, "utf8");

type Stage = { name: string; base: string; lines: string[] };

function stages(source: string): Stage[] {
  const lines = source
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line !== "" && !line.startsWith("#"));
  const found: Stage[] = [];
  for (const line of lines) {
    const from = /^FROM (\S+) AS (\S+)$/.exec(line);
    if (from)
      found.push({ name: from[2] ?? "", base: from[1] ?? "", lines: [] });
    else found.at(-1)?.lines.push(line);
  }
  return found;
}

function stage(name: string): Stage {
  const found = stages(dockerfile).find((entry) => entry.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

const fetching = () => stage("toolchain-fetch").lines.join("\n");
const sandbox = () => stage("sandbox").lines;

describe("the toolchain fetch stage", () => {
  // #761-T02
  it("is built on the pinned Python base and copies only the fetch scripts and the pins", () => {
    expect(stage("toolchain-fetch").base).toBe("${PYTHON_IMAGE}");
    const copies = stage("toolchain-fetch").lines.filter((line) =>
      line.startsWith("COPY "),
    );

    expect(copies).toEqual([
      "COPY runner/scripts/fetch_opencode.py runner/scripts/fetch_toolchain.py /fetch/scripts/",
      "COPY runner/git-pin.json runner/node-pin.json runner/pnpm-pin.json /fetch/",
    ]);
  });

  // #761-T02: the same strict, checksum-verifying way as the engine, once per component.
  it.each(["git", "node", "pnpm"])(
    "fetches %s through the pinned, checksum-verifying script",
    (component) => {
      expect(fetching()).toContain(
        `python /fetch/scripts/fetch_toolchain.py --component ${component} --dest /toolchain/${component}`,
      );
    },
  );

  // #761-T02
  it("drops what an agent does not need from Node.js: headers, man pages, docs", () => {
    expect(fetching()).toMatch(
      /rm -rf \/toolchain\/node\/include \/toolchain\/node\/share/,
    );
  });
});

describe("git of the Worker image", () => {
  const building = () => stage("git-build").lines.join("\n");

  // #761-T01
  it("is built from the verified source of the fetch stage, with nothing downloaded here", () => {
    expect(stage("git-build").base).toBe("${PYTHON_IMAGE}");
    expect(building()).toContain(
      "COPY --from=toolchain-fetch /toolchain/git /git-src",
    );
    expect(building()).toMatch(/\bmake\b[^\n]*\binstall\b/);
    expect(building()).not.toMatch(/\b(curl|wget|git clone)\b/);
  });

  // #761-T01
  it("is installed under /usr/local with its system config in /etc, builtins as symlinks", () => {
    expect(building()).toContain("prefix=/usr/local");
    expect(building()).toContain("sysconfdir=/etc");
    expect(building()).toContain("INSTALL_SYMLINKS=1");
    expect(building()).toContain("DESTDIR=/out");
  });

  // #761-T07 (review of #777, finding 6): git is GPL-2.0-only; OpenSSL 3 (Apache-2.0) must not be linked
  // into it. `git-imap-send` is the program that would link it, and nothing the agent needs uses it.
  it("is built without OpenSSL, in both make invocations, and without the OpenSSL headers of its own", () => {
    const makes = stage("git-build").lines.filter((line) =>
      /\bmake\b/.test(line),
    );

    expect(makes.length).toBeGreaterThan(0);
    for (const line of makes)
      expect(line.match(/\bNO_OPENSSL=1\b/g), line).toHaveLength(
        (line.match(/\bmake\b/g) ?? []).length,
      );
    expect(building()).not.toMatch(/\blibssl-dev\b/);
    // libcurl's TLS is OpenSSL's in the usual flavour: the GnuTLS one, here and in the final image.
    expect(building()).toContain("libcurl4-gnutls-dev");
    expect(building()).not.toContain("libcurl4-openssl-dev");
    expect(sandbox().join("\n")).not.toMatch(/\blibcurl4\b/);
  });

  // #761-T01: Debian's git (2.39) would be found first on a path and is too old for the guard.
  it("is the only git: the distribution's package is never installed", () => {
    const installs = stages(dockerfile)
      .flatMap((entry) => entry.lines)
      .filter((line) => /apt-get install/.test(line));

    for (const line of installs)
      expect(line.split(/\s+/), line).not.toContain("git");
  });

  // #761-T01
  it("reaches the final image from the build stage, root-owned", () => {
    expect(sandbox()).toContain(
      "COPY --from=git-build --chown=0:0 /out/usr/local/ /usr/local/",
    );
  });
});

describe("the rest of the toolchain in the Worker image", () => {
  const installLine = () =>
    sandbox().find(
      (line) => /apt-get install/.test(line) && line.includes("libc6-dev"),
    ) ?? "";

  // #761-T02
  it("installs a compiler, make, jq, unzip and libcurl with apt, without recommended packages", () => {
    const packages = installLine().split(/\s+/);

    expect(installLine()).toContain("--no-install-recommends");
    for (const name of [
      "gcc",
      "g++",
      "make",
      "libc6-dev",
      "jq",
      "unzip",
      "libcurl3-gnutls",
    ])
      expect(packages, name).toContain(name);
  });

  // #761-T02
  it("takes Node.js and pnpm from the verified fetch stage, root-owned, and links them onto the path", () => {
    expect(sandbox()).toContain(
      "COPY --from=toolchain-fetch --chown=0:0 /toolchain/node /opt/node",
    );
    expect(sandbox()).toContain(
      "COPY --from=toolchain-fetch --chown=0:0 /toolchain/pnpm /opt/pnpm",
    );
    const linking = sandbox().filter((line) => line.startsWith("RUN ln "));
    const links = linking.join("\n");

    for (const target of ["node", "npm", "npx", "pnpm"])
      expect(links).toContain(`/usr/local/bin/${target}`);
  });

  // #761-T02: uv comes from the digest-pinned image the build stage already uses.
  it("takes uv from the digest-pinned uv image", () => {
    expect(dockerfile).toMatch(
      /^ARG UV_IMAGE=ghcr\.io\/astral-sh\/uv:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/m,
    );
    expect(sandbox()).toContain(
      "COPY --from=uv --chown=0:0 /uv /uvx /usr/local/bin/",
    );
  });

  // #761-T02: the licenses of what was added travel with the image.
  it("ships the license text of git in its own doc directory, leaving /licenses to the project's three files", () => {
    expect(sandbox()).toContain(
      "COPY --from=toolchain-fetch --chown=0:0 /toolchain/git/COPYING /usr/local/share/doc/git/COPYING",
    );
  });

  // #761-T02
  it("fetches no package with a package manager or from the internet at build time besides the pins", () => {
    expect(dockerfile).not.toMatch(/\b(curl|wget|bun)\b/);
    expect(packageManagerRuns(dockerfile)).toEqual([]);
    expect(dockerfile).not.toMatch(/releases\/latest|@latest/);
  });
});

describe("the accident guard files in the Worker image", () => {
  // #761-T03
  it("puts the hook and the matrix in a root-owned directory the engine user cannot write", () => {
    expect(sandbox()).toContain(
      "RUN install -d -m 0755 -o 0 -g 0 /opt/code-reviewer/guard",
    );
    // Through a scratch stage, like the license files: the final stage copies nothing but pins from the context.
    expect(stage("guard-files").base).toBe("scratch");
    expect(stage("guard-files").lines).toEqual([
      "COPY runner/guard/reference-transaction runner/scripts/guard_matrix.sh /",
    ]);
    expect(sandbox()).toContain(
      "COPY --from=guard-files --chown=0:0 --chmod=0755 / /opt/code-reviewer/guard/",
    );
  });

  // #761-T03: the Worker sets core.hooksPath per job through GIT_CONFIG_SYSTEM; the root file system is read-only.
  it("bakes no git configuration into the image: no hooksPath, no system or global config, no GIT_CONFIG", () => {
    const executable = stages(dockerfile)
      .flatMap((entry) => entry.lines)
      .join("\n");

    expect(executable).not.toMatch(/hooksPath/i);
    expect(executable).not.toMatch(/GIT_CONFIG/);
    expect(executable).not.toMatch(/git config/);
    expect(executable).not.toMatch(/\/etc\/gitconfig|\.gitconfig/);
  });

  // #761-T03
  it("still ends on the unprivileged user and enables nothing", () => {
    const users = sandbox().filter((line) => line.startsWith("USER "));

    expect(users.at(-1)).toBe("USER 10001:10001");
    expect(dockerfile).not.toMatch(
      /RUNNER_IMPLEMENTER|RUNNER_DYNAMIC|RUNNER_OPENCODE|RUNNER_ADVERTISED/,
    );
  });
});
