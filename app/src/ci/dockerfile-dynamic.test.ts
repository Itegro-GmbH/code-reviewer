// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the engine part of runner/Dockerfile (#202): the `sandbox` target, the one image of the
// project, adds the pinned OpenCode, `nft`, a pinned `rg` and the dedicated engine user, installed
// root-owned from verified, checksum-pinned downloads. Whether the built image behaves (checksums,
// version as the engine user, the self-check) is proven by docker/smoke/runner.sh, which CI runs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_PACKAGE_MANAGER_RUNS,
  packageManagerRuns,
} from "./dockerfile-package-managers";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dockerfile = readFileSync(`${repoRoot}runner/Dockerfile`, "utf8");

type Stage = { name: string; base: string; lines: string[] };

/** Stages of a Dockerfile, each with its instructions (comments dropped, continued lines joined). */
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

/** Everything a stage and the stages it is built on contribute. */
function chain(name: string): string {
  const own = stage(name);
  const parent = stages(dockerfile).find((entry) => entry.name === own.base);
  return [parent ? chain(parent.name) : "", ...own.lines].join("\n");
}

describe("the Worker image", () => {
  // #202-T03
  it("is the last stage, so a plain build gives the one image", () => {
    expect(stages(dockerfile).at(-1)?.name).toBe("sandbox");
    expect(stages(dockerfile).map((entry) => entry.name)).not.toContain(
      "runtime",
    );
    expect(stages(dockerfile).map((entry) => entry.name)).not.toContain(
      "dynamic",
    );
  });

  // #202-T03
  it("enables nothing: no Dynamic variable is set", () => {
    const settings = chain("sandbox")
      .split("\n")
      .filter((line) => /^(ENV|ARG) /.test(line));

    expect(settings.join("\n")).not.toMatch(
      /RUNNER_DYNAMIC|RUNNER_OPENCODE|RUNNER_DIFF_JOB_USER|RUNNER_ADVERTISED/,
    );
  });
});

describe("the engine of the Worker image", () => {
  const image = () => chain("sandbox");

  // #202-T01
  it("is built on the base stage that holds Python, the venv and the unprivileged user", () => {
    expect(stage("sandbox").base).toBe("runtime-base");
  });

  // #202-T01
  it("installs the engine and ripgrep root-owned from the verified fetch stage, and nothing else", () => {
    const copies = stage("sandbox").lines.filter((line) =>
      line.startsWith("COPY "),
    );

    expect(copies).toContain(
      "COPY --from=engine-tools --chown=0:0 --chmod=0755 /engine-tools/ /usr/local/bin/",
    );
    expect(
      copies.filter((line) => line.includes("--from=engine-tools")),
    ).toHaveLength(1);
  });

  // #264-T10: only linux-x64 is pinned; on another platform the fetch scripts fail the build, there is no
  // image without an engine (the golden snapshot builds on x86_64).
  it("fetches with the strict scripts: no flag lets a platform without a pin build an engine-less image", () => {
    const fetching = stage("engine-tools").lines.join("\n");

    for (const script of ["fetch_opencode.py", "fetch_ripgrep.py"])
      expect(fetching).toContain(
        `python /fetch/scripts/${script} --dest /engine-tools`,
      );
    expect(dockerfile).not.toContain("--allow-unpinned-platform");
  });

  // #202-T01
  it("fetches only through the pinned, checksum-verifying scripts: no curl, wget, package manager or latest", () => {
    const fetching = stage("engine-tools").lines.join("\n");

    expect(fetching).toContain("python /fetch/scripts/fetch_opencode.py");
    expect(fetching).toContain("python /fetch/scripts/fetch_ripgrep.py");
    expect(fetching).toContain(
      "COPY runner/opencode-pin.json runner/ripgrep-pin.json /fetch/",
    );
    // The toolchain layer of the Implementer (#761) brings Node.js with npm and pnpm, so the Dockerfile
    // names them in links; what stays forbidden is fetching with curl, wget or bun, and running a package
    // manager at all (not a list of its subcommands: `npx pkg`, `npm update`, `pnpm up`, `pnpm fetch`).
    expect(dockerfile).not.toMatch(/\b(curl|wget|bun)\b/);
    expect(packageManagerRuns(dockerfile)).toEqual([]);
    expect(dockerfile).not.toMatch(/releases\/latest|@latest/);
    // ripgrep comes from the pinned release, never from the distribution's unpinned package.
    expect(image()).not.toMatch(/apt-get install[^\n]*ripgrep/);
  });

  // #202-T01
  it("ships the pins the runner's self-check compares the installed files with", () => {
    // The directory exists, root-owned and enterable, before the files go in: COPY would give a new
    // directory the mode of the files.
    expect(stage("sandbox").lines).toContain(
      "RUN install -d -m 0755 -o 0 -g 0 /opt/code-reviewer/pins",
    );
    expect(stage("sandbox").lines).toContain(
      "COPY --chown=0:0 --chmod=0644 runner/opencode-pin.json runner/ripgrep-pin.json /opt/code-reviewer/pins/",
    );
  });

  // #202-T01
  it("adds nft and the engine user 10101, distinct from the Diff job user 10001", () => {
    const base = chain("runtime-base");
    const own = stage("sandbox").lines.join("\n");

    expect(own).toContain(
      "apt-get install --yes --no-install-recommends nftables",
    );
    expect(own).toContain("groupadd --system --gid 10101 engine");
    expect(own).toContain(
      "useradd --system --uid 10101 --gid engine --no-create-home",
    );
    expect(own).toContain("--shell /usr/sbin/nologin engine");
    expect(base).toContain("groupadd --system --gid 10001 runner");
    expect(base).toContain("useradd --system --uid 10001 --gid runner");
  });

  // #202-T01 / #202-T03: the image alone never makes the runner a root supervisor.
  it("ends on the unprivileged user 10001: root and the capabilities come from the hardened container spec", () => {
    const users = stage("sandbox").lines.filter((line) =>
      line.startsWith("USER "),
    );

    expect(users.at(-1)).toBe("USER 10001:10001");
    expect(users[0]).toBe("USER 0:0");
  });
});

// #202-T01 / #761-T02: the ban is on running a package manager, not on some of its subcommands.
describe("the check that no RUN instruction runs a package manager", () => {
  const flagged = (run: string) => packageManagerRuns(`FROM x\n${run}\n`);

  it.each([
    "RUN npx pkg",
    "RUN npx --yes pkg@1",
    "RUN npm update",
    "RUN npm install --global something",
    "RUN npm ci && npm run build",
    "RUN pnpm up",
    "RUN pnpm fetch",
    "RUN pnpm dlx tool",
    "RUN pnpm --version",
    "RUN corepack enable",
    "RUN corepack prepare pnpm@10 --activate",
    "RUN yarn add left-pad",
    "RUN pnpx tool",
    "RUN cd /app && pnpm i",
    "RUN apt-get update; npm i -g x",
    "RUN true | npm run x",
    "RUN CI=1 npm i",
    "RUN env CI=1 npm i",
    'RUN sh -c "make && npm i"',
    "RUN find . -name package.json -exec npm i {} \\;",
    "RUN /usr/local/bin/npm i",
    "RUN /opt/pnpm/bin/pnpm.cjs add x",
    "RUN node /opt/node/lib/node_modules/npm/bin/npm-cli.js i",
    "RUN node /opt/pnpm/dist/pnpm.cjs fetch",
    "RUN apt-get update \\\n && npm install",
  ])("flags %s", (run) => {
    expect(flagged(run)).toHaveLength(1);
  });

  it.each([
    "RUN ln -s /opt/node/bin/node /usr/local/bin/node",
    "RUN ln -s /opt/node/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s /opt/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm",
    "RUN rm -rf /toolchain/node/include /toolchain/node/share",
    "RUN chmod 0755 /toolchain/pnpm/bin/pnpm.cjs /toolchain/pnpm/bin/pnpx.cjs",
    "RUN python /fetch/scripts/fetch_toolchain.py --component pnpm --dest /toolchain/pnpm",
    "COPY --from=toolchain-fetch --chown=0:0 /toolchain/pnpm /opt/pnpm",
  ])("lets %s pass", (instruction) => {
    expect(flagged(instruction)).toEqual([]);
  });

  it("allows nothing by exact form today, and only an exact RUN instruction could be allowed", () => {
    expect(ALLOWED_PACKAGE_MANAGER_RUNS).toEqual([]);
    expect(flagged("RUN node --version")).toEqual([]);
  });

  it("finds nothing in the Dockerfile of the Worker image", () => {
    expect(packageManagerRuns(dockerfile)).toEqual([]);
  });
});

describe("what the documentation claims about the build of the Worker image", () => {
  const documents = {
    "runner/Dockerfile": dockerfile,
    "docs/dynamic-review.md": readFileSync(
      `${repoRoot}docs/dynamic-review.md`,
      "utf8",
    ),
    "docs/decisions/0004-dynamic-runner-image-and-self-check.md": readFileSync(
      `${repoRoot}docs/decisions/0004-dynamic-runner-image-and-self-check.md`,
      "utf8",
    ),
  };

  // #202-T01: apt resolves nftables when the image is built; the base image digest does not decide it.
  it.each(Object.entries(documents))(
    "does not say the nft version follows the base image (%s)",
    (_name, text) => {
      expect(text.replace(/\s+/g, " ")).not.toMatch(
        /version follows the base image/i,
      );
    },
  );

  // #202-T01: the nftables package is installed unpinned, and the Dockerfile says so.
  it("installs nftables without a version pin and says so next to the install", () => {
    const install = /apt-get install[^\n]*nftables[^\n]*/.exec(
      dockerfile.replace(/\\\n\s*/g, " "),
    );

    expect(install?.[0]).toBeDefined();
    expect(install?.[0]).not.toMatch(/nftables=/);
    expect(dockerfile).toMatch(/NOT version-pinned/);
  });
});
